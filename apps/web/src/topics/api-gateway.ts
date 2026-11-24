import type { Trace } from '@structura/shared'
import { base64url, defaultTrace, json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator walks one request through the gateway's checks in order: the token,
// the rate limit, the route, the cache and the circuit breaker. Every status code,
// latency and header it shows is worked out from the three inputs.

const NOW = 1795001800 // "now" in the example, in Unix seconds
const LIMIT = 100 // requests per minute for this consumer
const USED = 37 // already used this minute, before this request
const TIMEOUT_MS = 800 // the gateway gives up on an upstream after this long
const RETRY_PAUSE_MS = 50
const TRIP_AT = 5 // failures in a row that open the circuit
const OPEN_SECONDS = 20
const AUTH_MS = 1
const LIMIT_MS = 2

const REQUESTS = ['GET /v1/products/7', 'GET /v1/orders/42', 'POST /v1/orders']
const TOKENS = ['Valid token', 'Expired token', 'No token']
const HEALTH = ['Healthy', 'Slow (timeouts)', 'Down (connection refused)']
const CIRCUITS = ['Closed (0 failures)', 'Closed (4 failures in a row)', 'Open (12 s left)', 'Half-open (one probe allowed)']

const ROUTES = [
  { prefix: '/v1/orders', service: 'Orders Service', upstream: 'orders.internal:8080', okMs: 38 },
  { prefix: '/v1/products', service: 'Catalog Service', upstream: 'catalog.internal:8080', okMs: 22 },
]

const token = (exp: number) => {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k-2026-11' }))
  const payload = base64url(JSON.stringify({ sub: 'user_8412', scope: 'orders:read orders:write', iat: exp - 3600, exp }))
  return `${header}.${payload}.Zk3q…`
}

const simulator: Simulator = {
  fields: [
    { id: 'request', label: 'Request', options: REQUESTS },
    { id: 'token', label: 'Token', options: TOKENS },
    { id: 'health', label: 'Upstream service', options: HEALTH },
    { id: 'circuit', label: 'Circuit breaker', options: CIRCUITS },
  ],
  defaults: { request: REQUESTS[1], token: TOKENS[0], health: HEALTH[0], circuit: CIRCUITS[0] },
  run({ request, token: tokenChoice, health, circuit }) {
    const req = REQUESTS.includes(request) ? request : REQUESTS[1]
    const [method, path] = req.split(' ')
    const route = ROUTES.find((r) => path.startsWith(r.prefix))!
    const isGet = method === 'GET'
    const cacheable = path.startsWith('/v1/products')
    const bearer = tokenChoice === TOKENS[2] ? null : token(tokenChoice === TOKENS[1] ? NOW - 600 : NOW + 1800)
    const header = bearer ? `Authorization: Bearer ${bearer}` : '(no Authorization header)'
    const input = `${req}, ${tokenChoice.toLowerCase()}, upstream ${health.toLowerCase()}, circuit ${circuit.toLowerCase()}`

    const steps: Trace['steps'] = [
      {
        text: `A mobile app calls the public API. It sends one request to one address, and it has no idea how many services sit behind it.`,
        nodes: ['Mobile App', 'API Gateway'],
        data: `${req} HTTP/1.1\nHost: api.shop.example.com\n${header}`,
      },
    ]

    // 1. Authentication: the cheapest check goes first, so bad callers cost almost nothing.
    if (!bearer || tokenChoice === TOKENS[1]) {
      const expired = Boolean(bearer)
      steps.push({
        text: expired
          ? `The gateway reads the token's exp claim: ${NOW - 600} is ${600} seconds in the past. The token has expired, so the gateway stops here. No service is called and no rate-limit count is used.`
          : 'There is no token, so the gateway refuses the request at once. Services behind it never see anonymous traffic on a protected route.',
        nodes: ['API Gateway', 'Token Check'],
        data: expired ? `exp=${NOW - 600}  now=${NOW}  → expired by ${600} s\nsignature: valid (the key was right, the clock was not)` : 'route requires auth: true\nAuthorization header: missing',
      })
      steps.push({
        text: 'The caller gets 401 Unauthorized with a WWW-Authenticate header. For an expired token the app can use its refresh token to get a new one, then try again.',
        nodes: ['Token Check', 'Mobile App'],
        data: `HTTP/1.1 401 Unauthorized\nWWW-Authenticate: Bearer error="${expired ? 'invalid_token", error_description="token expired' : 'invalid_request'}"\nlatency: ${AUTH_MS} ms (no upstream called)`,
      })
      steps.push({
        text: 'Even a rejected request is logged. A spike in 401s is often the first sign of a bug in a client or of someone guessing tokens.',
        nodes: ['API Gateway', 'Metrics & Logs'],
        data: `gateway_requests_total{route="${route.prefix}",status="401"} +1\nupstream: none`,
      })
      return { input, steps }
    }

    steps.push({
      text: 'The Token Check verifies the JWT signature with the identity provider\'s public key, which the gateway keeps in memory. It also checks that the token has not expired and has the right scope. No network call is needed, so it takes about a millisecond.',
      nodes: ['API Gateway', 'Token Check'],
      data: `kid=k-2026-11 → public key (cached)\nexp=${NOW + 1800}  now=${NOW}  → ${1800} s left\n${cacheable ? 'scope: none needed to read the catalog' : `scope "orders:read orders:write" covers ${method} ${route.prefix}`}\nidentity: user_8412`,
    })

    // 2. Rate limit.
    const remaining = LIMIT - USED - 1
    steps.push({
      text: `The Rate Limiter counts this request against user_8412's plan: ${LIMIT} requests a minute. ${USED} are used, so this one is allowed and ${remaining} are left. (The Rate Limiter topic shows how the counting works.)`,
      nodes: ['API Gateway', 'Rate Limiter'],
      data: `limiter.check("user_8412")  → allow\nX-RateLimit-Limit: ${LIMIT}\nX-RateLimit-Remaining: ${remaining}`,
    })

    // 3. Routing: the longest matching prefix wins.
    steps.push({
      text: `The gateway looks up the path in its Route Table. The longest matching prefix wins, so ${path} goes to ${route.service}. The table is in memory, so changing a route needs no redeploy.`,
      nodes: ['API Gateway', 'Route Table', route.service],
      data: json({ match: `${route.prefix}/*`, methods: [method], upstream: route.upstream, timeout_ms: TIMEOUT_MS, retries: isGet ? 1 : 0, cache_ttl_s: cacheable ? 60 : 0 }),
    })

    // 4. Cache: an entry past its TTL is "stale", and may still help later.
    const cacheAge = 75
    if (cacheable) {
      steps.push({
        text: `A GET on a product can be cached. The Response Cache has this product, but it is ${cacheAge} seconds old and the time to live is 60, so it is stale. The gateway must ask ${route.service} whether it changed. If that fails, the stale copy can still be used (up to 300 seconds, the stale-if-error window).`,
        nodes: ['API Gateway', 'Response Cache'],
        data: `key: GET /v1/products/7\nage: ${cacheAge} s   ttl: 60 s   stale-if-error: 300 s\nETag: "p7-v12"  → revalidate`,
      })
    } else {
      steps.push({
        text: `${isGet ? 'This response is private to the user' : 'POST requests change data'}, so the gateway does not cache it. The request goes straight to the circuit breaker.`,
        nodes: ['API Gateway', 'Response Cache'],
        data: `cache: skip (${isGet ? 'private data, Cache-Control: no-store' : 'not a safe method'})`,
      })
    }

    // 5. Circuit breaker + upstream call.
    const open = circuit === CIRCUITS[2]
    const half = circuit === CIRCUITS[3]
    const failing = health !== HEALTH[0]
    const failMs = health === HEALTH[1] ? TIMEOUT_MS : 3
    const failStatus = health === HEALTH[1] ? 504 : 502
    const failName = health === HEALTH[1] ? 'Gateway Timeout' : 'Bad Gateway'
    const priorFailures = circuit === CIRCUITS[1] ? 4 : 0
    let latency = AUTH_MS + LIMIT_MS
    let status = 200
    let outcome = ''
    let finalCircuit = open ? 'OPEN' : 'CLOSED'
    let fallback = false
    let retryAfter = 0

    if (open) {
      retryAfter = 12
      steps.push({
        text: `The Circuit Breaker is open: ${route.service} failed ${TRIP_AT} times in a row a short while ago. The gateway does not even try. It fails in under a millisecond, which keeps threads free and gives the service room to recover.${failing ? '' : ' Note that the service is healthy again, but the breaker only lets one probe through after its timer ends.'}`,
        nodes: ['API Gateway', 'Circuit Breaker'],
        data: `state: OPEN  (opened after ${TRIP_AT} failures in a row, stays open ${OPEN_SECONDS} s)\ntime left: 12 s\nupstream call: skipped`,
      })
      fallback = true
      status = 503
      outcome = 'short-circuited'
    } else if (half) {
      steps.push({
        text: `The open timer has ended, so the Circuit Breaker is half-open. It lets exactly one request through as a probe and sends the rest to the fallback. No retries on a probe.`,
        nodes: ['API Gateway', 'Circuit Breaker', route.service],
        data: `state: HALF_OPEN\nprobe → ${route.upstream}`,
      })
      if (!failing) {
        latency += route.okMs
        finalCircuit = 'CLOSED'
        outcome = 'probe succeeded: circuit closes'
      } else {
        latency += failMs
        finalCircuit = 'OPEN again for ' + OPEN_SECONDS + ' s'
        fallback = true
        status = failStatus
        outcome = 'probe failed: circuit opens again'
      }
    } else {
      steps.push({
        text: `The Circuit Breaker is closed, so the call goes ahead. It counts failures in a row: ${priorFailures} so far, and it opens at ${TRIP_AT}. A success resets the count to zero.`,
        nodes: ['API Gateway', 'Circuit Breaker', route.service],
        data: `state: CLOSED   failures in a row: ${priorFailures}/${TRIP_AT}\ntimeout: ${TIMEOUT_MS} ms   retries: ${isGet ? '1 (GET is safe to repeat)' : '0 (POST might create a second order)'}`,
      })
      if (!failing) {
        latency += route.okMs
        outcome = 'ok'
      } else {
        // Each failed attempt counts. If it reaches the limit, the breaker opens and blocks the retry.
        let failures = priorFailures + 1
        let attempts = 1
        latency += failMs
        const tripped = failures >= TRIP_AT
        if (isGet && !tripped) {
          latency += RETRY_PAUSE_MS + failMs
          failures++
          attempts++
        }
        if (failures >= TRIP_AT) finalCircuit = `OPEN for ${OPEN_SECONDS} s`
        else finalCircuit = `CLOSED (${failures}/${TRIP_AT} failures)`
        fallback = true
        status = failStatus
        outcome = `${attempts} failed attempt${attempts > 1 ? 's' : ''} (${failures} in a row)${tripped ? `: failure number ${TRIP_AT} opened the circuit, so no retry` : ''}`
      }
    }

    if (!fallback) {
      const revalidated = cacheable
      steps.push({
        text: `${route.service} answers in ${route.okMs} ms. ${revalidated ? 'It says the product has not changed (304 Not Modified), so the gateway refreshes the cache entry and sends the cached body. The Response Cache now holds it for another 60 seconds.' : isGet ? 'The gateway passes the answer back to the app.' : 'The order is created and the gateway passes the answer back. It was sent once, never retried.'}`,
        nodes: [route.service, 'Response Cache', 'Mobile App'].filter((n) => revalidated || n !== 'Response Cache'),
        data: `${revalidated ? 'HTTP/1.1 304 Not Modified (to the gateway)\n→ 200 OK to the app, X-Cache: REVALIDATED' : method === 'POST' ? 'HTTP/1.1 201 Created\nLocation: /v1/orders/43' : 'HTTP/1.1 200 OK'}\nX-RateLimit-Remaining: ${remaining}\nlatency: ${LIMIT_MS + AUTH_MS} ms in the gateway + ${route.okMs} ms upstream = ${latency} ms${half ? '\ncircuit: CLOSED again (probe worked)' : failing ? '' : '\nfailures in a row: reset to 0'}`,
      })
    } else {
      if (!open) {
        steps.push({
          text: `${health === HEALTH[1] ? `${route.service} does not answer within ${TIMEOUT_MS} ms, so the gateway gives up. Waiting longer would only tie up more connections.` : `${route.service} refuses the connection straight away (about 3 ms). Nothing is listening.`}${!half && isGet && outcome.indexOf('no retry') < 0 ? ` GET is safe to repeat, so it tries once more after ${RETRY_PAUSE_MS} ms.` : ''}`,
          nodes: [route.service, 'Circuit Breaker'],
          data: `attempt → ${health === HEALTH[1] ? `no response after ${TIMEOUT_MS} ms (timeout)` : 'connect: connection refused'}\n${outcome}\ncircuit now: ${finalCircuit}`,
        })
      }
      const stale = cacheable && isGet
      if (stale) {
        steps.push({
          text: `The Fallback Response uses the stale cache entry, ${cacheAge} seconds old and inside the 300-second stale-if-error window. The shopper sees the product page as it was a minute ago, which is far better than an error.`,
          nodes: ['Response Cache', 'Fallback Response', 'Mobile App'],
          data: `HTTP/1.1 200 OK\nX-Cache: STALE\nWarning: 110 - "Response is stale"\nAge: ${cacheAge}\nlatency: ${latency} ms`,
        })
        status = 200
      } else {
        steps.push({
          text: `There is nothing safe to show, so the Fallback Response returns a clear error. ${open ? '503 with Retry-After tells the app how long to wait.' : `${failStatus} ${failName} says the problem is behind the gateway, not in the request.`} It is a JSON body with a request id so support can find the log line.`,
          nodes: ['Circuit Breaker', 'Fallback Response', 'Mobile App'],
          data: `HTTP/1.1 ${status} ${open ? 'Service Unavailable' : failName}${open ? `\nRetry-After: ${retryAfter}` : ''}\n${json({ error: open ? 'circuit_open' : health === HEALTH[1] ? 'upstream_timeout' : 'upstream_unreachable', request_id: 'req_7c1e90', retryable: isGet })}\nlatency: ${latency} ms`,
        })
      }
    }

    steps.push({
      text: `The gateway writes one log line and updates its metrics, with the route, status, latency and breaker state. These numbers are how you find out a service is failing, usually before a user reports it.`,
      nodes: ['API Gateway', 'Metrics & Logs'],
      data: `route=${route.prefix} method=${method} status=${status} latency_ms=${latency}\nupstream=${route.service} outcome="${outcome}"\ncircuit=${finalCircuit}`,
    })

    return { input, steps }
  },
}

export const apiGateway: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'api-gateway',
  title: 'API Gateway',
  blurb: 'One front door for many services: tokens, rate limits, routing, caching and circuit breakers',
  guides: ['api-gateway-101', 'what-does-api-gateway-do', 'top-3-api-gateway-use-cases', 'reverse-proxy-vs-api-gateway-vs-load-balancer', 'scale-circuit-breaker', 'scale-architecture-of-api-gateway-at-uber'],
  takeaways: [
    'An API gateway is the single entry point for clients, so each service does not rebuild login, limits and logging.',
    'Put cheap checks first: a bad token is refused in about a millisecond, before any service is called.',
    'Route by the longest matching path prefix, and keep the route table as data so changes need no deploy.',
    'A circuit breaker stops calls to a failing service, so slow failures do not use up every connection.',
    'Retry only safe requests such as GET. A retried POST can create a second order.',
    'Keep the gateway thin and run several copies: it is on every request path, so it must not hold business logic or state.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'edge', label: 'API gateway (several copies)' },
      { id: 'services', label: 'Private network' },
    ],
    nodes: [
      { id: 'app', label: 'Mobile App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'token', label: 'Token Check', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'limiter', label: 'Rate Limiter', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'routes', label: 'Route Table', shape: 'rectangle', color: 'green', group: 'edge' },
      { id: 'cache', label: 'Response Cache', shape: 'rectangle', color: 'red', group: 'edge' },
      { id: 'breaker', label: 'Circuit Breaker', shape: 'rectangle', color: 'orange', group: 'edge' },
      { id: 'orders', label: 'Orders Service', shape: 'rectangle', color: 'violet', group: 'services' },
      { id: 'catalog', label: 'Catalog Service', shape: 'rectangle', color: 'violet', group: 'services' },
      { id: 'fallback', label: 'Fallback Response', shape: 'rectangle', color: 'orange', group: 'edge' },
      { id: 'metrics', label: 'Metrics & Logs', shape: 'rectangle', color: 'yellow', group: null },
    ],
    edges: [
      { from: 'app', to: 'gateway', label: 'HTTPS request', dashed: false },
      { from: 'gateway', to: 'token', label: 'verify JWT', dashed: false },
      { from: 'token', to: 'app', label: '401', dashed: true },
      { from: 'gateway', to: 'limiter', label: 'check key', dashed: false },
      { from: 'gateway', to: 'routes', label: 'match path', dashed: false },
      { from: 'gateway', to: 'cache', label: 'GET lookup', dashed: true },
      { from: 'gateway', to: 'breaker', label: 'call upstream', dashed: false },
      { from: 'breaker', to: 'orders', label: 'HTTP', dashed: false },
      { from: 'breaker', to: 'catalog', label: 'HTTP', dashed: false },
      { from: 'catalog', to: 'cache', label: 'fresh copy', dashed: true },
      { from: 'breaker', to: 'fallback', label: 'open or failed', dashed: true },
      { from: 'cache', to: 'fallback', label: 'stale copy', dashed: true },
      { from: 'orders', to: 'app', label: 'response', dashed: false },
      { from: 'fallback', to: 'app', label: '200 stale / 502 / 503 / 504', dashed: true },
      { from: 'gateway', to: 'metrics', label: 'log + metrics', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'services',
        name: 'services',
        columns: [
          { name: 'service_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'upstream', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'timeout_ms', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'max_retries', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'trip_after_failures', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'open_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'routes',
        name: 'routes',
        columns: [
          { name: 'route_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'path_prefix', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'method', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'service_id', type: 'text', pk: false, fk: 'services.service_id', nullable: false, unique: false },
          { name: 'auth_required', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'required_scope', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'cache_ttl_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'stale_if_error_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(path_prefix, method)'],
      },
      {
        id: 'signing_keys',
        name: 'signing_keys',
        columns: [
          { name: 'kid', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'public_key_pem', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'expires_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [{ from: 'routes', to: 'services', kind: 'one-to-many', label: 'sends to' }],
  },
  explanation: {
    title: 'API Gateway',
    summary:
      'An API gateway is the one front door for all the services behind it. It checks who is calling, limits how often, picks the right service, can cache answers, and stops calling a service that is failing. Services then focus on business logic. The hard parts are keeping the gateway fast and thin, and deciding what to do when a service behind it breaks.',
    sections: [
      {
        heading: 'Overview',
        body: 'A shop has an Orders Service and a Catalog Service. Without a gateway, the mobile app must know both addresses, and each service must check tokens, count requests and write logs. Every team builds the same code, and each does it a little differently.\n\nAn API gateway sits in front. The app calls one address, api.shop.example.com. The gateway does the shared work, then forwards the request. It is a reverse proxy that also understands your API.\n\nA load balancer spreads traffic over copies of one service. A gateway chooses between different services and adds policy: login, limits and caching. Real systems often have both: a load balancer in front of several gateway copies.',
      },
      {
        heading: 'Requirements',
        body: '- One public address for many services.\n- Reject bad callers early: no token, an expired token or too many requests.\n- Route by path and method, and change routes without a deploy.\n- Add only a few milliseconds to each request.\n- Stay up when one service is slow or down.\n- Log every request with a status and a latency.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 30k requests per second at peak, and one gateway copy handles about 8k per second.\n- Copies needed: 30k / 8k = 3.75, so 4. Add one spare, so 5 copies, and the system still works if one fails.\n- Log volume at 300 bytes a line: 30k × 86,400 s × 300 B = 777.6 GB a day. This is why logs are sampled or sent to a log pipeline, not kept in the gateway.\n- Why the circuit breaker matters (Little\'s law, connections open = rate × time each waits): suppose 10k requests per second go to the Orders Service and it hangs. With the 800 ms timeout, 10k × 0.8 = 8k connections wait at once. Without a timeout, the number grows until the gateway runs out of memory. With the breaker open, the count falls to almost zero.',
      },
      {
        heading: 'Step by step',
        body: '1. The Mobile App sends an HTTPS request to the API Gateway.\n2. The Token Check verifies the JWT signature, the expiry and the scope. A bad token gets 401 and the request stops.\n3. The Rate Limiter counts the request for this user. Too many gets 429.\n4. The Route Table matches the path to a service by the longest prefix.\n5. For a safe GET, the Response Cache may answer, or may hold a copy to use if the service fails.\n6. The Circuit Breaker lets the call through to the Orders Service or the Catalog Service when it is closed, and blocks it when it is open.\n7. If the service is slow, down or blocked, the Fallback Response returns a stale copy or a clear error.\n8. Every request ends with a log line and metrics in Metrics & Logs.',
      },
      {
        heading: 'Components',
        body: '- Mobile App: the client. It knows one address and sends a token with each request.\n- API Gateway: the front door. It runs each check in order and forwards the request.\n- Token Check: verifies the JWT with the identity provider\'s public key, kept in memory. It needs no network call.\n- Rate Limiter: counts requests per user or API key and refuses extra ones with 429.\n- Route Table: maps path and method to a service, with its timeout, retries and cache rules. It is data, not code.\n- Response Cache: keeps answers to safe GET requests. It also keeps stale copies for use when a service fails.\n- Circuit Breaker: counts failures per service. After 5 in a row it opens and blocks calls for 20 seconds, then lets one probe through.\n- Orders Service: private service for orders. It trusts the gateway for identity and does not check the token again.\n- Catalog Service: private service for products. Read-heavy, so its answers are cached.\n- Fallback Response: what the caller gets when the service cannot answer: a stale copy, or a clear error such as 503.\n- Metrics & Logs: a log line and counters for every request, so you can see error rates and latency per route.',
      },
      {
        heading: 'Key decisions',
        body: '- Where to check tokens: at the gateway, once. Services still check what the user may do with their own data. Use a signed token (JWT) so the gateway needs no database call.\n- Order of checks: cheapest first. Token, then rate limit, then route, then cache, then the upstream call.\n- Timeouts: always set one. A request with no timeout is a leak.\n- Retries: only for safe requests (GET), at most once or twice, with a pause. A retried POST needs an idempotency key or it can run twice.\n- Circuit breaker: closed (normal), open (blocked, fail fast), half-open (one probe). Tune the failure count and the open time per service.\n- Fallback: a stale cached copy for reads. A clear error for writes. Never pretend a write worked.\n- One gateway or one per client type: a "backend for frontend" gateway for mobile and one for web lets each shape responses, but it is more to run.\n- Keep it thin: no business rules in the gateway, or it becomes a bottleneck that every team must change.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The gateway keeps no state, so add copies behind a load balancer. Counters and cached data live in Redis or in each copy\'s memory.\n- The gateway is a single point of failure by design, so run at least three copies in different zones and deploy changes slowly.\n- Cache the identity provider\'s public keys with their kid. Refresh on a new kid, so a key rotation does not break logins.\n- Share the route table by loading it from a database or config service every few seconds. A bad route must be easy to roll back.\n- Add a request id header at the gateway and pass it to every service, so one request can be followed through all logs.\n- Limit request size and header size, to stop huge bodies from using memory.\n- Watch the 5xx rate and p99 latency per route. A breaker that opens is a signal to page someone, not just to protect the system.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why not let each service check tokens and limits itself?\n- What is the difference between a load balancer, a reverse proxy and an API gateway?\n- A service starts timing out. What does the gateway do in the first second, the first minute and after a deploy?\n- Which requests are safe to retry, and why not POST?\n- How do you roll out a new route, and roll it back, without downtime?\n- How would you handle a token revoked before it expires?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A circuit breaker in about 30 lines',
        language: 'javascript',
        source: `export class CircuitBreaker {
  constructor({ tripAfter = 5, openMs = 20_000 } = {}) {
    this.tripAfter = tripAfter
    this.openMs = openMs
    this.failures = 0 // failures in a row
    this.openedAt = 0
    this.probing = false
  }

  get state() {
    if (this.failures < this.tripAfter) return 'closed'
    return Date.now() - this.openedAt >= this.openMs ? 'half-open' : 'open'
  }

  async call(fn) {
    const state = this.state
    if (state === 'open') throw new Error('circuit open') // fail fast, no call
    if (state === 'half-open') {
      if (this.probing) throw new Error('circuit open') // only one probe at a time
      this.probing = true
    }
    try {
      const result = await fn()
      this.failures = 0 // any success closes the circuit
      return result
    } catch (err) {
      this.failures++
      if (this.failures >= this.tripAfter) this.openedAt = Date.now() // open (or open again)
      throw err
    } finally {
      this.probing = false
    }
  }
}`,
        versions: [
          {
            language: 'java',
            source: `public class CircuitBreaker {
  private final int tripAfter;
  private final long openMs;
  private int failures = 0; // failures in a row
  private long openedAt = 0;
  private boolean probing = false;

  public CircuitBreaker(int tripAfter, long openMs) {
    this.tripAfter = tripAfter;
    this.openMs = openMs;
  }

  private String state() {
    if (failures < tripAfter) return "closed";
    return System.currentTimeMillis() - openedAt >= openMs ? "half-open" : "open";
  }

  public synchronized <T> T call(java.util.concurrent.Callable<T> fn) throws Exception {
    String state = state();
    if (state.equals("open")) throw new IllegalStateException("circuit open"); // fail fast
    if (state.equals("half-open")) {
      if (probing) throw new IllegalStateException("circuit open"); // one probe at a time
      probing = true;
    }
    try {
      T result = fn.call();
      failures = 0; // any success closes the circuit
      return result;
    } catch (Exception e) {
      failures++;
      if (failures >= tripAfter) openedAt = System.currentTimeMillis();
      throw e;
    } finally {
      probing = false;
    }
  }
}`,
          },
          {
            language: 'python',
            source: `import time

class CircuitBreaker:
    def __init__(self, trip_after=5, open_seconds=20):
        self.trip_after = trip_after
        self.open_seconds = open_seconds
        self.failures = 0              # failures in a row
        self.opened_at = 0.0
        self.probing = False

    @property
    def state(self):
        if self.failures < self.trip_after:
            return "closed"
        return "half-open" if time.time() - self.opened_at >= self.open_seconds else "open"

    def call(self, fn):
        state = self.state
        if state == "open":
            raise RuntimeError("circuit open")      # fail fast, no call
        if state == "half-open":
            if self.probing:
                raise RuntimeError("circuit open")  # only one probe at a time
            self.probing = True
        try:
            result = fn()
            self.failures = 0                       # any success closes the circuit
            return result
        except Exception:
            self.failures += 1
            if self.failures >= self.trip_after:
                self.opened_at = time.time()        # open (or open again)
            raise
        finally:
            self.probing = False`,
          },
        ],
      },
      {
        title: 'Route lookup: the longest prefix wins',
        language: 'javascript',
        source: `const routes = [
  { prefix: '/v1/orders', service: 'orders.internal:8080' },
  { prefix: '/v1/orders/export', service: 'reports.internal:8080' },
  { prefix: '/v1/products', service: 'catalog.internal:8080' },
]

export function match(path) {
  return routes
    .filter((r) => path === r.prefix || path.startsWith(r.prefix + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0] // most specific rule first
}

// match('/v1/orders/42')       → orders.internal:8080
// match('/v1/orders/export/7') → reports.internal:8080 (longer prefix wins)
// match('/v1/orderstatus')     → undefined (not a path boundary: no false match)`,
        versions: [
          {
            language: 'python',
            source: `routes = [
    {"prefix": "/v1/orders", "service": "orders.internal:8080"},
    {"prefix": "/v1/orders/export", "service": "reports.internal:8080"},
    {"prefix": "/v1/products", "service": "catalog.internal:8080"},
]

def match(path):
    hits = [r for r in routes if path == r["prefix"] or path.startswith(r["prefix"] + "/")]
    return max(hits, key=lambda r: len(r["prefix"]), default=None)  # most specific rule first

# match("/v1/orders/42")       -> orders.internal:8080
# match("/v1/orders/export/7") -> reports.internal:8080 (longer prefix wins)
# match("/v1/orderstatus")     -> None (not a path boundary: no false match)`,
          },
        ],
      },
      {
        title: 'Verify a JWT at the gateway (no network call)',
        language: 'javascript',
        source: `import { createVerify } from 'node:crypto'

export function verify(token, publicKeyPem, now = Math.floor(Date.now() / 1000)) {
  const [header, payload, signature] = token.split('.')
  const ok = createVerify('RSA-SHA256')
    .update(header + '.' + payload)
    .verify(publicKeyPem, signature, 'base64url') // the key is cached in memory
  if (!ok) return { status: 401, error: 'bad signature' }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  if (claims.exp <= now) return { status: 401, error: 'token expired' }
  return { status: 200, user: claims.sub, scope: claims.scope.split(' ') }
}`,
      },
      {
        title: 'Route table lookup',
        language: 'sql',
        source: `-- Routes live in data, so a new route or a new timeout needs no deploy.
SELECT r.service_id, s.upstream, s.timeout_ms, s.max_retries,
       r.auth_required, r.required_scope, r.cache_ttl_seconds
FROM routes r
JOIN services s ON s.service_id = r.service_id
WHERE r.method = 'GET'
  AND '/v1/orders/42' LIKE r.path_prefix || '%'
ORDER BY length(r.path_prefix) DESC   -- longest prefix wins
LIMIT 1;`,
      },
    ],
    related: ['Reverse proxy', 'Load balancer', 'Rate limiter', 'Circuit breaker', 'JWT', 'Backend for frontend', 'Service mesh'],
  },
  simulator,
}
