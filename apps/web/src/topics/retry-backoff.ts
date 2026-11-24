import { shortNumber } from '../learn/numbers'
import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, with Google's SRE book and the AWS
// Architecture Blog's "Exponential Backoff And Jitter" as references (linked, not copied).
// The simulator plays every phone's retries in tenths of a second against a payment
// provider that can serve 2,000 requests a second, so peaks and recovery times are computed.

const STEP = 0.1 // seconds per tick
const HORIZON = 150 // seconds simulated
const CAPACITY = 2000 // requests a second the provider serves once it's back
const PER_TICK = CAPACITY * STEP
const BASE = 1 // first backoff, seconds
const CAP = 32 // longest wait, seconds
const MAX_ATTEMPTS = 8 // the first try and 7 retries (the naive strategy has no limit)

const STRATEGIES = ['Retry every 1 s until it works', 'Exponential backoff, no jitter', 'Exponential backoff + full jitter']
const OUTAGES: Record<string, number> = { '2 s blip': 2, '10 s outage': 10, '30 s outage': 30 }
const CLIENTS: Record<string, number> = { '1,000 phones': 1000, '10,000 phones': 10000 }

/** A small seeded random generator (mulberry32), so a run gives the same numbers every time. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seconds to wait after the `attempt`-th try failed (attempt 1 = the first try). */
export function backoff(strategy: string, attempt: number, rand: () => number): number {
  if (strategy === STRATEGIES[0]) return 1
  const ceiling = Math.min(CAP, BASE * 2 ** (attempt - 1)) // 1, 2, 4, 8, 16, 32, 32…
  return strategy === STRATEGIES[1] ? ceiling : rand() * ceiling // full jitter: anywhere in 0…ceiling
}

export interface Run {
  /** Requests sent in each second (index = second). */
  perSecond: number[]
  /** After the provider is back: the most requests in one tick (0.1 s), and in one second. */
  peakTick: number
  peakSecond: number
  total: number
  succeeded: number
  gaveUp: number
  /** When the last payment got through, in seconds. */
  lastOk: number
  /** One phone's tries: when each was sent and whether it worked. */
  sample: { at: number; ok: boolean; wait?: number }[]
}

/** Every phone sends at 0 s, when the provider has just gone down, then retries by the strategy. */
export function simulate(strategy: string, outage: number, clients: number, seed = 7): Run {
  const rand = random(seed)
  const ticks = Math.round(HORIZON / STEP)
  // Which phones try in each tick, and how many tries each has made.
  const queue: number[][] = Array.from({ length: ticks + 1 }, () => [])
  const attempts = new Uint16Array(clients)
  for (let c = 0; c < clients; c++) queue[0].push(c)
  const perSecond = new Array(HORIZON).fill(0)
  const sample: Run['sample'] = []
  // The phone whose tries the walkthrough shows: any one will do, as arrivals are shuffled.
  const watched = Math.floor(clients / 3)
  let peakTick = 0
  let total = 0
  let succeeded = 0
  let last = 0
  for (let tick = 0; tick <= ticks; tick++) {
    const arriving = queue[tick]
    if (!arriving.length) continue
    // Who gets one of the 200 places is down to luck: shuffle the tick's arrivals.
    for (let i = arriving.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[arriving[i], arriving[j]] = [arriving[j], arriving[i]]
    }
    const t = tick * STEP
    total += arriving.length
    if (t >= outage) peakTick = Math.max(peakTick, arriving.length)
    if (Math.floor(t) < HORIZON) perSecond[Math.floor(t)] += arriving.length
    // While it's down nothing gets through; once it's back, 200 a tick do and the rest get 503.
    let room = t < outage ? 0 : PER_TICK
    for (const c of arriving) {
      attempts[c]++
      const ok = room > 0
      if (ok) {
        room--
        succeeded++
        last = t
        if (c === watched) sample.push({ at: t, ok })
        continue
      }
      if (attempts[c] >= MAX_ATTEMPTS && strategy !== STRATEGIES[0]) {
        if (c === watched) sample.push({ at: t, ok })
        continue
      }
      const wait = backoff(strategy, attempts[c], rand)
      if (c === watched) sample.push({ at: t, ok, wait })
      const next = tick + Math.max(1, Math.round(wait / STEP))
      if (next <= ticks) queue[next].push(c)
    }
  }
  // Phones still waiting when the simulation ends count as given up.
  return { perSecond, peakTick, peakSecond: Math.max(...perSecond.slice(Math.ceil(outage))), total, succeeded, gaveUp: clients - succeeded, lastOk: last, sample }
}

const n = (x: number) => shortNumber(x)
const s1 = (x: number) => `${Number(x.toFixed(1))} s`

/**
 * Requests a second as text bars: one row for every few seconds until it settles,
 * each showing that slice's busiest second, so a one-second spike isn't averaged away.
 */
function chart(perSecond: number[]): string {
  let end = perSecond.length
  while (end > 1 && perSecond[end - 1] === 0) end--
  const width = Math.max(1, Math.ceil(end / 16))
  const rows: [string, number][] = []
  for (let from = 0; from < end; from += width) rows.push([width === 1 ? `${from} s` : `${from}–${from + width} s`, Math.max(...perSecond.slice(from, from + width))])
  const label = Math.max(...rows.map(([l]) => l.length))
  // Bars are drawn to the provider's capacity (6 blocks), not to the biggest value, so the
  // outage's spike doesn't flatten the rest. Short lines: this shows in a 390px-wide block.
  const bar = (v: number) => '█'.repeat(Math.min(12, Math.round((v / CAPACITY) * 6)))
  const over = (v: number) => (v > CAPACITY ? ` ${v >= 10 * CAPACITY ? Math.round(v / CAPACITY) : Math.round((v / CAPACITY) * 10) / 10}×` : '')
  return [
    `busiest second (██████ = ${n(CAPACITY)}/s)`,
    // The bar goes last: its block character can be wider than the font's other characters.
    ...rows.map(([l, v]) => `${l.padEnd(label)} ${n(v).padStart(6)} ${bar(v)}${over(v)}`.trimEnd()),
  ].join('\n')
}

const simulator: Simulator = {
  fields: [
    { id: 'strategy', label: 'Retry strategy', options: STRATEGIES },
    { id: 'outage', label: 'Provider down for', options: Object.keys(OUTAGES) },
    { id: 'clients', label: 'Phones waiting', options: Object.keys(CLIENTS) },
  ],
  defaults: { strategy: STRATEGIES[1], outage: '10 s outage', clients: '10,000 phones' },
  run({ strategy, outage, clients }) {
    const strat = STRATEGIES.includes(strategy) ? strategy : STRATEGIES[1]
    const down = OUTAGES[outage] ?? 10
    const phones = CLIENTS[clients] ?? 10000
    const r = simulate(strat, down, phones)
    const jitter = strat === STRATEGIES[2]
    const fixed = strat === STRATEGIES[0]
    const lines = r.sample.map((a, i) => `try ${i + 1} at ${s1(a.at)}: ${a.ok ? 'OK' : '503'}${a.wait !== undefined ? `, wait ${s1(a.wait)}` : ''}`)
    // The 1-second strategy can make 50 tries: show the start and the end.
    const tries = (lines.length > 10 ? [...lines.slice(0, 7), `… ${lines.length - 9} more …`, ...lines.slice(-2)] : lines).join('\n')
    const perPayment = (r.total / phones).toFixed(1)
    const steps: Trace['steps'] = [
      {
        text: `${n(phones)} phones are paying for orders when the Payment Provider goes down for ${down} seconds. Every call fails fast with 503.`,
        nodes: ['Client Apps', 'API Gateway', 'Order Service', 'Payment Provider'],
        data: `POST /v1/payments  (×${n(phones)} at 0 s)\nIdempotency-Key: 7c1e…\n→ 503 Service Unavailable`,
      },
      {
        text: 'Before waiting, the Order Service asks: is this failure worth retrying? A 503, a 429 or a timeout may work next time. A 400 or 401 never will, so it fails at once.',
        nodes: ['Retryable?'],
        data: 'retry:     503 502 504 429 timeout\nfail now:  400 401 403 404 422',
      },
      {
        text: fixed
          ? 'This strategy waits exactly 1 second, every time, forever. Every phone failed at the same moment, so every phone comes back at the same moment.'
          : jitter
            ? `Exponential backoff with full jitter: the most it may wait doubles each time (1, 2, 4, 8 … ${CAP} s), and each phone picks a random wait between 0 and that. One phone's tries:`
            : `Exponential backoff: wait 1 s, then 2, 4, 8, 16, ${CAP} s. Each wait is longer, but every phone uses the same numbers, so they stay in step. One phone's tries:`,
        nodes: ['Backoff + Jitter'],
        data: tries,
      },
      {
        text: `At ${down} s the provider is back. It can serve ${n(CAPACITY)} requests a second (${n(PER_TICK)} in each tenth of a second); the rest get 503 again. From then on, the busiest tenth of a second brought ${n(r.peakTick)} requests${r.peakTick > PER_TICK ? `: ${Math.round(r.peakTick / PER_TICK)}× what it can take` : ', within what it can take'}. The chart's first rows are the outage itself.`,
        nodes: ['Payment Provider', 'Order Service'],
        data: chart(r.perSecond),
      },
      {
        text: fixed
          ? 'This strategy never gives up, so nothing reaches the Dead-Letter Queue. But a phone that never stops retrying is part of the overload.'
          : r.gaveUp > 0
            ? `${n(r.gaveUp)} phones used all ${MAX_ATTEMPTS} tries and gave up. Their payments go to the Dead-Letter Queue, to be checked and finished later, and the app says "We're still checking", not "Failed".`
            : `No phone ran out of its ${MAX_ATTEMPTS} tries, so nothing went to the Dead-Letter Queue.`,
        nodes: ['Dead-Letter Queue'],
        data: `succeeded: ${n(r.succeeded)} of ${n(phones)}\ngave up:   ${n(r.gaveUp)}${fixed ? '' : `  (after ${MAX_ATTEMPTS} tries)`}`,
      },
      {
        text: `The Retry Budget watches what share of the traffic is retries. Here ${n(r.total - phones)} of ${n(r.total)} requests were retries: ${Math.round(((r.total - phones) / r.total) * 100)}%. This run has no budget. A 10% budget would have failed most of these retries fast, before they reached the provider.`,
        nodes: ['Retry Budget'],
        data: `first tries: ${n(phones)}\nretries:     ${n(r.total - phones)}\ntotal:       ${n(r.total)}\nper payment: ${perPayment}`,
      },
      {
        text:
          r.gaveUp === 0
            ? `Every payment went through by ${s1(r.lastOk)}, ${s1(r.lastOk - down)} after the provider came back. ${
                fixed
                  ? `But it took ${n(r.total)} requests, ${perPayment} per payment, with up to ${n(r.peakSecond)} a second hitting a provider that takes ${n(CAPACITY)}.`
                  : jitter
                    ? 'Jitter spread the retries out, so the provider was rarely asked for more than it could take.'
                    : 'Here the waves were small enough to get through.'
              }`
            : `${n(r.gaveUp)} payments never went through. ${
                jitter
                  ? 'Jitter kept the load under capacity, but some phones used up their tries during the outage. A longer outage needs more tries or a longer cap.'
                  : 'The retries stayed in step, so each wave hit the provider all at once and only 200 of it got through. Try the same outage with full jitter.'
              }`,
        nodes: ['Metrics & Alerts'],
        data: `after recovery, the busiest\n  second: ${n(r.peakSecond)} (${n(CAPACITY)} fit)\n  0.1 s:  ${n(r.peakTick)} (${n(PER_TICK)} fit)\nlast payment at ${s1(r.lastOk)}`,
      },
    ]
    return { input: `${strat}, provider down ${down} s, ${n(phones)} phones`, steps }
  },
}

export const retryBackoff: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'retry-backoff',
  title: 'Retries: Backoff and Jitter',
  blurb: 'Why retrying at once makes an outage worse: exponential backoff, jitter, retry budgets and dead letters',
  guides: [
    'how-do-we-retry-on-failures',
    'scale-fault-tolerance-timeouts-and-retries-thread-separation-semaphores-circ',
    'top-6-cases-to-apply-idempotency',
    'scale-circuit-breaker',
  ],
  takeaways: [
    'Retry only failures that can pass on their own: timeouts, 429 and 5xx, never 400 or 401.',
    'Exponential backoff doubles the wait after each failure, up to a cap, so a struggling server gets room to recover.',
    'Jitter makes each client wait a random part of that time, so thousands of clients that failed together do not retry together.',
    'Limit retries: a few tries per request, a retry budget per client, and retries at one layer only.',
    'A retry can repeat work that already happened, so make the operation idempotent with a key.',
    'When the tries run out, park the work in a dead-letter queue and tell the user it is pending, not failed.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'caller', label: 'The caller' },
      { id: 'retry', label: 'Retry policy' },
    ],
    nodes: [
      { id: 'clients', label: 'Client Apps', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: null },
      { id: 'service', label: 'Order Service', shape: 'rectangle', color: 'violet', group: 'caller' },
      { id: 'breaker', label: 'Circuit Breaker', shape: 'rectangle', color: 'violet', group: 'caller' },
      { id: 'provider', label: 'Payment Provider', shape: 'rectangle', color: 'violet', group: null },
      { id: 'decide', label: 'Retryable?', shape: 'diamond', color: 'violet', group: 'retry' },
      { id: 'backoff', label: 'Backoff + Jitter', shape: 'rectangle', color: 'orange', group: 'retry' },
      { id: 'budget', label: 'Retry Budget', shape: 'rectangle', color: 'red', group: 'retry' },
      { id: 'dlq', label: 'Dead-Letter Queue', shape: 'rectangle', color: 'yellow', group: null },
      { id: 'metrics', label: 'Metrics & Alerts', shape: 'rectangle', color: 'yellow', group: null },
    ],
    edges: [
      { from: 'clients', to: 'gateway', label: 'pay', dashed: false },
      { from: 'gateway', to: 'service', label: 'POST /payments', dashed: false },
      { from: 'service', to: 'breaker', label: 'call', dashed: false },
      { from: 'breaker', to: 'provider', label: 'charge', dashed: false },
      { from: 'provider', to: 'decide', label: '503 / timeout', dashed: true },
      { from: 'decide', to: 'budget', label: 'yes', dashed: false },
      { from: 'budget', to: 'backoff', label: 'within budget', dashed: false },
      { from: 'backoff', to: 'breaker', label: 'retry later', dashed: true },
      { from: 'decide', to: 'service', label: 'no: fail now', dashed: true },
      { from: 'backoff', to: 'dlq', label: 'out of tries', dashed: true },
      { from: 'service', to: 'metrics', label: 'retries, give-ups', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'payment_attempts',
        name: 'payment_attempts',
        columns: [
          { name: 'attempt_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'payment_id', type: 'text', pk: false, fk: 'payments.payment_id', nullable: false, unique: false },
          { name: 'attempt_no', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status_code', type: 'smallint', pk: false, fk: null, nullable: true, unique: false },
          { name: 'error', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'waited_ms', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'sent_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(payment_id, attempt_no) unique'],
      },
      {
        id: 'payments',
        name: 'payments',
        columns: [
          { name: 'payment_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'idempotency_key', type: 'uuid', pk: false, fk: null, nullable: false, unique: true },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'next_retry_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(status, next_retry_at)'],
      },
      {
        id: 'dead_letters',
        name: 'dead_letters',
        columns: [
          { name: 'dead_letter_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'payment_id', type: 'text', pk: false, fk: 'payments.payment_id', nullable: false, unique: true },
          { name: 'attempts', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'last_error', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'payment_attempts', to: 'payments', kind: 'one-to-many', label: 'tries of' },
      { from: 'dead_letters', to: 'payments', kind: 'one-to-one', label: 'parks' },
    ],
  },
  explanation: {
    title: 'Retries: Backoff and Jitter',
    summary:
      'When a call fails, trying again often works: the server was busy for a moment, or a packet was lost. But if every client retries at once, and keeps retrying, the extra traffic keeps the server down. Exponential backoff waits longer after each failure; jitter makes each client wait a random part of that time; limits and budgets stop retries from multiplying.',
    sections: [
      {
        heading: 'Overview',
        body: 'A retry is a second try at a call that failed. It is the cheapest fix for short failures: a dropped connection, a server restarting, a 503 during a deploy.\n\nRetries are also dangerous. 10k phones that failed at the same moment will, by default, retry at the same moment. That burst hits a server that is just recovering and knocks it down again. This is called a retry storm.\n\nThree ideas keep retries safe: wait longer each time (exponential backoff), wait a random amount (jitter), and limit how much retrying anyone may do (retry budgets).',
      },
      {
        heading: 'Requirements',
        body: '- Retry failures that can pass on their own; fail fast on the rest.\n- Spread retries out in time so they never arrive in one burst.\n- Put a limit on tries per request and on retries per client.\n- Never charge, send or create twice because of a retry.\n- Tell the user honestly when the tries run out: pending, not failed.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: the Payment Provider serves 2k requests a second, so 200 in each tenth of a second. It goes down for 10 seconds while 10k phones are paying.\n- Without jitter, every phone retries in the same tenth of a second: 10k requests against room for 200. 200 get through, and the other 9,800 come back together at the next step.\n- With full jitter, after the 5th failed try each phone waits a random time between 0 and 16 seconds. 10k phones over 16 seconds is about 625 a second, or 63 in each tenth: well under 200.\n- Retrying every second, forever: the 10k phones need 50 waves of 200, so about 50 seconds and 355k requests, 35.5 for each payment.',
      },
      {
        heading: 'Step by step',
        body: "1. The Client Apps pay through the API Gateway, and the Order Service calls the Payment Provider through the Circuit Breaker.\n2. The call fails with 503 or times out.\n3. Retryable? checks the failure: 503, 429 and timeouts may pass; 400 and 401 never will.\n4. The Retry Budget checks that retries are still a small share of the traffic.\n5. Backoff + Jitter picks the wait: a random time between 0 and 1, 2, 4, 8… seconds, up to a cap.\n6. After the wait the call goes through the Circuit Breaker again, with the same idempotency key.\n7. After the last try the payment goes to the Dead-Letter Queue, and the app shows it as pending.\n8. Metrics & Alerts count retries and give-ups, so a storm shows up on a graph.",
      },
      {
        heading: 'Components',
        body: "- Client Apps: the phones paying; each one retries on its own.\n- API Gateway: the front door; it passes on the provider's Retry-After when there is one.\n- Order Service: makes the call and owns the retry policy.\n- Circuit Breaker: stops calling a provider that keeps failing, so retries fail fast for a while.\n- Payment Provider: the dependency that fails; it can serve 2k requests a second.\n- Retryable?: decides which failures are worth another try.\n- Backoff + Jitter: works out how long to wait before the next try.\n- Retry Budget: keeps retries below a share of all requests, such as 10%.\n- Dead-Letter Queue: holds payments that ran out of tries, to finish later.\n- Metrics & Alerts: retries, give-ups and their share of traffic, per dependency.",
      },
      {
        heading: 'Key decisions',
        body: '- No backoff (retry at once, or every second): simplest, and the cause of retry storms.\n- Exponential backoff: wait base × 2^attempt, capped (1, 2, 4, 8… s). Spaces the tries out, but clients that failed together stay together.\n- Full jitter: wait a random time between 0 and that value. Spreads clients out best; the usual default.\n- Equal jitter: half the value plus a random half. Always waits a little; in AWS\'s simulations it did worse than full jitter.\n- Decorrelated jitter: the next wait is random between the base and 3 times the last wait, capped. Close to full jitter.\n- How many tries: 3 to 5 for a user waiting on a screen; more, spread over minutes, for background jobs.\n- Retry-After: when the server says how long to wait, wait that long instead.',
      },
      {
        heading: 'Scaling and failure',
        body: "- Retry at one layer only. If 3 layers each make 4 tries, one click can become 4 × 4 × 4 = 64 calls to the bottom layer.\n- A retry budget per client (retries under 10% of requests) keeps a retry storm from growing past a small amount.\n- A circuit breaker opens after repeated failures, so retries fail fast instead of piling onto a dead dependency.\n- Every retried call that changes something needs an idempotency key, so a retry after a timeout doesn't pay twice.\n- Set a timeout on every try; a hanging call holds a thread and hides the failure.\n- Watch retries as a share of traffic; a jump means something is failing even if users still succeed.",
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why does adding jitter help, if the average wait stays the same?\n- Which HTTP status codes would you retry, and which would you not?\n- Three services each retry 3 times. How many calls can one user request cause at the bottom?\n- How do retries and idempotency keys work together for payments?\n- What should the app show the user when the last retry fails?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Retry with exponential backoff and full jitter',
        language: 'javascript',
        source: `// Retries only failures that can pass, waits a random time up to a doubling cap,
// and honours the server's Retry-After.
export async function withRetry(call, { base = 1000, cap = 32000, tries = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (err) {
      if (attempt >= tries || !isRetryable(err)) throw err
      const ceiling = Math.min(cap, base * 2 ** (attempt - 1)) // 1 s, 2 s, 4 s, 8 s…
      const wait = err.retryAfterMs ?? Math.random() * ceiling // full jitter: 0…ceiling
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

// Timeouts, 429 and 5xx may pass on their own. 4xx won't: retrying only adds load.
const isRetryable = (err) => err.timeout || err.status === 429 || (err.status >= 500 && err.status !== 501)

// await withRetry(() => pay(order, { idempotencyKey: order.key }))`,
        versions: [
          {
            language: 'java',
            source: `import java.util.concurrent.Callable;
import java.util.concurrent.ThreadLocalRandom;

public class Retry {
  public static class CallFailed extends Exception {
    final int status;          // 0 for a timeout
    final Long retryAfterMs;   // from the Retry-After header, if any
    public CallFailed(int status, Long retryAfterMs) { this.status = status; this.retryAfterMs = retryAfterMs; }
  }

  // Timeouts, 429 and 5xx may pass on their own. 4xx won't: retrying only adds load.
  static boolean isRetryable(CallFailed e) {
    return e.status == 0 || e.status == 429 || (e.status >= 500 && e.status != 501);
  }

  public static <T> T withRetry(Callable<T> call, long baseMs, long capMs, int tries) throws Exception {
    for (int attempt = 1; ; attempt++) {
      try {
        return call.call();
      } catch (CallFailed e) {
        if (attempt >= tries || !isRetryable(e)) throw e;
        long ceiling = Math.min(capMs, baseMs << (attempt - 1)); // 1 s, 2 s, 4 s, 8 s…
        long wait = e.retryAfterMs != null ? e.retryAfterMs : ThreadLocalRandom.current().nextLong(ceiling + 1); // full jitter
        Thread.sleep(wait);
      }
    }
  }
}`,
          },
        ],
      },
      {
        title: 'Three kinds of jitter',
        language: 'javascript',
        source: `// The wait before retry number \`attempt\` (1, 2, 3…), in ms. base 1 s, cap 32 s.
const base = 1000
const cap = 32000
const ceiling = (attempt) => Math.min(cap, base * 2 ** (attempt - 1))
const between = (lo, hi) => lo + Math.random() * (hi - lo)

// Full jitter: anywhere from 0 to the ceiling. Spreads clients out the most.
const full = (attempt) => between(0, ceiling(attempt))

// Equal jitter: half the ceiling, plus a random half. Never retries straight away.
const equal = (attempt) => ceiling(attempt) / 2 + between(0, ceiling(attempt) / 2)

// Decorrelated jitter: grows from the last wait instead of the attempt number.
const decorrelated = (lastWait) => Math.min(cap, between(base, lastWait * 3))

// attempt 4: full → 0…8 s, equal → 4…8 s; decorrelated after a 2 s wait → 1…6 s`,
        versions: [
          {
            language: 'java',
            source: `import java.util.concurrent.ThreadLocalRandom;

public class Jitter {
  static final double BASE = 1000, CAP = 32000; // ms

  static double ceiling(int attempt) { return Math.min(CAP, BASE * Math.pow(2, attempt - 1)); }
  static double between(double lo, double hi) { return lo + ThreadLocalRandom.current().nextDouble() * (hi - lo); }

  // Full jitter: anywhere from 0 to the ceiling. Spreads clients out the most.
  static double full(int attempt) { return between(0, ceiling(attempt)); }

  // Equal jitter: half the ceiling, plus a random half. Never retries straight away.
  static double equal(int attempt) { return ceiling(attempt) / 2 + between(0, ceiling(attempt) / 2); }

  // Decorrelated jitter: grows from the last wait instead of the attempt number.
  static double decorrelated(double lastWait) { return Math.min(CAP, between(BASE, lastWait * 3)); }

  public static void main(String[] args) {
    // attempt 4: full → 0…8 s, equal → 4…8 s; decorrelated after a 2 s wait → 1…6 s
    System.out.printf("%.0f %.0f %.0f%n", full(4), equal(4), decorrelated(2000));
  }
}`,
          },
        ],
      },
      {
        title: 'A retry budget: retries under 10% of requests',
        language: 'javascript',
        source: `// One per client (or per dependency). Counts the last minute in 10 s buckets.
export class RetryBudget {
  constructor(ratio = 0.1) {
    this.ratio = ratio
    this.buckets = Array.from({ length: 6 }, () => ({ requests: 0, retries: 0 }))
    this.current = 0
    setInterval(() => {
      this.current = (this.current + 1) % 6 // the oldest 10 s drops out
      this.buckets[this.current] = { requests: 0, retries: 0 }
    }, 10_000).unref?.()
  }

  #sum(field) {
    return this.buckets.reduce((n, b) => n + b[field], 0)
  }

  onRequest() {
    this.buckets[this.current].requests++
  }

  /** May this failure be retried? If not, fail fast: the dependency is in trouble. */
  canRetry() {
    if (this.#sum('retries') >= this.ratio * this.#sum('requests')) return false
    this.buckets[this.current].retries++
    return true
  }
}`,
        versions: [
          {
            language: 'java',
            source: `import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

// One per client (or per dependency). Counts the last minute in 10 s buckets.
public class RetryBudget {
  private final double ratio;
  private final long[] requests = new long[6];
  private final long[] retries = new long[6];
  private int current = 0;

  public RetryBudget(double ratio) {
    this.ratio = ratio;
    Executors.newSingleThreadScheduledExecutor().scheduleAtFixedRate(this::rotate, 10, 10, TimeUnit.SECONDS);
  }

  private synchronized void rotate() {
    current = (current + 1) % 6; // the oldest 10 s drops out
    requests[current] = 0;
    retries[current] = 0;
  }

  public synchronized void onRequest() { requests[current]++; }

  /** May this failure be retried? If not, fail fast: the dependency is in trouble. */
  public synchronized boolean canRetry() {
    long req = 0, ret = 0;
    for (int i = 0; i < 6; i++) { req += requests[i]; ret += retries[i]; }
    if (ret >= ratio * req) return false;
    retries[current]++;
    return true;
  }
}`,
          },
        ],
      },
    ],
    related: ['Idempotency keys', 'Circuit breaker', 'Rate limiting', 'Dead-letter queues', 'Timeouts', 'Load shedding'],
  },
  simulator,
}
