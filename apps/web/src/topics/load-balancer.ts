import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator, stableHash } from './simulator'
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
  blurb: 'Sharing requests across servers: how it picks one, health checks, and what happens when something fails',
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
    'A load balancer shares requests across many servers, so no single one is the limit and one can fail without an outage.',
    'Round robin is simple but blind to load; least connections copes with slow servers; hashing keeps a client on one server.',
    'Health checks remove a dead server within seconds: 3 failed checks 5 seconds apart is 15 seconds.',
    'Keep servers stateless, with sessions in Redis or a signed cookie, so any server can answer any request.',
    'The load balancer must not be the weak spot: run an active and a standby pair, or use a managed service.',
    'With plain hash mod N, removing one of 3 servers moves about two thirds of the clients; consistent hashing moves only that server\'s share.',
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
      'A load balancer sits in front of a group of identical servers and hands each request to one of them. You can add servers when traffic grows, broken servers stop getting requests, and users only ever see one address.',
    sections: [
      {
        heading: 'Overview',
        body: 'One server has a ceiling: at some point its CPU, memory or network runs out. A bigger machine ("scaling up") gets expensive and is still one machine that can fail. Running many copies of the app ("scaling out") is better, but then something has to decide which copy gets each request. That is the load balancer.\n\nThere are two common kinds. A layer 4 load balancer passes TCP connections along without reading them, so it\'s very fast. A layer 7 load balancer reads the HTTP request, so it can choose by path or header, add headers, and end TLS (it decrypts HTTPS once, at the front, so the servers behind don\'t have to).',
      },
      {
        heading: 'Requirements',
        body: '- Share the traffic so that no server is overloaded.\n- Stop sending requests to a server that is down, within seconds.\n- Let the team add and remove servers without any downtime.\n- Not become the one thing whose failure takes the site down.\n- Add very little delay: well under a millisecond at layer 4, a few milliseconds at layer 7.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example shop at its busiest: 20k requests a second, each taking 50 ms and returning 50 KB.\n- Requests in progress at any moment (rate × time): 20k × 0.05 s = 1k.\n- Data going out: 20k × 50 KB = 1 GB a second = 8 Gbit/s, so one 10 Gbit link leaves too little room.\n- If one server handles 2,500 requests a second, 8 servers is the bare minimum. To run them at 75% at the peak: 8 ÷ 0.75 = 10.7, so 11 servers, each at 1,818 requests a second (73%).\n- If one of the 11 dies, the other 10 take 2k a second each (80%): still fine. With only 8, losing one overloads the rest.\n- Health checks: 11 servers checked every 5 seconds is about 2 checks a second. Cheap.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client (Browser) asks DNS (round-robin records) for the site\'s address and gets the load balancers\' addresses.\n2. The Client (Browser) sends its request to the Load Balancer (active).\n3. The Health Checker keeps the list of healthy servers up to date by checking App Server 1, App Server 2 and App Server 3.\n4. The Algorithm (picks a server) chooses one healthy server.\n5. The Load Balancer (active) passes the request on, adding an X-Forwarded-For header with the user\'s real address.\n6. The chosen server reads the user\'s session from the Session Store (Redis).\n7. The answer goes back through the load balancer to the browser.\n8. Counts and timings go to Metrics & Logs, and the Load Balancer (standby) listens for the active one\'s heartbeat, ready to take over.',
      },
      {
        heading: 'Components',
        body: '- Client (Browser): sends HTTPS requests to one public address.\n- DNS (round-robin records): returns the addresses of several load balancers; a short TTL (how long the answer may be cached) lets you move traffic quickly.\n- Load Balancer (active): accepts connections, decrypts HTTPS and passes each request to a chosen server.\n- Load Balancer (standby): an identical copy that takes over the shared address when the active one stops sending heartbeats.\n- Algorithm (picks a server): the rule for choosing: round robin, least connections, weighted, or a hash of the client.\n- Health Checker: calls GET /healthz on every server every 5 seconds; removes a server after 3 failures and lets it back after 2 successes.\n- App Server 1: one stateless copy of the app (it keeps nothing about users in its own memory).\n- App Server 2: another identical copy; any request can go to any of them.\n- App Server 3: a third copy, so losing one still leaves two.\n- Session Store (Redis): keeps sessions outside the servers, so the servers stay interchangeable.\n- Metrics & Logs: requests, errors and response times per server, for alerts and for knowing when to add servers.',
      },
      {
        heading: 'Key decisions',
        body: '- Round robin: takes turns. Simple and fair when requests cost about the same, but it doesn\'t notice a slow server.\n- Least connections: picks the server with the fewest open connections. Better when requests vary a lot, say 10 ms for some and 2 seconds for others.\n- Weighted: gives bigger machines a bigger share, for example weight 2 for a server with twice the CPU.\n- Hash of the client or a key: the same client always reaches the same server, which helps local caches. A plain "hash mod N" reshuffles most clients when a server is added or removed; consistent hashing avoids that.\n- Sticky sessions (the load balancer remembers each client\'s server) are a shortcut for servers that keep state. But they make the load uneven, and the session is lost when that server dies. Prefer stateless servers.\n- Layer 4 or layer 7: layer 4 is faster and simpler; layer 7 can route by path, retry, and change headers.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A dead server: 3 failed checks × 5 seconds = 15 seconds before it\'s removed. Checking every second finds failures sooner, but adds load and false alarms.\n- A slow but working server still passes its health checks. Least connections helps, and so does removing any server whose error rate stands out from the rest.\n- The load balancer itself: run two that share one address, or use a managed cloud load balancer, which scales for you.\n- Draining: before a deploy, mark a server "draining", so it finishes the requests it has and gets no new ones.\n- Retries: retry only requests that are safe to repeat, never on the same failing server, and with a limit, so retries don\'t multiply the load.\n- Very large sites add DNS or anycast routing in front, to share traffic between regions.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What\'s the difference between a load balancer, a reverse proxy and an API gateway?\n- How do you stop the load balancer from being a single point of failure?\n- One server is up but very slow. What happens with round robin, and what would you change?\n- How do you ship a new version with no downtime?\n- When would you choose layer 4 over layer 7?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
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
        title: 'The three algorithms',
        language: 'javascript',
        source: `let counter = 0
// Round robin: take turns among the healthy servers.
export const roundRobin = (pool) => pool.filter((b) => b.up)[counter++ % pool.filter((b) => b.up).length]

// Least connections: whoever is least busy right now.
export const leastConn = (pool) => pool.filter((b) => b.up).reduce((a, b) => (b.conns < a.conns ? b : a))

// Hash: same client, same server (while the pool is unchanged).
export function ipHash(pool, ip) {
  const up = pool.filter((b) => b.up)
  let h = 2166136261
  for (const ch of ip) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return up[(h >>> 0) % up.length]
}`,
        versions: [
          {
            language: 'java',
            source: `import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

public class Balancer {
  public record Backend(String name, boolean up, int conns) {}

  private static final AtomicInteger counter = new AtomicInteger();

  // Round robin: take turns among the healthy servers.
  static Backend roundRobin(List<Backend> pool) {
    List<Backend> up = pool.stream().filter(Backend::up).toList();
    return up.get(Math.floorMod(counter.getAndIncrement(), up.size()));
  }

  // Least connections: whoever is least busy right now.
  static Backend leastConn(List<Backend> pool) {
    return pool.stream().filter(Backend::up).min(Comparator.comparingInt(Backend::conns)).orElseThrow();
  }

  // Hash: same client, same server (while the pool is unchanged). FNV-1a, 32 bits.
  static Backend ipHash(List<Backend> pool, String ip) {
    List<Backend> up = pool.stream().filter(Backend::up).toList();
    int h = 0x811c9dc5;
    for (char ch : ip.toCharArray()) h = (h ^ ch) * 16777619;
    return up.get((int) (Integer.toUnsignedLong(h) % up.size()));
  }
}`,
          },
          {
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
        ],
      },
      {
        title: 'A health endpoint that checks what matters',
        language: 'javascript',
        source: `import express from 'express'
import { createClient } from 'redis'

const app = express()
const cache = createClient({ url: 'redis://sessions.internal' })
await cache.connect()

// While Redis is down, commands wait for a reconnect instead of failing, so cap the wait.
const within = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

app.get('/healthz', async (req, res) => {
  // Fail only if THIS server can't do its job. Don't check every dependency
  // deeply, or one slow database would take the whole pool out at once.
  try {
    await within(cache.ping(), 500)
  } catch {
    return res.status(503).json({ status: 'down' })
  }
  res.json({ status: 'ok' })
})

app.listen(8080)`,
        versions: [
          {
            language: 'java',
            source: `import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import redis.clients.jedis.DefaultJedisClientConfig;
import redis.clients.jedis.RedisClient;

@RestController
public class Health {
  // A 500 ms timeout: a hung Redis fails the check instead of hanging it.
  private final RedisClient cache = RedisClient.builder()
      .hostAndPort("sessions.internal", 6379)
      .clientConfig(DefaultJedisClientConfig.builder().socketTimeoutMillis(500).connectionTimeoutMillis(500).build())
      .build();

  @GetMapping("/healthz")
  ResponseEntity<Map<String, String>> healthz() {
    // Fail only if THIS server can't do its job. Don't check every dependency
    // deeply, or one slow database would take the whole pool out at once.
    try {
      cache.ping();
    } catch (Exception e) {
      return ResponseEntity.status(503).body(Map.of("status", "down"));
    }
    return ResponseEntity.ok(Map.of("status", "ok"));
  }
}`,
          },
          {
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
      },
    ],
    related: ['Reverse proxy', 'API gateway', 'Health checks', 'Consistent hashing', 'High availability', 'Sticky sessions'],
  },
  simulator,
}
