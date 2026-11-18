import type { Trace } from '@structura/shared'
import { defaultTrace, json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator replays 10 seconds of traffic against a payment service that is
// healthy, flaky, hanging or briefly down. Threads, timeouts, retries and the
// breaker's three states are all worked out event by event, so every count is computed.

const SECONDS = 10
const SHARED_THREADS = 20 // one pool for every endpoint, unless a bulkhead splits it
const PAY_THREADS = 10 // the payment bulkhead's own pool
const TIMEOUT_MS = 1000
const BROWSE_EVERY_MS = 200
const BROWSE_HOLD_MS = 30
const FAILS_TO_OPEN = 5
const OPEN_MS = 3000

const RATES = ['5 checkouts a second', '10 checkouts a second', '20 checkouts a second']
const HEALTH = ['Healthy', 'Flaky: every 2nd call fails', 'Hanging: never answers', 'Outage from 3 s to 7 s']
const PROTECTION = [
  'None: no timeout, no retry, shared threads',
  'Timeout + 3 immediate retries',
  'Timeout + 2 retries with backoff and jitter',
  'Circuit breaker + bulkhead + fallback',
]

interface Down {
  ms: number
  ok: boolean
}

/** What Payment Service does with its nth call at time t. ms = Infinity means it never answers. */
function downstream(health: string, t: number, n: number): Down {
  if (health === HEALTH[1]) return n % 2 === 0 ? { ms: 100, ok: false } : { ms: 50, ok: true }
  if (health === HEALTH[2]) return { ms: Infinity, ok: false }
  if (health === HEALTH[3]) return t >= 3000 && t < 7000 ? { ms: 100, ok: false } : { ms: 50, ok: true }
  return { ms: 50, ok: true }
}

/** A fixed set of threads: a request takes one and keeps it until it is done (or forever). */
class Pool {
  busyUntil: number[]
  peak = 0
  fullMs = 0
  constructor(size: number) {
    this.busyUntil = Array(size).fill(0)
  }
  take(t: number): number {
    const i = this.busyUntil.findIndex((x) => x <= t)
    if (i >= 0) this.peak = Math.max(this.peak, this.busyUntil.filter((x) => x > t).length + 1)
    return i
  }
  release(i: number, until: number) {
    this.busyUntil[i] = until
  }
  busyAt(t: number) {
    return this.busyUntil.filter((x) => x > t).length
  }
}

type Outcome = 'paid' | 'pay-later' | 'error' | 'rejected' | 'hung'

const fmt = (ms: number) => (ms === Infinity ? 'never' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)

function simulate(rate: string, health: string, protection: string) {
  const perSecond = Number(rate.split(' ')[0]) || 10
  const strategy = Math.max(0, PROTECTION.indexOf(protection))
  const protectedMode = strategy === 3
  const shared = new Pool(SHARED_THREADS)
  const payPool = protectedMode ? new Pool(PAY_THREADS) : shared

  // Everything that happens in the 10 seconds, in order: payments, and a browse request every 0.2 s.
  const events: { t: number; kind: 'pay' | 'browse'; i: number }[] = []
  for (let i = 0; i < perSecond * SECONDS; i++) events.push({ t: Math.round((i * 1000) / perSecond), kind: 'pay', i })
  for (let k = 0; k < (SECONDS * 1000) / BROWSE_EVERY_MS; k++) events.push({ t: k * BROWSE_EVERY_MS, kind: 'browse', i: k })
  events.sort((a, b) => a.t - b.t || (a.kind === 'pay' ? -1 : 1))

  // Circuit breaker: results arrive later than requests, so they wait in a list until their time.
  let state = 'closed' as 'closed' | 'open' | 'half-open'
  let fails = 0
  let openUntil = 0
  let probing = false
  const pending: { at: number; ok: boolean; probe: boolean }[] = []
  const transitions: { at: number; to: string; why: string }[] = []
  const move = (at: number, to: typeof state, why: string) => {
    state = to
    transitions.push({ at, to, why })
  }
  const settle = (t: number) => {
    pending.sort((a, b) => a.at - b.at)
    while (pending.length && pending[0].at <= t) {
      const o = pending.shift()!
      if (o.probe) {
        probing = false
        if (o.ok) {
          fails = 0
          move(o.at, 'closed', 'the probe call worked')
        } else {
          openUntil = o.at + OPEN_MS
          move(o.at, 'open', 'the probe call failed')
        }
      } else if (state === 'closed') {
        if (o.ok) fails = 0
        else if (++fails >= FAILS_TO_OPEN) {
          openUntil = o.at + OPEN_MS
          move(o.at, 'open', `${FAILS_TO_OPEN} failures in a row`)
        }
      }
    }
  }

  const counts: Record<Outcome, number> = { paid: 0, 'pay-later': 0, error: 0, rejected: 0, hung: 0 }
  let calls = 0
  let fastFails = 0
  let browseOk = 0
  let browseBlocked = 0
  const latencies: number[] = []
  const attemptsPerRequest: number[] = []
  let firstFullAt = -1

  for (const ev of events) {
    const t = ev.t
    if (ev.kind === 'browse') {
      const i = shared.take(t)
      if (i < 0) browseBlocked++
      else {
        shared.release(i, t + BROWSE_HOLD_MS)
        browseOk++
      }
      continue
    }
    const slot = payPool.take(t)
    if (slot < 0) {
      counts.rejected++
      if (firstFullAt < 0) firstFullAt = t
      continue
    }
    let cur = t
    let ok = false
    let hungForever = false
    let attempts = 0
    if (protectedMode) {
      settle(t)
      if (state === 'open' && t >= openUntil) move(t, 'half-open', `${OPEN_MS / 1000} s passed, let one probe through`)
      if (state === 'open' || (state === 'half-open' && probing)) {
        fastFails++
        counts['pay-later']++
        payPool.release(slot, t + 1)
        latencies.push(1)
        attemptsPerRequest.push(0)
        continue
      }
      const probe = state === 'half-open'
      if (probe) probing = true
      const d = downstream(health, t, ++calls)
      const seen = d.ms <= TIMEOUT_MS ? d : { ms: TIMEOUT_MS, ok: false }
      pending.push({ at: t + seen.ms, ok: seen.ok, probe })
      cur = t + seen.ms
      ok = seen.ok
      attempts = 1
    } else {
      const maxAttempts = strategy === 0 ? 1 : strategy === 1 ? 4 : 3
      const timeout = strategy === 0 ? Infinity : TIMEOUT_MS
      for (let a = 0; a < maxAttempts; a++) {
        const d = downstream(health, cur, ++calls)
        attempts++
        if (d.ms <= timeout) {
          cur += d.ms
          if (d.ok) {
            ok = true
            break
          }
        } else if (timeout === Infinity) {
          hungForever = true
          cur = Infinity
          break
        } else cur += timeout
        if (a < maxAttempts - 1 && strategy === 2) {
          // Full jitter: wait a random time between 0 and the cap (200 ms, then 400 ms).
          const cap = 200 * 2 ** a
          cur += Math.round(cap * ((stableHash(`${ev.i}:${a}`) % 1000) / 1000))
        }
      }
    }
    payPool.release(slot, cur)
    attemptsPerRequest.push(attempts)
    if (hungForever) counts.hung++
    else {
      latencies.push(cur - t)
      if (ok) counts.paid++
      else if (protectedMode) counts['pay-later']++
      else counts.error++
    }
  }
  latencies.sort((a, b) => a - b)
  const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0)
  return {
    perSecond,
    strategy,
    protectedMode,
    total: perSecond * SECONDS,
    counts,
    calls,
    fastFails,
    browseOk,
    browseTotal: browseOk + browseBlocked,
    browseBlocked,
    sharedPeak: shared.peak,
    payPeak: payPool.peak,
    median: pct(50),
    p95: pct(95),
    worst: latencies.length ? latencies[latencies.length - 1] : 0,
    transitions,
    firstFullAt,
    attemptsPerRequest,
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'rate', label: 'Traffic', options: RATES },
    { id: 'health', label: 'Payment Service', options: HEALTH },
    { id: 'protection', label: 'Protection', options: PROTECTION },
  ],
  defaults: { rate: RATES[1], health: HEALTH[2], protection: PROTECTION[0] },
  run({ rate, health, protection }) {
    const r = simulate(rate, health, protection)
    const c = r.counts
    const failed = c.error + c.rejected + c.hung
    const steps: Trace['steps'] = []
    const poolName = r.protectedMode ? 'Payment Bulkhead (own thread pool)' : 'Browse Thread Pool'

    steps.push({
      text: `For ${SECONDS} seconds, shoppers place ${r.perSecond} orders a second (${r.total} in all) and browse product pages every ${BROWSE_EVERY_MS} ms. Every order needs one call to the Payment Service, which is: ${health.toLowerCase()}.`,
      nodes: ['Shopper'],
      data: `${r.total} × POST /checkout  (one every ${Math.round(1000 / r.perSecond)} ms)\n${(SECONDS * 1000) / BROWSE_EVERY_MS} × GET /products  (one every ${BROWSE_EVERY_MS} ms)\nPayment Service: ${health}\nProtection: ${protection}`,
    })

    steps.push({
      text: r.protectedMode
        ? `Checkout takes a thread from its own pool of ${PAY_THREADS}, kept just for payment calls. Product pages use a different pool of ${SHARED_THREADS}. At worst ${r.payPeak} of the ${PAY_THREADS} payment threads were busy, and the browse pool peaked at ${r.sharedPeak}.${c.rejected ? ` ${c.rejected} orders found the payment pool full and were turned away at once.` : ''}`
        : `Checkout and product pages share one pool of ${SHARED_THREADS} threads. A thread is held while it waits for Payment Service, so slow calls use up threads. The pool peaked at ${r.sharedPeak} of ${SHARED_THREADS}${r.firstFullAt >= 0 ? `, and was full from t=${fmt(r.firstFullAt)}: ${c.rejected} orders found no free thread` : ''}.`,
      nodes: ['Checkout Service', poolName],
      data: `thread pool: ${r.protectedMode ? `payments ${PAY_THREADS} + everything else ${SHARED_THREADS}` : `${SHARED_THREADS}, shared`}\npeak busy: ${r.protectedMode ? `payments ${r.payPeak}/${PAY_THREADS}, others ${r.sharedPeak}/${SHARED_THREADS}` : `${r.sharedPeak}/${SHARED_THREADS}`}\norders with no free thread: ${c.rejected}`,
    })

    if (r.protectedMode) {
      const flips = r.transitions.map((x) => `t=${fmt(x.at)}  → ${x.to.toUpperCase()}  (${x.why})`).join('\n')
      steps.push({
        text: r.transitions.length
          ? `The Circuit Breaker counts failures. After ${FAILS_TO_OPEN} in a row it opens, so ${r.fastFails} calls were refused in about 1 ms without touching Payment Service. After ${OPEN_MS / 1000} s it lets one probe call through: if it works the breaker closes again.`
          : `The Circuit Breaker is closed the whole time: the failures were never ${FAILS_TO_OPEN} in a row, so every call went through.`,
        nodes: ['Circuit Breaker', 'Metrics & Alerts'],
        data: r.transitions.length ? `${flips}\ncalls refused while open: ${r.fastFails}` : `state: CLOSED for ${SECONDS} s\ncalls refused: 0`,
      })
    }

    const attempts = r.attemptsPerRequest.reduce((a, b) => a + b, 0)
    steps.push({
      text:
        r.strategy === 0
          ? `There is no timeout and no retry. A call that never answers keeps its thread for ever. ${c.hung ? `${c.hung} orders are still waiting at the end.` : 'This time every call got an answer, so nothing was stuck.'}`
          : r.strategy === 3
            ? `Each call gets a ${fmt(TIMEOUT_MS)} timeout and no retry. A slow Payment Service now costs at most ${fmt(TIMEOUT_MS)} of one thread, never more.`
            : `Each call gets a ${fmt(TIMEOUT_MS)} timeout, then retries ${r.strategy === 1 ? '3 times straight away' : '2 times after a pause that doubles (up to 200 ms, then 400 ms) and is randomised with jitter, so clients don\'t all retry together'}. Orders made ${attempts} calls for ${r.total - c.rejected} accepted orders: ${(attempts / Math.max(1, r.total - c.rejected)).toFixed(2)} calls each.`,
      nodes: ['Timeout and Retry'],
      data: `timeout: ${r.strategy === 0 ? 'none' : fmt(TIMEOUT_MS)}\nretries: ${r.strategy === 1 ? '3, no pause' : r.strategy === 2 ? '2, backoff 200/400 ms × random(0..1)' : '0'}\ncalls sent to Payment Service: ${r.calls}\naverage per accepted order: ${(r.calls / Math.max(1, r.total - c.rejected - r.fastFails)).toFixed(2)}`,
    })

    steps.push({
      text: `Payment Service received ${r.calls} calls for ${r.total} orders. ${r.calls > r.total ? `That is ${(r.calls / r.total).toFixed(2)} times the load of the real orders: retries add traffic exactly when the service is struggling.` : r.calls < r.total ? `That is only ${Math.round((100 * r.calls) / r.total)}% of the orders, because the rest were turned away or refused before they got there.` : 'One call per order, no extra load.'}`,
      nodes: ['Payment Service'],
      data: `orders: ${r.total}\ncalls received: ${r.calls}\nload factor: ${(r.calls / r.total).toFixed(2)}×`,
    })

    steps.push({
      text: r.protectedMode
        ? `When a call fails or the breaker is open, checkout doesn't show an error. It saves the order as payment_pending and puts a job on the Pay Later Queue. ${c['pay-later']} orders went this way; a worker charges them once Payment Service is back.`
        : `${c.paid} of ${r.total} orders were paid. ${failed} failed: ${c.error} got an error after waiting, ${c.rejected} found no free thread${c.hung ? `, ${c.hung} are still waiting` : ''}. Failed orders are lost unless the shopper tries again.`,
      nodes: r.protectedMode ? ['Pay Later Queue', 'Order Database'] : ['Order Database'],
      data: json({ paid: c.paid, pay_later: c['pay-later'], failed_with_error: c.error, no_thread: c.rejected, still_waiting: c.hung }),
    })

    steps.push({
      text: `Meanwhile, ${r.browseOk} of ${r.browseTotal} product-page requests were served. ${r.browseBlocked ? `${r.browseBlocked} got no thread: the payment problem has taken down pages that don't use payments at all.` : 'Browsing was not affected.'}`,
      nodes: ['Browse Thread Pool', 'Product Pages'],
      data: `product pages served: ${r.browseOk}/${r.browseTotal}\nblocked by busy threads: ${r.browseBlocked}`,
    })

    steps.push({
      text: `The result for shoppers: ${c.paid} paid at once${r.protectedMode ? `, ${c['pay-later']} paid later` : ''}, ${failed} failed. A typical order took ${fmt(r.median)}, the slowest 5% took ${fmt(r.p95)} or more${c.hung ? ', and some never finished' : ''}.`,
      nodes: ['Metrics & Alerts'],
      data: `paid_now ${c.paid}\npaid_later ${c['pay-later']}\nfailed ${failed}\nlatency median ${fmt(r.median)} · p95 ${fmt(r.p95)} · worst ${c.hung ? 'never' : fmt(r.worst)}`,
    })

    return { input: `${rate}, ${health.toLowerCase()}, ${protection.toLowerCase()}`, steps }
  },
}

export const circuitBreaker: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'circuit-breaker',
  title: 'Circuit Breaker and Resilience Patterns',
  blurb: 'Timeouts, retries with backoff, circuit breakers and bulkheads: keeping one slow service from taking everything down',
  guides: ['resiliency-patterns', 'scale-circuit-breaker', 'scale-circuit-breaking-in-distributed-systems', 'scale-bulkheads-partition-and-tolerate-failure-in-one-part', 'how-do-we-retry-on-failures', 'scale-design-for-resiliency'],
  takeaways: [
    'A slow dependency is more dangerous than a dead one: every waiting call holds a thread until the pool runs out.',
    'Always set a timeout, and make it shorter than the timeout of whoever calls you.',
    'Retry only safe or idempotent calls, a few times, with exponential backoff and jitter, or retries become a retry storm.',
    'A circuit breaker has three states: closed (normal), open (fail fast) and half-open (let one probe through).',
    'A bulkhead gives each dependency its own threads, so one bad dependency cannot starve the rest of the app.',
    'Decide the fallback before the outage: a queue to retry later, a cached copy, or a clear error. Never pretend a write worked.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'guard', label: 'Protection around the payment call' },
      { id: 'pages', label: 'Everything that is not payments' },
    ],
    nodes: [
      { id: 'shopper', label: 'Shopper', shape: 'ellipse', color: 'blue', group: null },
      { id: 'checkout', label: 'Checkout Service', shape: 'rectangle', color: 'violet', group: null },
      { id: 'bulkhead', label: 'Payment Bulkhead (own thread pool)', shape: 'rectangle', color: 'orange', group: 'guard' },
      { id: 'breaker', label: 'Circuit Breaker', shape: 'diamond', color: 'violet', group: 'guard' },
      { id: 'retry', label: 'Timeout and Retry', shape: 'rectangle', color: 'orange', group: 'guard' },
      { id: 'payment', label: 'Payment Service', shape: 'rectangle', color: 'violet', group: null },
      { id: 'queue', label: 'Pay Later Queue', shape: 'rectangle', color: 'yellow', group: null },
      { id: 'orders', label: 'Order Database', shape: 'rectangle', color: 'green', group: null },
      { id: 'browse', label: 'Browse Thread Pool', shape: 'rectangle', color: 'orange', group: 'pages' },
      { id: 'pages', label: 'Product Pages', shape: 'rectangle', color: 'violet', group: 'pages' },
      { id: 'metrics', label: 'Metrics & Alerts', shape: 'rectangle', color: 'yellow', group: null },
    ],
    edges: [
      { from: 'shopper', to: 'checkout', label: 'POST /checkout', dashed: false },
      { from: 'shopper', to: 'browse', label: 'GET /products', dashed: false },
      { from: 'browse', to: 'pages', label: 'serve page', dashed: false },
      { from: 'checkout', to: 'bulkhead', label: 'take a thread', dashed: false },
      { from: 'bulkhead', to: 'breaker', label: 'may I call?', dashed: false },
      { from: 'breaker', to: 'retry', label: 'closed or probe', dashed: false },
      { from: 'retry', to: 'payment', label: 'charge()', dashed: false },
      { from: 'breaker', to: 'queue', label: 'open: fail fast', dashed: true },
      { from: 'retry', to: 'queue', label: 'gave up', dashed: true },
      { from: 'checkout', to: 'orders', label: 'save order', dashed: false },
      { from: 'breaker', to: 'metrics', label: 'state changes', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'orders',
        name: 'orders',
        columns: [
          { name: 'order_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'total_cents', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id, created_at)'],
      },
      {
        id: 'payment_attempts',
        name: 'payment_attempts',
        columns: [
          { name: 'attempt_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'order_id', type: 'bigint', pk: false, fk: 'orders.order_id', nullable: false, unique: false },
          { name: 'idempotency_key', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'outcome', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'latency_ms', type: 'int', pk: false, fk: null, nullable: true, unique: false },
          { name: 'attempted_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(order_id)'],
      },
      {
        id: 'pay_later_jobs',
        name: 'pay_later_jobs',
        columns: [
          { name: 'job_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'order_id', type: 'bigint', pk: false, fk: 'orders.order_id', nullable: false, unique: true },
          { name: 'tries', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'next_try_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(next_try_at)'],
      },
      {
        id: 'breaker_events',
        name: 'breaker_events',
        columns: [
          { name: 'event_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'dependency', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'from_state', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'to_state', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(dependency, at)'],
      },
    ],
    relations: [
      { from: 'payment_attempts', to: 'orders', kind: 'one-to-many', label: 'tries to pay' },
      { from: 'pay_later_jobs', to: 'orders', kind: 'one-to-one', label: 'retries payment for' },
    ],
  },
  explanation: {
    title: 'Circuit Breaker and Resilience Patterns',
    summary:
      'When a service you call gets slow, your threads pile up waiting for it, and soon your whole app is down too. A few small patterns stop that: timeouts bound the wait, retries with backoff ride out short glitches, a circuit breaker stops calling a service that is failing, and a bulkhead keeps its trouble in one corner of your app.',
    sections: [
      {
        heading: 'Overview',
        body: 'Picture a shop checkout that calls a payment service. One day the payment service stops answering. Each checkout request waits for it, and each waiting request holds a thread. A server has a fixed number of threads. After a few seconds all of them are waiting, and the shop cannot even show a product page. One broken dependency has become a full outage. This is a cascading failure.\n\nResilience patterns are the cheap fix. They don\'t make Payment Service work. They make your service keep working while it doesn\'t.',
      },
      {
        heading: 'Requirements',
        body: '- Bound how long any call can wait.\n- Survive short glitches (a lost packet, one restarting server) without the shopper noticing.\n- Stop sending traffic to a service that is clearly failing, and give it room to recover.\n- Keep unrelated features working while one dependency is down.\n- Show a clear, honest result to the shopper: paid, paid later, or failed.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 200 checkouts a second at peak.\n- Little\'s law: threads in use = arrival rate × time each call takes. Healthy, at 50 ms: 200 × 0.05 = 10 threads. If Payment Service hangs and the timeout is 1 s: 200 × 1 = 200 threads. With no timeout and an 8 s answer: 200 × 8 = 1,600 threads, far more than a server has.\n- Retries multiply load. 3 retries mean up to 4 calls per order: 200 × 4 = 800 calls a second sent to a service that is already struggling.\n- A breaker that opens for 30 s refuses about 200 × 30 = 6,000 calls (minus one probe) without sending them. If each is saved as a job of about 200 bytes, that is 6,000 × 200 B = 1.2 MB of queue.',
      },
      {
        heading: 'Step by step',
        body: '1. The Shopper sends POST /checkout to the Checkout Service. Product browsing goes to the Browse Thread Pool, a separate pool.\n2. Checkout takes a thread from the Payment Bulkhead (own thread pool). If none is free, the order is turned away at once.\n3. The Circuit Breaker is asked "may I call?". If it is open, the call is refused in about a millisecond and the order goes to the Pay Later Queue.\n4. If it is closed (or half-open and this is the probe), the call goes through Timeout and Retry.\n5. Timeout and Retry calls the Payment Service with a 1 s timeout, and retries only when it is safe.\n6. The result is saved in the Order Database as paid or payment_pending.\n7. If the call failed or timed out, the order is put on the Pay Later Queue, and the breaker counts the failure.\n8. Every state change of the breaker is sent to Metrics & Alerts.',
      },
      {
        heading: 'Components',
        body: '- Shopper: places orders and browses pages.\n- Checkout Service: takes the order and runs the payment call inside its protection.\n- Payment Bulkhead (own thread pool): a small, fixed set of threads used only for payment calls, so payment trouble cannot use up the threads other features need.\n- Circuit Breaker: counts failures per dependency and moves between closed, open and half-open.\n- Timeout and Retry: gives each call a time limit and retries safe calls a few times, with exponential backoff and jitter.\n- Payment Service: the dependency that can be slow or down.\n- Pay Later Queue: where orders wait to be charged when payment could not be tried or did not work.\n- Order Database: stores each order with its status (paid, payment_pending, failed) and every payment attempt.\n- Browse Thread Pool: the threads for product pages, kept apart from payment threads.\n- Product Pages: pages that don\'t need payments and should keep working during a payment outage.\n- Metrics & Alerts: breaker state, failure rate and queue depth, so the team is paged when the breaker opens.',
      },
      {
        heading: 'Key decisions',
        body: '- Timeouts first. Without one, nothing else helps. Set it from real latency: a little above the 99th percentile (p99) of a healthy call. Keep the inner timeout shorter than the caller\'s, or the caller gives up while you are still retrying.\n- What to retry: only network errors and 5xx on idempotent calls. A charge needs an idempotency key, or a retry can bill twice. Never retry a 400.\n- Backoff and jitter: wait 200 ms, then 400 ms, then 800 ms (doubling), each multiplied by a random number between 0 and 1. Without jitter, a thousand clients retry at the same instant and knock the service over again.\n- Breaker settings: open after 5 failures in a row (or a failure rate such as 50% over the last 20 calls), stay open for a few seconds, then half-open: let one probe through. A good probe closes the breaker; a bad one reopens it.\n- Bulkhead: a thread pool or a semaphore per dependency. Size it from Little\'s law (rate × latency) plus some room.\n- Fallback: for reads, a cached copy. For a payment, save the order and charge later. Say so plainly to the shopper.\n- Where the breaker lives: in each caller (a library such as Resilience4j or Polly), or in a service mesh proxy. A library knows the fallback; a mesh needs no code changes.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Each app server has its own breaker, so a failing service is noticed within seconds without any coordination. The price is that each server sees only its share of the failures.\n- Use a failure rate with a minimum number of calls, not one failure, or a single error at 3 a.m. opens the breaker.\n- When the breaker opens, alert someone. It is a symptom, not a fix.\n- Don\'t let all servers probe at the same moment: add jitter to the open time as well.\n- Retries at every layer multiply: 3 layers that each try a call 3 times (1 call and 2 retries) send 3 × 3 × 3 = 27 calls for one request. Retry at one layer only, or use a retry budget (for example, retries may be at most 10% of calls).\n- Load shedding: when you are overloaded yourself, refuse early with 503 and Retry-After instead of queueing for ever.\n- Test it: kill the dependency in staging, or add 5 seconds of delay with a fault-injection tool, and check that the breaker opens and the pages keep working.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why is a slow service worse than a dead one?\n- What are the three states of a circuit breaker, and what moves it between them?\n- Why add jitter to a retry delay?\n- A checkout call is retried and the customer is charged twice. What went wrong, and how do you stop it?\n- How does a bulkhead differ from a rate limiter?\n- How would you choose the timeout, the failure threshold and the open time?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A circuit breaker with three states',
        language: 'javascript',
        source: `export class CircuitBreaker {
  state = 'closed' // closed = normal, open = fail fast, half-open = one probe
  fails = 0
  openedAt = 0
  probing = false
  constructor(failuresToOpen = 5, openMs = 3000) {
    Object.assign(this, { failuresToOpen, openMs })
  }

  async call(fn, fallback) {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.openMs) return fallback() // fail fast, no network
      this.state = 'half-open' // time is up: allow a probe
    }
    if (this.state === 'half-open') {
      if (this.probing) return fallback() // only one probe at a time
      this.probing = true
    }
    try {
      const result = await fn()
      this.state = 'closed' // a good call closes the breaker
      this.fails = 0
      return result
    } catch {
      if (this.state === 'half-open' || ++this.fails >= this.failuresToOpen) {
        this.state = 'open'
        this.openedAt = Date.now()
      }
      return fallback()
    } finally {
      this.probing = false
    }
  }
}`,
        versions: [
          {
            language: 'java',
            source: `import java.util.concurrent.Callable;
import java.util.function.Supplier;

public class CircuitBreaker {
  enum State { CLOSED, OPEN, HALF_OPEN } // normal, fail fast, one probe

  private State state = State.CLOSED;
  private int fails = 0;
  private long openedAt = 0;
  private boolean probing = false;
  private final int failuresToOpen;
  private final long openMs;

  CircuitBreaker(int failuresToOpen, long openMs) {
    this.failuresToOpen = failuresToOpen;
    this.openMs = openMs;
  }

  synchronized boolean allow() {
    if (state == State.OPEN) {
      if (System.currentTimeMillis() - openedAt < openMs) return false; // fail fast, no network
      state = State.HALF_OPEN; // time is up: allow a probe
    }
    if (state == State.HALF_OPEN) {
      if (probing) return false; // only one probe at a time
      probing = true;
    }
    return true;
  }

  synchronized void record(boolean ok) {
    probing = false;
    if (ok) { state = State.CLOSED; fails = 0; return; } // a good call closes the breaker
    if (state == State.HALF_OPEN || ++fails >= failuresToOpen) {
      state = State.OPEN;
      openedAt = System.currentTimeMillis();
    }
  }

  <T> T call(Callable<T> fn, Supplier<T> fallback) {
    if (!allow()) return fallback.get();
    try {
      T result = fn.call();
      record(true);
      return result;
    } catch (Exception e) {
      record(false);
      return fallback.get();
    }
  }
}`,
          },
          {
            language: 'python',
            source: `import time

class CircuitBreaker:
    def __init__(self, failures_to_open=5, open_s=3.0):
        self.state = "closed"          # closed = normal, open = fail fast, half-open = one probe
        self.fails = 0
        self.opened_at = 0.0
        self.probing = False
        self.failures_to_open, self.open_s = failures_to_open, open_s

    def call(self, fn, fallback):
        if self.state == "open":
            if time.time() - self.opened_at < self.open_s:
                return fallback()      # fail fast, no network
            self.state = "half-open"   # time is up: allow a probe
        if self.state == "half-open":
            if self.probing:
                return fallback()      # only one probe at a time
            self.probing = True
        try:
            result = fn()
            self.state, self.fails = "closed", 0   # a good call closes the breaker
            return result
        except Exception:
            self.fails += 1
            if self.state == "half-open" or self.fails >= self.failures_to_open:
                self.state, self.opened_at = "open", time.time()
            return fallback()
        finally:
            self.probing = False`,
          },
        ],
      },
      {
        title: 'Retry with exponential backoff and full jitter',
        language: 'javascript',
        source: `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function withRetry(fn, { retries = 2, baseMs = 200, timeoutMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      // A timeout on every attempt, so a hung call can't hold the thread for ever.
      return await Promise.race([fn(), sleep(timeoutMs).then(() => Promise.reject(new Error('timeout')))])
    } catch (err) {
      if (attempt === retries || err.status === 400) throw err // out of tries, or a retry can't help
      const cap = baseMs * 2 ** attempt // 200 ms, then 400 ms
      await sleep(Math.random() * cap) // full jitter: spread clients out
    }
  }
}`,
        versions: [
          {
            language: 'python',
            source: `import random, time

def with_retry(fn, retries=2, base_s=0.2, timeout_s=1.0):
    for attempt in range(retries + 1):
        try:
            return fn(timeout=timeout_s)          # a timeout on every attempt
        except TimeoutError:
            if attempt == retries:
                raise
            cap = base_s * 2 ** attempt           # 0.2 s, then 0.4 s
            time.sleep(random.uniform(0, cap))    # full jitter: spread clients out`,
          },
        ],
      },
      {
        title: 'Bulkhead: a small pool just for payments',
        language: 'javascript',
        source: `// A semaphore: at most 10 payment calls at once. The 11th is refused immediately,
// so payments can never use the threads that product pages need.
export class Bulkhead {
  inFlight = 0
  constructor(max = 10) {
    this.max = max
  }
  async run(fn) {
    if (this.inFlight >= this.max) throw Object.assign(new Error('bulkhead full'), { status: 503 })
    this.inFlight++
    try {
      return await fn()
    } finally {
      this.inFlight--
    }
  }
}

const paymentPool = new Bulkhead(10)
// 10 threads ÷ 0.05 s per call = 200 healthy calls a second.
// During a hang with a 1 s timeout: 10 ÷ 1 = only 10 calls a second get in.`,
        versions: [
          {
            language: 'java',
            source: `import java.util.concurrent.Callable;
import java.util.concurrent.Semaphore;

public class Bulkhead {
  private final Semaphore permits;

  Bulkhead(int max) { permits = new Semaphore(max); }

  // At most 10 payment calls at once. The 11th is refused immediately,
  // so payments can never use the threads that product pages need.
  <T> T run(Callable<T> fn) throws Exception {
    if (!permits.tryAcquire()) throw new IllegalStateException("bulkhead full");
    try {
      return fn.call();
    } finally {
      permits.release();
    }
  }
}`,
          },
        ],
      },
      {
        title: 'The pay-later worker',
        language: 'sql',
        source: `-- A worker takes due jobs, charges them and reschedules failures with a growing delay.
-- SKIP LOCKED lets many workers run without taking the same job twice.
SELECT j.job_id, j.order_id, o.total_cents
FROM pay_later_jobs j
JOIN orders o USING (order_id)
WHERE j.next_try_at <= now()
ORDER BY j.next_try_at
LIMIT 50
FOR UPDATE OF j SKIP LOCKED;

-- After a failed charge: try again in 1, 2, 4 ... minutes (capped at an hour).
UPDATE pay_later_jobs
SET tries = tries + 1,
    next_try_at = now() + LEAST(interval '1 hour', interval '1 minute' * power(2, tries))
WHERE job_id = 8841;`,
      },
    ],
    related: ['Timeouts', 'Retries and backoff', 'Bulkhead', 'Load shedding', 'Idempotency', 'Cascading failure', 'Service mesh'],
  },
  simulator,
}
