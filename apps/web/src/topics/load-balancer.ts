import type { Trace } from '@structura/shared'
import { json, type Simulator, stableHash } from './simulator'
import type { StaticTopic } from './types'

// A load balancer in front of three app servers. The simulator really runs the
// three common algorithms (round robin, least connections, hash of the client
// IP) on a fixed set of connection counts, so the learner sees which server each
// one picks and what happens when a server is slow or dead.

interface Server {
  name: string
  conns: number
  latencyMs: number
  healthy: boolean
}

const BASE: Server[] = [
  { name: 'App Server 1', conns: 12, latencyMs: 45, healthy: true },
  { name: 'App Server 2', conns: 4, latencyMs: 45, healthy: true },
  { name: 'App Server 3', conns: 9, latencyMs: 45, healthy: true },
]

const SLOW = 'App Server 2 is overloaded (slow)'
const DEAD = 'App Server 2 fails its health check'
const LB_DIES = 'The active load balancer dies'

const simulator: Simulator = {
  fields: [
    { id: 'ip', label: 'Client IP', options: ['198.51.100.23', '203.0.113.77', '192.0.2.140'] },
    { id: 'algorithm', label: 'Algorithm', options: ['Round robin', 'Least connections', 'IP hash'] },
    { id: 'request', label: 'Request number', options: ['1000', '1001', '1002'] },
    { id: 'scenario', label: 'What happens', options: ['A normal day', SLOW, DEAD, LB_DIES] },
  ],
  defaults: { ip: '198.51.100.23', algorithm: 'Round robin', request: '1000', scenario: 'A normal day' },
  run({ ip, algorithm, request, scenario }) {
    const n = Number(request)
    const servers = BASE.map((s) => ({ ...s }))
    if (scenario === SLOW) {
      servers[1].conns = 41
      servers[1].latencyMs = 1_800
    }
    if (scenario === DEAD) servers[1].healthy = false

    const pool = servers.filter((s) => s.healthy)
    const pick = (): { server: Server; why: string } => {
      if (algorithm === 'Round robin') {
        const server = pool[n % pool.length]
        return { server, why: `request ${n} mod ${pool.length} healthy servers = ${n % pool.length}, so the ${n % pool.length + 1}${['st', 'nd', 'rd'][n % pool.length]} healthy server. It ignores how busy each one is.` }
      }
      if (algorithm === 'Least connections') {
        const server = pool.reduce((a, b) => (b.conns < a.conns ? b : a))
        return { server, why: `${server.name} has the fewest open connections (${server.conns}), so it gets the request.` }
      }
      const h = stableHash(ip)
      const server = pool[h % pool.length]
      return { server, why: `hash(${ip}) = ${h}; ${h} mod ${pool.length} healthy servers = ${h % pool.length}. The same client IP always lands on the same server while the pool stays the same.` }
    }
    const { server, why } = pick()

    const steps: Trace['steps'] = [
      {
        text: 'The browser looks up shop.example.com. DNS returns the addresses of two load balancers (round-robin DNS spreads clients between them).',
        nodes: ['Client (Browser)', 'DNS (round-robin records)'],
        data: `$ dig +short shop.example.com\n203.0.113.10   ← Load Balancer (active)\n203.0.113.11   ← Load Balancer (standby)`,
      },
    ]

    if (scenario === LB_DIES) {
      steps.push(
        {
          text: 'The active load balancer crashes. The standby notices the missing heartbeats and takes over the shared virtual IP address within seconds, so clients keep using the same address.',
          nodes: ['Load Balancer (active)', 'Load Balancer (standby)'],
          data: 'VRRP heartbeat from 203.0.113.10: missing ×3 (1 s apart)\nstandby claims virtual IP 203.0.113.10 ✓\nexisting TCP connections drop; clients retry and reconnect',
        },
        {
          text: 'From now on the standby does the active load balancer\'s job. This is why a load balancer is deployed in pairs: one box would be a single point of failure.',
          nodes: ['Load Balancer (standby)'],
          data: 'active: Load Balancer (standby) (promoted)\nspare: none until the old one is repaired',
        },
      )
    } else {
      steps.push({
        text: `The browser opens a TLS connection to the Load Balancer (active) and sends the request. The load balancer ends TLS here, then talks plain HTTP inside the private network.`,
        nodes: ['Client (Browser)', 'Load Balancer (active)'],
        data: `GET /cart HTTP/1.1\nHost: shop.example.com\nCookie: sid=9f3c2a\nsource: ${ip}`,
      })
    }

    steps.push({
      text: scenario === DEAD
        ? 'The Health Checker probes every server every 5 seconds. App Server 2 failed 3 probes in a row (15 seconds), so it is marked down and taken out of the pool.'
        : 'The Health Checker probes every server every 5 seconds with GET /healthz. Only servers that answer 200 stay in the pool.',
      nodes: ['Health Checker', ...(scenario === DEAD ? ['App Server 2'] : [])],
      data: servers.map((s) => `${s.name}: ${s.healthy ? `200 OK in ${s.latencyMs > 500 ? '1,800 ms (slow but alive)' : `${s.latencyMs} ms`}` : 'timeout ×3 → DOWN'}`).join('\n') + `\npool = [${pool.map((s) => s.name.replace('App Server ', '')).join(', ')}]`,
    })

    steps.push({
      text: `The ${algorithm.toLowerCase()} algorithm chooses a server from the healthy pool: ${why}`,
      nodes: ['Algorithm (picks a server)'],
      data: `algorithm = ${algorithm}\n` + pool.map((s) => `${s.name}: ${s.conns} open connections`).join('\n') + `\n→ ${server.name}`,
    })

    steps.push({
      text: `The load balancer forwards the request to ${server.name} and adds the client's real address in X-Forwarded-For, because the server only sees the load balancer's address.`,
      nodes: ['Load Balancer (active)', server.name],
      data: `GET /cart HTTP/1.1\nHost: shop.example.com\nX-Forwarded-For: ${ip}\nX-Forwarded-Proto: https\n→ ${server.name}:8080`,
    })

    steps.push({
      text: `${server.name} keeps no user state in memory. It reads the cart from the Session Store (Redis) by the session id, so any server could have served this request. That is what makes round robin safe.`,
      nodes: [server.name, 'Session Store (Redis)'],
      data: `GET session:9f3c2a → { user_id: 8841, cart: [{ sku: "B07-441", qty: 2 }] }`,
    })

    const slow = server.latencyMs > 500
    steps.push({
      text: slow
        ? `${server.name} is overloaded, so the answer takes ${server.latencyMs.toLocaleString('en-US')} ms instead of 45 ms. ${algorithm === 'Least connections' ? 'Least connections would normally avoid it.' : 'This algorithm does not look at load, so it keeps sending requests there.'}`
        : `${server.name} answers in ${server.latencyMs} ms and the Load Balancer (active) relays the response to the browser.`,
      nodes: [server.name, 'Load Balancer (active)', 'Client (Browser)'],
      data: `HTTP/1.1 200 OK\nX-Served-By: ${server.name.toLowerCase().replace(/ /g, '-')}\nlatency: ${server.latencyMs} ms`,
    })

    const movedNote =
      algorithm === 'IP hash'
        ? (() => {
            const before = BASE[stableHash(ip) % BASE.length].name
            return before === server.name ? `${ip} stays on ${server.name}.` : `${ip} used to map to ${before} and has now moved to ${server.name}: with plain hash mod N, changing the pool size moves most clients (2 of every 3 when 3 servers become 2). Consistent hashing moves far fewer.`
          })()
        : ''
    steps.push({
      text: `Every request is counted in Metrics & Logs: requests per second, errors and latency per server. ${scenario === DEAD ? movedNote || 'The dead server is gone from the pool until it passes 2 probes in a row.' : movedNote || 'Alerts fire when a server\'s error rate or latency stands out from the others.'}`.trim(),
      nodes: ['Metrics & Logs'],
      data: json({ server: server.name, status: 200, latency_ms: server.latencyMs, algorithm, pool_size: pool.length }),
    })

    return { input: `${ip}, ${algorithm}, request ${request}${scenario === 'A normal day' ? '' : `, ${scenario}`}`, steps }
  },
}

export const loadBalancer: StaticTopic = {
  kind: 'static',
  id: 'load-balancer',
  title: 'Load Balancer',
  blurb: 'Spreading requests over servers: algorithms, health checks and failover',
  difficulty: 'Intermediate',
  guides: [
    'primer-load-balancer',
    'key-use-cases-for-load-balancers',
    'what-are-the-differences-between-a-load-balancer-and-an-api-gateway',
    'load-balancer-realistic-use-cases-you-may-not-know',
    'cloud-load-balancer-cheat-sheet',
    'reverse-proxy-vs-api-gateway-vs-load-balancer',
    'how-do-we-detect-node-failures-in-distributed-systems',
    'primer-availability-patterns',
  ],
  takeaways: [
    'A load balancer spreads requests over many servers so no single one is the limit, and so one can fail without an outage.',
    'Round robin is simple but blind to load; least connections adapts to slow servers; hashing keeps a client on one server.',
    'Health checks remove a dead server from the pool within seconds: 3 failed probes 5 seconds apart is 15 seconds.',
    'Keep servers stateless (sessions in Redis or a signed cookie), so any server can serve any request.',
    'The load balancer must not be a single point of failure: run an active and a standby pair, or a managed service.',
    'Plain hash mod N moves about two thirds of clients when a server leaves (3 to 2); consistent hashing moves only the share that server held.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'edge', label: 'Load balancer tier' },
      { id: 'apps', label: 'App tier' },
    ],
    nodes: [
      { id: 'client', label: 'Client (Browser)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'dns', label: 'DNS (round-robin records)', shape: 'cloud', color: 'blue', group: null },
      { id: 'lb', label: 'Load Balancer (active)', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'standby', label: 'Load Balancer (standby)', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'algo', label: 'Algorithm (picks a server)', shape: 'diamond', color: 'violet', group: 'edge' },
      { id: 'health', label: 'Health Checker', shape: 'rectangle', color: 'orange', group: 'edge' },
      { id: 's1', label: 'App Server 1', shape: 'rectangle', color: 'violet', group: 'apps' },
      { id: 's2', label: 'App Server 2', shape: 'rectangle', color: 'violet', group: 'apps' },
      { id: 's3', label: 'App Server 3', shape: 'rectangle', color: 'violet', group: 'apps' },
      { id: 'sessions', label: 'Session Store (Redis)', shape: 'rectangle', color: 'red', group: null },
      { id: 'metrics', label: 'Metrics & Logs', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'client', to: 'dns', label: 'lookup', dashed: true },
      { from: 'client', to: 'lb', label: 'HTTPS', dashed: false },
      { from: 'lb', to: 'algo', label: 'choose', dashed: false },
      { from: 'algo', to: 's1', label: 'HTTP', dashed: false },
      { from: 'algo', to: 's2', label: 'HTTP', dashed: false },
      { from: 'algo', to: 's3', label: 'HTTP', dashed: false },
      { from: 'health', to: 's1', label: 'GET /healthz', dashed: true },
      { from: 'health', to: 's2', label: 'GET /healthz', dashed: true },
      { from: 'health', to: 's3', label: 'GET /healthz', dashed: true },
      { from: 'health', to: 'algo', label: 'healthy pool', dashed: true },
      { from: 'lb', to: 'standby', label: 'heartbeat', dashed: true },
      { from: 's1', to: 'sessions', label: 'session', dashed: false },
      { from: 's2', to: 'sessions', label: 'session', dashed: false },
      { from: 's3', to: 'sessions', label: 'session', dashed: false },
      { from: 'lb', to: 'metrics', label: 'counters', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'backends',
        name: 'backends',
        columns: [
          { name: 'id', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'address', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'weight', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'state', type: "text ('up' | 'down' | 'draining')", pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'health_checks',
        name: 'health_checks',
        columns: [
          { name: 'backend_id', type: 'int', pk: true, fk: 'backends.id', nullable: false, unique: false },
          { name: 'checked_at', type: 'timestamptz', pk: true, fk: null, nullable: false, unique: false },
          { name: 'status_code', type: 'int', pk: false, fk: null, nullable: true, unique: false },
          { name: 'latency_ms', type: 'int', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(backend_id, checked_at DESC)'],
      },
    ],
    relations: [{ from: 'health_checks', to: 'backends', kind: 'one-to-many', label: 'probes' }],
  },
  explanation: {
    title: 'Load Balancer',
    summary:
      'A load balancer sits in front of a group of identical servers and hands each request to one of them. It lets you add servers to handle more traffic, stops sending traffic to servers that have failed, and hides all of that behind a single address.',
    sections: [
      {
        heading: 'Overview',
        body: 'One server has a ceiling: its CPU, memory and network card. Scaling up (a bigger machine) gets expensive and still leaves one point of failure. Scaling out means running many copies of the app, and then something has to decide which copy gets each request. That is the load balancer.\n\nThere are two common layers. A layer 4 balancer works on TCP connections and is very fast; it does not read the request. A layer 7 balancer reads HTTP, so it can route by path or header, end TLS (decrypt HTTPS once, at the edge) and add headers.',
      },
      {
        heading: 'Requirements',
        body: '- Spread traffic so no server is overloaded.\n- Stop sending requests to a server that is down, within seconds.\n- Let operators add and remove servers without downtime.\n- Not become a single point of failure itself.\n- Add very little latency (well under a millisecond for layer 4, a few for layer 7).',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example shop: 20,000 requests per second at peak, 50 ms average, 50 KB response.\n- Concurrent requests (Little\'s law, rate × time): 20,000 × 0.05 s = 1,000 in flight at once.\n- Bandwidth out: 20,000 × 50 KB = 1 GB/s = 8 Gbit/s, so the load balancer needs more than one 10 Gbit link of headroom.\n- If one server handles 2,500 requests per second, 8 servers are the bare minimum. Planning for 75% load at peak gives 8 / 0.75 = 10.7, so 11 servers (each at 1,818 requests per second, 73%).\n- If one of the 11 dies, the other 10 each take 2,000 per second (80%): still fine. With only 8, losing one means overload.\n- Health probes: 11 servers every 5 seconds is about 2 probes per second. Cheap.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client (Browser) asks DNS (round-robin records) for the site\'s address and gets the load balancers.\n2. The Client (Browser) sends the request to the Load Balancer (active).\n3. The Health Checker keeps the list of healthy servers up to date by probing App Server 1, App Server 2 and App Server 3.\n4. The Algorithm (picks a server) chooses one healthy server.\n5. The Load Balancer (active) forwards the request, adding X-Forwarded-For with the real client address.\n6. The chosen app server reads the user\'s session from the Session Store (Redis).\n7. The response goes back through the load balancer to the browser.\n8. Counters flow to Metrics & Logs, and the Load Balancer (standby) watches the active one\'s heartbeat, ready to take over.',
      },
      {
        heading: 'Components',
        body: '- Client (Browser): sends HTTPS requests to one public address.\n- DNS (round-robin records): returns the addresses of several load balancers; a short TTL lets you move traffic quickly.\n- Load Balancer (active): accepts connections, ends TLS and forwards requests to a chosen server.\n- Load Balancer (standby): an identical copy that takes over the shared virtual IP when the active one stops sending heartbeats.\n- Algorithm (picks a server): the rule that picks the server: round robin, least connections, weighted or a hash of the client.\n- Health Checker: probes every server (GET /healthz every 5 s) and removes one after 3 failures, adding it back after 2 successes.\n- App Server 1: a stateless copy of the application.\n- App Server 2: another identical copy; any request can go to any of them.\n- App Server 3: a third copy, so that losing one still leaves two.\n- Session Store (Redis): keeps sessions outside the servers so they stay interchangeable.\n- Metrics & Logs: request counts, errors and latency per server, used for alerts and for deciding when to add servers.',
      },
      {
        heading: 'Key decisions',
        body: '- Round robin: simplest and fair when requests cost about the same. It does not notice a slow server.\n- Least connections: sends work to the server with the fewest open connections; better when requests vary a lot (some take 10 ms, some 2 s).\n- Weighted: give bigger machines a bigger share, for example weight 2 for a server with twice the CPU.\n- IP or key hash: the same client reaches the same server, which helps local caches. Plain hash mod N reshuffles most clients when the pool changes; use consistent hashing instead.\n- Sticky sessions (the balancer remembers a client\'s server) are a shortcut for stateful servers, but they unbalance load and lose the session when that server dies. Prefer stateless servers.\n- Layer 4 vs layer 7: layer 4 is faster and simpler; layer 7 allows path routing, retries and header rewriting.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A dead server: 3 failed probes × 5 s = 15 s until it is removed. Faster detection (1 s probes) catches failures sooner but adds probe load and false alarms.\n- A slow but alive server passes health checks. Least connections and outlier detection (eject a server whose error rate stands out) handle this.\n- The load balancer itself: run two with a shared virtual IP (VRRP) or use a managed one (a cloud load balancer scales for you).\n- Draining: before deploying, mark a server "draining" so it finishes its current requests and gets no new ones.\n- Retries: retry only idempotent requests, and never to the same failing server; add a limit so retries do not multiply the load.\n- Very large sites add a layer of DNS or anycast in front, to spread traffic between regions.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the difference between a load balancer, a reverse proxy and an API gateway?\n- How do you avoid the load balancer being a single point of failure?\n- A server is up but very slow. What happens with round robin, and what would you change?\n- How do you deploy a new version with no downtime?\n- When would you choose layer 4 over layer 7?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'nginx: least connections with passive health checks',
        language: 'bash',
        source: `upstream app {
    least_conn;                       # pick the server with fewest open connections
    server 10.0.1.11:8080 max_fails=3 fail_timeout=15s;   # 3 failures: out for 15 s
    server 10.0.1.12:8080 max_fails=3 fail_timeout=15s;
    server 10.0.1.13:8080 max_fails=3 fail_timeout=15s weight=2;  # bigger machine
    server 10.0.1.14:8080 backup;     # used only when the others are down
}

server {
    listen 443 ssl;
    location / {
        proxy_pass http://app;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_next_upstream error timeout http_502;   # retry on another server
    }
}`,
      },
      {
        title: 'The three algorithms in TypeScript',
        language: 'typescript',
        source: `interface Backend { name: string; conns: number; up: boolean }

let counter = 0
// Round robin: take turns among the healthy servers.
export const roundRobin = (pool: Backend[]) => pool.filter((b) => b.up)[counter++ % pool.filter((b) => b.up).length]

// Least connections: whoever is least busy right now.
export const leastConn = (pool: Backend[]) => pool.filter((b) => b.up).reduce((a, b) => (b.conns < a.conns ? b : a))

// Hash: same client, same server (while the pool is unchanged).
export function ipHash(pool: Backend[], ip: string) {
  const up = pool.filter((b) => b.up)
  let h = 2166136261
  for (const ch of ip) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return up[(h >>> 0) % up.length]
}`,
      },
      {
        title: 'A health endpoint that checks what matters',
        language: 'python',
        source: `from flask import Flask
import redis

app = Flask(__name__)
cache = redis.Redis(host="sessions.internal", socket_timeout=0.5)

@app.get("/healthz")
def healthz():
    # Fail only if THIS server can't do its job. Don't check every dependency
    # deeply, or one slow database would take the whole pool out at once.
    try:
        cache.ping()
    except redis.RedisError:
        return {"status": "down"}, 503
    return {"status": "ok"}, 200`,
      },
    ],
    related: ['Reverse proxy', 'API gateway', 'Health checks', 'Consistent hashing', 'High availability', 'Sticky sessions'],
  },
  simulator,
}
