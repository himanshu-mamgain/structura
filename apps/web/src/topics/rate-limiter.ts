import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator runs the three real algorithms on a list of request times, so
// the allowed/blocked counts it shows are computed, not canned.

const LIMIT = 10 // requests...
const WINDOW = 60 // ...per 60 seconds
const REFILL = LIMIT / WINDOW // token bucket: tokens per second
const KEY = 'key_live_8f3a'
const GATEWAYS = 4

interface Limiter {
  /** Would a request at time t pass? (no state change) */
  peek(t: number): boolean
  take(t: number): void
}

function tokenBucket(capacity: number, rate: number): Limiter {
  let tokens = capacity
  let last = 0
  const refilled = (t: number) => Math.min(capacity, tokens + (t - last) * rate)
  return {
    peek: (t) => refilled(t) >= 1,
    take(t) {
      tokens = refilled(t) - 1
      last = t
    },
  }
}

function fixedWindow(): Limiter {
  let win = -1
  let count = 0
  const current = (t: number) => (Math.floor(t / WINDOW) === win ? count : 0)
  return {
    peek: (t) => current(t) < LIMIT,
    take(t) {
      count = current(t) + 1
      win = Math.floor(t / WINDOW)
    },
  }
}

// Sliding window counter: estimate = previous window × share still inside + current window.
function slidingCounter(): Limiter {
  let win = 0
  let cur = 0
  let prev = 0
  const view = (t: number) => {
    const w = Math.floor(t / WINDOW)
    if (w === win) return { w, cur, prev }
    return { w, cur: 0, prev: w === win + 1 ? cur : 0 }
  }
  const estimate = (t: number) => {
    const v = view(t)
    return v.prev * (1 - (t % WINDOW) / WINDOW) + v.cur
  }
  return {
    peek: (t) => estimate(t) + 1 <= LIMIT,
    take(t) {
      const v = view(t)
      win = v.w
      prev = v.prev
      cur = v.cur + 1
    },
  }
}

const ALGORITHMS = ['Token bucket', 'Fixed window counter', 'Sliding window counter']
const make = (algo: string): Limiter => (algo === ALGORITHMS[0] ? tokenBucket(LIMIT, REFILL) : algo === ALGORITHMS[1] ? fixedWindow() : slidingCounter())

const TRAFFIC: Record<string, number[]> = {
  '20 requests at once (t=30s)': Array(20).fill(30),
  '10 at t=55s, then 10 at t=65s': [...Array(10).fill(55), ...Array(10).fill(65)],
  'One request every 2 s for a minute': Array.from({ length: 30 }, (_, i) => i * 2),
}

const REDIS = ['Redis healthy', 'Redis down: fail open', 'Redis down: fail closed', 'Redis down: local fallback']

/** Collapses [✓,✓,✗…] into "#1-#10 ✓ · #11-#20 ✗" with the time of each run. */
function timeline(times: number[], ok: boolean[]): string {
  const runs: string[] = []
  let start = 0
  for (let i = 1; i <= ok.length; i++) {
    if (i === ok.length || ok[i] !== ok[start]) {
      const range = i - start === 1 ? `#${start + 1}` : `#${start + 1}-#${i}`
      const at = times[start] === times[i - 1] ? `t=${times[start]}s` : `t=${times[start]}s..${times[i - 1]}s`
      runs.push(`${range} (${at}) ${ok[start] ? '✓ 200' : '✗ 429'}`)
      start = i
    }
  }
  return runs.join('\n')
}

/** The most requests let through in any 60-second span: the limit's real worth. */
function busiestMinute(allowed: number[]): number {
  let best = 0
  for (let i = 0; i < allowed.length; i++) {
    let n = 0
    for (let j = i; j < allowed.length && allowed[j] - allowed[i] < WINDOW; j++) n++
    best = Math.max(best, n)
  }
  return best
}

const simulator: Simulator = {
  fields: [
    { id: 'algorithm', label: 'Algorithm', options: ALGORITHMS },
    { id: 'traffic', label: 'Traffic', options: Object.keys(TRAFFIC) },
    { id: 'redis', label: 'Counter store', options: REDIS },
  ],
  defaults: { algorithm: ALGORITHMS[0], traffic: '10 at t=55s, then 10 at t=65s', redis: REDIS[0] },
  run({ algorithm, traffic, redis }) {
    const times = TRAFFIC[traffic] ?? TRAFFIC['20 requests at once (t=30s)']
    const n = times.length
    const down = redis !== REDIS[0]
    const algo = down ? 'Token bucket' : algorithm
    const ok: boolean[] = []
    let state = ''
    let retryAfter = 0

    if (!down) {
      const limiter = make(algorithm)
      times.forEach((t) => {
        const pass = limiter.peek(t)
        if (pass) limiter.take(t)
        ok.push(pass)
      })
      if (ok.includes(false)) {
        // Retry-After: the first whole second at which the same request would pass.
        const t = times[ok.indexOf(false)]
        let wait = 1
        const probe = make(algorithm)
        times.forEach((x, i) => {
          if (ok[i]) probe.take(x)
        })
        while (!probe.peek(t + wait) && wait < WINDOW * 2) wait++
        retryAfter = wait
      }
      const key = algorithm === ALGORITHMS[0] ? 'rl:tb' : algorithm === ALGORITHMS[1] ? 'rl:fw' : 'rl:sw'
      const last = times[n - 1]
      if (algorithm === ALGORITHMS[0]) {
        let tokens = LIMIT
        let prev = 0
        times.forEach((t, i) => {
          if (ok[i]) {
            tokens = Math.min(LIMIT, tokens + (t - prev) * REFILL) - 1
            prev = t
          }
        })
        const shown = Math.min(LIMIT, tokens + (last - prev) * REFILL)
        state = `HGETALL ${key}:${KEY}\n  tokens → ${shown.toFixed(2)}\n  ts     → ${last}`
      } else if (algorithm === ALGORITHMS[1]) {
        const w = Math.floor(last / WINDOW)
        const inWindow = times.filter((t, i) => ok[i] && Math.floor(t / WINDOW) === w).length
        state = `GET ${key}:${KEY}:${w}\n  → ${inWindow}   (EXPIRE 120 s)`
      } else {
        const w = Math.floor(last / WINDOW)
        const count = (win: number) => times.filter((t, i) => ok[i] && Math.floor(t / WINDOW) === win).length
        state = `GET ${key}:${KEY}:${w - 1} → ${count(w - 1)}\nGET ${key}:${KEY}:${w} → ${count(w)}\nestimate = ${count(w - 1)} × ${(1 - (last % WINDOW) / WINDOW).toFixed(3)} + ${count(w)} = ${(count(w - 1) * (1 - (last % WINDOW) / WINDOW) + count(w)).toFixed(2)}`
      }
    } else if (redis === REDIS[1]) {
      times.forEach(() => ok.push(true))
    } else if (redis === REDIS[2]) {
      times.forEach(() => ok.push(false))
    } else {
      // Each gateway keeps its own small bucket: a share of the limit, no coordination.
      const locals = Array.from({ length: GATEWAYS }, () => tokenBucket(LIMIT / GATEWAYS, REFILL / GATEWAYS))
      times.forEach((t, i) => {
        const l = locals[i % GATEWAYS]
        const pass = l.peek(t)
        if (pass) l.take(t)
        ok.push(pass)
      })
    }

    const allowedTimes = times.filter((_, i) => ok[i])
    const allowed = allowedTimes.length
    const blocked = n - allowed
    const busiest = busiestMinute(allowedTimes)
    const steps: Trace['steps'] = [
      {
        text: `A client app calls the API ${n} time${n > 1 ? 's' : ''} with its API key. The plan allows ${LIMIT} requests per ${WINDOW} seconds.`,
        nodes: ['Client app'],
        data: `${n} × GET /v1/orders\nAuthorization: Bearer ${KEY}\nrequest times: ${times.length > 12 ? `${times.slice(0, 6).join(', ')}, … ${times[n - 1]}` : times.join(', ')} (seconds)`,
      },
      {
        text: 'The API Gateway checks the key, works out who the caller is, and asks the Rate Limiter before doing any real work. Rejecting early is cheap; running the request is not.',
        nodes: ['API Gateway', 'Rate Limiter'],
        data: `identity: api_key=${KEY}, plan=free\nlimiter.check("${KEY}", route="GET /v1/orders")`,
      },
      {
        text: `The Rate Limiter looks up the rule for this plan. Rules change rarely, so each gateway caches them from the Rules Store.`,
        nodes: ['Rate Limiter', 'Rules Store'],
        data: json({ plan: 'free', algorithm: algo, limit: LIMIT, window_seconds: WINDOW, burst: algo === 'Token bucket' ? LIMIT : null }),
      },
    ]

    if (!down) {
      steps.push({
        text:
          algorithm === ALGORITHMS[0]
            ? `Redis runs a small Lua script, so read, refill and take-a-token happen as one atomic step (no two gateways can both take the last token). The bucket holds up to ${LIMIT} tokens and refills ${REFILL.toFixed(3)} per second.`
            : algorithm === ALGORITHMS[1]
              ? `Redis does INCR on a counter named after the key and the current minute. The first INCR in a minute sets a 120 s expiry, so old counters clean themselves up.`
              : `Redis reads the counters for this minute and the last one, and weights the last by how much of it still overlaps the sliding minute. This smooths the edge a fixed window has.`,
        nodes: ['Redis Primary (counters)'],
        data: state,
      })
    } else {
      steps.push({
        text: 'The Rate Limiter calls Redis and the call times out after 20 ms. Now the system has to choose what a limiter does when it can\'t count.',
        nodes: ['Redis Primary (counters)', 'Rate Limiter'],
        data: `EVALSHA rl_take …\n→ error: connection timed out after 20 ms\ncircuit breaker: OPEN for 5 s`,
      })
    }

    if (redis === REDIS[1]) {
      steps.push({
        text: `Fail open: with no counter, every request is let through. Users never notice the outage, but for these ${n} requests there is no limit at all. Fine for a read API, risky for a login or SMS endpoint.`,
        nodes: ['Allowed?', 'App Servers'],
        data: `decision: ALLOW ×${n} (limiter unavailable)\nlet through: ${allowed} of ${n}; busiest minute: ${busiest} requests vs a limit of ${LIMIT}`,
      })
    } else if (redis === REDIS[2]) {
      steps.push({
        text: `Fail closed: with no counter, every request is refused. The limit is never exceeded, but a Redis outage becomes a full API outage. Use it only for abuse-prone endpoints.`,
        nodes: ['Allowed?', 'Reject with 429 and Retry-After'],
        data: `decision: DENY ×${n} (limiter unavailable)\nresponse: 503 Service Unavailable, Retry-After: 5`,
      })
    } else if (redis === REDIS[3]) {
      steps.push({
        text: `Local fallback: each of the ${GATEWAYS} gateways uses its own small token bucket, a ${GATEWAYS}th of the limit (${LIMIT / GATEWAYS} tokens). No coordination, so it is rough, but abuse stays bounded while Redis recovers.`,
        nodes: ['Local Fallback Limiter', 'Allowed?'],
        data: `gateway bucket: capacity ${LIMIT / GATEWAYS}, refill ${(REFILL / GATEWAYS).toFixed(4)}/s each\nrequests spread round-robin over ${GATEWAYS} gateways\n${timeline(times, ok)}`,
      })
    } else {
      steps.push({
        text: `The script returns allow or deny for each request. With ${algorithm.toLowerCase()}, ${allowed} of the ${n} requests pass and ${blocked} are refused.`,
        nodes: ['Allowed?'],
        data: timeline(times, ok),
      })
    }

    if (allowed > 0) {
      steps.push({
        text: `Allowed requests go on to the App Servers. The response carries headers so well-behaved clients can slow down before they are refused.`,
        nodes: ['Allowed?', 'App Servers'],
        data: `HTTP/1.1 200 OK\nX-RateLimit-Limit: ${LIMIT}\nX-RateLimit-Remaining: ${Math.max(0, LIMIT - allowed)}\nX-RateLimit-Reset: ${WINDOW - (times[n - 1] % WINDOW)}`,
      })
    }
    if (blocked > 0 && redis !== REDIS[2]) {
      steps.push({
        text: `Refused requests get HTTP 429 Too Many Requests and a Retry-After header, the number of seconds until the same request would pass.${down ? '' : ' The App Servers never see them.'}`,
        nodes: ['Allowed?', 'Reject with 429 and Retry-After'],
        data: `HTTP/1.1 429 Too Many Requests\nRetry-After: ${retryAfter || Math.ceil(1 / (REFILL / GATEWAYS))}\n${json({ error: 'rate_limited', limit: LIMIT, window_seconds: WINDOW })}`,
      })
    }
    steps.push({
      text:
        busiest > LIMIT
          ? `Look at the busiest 60 seconds: ${busiest} requests got through against a limit of ${LIMIT}. ${down ? 'That is the cost of the failure mode you chose.' : algorithm === ALGORITHMS[0] ? 'A token bucket allows a full bucket (a burst of 10) plus whatever refilled during the minute. That is the trade for allowing bursts.' : 'That is the boundary problem: the counter reset in the middle of the burst, so the client got two windows\' worth in seconds.'}`
          : `Look at the busiest 60 seconds: ${busiest} requests got through, never more than the limit of ${LIMIT}. Rejections are counted for dashboards and alerts.`,
      nodes: ['Metrics & Alerts'],
      data: `rate_limit_allowed_total{plan="free"} ${allowed}\nrate_limit_blocked_total{plan="free"} ${blocked}\nbusiest_60s=${busiest} limit=${LIMIT}`,
    })

    return { input: `${down ? redis : algorithm}, ${traffic.toLowerCase()}`, steps }
  },
}

export const rateLimiter: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'rate-limiter',
  title: 'Rate Limiter',
  blurb: 'Token bucket, fixed and sliding windows, and what to do when the counter store is down',
  guides: ['scale-rate-limiting', 'scale-scaling-api-with-rate-limiters-at-stripe', 'scale-rate-limiting-for-scaling-to-millions-of-domains-at-cloudflare', 'api-gateway-101', 'primer-cache'],
  takeaways: [
    'A rate limiter protects the service from abuse and from one noisy client; reject early, at the gateway.',
    'Token bucket allows short bursts up to its capacity but holds the long-run average to the refill rate.',
    'Fixed windows are simple but can let through twice the limit around a window edge.',
    'A sliding window counter smooths that edge with two counters and a weighted sum.',
    'Counting must be atomic across gateways: use one Lua script or INCR in Redis, never read-then-write.',
    'Decide in advance whether the limiter fails open or closed, and return 429 with Retry-After.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'edge', label: 'Edge' },
      { id: 'redis', label: 'Redis cluster' },
    ],
    nodes: [
      { id: 'client', label: 'Client app', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'limiter', label: 'Rate Limiter', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'rules', label: 'Rules Store', shape: 'rectangle', color: 'green', group: null },
      { id: 'primary', label: 'Redis Primary (counters)', shape: 'rectangle', color: 'red', group: 'redis' },
      { id: 'replica', label: 'Redis Replica', shape: 'rectangle', color: 'red', group: 'redis' },
      { id: 'fallback', label: 'Local Fallback Limiter', shape: 'rectangle', color: 'orange', group: 'edge' },
      { id: 'decision', label: 'Allowed?', shape: 'diamond', color: 'violet', group: null },
      { id: 'app', label: 'App Servers', shape: 'rectangle', color: 'violet', group: null },
      { id: 'reject', label: 'Reject with 429 and Retry-After', shape: 'rectangle', color: 'orange', group: null },
      { id: 'metrics', label: 'Metrics & Alerts', shape: 'rectangle', color: 'yellow', group: null },
    ],
    edges: [
      { from: 'client', to: 'gateway', label: 'API request', dashed: false },
      { from: 'gateway', to: 'limiter', label: 'check(key)', dashed: false },
      { from: 'limiter', to: 'rules', label: 'load rule', dashed: true },
      { from: 'limiter', to: 'primary', label: 'atomic Lua script', dashed: false },
      { from: 'primary', to: 'replica', label: 'replicate', dashed: true },
      { from: 'limiter', to: 'fallback', label: 'Redis timeout', dashed: true },
      { from: 'primary', to: 'decision', label: 'allow / deny', dashed: false },
      { from: 'fallback', to: 'decision', label: 'allow / deny', dashed: true },
      { from: 'decision', to: 'app', label: 'allowed', dashed: false },
      { from: 'decision', to: 'reject', label: 'denied', dashed: false },
      { from: 'reject', to: 'client', label: '429', dashed: true },
      { from: 'limiter', to: 'metrics', label: 'counts', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'plans',
        name: 'plans',
        columns: [
          { name: 'plan_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: [],
      },
      {
        id: 'rate_limit_rules',
        name: 'rate_limit_rules',
        columns: [
          { name: 'rule_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'plan_id', type: 'text', pk: false, fk: 'plans.plan_id', nullable: false, unique: false },
          { name: 'route_pattern', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'algorithm', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'limit_count', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'window_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'fail_mode', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(plan_id, route_pattern)'],
      },
      {
        id: 'api_keys',
        name: 'api_keys',
        columns: [
          { name: 'key_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'plan_id', type: 'text', pk: false, fk: 'plans.plan_id', nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(plan_id)'],
      },
    ],
    relations: [
      { from: 'rate_limit_rules', to: 'plans', kind: 'one-to-many', label: 'applies to' },
      { from: 'api_keys', to: 'plans', kind: 'one-to-many', label: 'is on' },
    ],
  },
  explanation: {
    title: 'Rate Limiter',
    summary:
      'A rate limiter caps how many requests a caller can make in a period. It protects services from abuse and overload, keeps one noisy client from starving the rest, and enforces paid plans. The hard parts are choosing the counting algorithm, counting correctly across many servers, and deciding what happens when the counter store is down.',
    sections: [
      {
        heading: 'Overview',
        body: 'Without a limit, one buggy script in a retry loop can use all of an API\'s capacity. A rate limiter sits at the gateway, in front of the app, and answers one question per request: allow or deny. Denied requests get HTTP 429 (Too Many Requests) and a Retry-After header, so a well-behaved client knows when to try again.\n\nThe limit is per identity: an API key, a user id or an IP address, sometimes per route as well.',
      },
      {
        heading: 'Requirements',
        body: '- Limit by key and route, with different limits per plan.\n- Add very little latency: a few milliseconds at most.\n- Work across many gateway servers with one shared count.\n- Be accurate enough: a limit of 10 should not become 20.\n- Survive failures of its own storage, with a clear policy.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 200,000 API requests per second at peak, 10 million active API keys.\n- Every request needs one counter check, so 200,000 Redis operations per second. One Redis node handles roughly 60,000 to 100,000 scripted operations per second, so plan at least 4 shards (200,000 / 60,000 = 3.3, rounded up).\n- Token bucket state is about 120 bytes per key (key name, two fields, overhead): 10,000,000 × 120 B = 1.2 GB. Fixed window counters need about 70 B per key, 0.7 GB.\n- A sliding window log stores every timestamp: 100 requests × 16 B × 10 million keys = 16 GB. This is why most systems use the counter versions.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client app sends a request with its API key.\n2. The API Gateway authenticates it and asks the Rate Limiter for a decision.\n3. The Rate Limiter loads the rule for the caller\'s plan from the Rules Store (cached locally).\n4. It runs an atomic script on Redis Primary (counters), which updates the count and returns allow or deny.\n5. The decision is Allowed?: if yes, the request goes on to the App Servers.\n6. If no, the caller gets Reject with 429 and Retry-After and the app never sees the request.\n7. If Redis doesn\'t answer, the Local Fallback Limiter (or a fail-open or fail-closed rule) decides.\n8. Allowed and denied counts flow to Metrics & Alerts.',
      },
      {
        heading: 'Components',
        body: '- Client app: the caller, identified by an API key.\n- API Gateway: authenticates the request and is the single place limits are enforced.\n- Rate Limiter: library or middleware in the gateway that picks the rule and talks to Redis.\n- Rules Store: the database of limits per plan and route; read rarely and cached.\n- Redis Primary (counters): holds the counters; one Lua script makes read-and-update atomic.\n- Redis Replica: a copy that takes over if the primary fails; it may lag a little, so a few requests can slip through.\n- Local Fallback Limiter: a rough in-memory bucket on each gateway, used when Redis is unreachable.\n- Allowed?: the decision at the end of the check.\n- App Servers: the real API; they only see requests that passed.\n- Reject with 429 and Retry-After: the refusal, with the time to wait.\n- Metrics & Alerts: allowed and denied counts per plan, so spikes and abuse show up.',
      },
      {
        heading: 'Key decisions',
        body: '- Token bucket: a bucket of N tokens refilling at a steady rate; each request takes one. Allows bursts up to N, then the average rate. Simple state (tokens, timestamp). Used by Stripe and many cloud APIs.\n- Fixed window counter: one counter per minute. Cheapest, but a client can send 10 at the end of one minute and 10 at the start of the next: 20 requests in seconds.\n- Sliding window counter: previous window × share still overlapping + current window. Two counters, close to exact, no edge spike.\n- Sliding window log: exact, stores every timestamp, so memory grows with the limit.\n- Where to count: in each gateway\'s memory is fast but each node sees only part of the traffic; a shared Redis is accurate for one extra network hop.\n- Race conditions: GET then SET lets two gateways both pass the last token. Use INCR or one Lua script.\n- Fail open or closed: open keeps the API up but unprotected; closed protects but turns a Redis outage into an API outage. A local fallback is a middle path.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Shard Redis by the limiter key (consistent hashing), so one key\'s state lives on one node.\n- A hot key (one huge customer) can overload a shard; give it its own shard or count in batches in memory and sync every few milliseconds.\n- Use the Redis server clock inside the script, not the gateways\' clocks, since gateway clocks drift.\n- Replicas lag, so after a failover the counts can be a little low; accept the small slack.\n- Add a short timeout (about 20 ms) and a circuit breaker so a slow Redis doesn\'t slow every request.\n- Return X-RateLimit-Limit, X-RateLimit-Remaining and Retry-After so clients can back off.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why can a fixed window let through twice the limit?\n- How do you make the check atomic across ten gateways?\n- Your Redis shard is down. Do you fail open or closed, and does it depend on the endpoint?\n- How would you limit by IP and by user at the same time?\n- How do you give one enterprise customer a much higher limit without a code change?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Token bucket as one atomic Redis script',
        language: 'typescript',
        source: `import Redis from 'ioredis'
const redis = new Redis()

// Runs inside Redis, so read, refill and take happen as one step.
const script = \`
local cap, rate = tonumber(ARGV[1]), tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1])  -- Redis clock, not the gateway's
local s = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = math.min(cap, (tonumber(s[1]) or cap) + (now - (tonumber(s[2]) or now)) * rate)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], 120)
return allowed and 1 or 0
\`

export async function allow(apiKey: string, capacity = 10, perSecond = 10 / 60) {
  return (await redis.eval(script, 1, \`rl:tb:\${apiKey}\`, capacity, perSecond)) === 1
}`,
      },
      {
        title: 'Fixed window counter with INCR',
        language: 'python',
        source: `import time, redis
r = redis.Redis()

def allow(api_key: str, limit: int = 10, window: int = 60) -> bool:
    bucket = int(time.time()) // window          # which minute are we in?
    key = f"rl:fw:{api_key}:{bucket}"
    count = r.incr(key)                            # atomic, so no race
    if count == 1:
        r.expire(key, window * 2)                  # old counters clean themselves up
    return count <= limit`,
      },
      {
        title: 'Sliding window counter estimate',
        language: 'python',
        source: `def estimate(prev_count: int, cur_count: int, seconds_into_window: float, window: int = 60) -> float:
    # The share of the previous window that still overlaps the last 60 seconds.
    overlap = 1 - seconds_into_window / window
    return prev_count * overlap + cur_count

# 10 requests at t=55, a new request at t=65 (5 s into the next window):
# estimate(10, 0, 5) = 10 * 0.9167 = 9.17, so one more would make 10.17 > 10: denied.`,
      },
      {
        title: 'Rules table lookup',
        language: 'sql',
        source: `-- Limits live in data, so changing a plan needs no deploy.
SELECT r.algorithm, r.limit_count, r.window_seconds, r.fail_mode
FROM api_keys k
JOIN rate_limit_rules r ON r.plan_id = k.plan_id
WHERE k.key_id = 'key_live_8f3a'
  AND 'GET /v1/orders' LIKE r.route_pattern
ORDER BY length(r.route_pattern) DESC   -- most specific rule wins
LIMIT 1;`,
      },
    ],
    related: ['Token bucket', 'Sliding window', 'API gateway', 'Redis Lua scripts', 'Circuit breaker', 'Backpressure'],
  },
  simulator,
}
