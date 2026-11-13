import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from terraform-aws-modules/terraform-aws-alb (Apache License 2.0): the
// listener, rule and target group structure (HTTP→HTTPS redirect, rules with
// priorities and conditions, target groups with health checks) follows the
// module's examples. The rule evaluator, walkthrough and story are Structura's.

interface Rule {
  priority: number
  label: string
  host?: string
  path?: string
  header?: [string, string]
  target: string
}

const RULES: Rule[] = [
  { priority: 10, label: 'host admin.example.com', host: 'admin.example.com', target: 'admin' },
  { priority: 20, label: 'path /api/* and header X-Canary: 1', path: '/api/*', header: ['x-canary', '1'], target: 'api-v2' },
  { priority: 30, label: 'path /api/*', path: '/api/*', target: 'api' },
]
const BAD_RULE: Rule = { priority: 1, label: 'path /* (maintenance banner, left on)', path: '/*', target: 'web' }

/** ALB path patterns: case-sensitive, * matches any characters, ? exactly one. */
function glob(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return re.test(value)
}

const API_TARGETS = [
  { ip: '10.0.3.25', zone: 'a', inFlight: 4 },
  { ip: '10.0.4.31', zone: 'b', inFlight: 11 }, // busy with slow report exports
  { ip: '10.0.5.17', zone: 'c', inFlight: 2 },
]

const HEALTH = { path: '/status', interval: 30, timeout: 5, healthy: 5, unhealthy: 2 } // the ALB defaults, with the sample app's path

const REQUESTS: Record<string, { scheme: 'http' | 'https'; host: string; path: string; headers: Record<string, string> }> = {
  'GET http://shop.example.com/cart': { scheme: 'http', host: 'shop.example.com', path: '/cart', headers: {} },
  'GET https://shop.example.com/': { scheme: 'https', host: 'shop.example.com', path: '/', headers: {} },
  'GET https://shop.example.com/api/orders/42': { scheme: 'https', host: 'shop.example.com', path: '/api/orders/42', headers: {} },
  'GET …/api/orders/42 with X-Canary: 1': { scheme: 'https', host: 'shop.example.com', path: '/api/orders/42', headers: { 'x-canary': '1' } },
  'GET https://admin.example.com/users': { scheme: 'https', host: 'admin.example.com', path: '/users', headers: {} },
}

const TARGET_NODE: Record<string, string> = { web: 'Web Targets', admin: 'Admin Targets', 'api-v2': 'API v2 Targets' }

const simulator: Simulator = {
  fields: [
    { id: 'request', label: 'Request', options: Object.keys(REQUESTS) },
    { id: 'rules', label: 'Listener rules', options: ['Specific rules first', 'A /* rule added at priority 1'] },
    { id: 'health', label: 'API targets', options: ['All healthy', 'One failing its health check', 'All failing their health check'] },
    { id: 'algorithm', label: 'Load balancing', options: ['Round robin', 'Least outstanding requests'] },
  ],
  defaults: { request: 'GET https://shop.example.com/api/orders/42', rules: 'Specific rules first', health: 'All healthy', algorithm: 'Round robin' },
  run(v) {
    const req = REQUESTS[v.request] ?? REQUESTS['GET https://shop.example.com/']
    const bad = v.rules.startsWith('A /*')
    const failing = v.health.startsWith('One') ? 1 : v.health.startsWith('All failing') ? 3 : 0
    const steps: Trace['steps'] = []

    if (req.scheme === 'http') {
      steps.push({
        text: 'The shopper typed the address without https. The listener on port 80 has a single action: redirect to HTTPS with a 301. The browser repeats the request on port 443 and remembers the redirect.',
        nodes: ['Shopper', 'HTTP Listener (80)'],
        data: `GET http://${req.host}${req.path}\n← 301 Moved Permanently\n   Location: https://${req.host}${req.path}`,
      })
    }
    steps.push({
      text: `The HTTPS listener on port 443 finishes the TLS handshake with the certificate for ${req.host}, chosen by the name the browser sent (SNI). Traffic between the load balancer and the tasks stays inside the VPC. The request is now plain HTTP the load balancer can read: host, path and headers.`,
      nodes: ['Shopper', 'HTTPS Listener (443)', 'TLS Certificate', 'Access Logs'],
      data: `GET ${req.path} HTTP/1.1\nHost: ${req.host}${Object.entries(req.headers)
        .map(([k, val]) => `\n${k}: ${val}`)
        .join('')}\ncertificate: ${req.host === 'admin.example.com' ? 'admin.example.com' : '*.example.com'} (ACM)`,
    })

    // Rules are checked in priority order; the first whose conditions all match wins.
    const rules = (bad ? [BAD_RULE, ...RULES] : RULES).slice().sort((a, b) => a.priority - b.priority)
    let chosen: Rule | null = null
    const lines = rules.map((r) => {
      const ok = (!r.host || r.host === req.host) && (!r.path || glob(r.path, req.path)) && (!r.header || req.headers[r.header[0]] === r.header[1])
      const line = `${String(r.priority).padStart(3)}  ${r.label.padEnd(40)} → ${r.target}`
      if (chosen) return `${line}   (not checked)`
      if (ok) {
        chosen = r
        return `${line}   ← first match`
      }
      return `${line}   no`
    })
    const target = (chosen as Rule | null)?.target ?? 'web'
    lines.push(`def  default action${' '.repeat(28)} → web${chosen ? '   (not used)' : '   ← used'}`)
    const isApi = req.path.startsWith('/api/')
    steps.push({
      text: `The Listener Rules are checked in priority order, lowest number first, and the first rule whose conditions all match decides. ${chosen ? `Rule ${(chosen as Rule).priority} matches, so the request goes to the "${target}" target group.` : 'No rule matches, so the default action sends it to the "web" target group.'}${bad && isApi ? ' The /* rule at priority 1 matches every path, so the API rules below it are never reached: the web app answers API calls with its 404 page.' : ''}`,
      nodes: ['Listener Rules', target === 'api' ? 'API Task (zone a)' : TARGET_NODE[target]],
      data: lines.join('\n'),
    })

    if (target !== 'api') {
      steps.push({
        text: `${TARGET_NODE[target]} receive the request. ${target === 'web' && isApi ? 'The web app has no /api routes and returns 404. Every API call fails the same way until the rule is removed or moved below the API rules.' : target === 'api-v2' ? 'Only requests carrying the canary header reach the new version, so the team can test it in production before shifting real traffic.' : 'Each target group has its own health check and its own set of tasks.'}`,
        nodes: [TARGET_NODE[target], 'Health Checks'],
        data: target === 'web' && isApi ? `← 404 Not Found (from the web app)\ncontent-type: text/html` : `← 200 OK (from ${target})`,
      })
      return { input: `${v.request} · ${bad ? '/* at priority 1' : 'specific first'} → ${target}${target === 'web' && isApi ? ' (404)' : ''}`, steps }
    }

    // Health: two failed checks 30 s apart mark a target unhealthy.
    const unhealthy = API_TARGETS.slice(0, failing).map((t) => t.ip)
    const detect = HEALTH.unhealthy * HEALTH.interval
    const healthy = API_TARGETS.filter((t) => !unhealthy.includes(t.ip))
    const pool = healthy.length ? healthy : API_TARGETS // all unhealthy: fail open
    steps.push({
      text: failing === 0
        ? `Health Checks call GET ${HEALTH.path} on every target every ${HEALTH.interval} seconds. All three API tasks answer 200, so all three get traffic.`
        : failing === 1
          ? `The task in zone a is deadlocked and its ${HEALTH.path} times out. After ${HEALTH.unhealthy} failed checks ${HEALTH.interval} s apart it is marked unhealthy, up to ${detect} seconds after it broke; until then it still gets its share of requests. It needs ${HEALTH.healthy} passing checks (${HEALTH.healthy * HEALTH.interval} s) to come back.`
          : `All three API tasks fail their health checks (a bad config pushed to all of them). Rather than send nothing anywhere, the load balancer fails open: when every target in a group is unhealthy, it routes to all of them anyway.`,
      nodes: ['Health Checks', 'API Task (zone a)', 'API Task (zone b)', 'API Task (zone c)'],
      data: API_TARGETS.map((t) => `${t.ip} (zone ${t.zone})  ${unhealthy.includes(t.ip) ? 'unhealthy: 2 checks timed out' : 'healthy: 200 OK'}`).join('\n') + (failing === 3 ? '\n→ no healthy targets: routing to all (fail open)' : ''),
    })

    // Send the next 6 requests and show where each goes.
    const lor = v.algorithm.startsWith('Least')
    const load = new Map(pool.map((t) => [t.ip, t.inFlight]))
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      let ip: string
      if (lor) ip = [...load.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0]
      else ip = pool[i % pool.length].ip
      load.set(ip, load.get(ip)! + 1) // these requests are still running when the next one arrives
      picks.push(ip)
    }
    const zoneOf = (ip: string) => API_TARGETS.find((t) => t.ip === ip)!.zone
    steps.push({
      text: lor
        ? `Least outstanding requests sends each request to the target with the fewest requests in progress. The task in zone b is busy with slow report exports (${API_TARGETS[1].inFlight} in flight), so it is skipped until the others catch up.`
        : `Round robin takes the targets in turn, whatever they're doing. ${pool.some((t) => t.ip === '10.0.4.31') ? `The task in zone b already has ${API_TARGETS[1].inFlight} slow requests in flight and still gets its full share.` : ''}`,
      nodes: ['API Task (zone a)', 'API Task (zone b)', 'API Task (zone c)'],
      data: [
        `in flight before: ${pool.map((t) => `${zoneOf(t.ip)}=${t.inFlight}`).join(', ')}`,
        `next 6 requests: ${picks.map((ip) => zoneOf(ip)).join(' ')}`,
        `in flight after: ${pool.map((t) => `${zoneOf(t.ip)}=${load.get(t.ip)}`).join(', ')}`,
      ].join('\n'),
    })

    const errors = failing === 3 ? 6 : 0
    steps.push({
      text:
        failing === 3
          ? 'Every request reaches a broken task and fails, but the team sees real errors from real code in the logs instead of the load balancer\'s own 503, and the moment the config is fixed traffic flows again.'
          : `The task answers and the load balancer returns the response to the shopper. Each request is written to the Access Logs in S3 with its target, status and timings.${failing === 1 ? ` For the ${detect} seconds before zone a's task was marked unhealthy, about a third of API requests failed.` : ''}`,
      nodes: ['API Task (zone c)', 'HTTPS Listener (443)', 'Shopper', 'Access Logs'],
      data: `${errors ? '← 500 Internal Server Error (6 of 6)' : '← 200 OK'}\nlog: https ${new Date(Date.UTC(2026, 10, 12, 9, 30, 0)).toISOString()} shop-alb … ${picks[0]}:3001 0.001 0.042 0.000 ${errors ? 500 : 200} …`,
    })

    return {
      input: `${v.request} · ${bad ? '/* at priority 1' : 'specific first'} · ${failing ? `${failing} unhealthy` : 'all healthy'} · ${lor ? 'least outstanding' : 'round robin'} → api: ${picks.map(zoneOf).join('')}`,
      steps,
    }
  },
}

const run = (o: Partial<Record<'request' | 'rules' | 'health' | 'algorithm', string>>) => ({ ...simulator.defaults, ...o })

export const awsAlb: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'aws-alb',
  title: 'Application Load Balancer',
  blurb: 'One HTTPS entry point for many services: listeners, rules, target groups, health checks and routing algorithms',
  adaptedFrom: {
    title: 'terraform-aws-alb',
    author: 'terraform-aws-modules (Anton Babenko and contributors)',
    url: 'https://github.com/terraform-aws-modules/terraform-aws-alb',
    license: 'Apache License 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  guides: ['tf-aws-alb', 'tf-aws-alb-complete', 'tf-aws-alb-patterns', 'tf-aws-nlb-complete', 'what-are-the-differences-between-a-load-balancer-and-an-api-gateway', 'reverse-proxy-vs-api-gateway-vs-load-balancer'],
  story: {
    title: 'The rule that swallowed the API',
    dek: 'One load balancer in front of a shop\'s website, API and admin panel, a maintenance banner that broke every API call, and what health checks do when everything is broken.',
    chapters: [
      {
        heading: 'One front door',
        body: `An online furniture shop had three services: the website, an API the mobile app used, and an admin panel. Each had its own server with its own public address and its own TLS certificate, renewed by hand. Twice a year someone forgot.

They moved all three behind one **Application Load Balancer** (ALB), which works at the HTTP level:
- A **listener** waits on a port. The one on port 80 does one thing: redirect to HTTPS. The one on 443 holds the certificates, from AWS Certificate Manager, which renews them automatically.
- **Rules** on the listener look at each request's host, path and headers and choose where it goes.
- A **target group** is a set of targets (here, containers' addresses) that serve one thing, with its own health check.

The tasks themselves moved into private subnets, with no public address at all.`,
        replay: { label: 'Follow an http:// request', values: run({ request: 'GET http://shop.example.com/cart' }) },
      },
      {
        heading: 'Paths and hosts',
        body: `The rules were short:
- \`admin.example.com\` goes to the admin target group
- \`/api/*\` goes to the API
- everything else falls through to the **default action**: the website

Rules have **priorities**. The load balancer checks them from the lowest number up, and the first rule whose conditions all match wins. Nothing after it is looked at.

Later they added a canary rule above the API rule: \`/api/*\` together with the header \`X-Canary: 1\` goes to the new API version. Testers set the header; customers never see it.`,
        replay: { label: 'Follow an API request', values: run({}) },
      },
      {
        heading: 'The maintenance banner',
        body: `Before a big sale, someone added a rule to show a maintenance banner: path \`/*\`, forward to the website, priority 1, "just for an hour". The website looked fine. Nobody turned it off.

The mobile app broke completely. \`/*\` matches every path, including \`/api/orders/42\`, and at priority 1 it was checked first. Every API call went to the website, which answered with its 404 page. The API's own rules were never reached.

> First match wins. A broad rule with a low number hides every rule after it.

They added a check to their Terraform pipeline: no rule with a path of \`/*\` may have a lower number than a more specific rule.`,
        replay: { label: 'Replay with the /* rule at priority 1', values: run({ rules: 'A /* rule added at priority 1' }) },
      },
      {
        heading: 'A task that stopped answering',
        body: `One API task deadlocked. It still accepted connections; it just never answered. The load balancer's **health check** calls \`GET /status\` on every target every 30 seconds. After 2 failures in a row it marks the target unhealthy and stops sending it requests.

So for up to 60 seconds, a third of API requests went to a task that would never answer. They weighed shorter intervals, which find failures sooner but can also remove a healthy task during a short pause, and settled on 10 seconds with 3 failures.

They also changed the routing algorithm. Round robin gives every target the same number of requests, even one busy with slow report exports. **Least outstanding requests** sends each new request to the target with the fewest requests still in progress.`,
        replay: { label: 'Replay one failing target', values: run({ health: 'One failing its health check' }) },
      },
      {
        heading: 'When everything is unhealthy',
        body: `During a bad deploy, a wrong database password went to all API tasks at once, and every health check failed. You might expect the load balancer to stop sending anything. It doesn't. When every target in a group is unhealthy, it **fails open** and routes to all of them.

That sounds wrong, but it's deliberate: a health check that is itself broken (a typo in the path, a dependency it checks too eagerly) would otherwise take down a working service. The team kept their \`/status\` check shallow: it says the process is up and can serve, not that every downstream system is perfect.

> A health check answers one question: should this target get traffic right now? Keep it fast, cheap and honest.`,
        replay: { label: 'Replay every target failing', values: run({ health: 'All failing their health check', algorithm: 'Least outstanding requests' }) },
      },
    ],
  },
  takeaways: [
    'An Application Load Balancer works at the HTTP level: listeners on ports, rules on host, path and headers, and target groups of servers or containers.',
    'Rules run in priority order and the first full match wins, so broad rules like /* must come after specific ones.',
    'The load balancer terminates TLS with certificates that renew automatically, and port 80 should only redirect to HTTPS.',
    'Health checks remove a failing target after a few failed checks, so a broken target still gets requests for interval × threshold seconds.',
    'Least outstanding requests suits requests of uneven cost better than round robin.',
    'If every target is unhealthy the load balancer fails open, so keep health checks shallow and honest.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'alb', label: 'Load balancer' },
      { id: 'api', label: 'Target group: api' },
    ],
    nodes: [
      { id: 'shopper', label: 'Shopper', shape: 'ellipse', color: 'blue', group: null },
      { id: 'l80', label: 'HTTP Listener (80)', shape: 'rectangle', color: 'violet', group: 'alb' },
      { id: 'l443', label: 'HTTPS Listener (443)', shape: 'rectangle', color: 'violet', group: 'alb' },
      { id: 'cert', label: 'TLS Certificate', shape: 'rectangle', color: 'green', group: null },
      { id: 'rules', label: 'Listener Rules', shape: 'diamond', color: 'violet', group: 'alb' },
      { id: 'health', label: 'Health Checks', shape: 'rectangle', color: 'violet', group: 'alb' },
      { id: 'web', label: 'Web Targets', shape: 'rectangle', color: 'orange', group: null },
      { id: 'admin', label: 'Admin Targets', shape: 'rectangle', color: 'orange', group: null },
      { id: 'v2', label: 'API v2 Targets', shape: 'rectangle', color: 'orange', group: null },
      { id: 'a', label: 'API Task (zone a)', shape: 'rectangle', color: 'orange', group: 'api' },
      { id: 'b', label: 'API Task (zone b)', shape: 'rectangle', color: 'orange', group: 'api' },
      { id: 'c', label: 'API Task (zone c)', shape: 'rectangle', color: 'orange', group: 'api' },
      { id: 'logs', label: 'Access Logs', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'shopper', to: 'l80', label: 'http', dashed: false },
      { from: 'l80', to: 'shopper', label: '301 to https', dashed: true },
      { from: 'shopper', to: 'l443', label: 'https', dashed: false },
      { from: 'l443', to: 'cert', label: 'SNI', dashed: false },
      { from: 'l443', to: 'rules', label: 'request', dashed: false },
      { from: 'l443', to: 'logs', label: 'every request', dashed: true },
      { from: 'rules', to: 'admin', label: 'admin host', dashed: false },
      { from: 'rules', to: 'v2', label: 'X-Canary: 1', dashed: false },
      { from: 'rules', to: 'a', label: '/api/*', dashed: false },
      { from: 'rules', to: 'b', label: '/api/*', dashed: false },
      { from: 'rules', to: 'c', label: '/api/*', dashed: false },
      { from: 'rules', to: 'web', label: 'default', dashed: false },
      { from: 'health', to: 'a', label: 'GET /status', dashed: true },
      { from: 'health', to: 'b', label: 'GET /status', dashed: true },
      { from: 'health', to: 'c', label: 'GET /status', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Application Load Balancer',
    summary:
      'An Application Load Balancer (ALB) is AWS\'s HTTP load balancer. Listeners accept connections on a port and terminate TLS; rules match each request\'s host, path or headers and forward it to a target group; health checks keep broken targets out of rotation.',
    sections: [
      {
        heading: 'Overview',
        body: 'A load balancer gives many servers one address. AWS has two main kinds: the Network Load Balancer works with TCP and UDP connections, and the Application Load Balancer understands HTTP, so it can route by host name, path, headers or query string, redirect, return fixed responses and terminate TLS.\n\nAn ALB is made of listeners (a port and protocol), rules (conditions and actions, in priority order), and target groups (the servers, containers or functions that do the work, with a health check). It runs nodes in every availability zone you give it and scales them automatically.\n\nThe simulator really evaluates the listener rules against your request, applies health check thresholds and picks targets with round robin or least outstanding requests.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- One public HTTPS endpoint for the website, the API and the admin panel.\n- Route by host and path; send header-tagged requests to a canary version.\n- Redirect HTTP to HTTPS.\n- Stop sending requests to broken tasks.\n\nNon-functional:\n- Survive the loss of an availability zone.\n- Certificates renew without anyone remembering.\n- Logs of every request for debugging.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Health checks: 3 API tasks checked every 30 s from each load balancer node in 3 zones = 3 × 3 ÷ 30 = 0.3 checks a second; trivial, but it grows with targets × nodes.\n- Detecting a dead target: unhealthy threshold × interval = 2 × 30 s = up to 60 s; recovery needs healthy threshold × interval = 5 × 30 s = 150 s.\n- With 10 s and 3 failures: detection in up to 30 s.\n- Requests to a dead target before it is removed: at 600 requests a second spread over 3 tasks, 200 a second × 60 s = 12,000 failed requests.\n- Access logs: 600 requests a second × 86,400 s × ~400 bytes ≈ 20.7 GB a day to S3.',
      },
      {
        heading: 'Step by step',
        body: '1. The Shopper connects to the HTTP Listener (80), which redirects to HTTPS, or straight to the HTTPS Listener (443).\n2. The HTTPS Listener (443) completes TLS with the TLS Certificate chosen by SNI and writes the request to the Access Logs.\n3. Listener Rules are checked in priority order: the admin host goes to Admin Targets, /api/* with X-Canary: 1 to API v2 Targets, /api/* to the API tasks, and anything else to Web Targets.\n4. Health Checks call GET /status on API Task (zone a), API Task (zone b) and API Task (zone c); unhealthy ones get no new requests.\n5. The load balancer picks a healthy API task by round robin or least outstanding requests and returns its response to the Shopper.',
      },
      {
        heading: 'Components',
        body: '- Shopper: a browser or the mobile app.\n- HTTP Listener (80): plain HTTP; its only action is a 301 redirect to HTTPS.\n- HTTPS Listener (443): HTTPS; terminates TLS and runs the rules.\n- TLS Certificate: from AWS Certificate Manager, renewed automatically; several per listener, chosen by SNI.\n- Listener Rules: conditions (host, path, header, method, query, source IP) and actions (forward, weighted forward, redirect, fixed response), checked by priority.\n- Health Checks: periodic requests to each target; thresholds decide when it leaves and rejoins.\n- Web Targets: the website\'s tasks, the default action.\n- Admin Targets: the admin panel, reached by host name.\n- API v2 Targets: a canary version reached only with a header.\n- API Task (zone a): one API container, registered by IP address.\n- API Task (zone b): the same, in another zone.\n- API Task (zone c): the same, in a third zone.\n- Access Logs: one line per request in S3, with target, status and timings.',
      },
      {
        heading: 'Key decisions',
        body: '- ALB or NLB: ALB for HTTP routing, TLS and redirects; NLB for raw TCP/UDP, static IP addresses and the lowest latency.\n- Rule order: specific rules get low numbers, broad ones high numbers; the default action catches the rest.\n- Health check design: a cheap endpoint that says the process can serve, not a deep check of every dependency, which can remove all targets at once.\n- Thresholds: shorter intervals detect failures sooner but react to short pauses; pair them with retries in clients.\n- Algorithm: round robin for uniform requests; least outstanding requests when some requests are slow.\n- Deregistration delay: during deploys, a target leaving the group keeps finishing in-flight requests for this long (300 s by default); lower it for short requests.\n- Stickiness: avoid it if you can by keeping sessions out of the servers; it makes the load uneven.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The ALB scales its nodes with traffic; for a sudden huge spike (a launch), warm it up in advance through AWS support or Load Balancer Capacity Units reservation.\n- Cross-zone load balancing is on for ALBs, so targets get equal shares even if zones have different numbers of them.\n- A zone failure removes that zone\'s node from DNS and its targets from rotation.\n- Fail open: if every target is unhealthy, the ALB routes to all of them.\n- Slow start can ramp traffic to new targets over a few minutes, so a cold cache isn\'t flooded.\n- Put AWS WAF on the listener to block common attacks before they reach the app.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- A request matches two rules. Which one wins, and how do you check?\n- How long can a dead target keep getting traffic? How would you shorten it, and what\'s the risk?\n- Why does an ALB route to unhealthy targets when they\'re all unhealthy?\n- When would you choose a Network Load Balancer instead?\n- How do you send 5% of real traffic to a new version?\n- Deploys cause a burst of 502 errors. What would you look at?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'ALB listeners and rules in Terraform (bash)',
        language: 'bash',
        source: `cat > alb.tf <<'EOF'
module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 10.0"

  name    = "shop"
  vpc_id  = module.vpc.vpc_id
  subnets = module.vpc.public_subnets

  listeners = {
    http = {
      port     = 80
      protocol = "HTTP"
      redirect = { port = "443", protocol = "HTTPS", status_code = "HTTP_301" }
    }
    https = {
      port            = 443
      protocol        = "HTTPS"
      certificate_arn = module.acm.acm_certificate_arn
      forward         = { target_group_key = "web" } # the default action

      rules = {
        api = {
          priority   = 30
          actions    = [{ forward = { target_group_key = "api" } }]
          conditions = [{ path_pattern = { values = ["/api/*"] } }]
        }
      }
    }
  }

  target_groups = {
    web = { protocol = "HTTP", port = 80, target_type = "ip", create_attachment = false }
    api = {
      protocol          = "HTTP"
      port              = 3001
      target_type       = "ip"   # ECS registers each task's address
      create_attachment = false
      load_balancing_algorithm_type = "least_outstanding_requests"
      health_check = { path = "/status", interval = 10, unhealthy_threshold = 3, healthy_threshold = 3 }
    }
  }
}
EOF`,
      },
      {
        title: 'How rules are evaluated (TypeScript)',
        language: 'typescript',
        source: `interface Rule {
  priority: number
  host?: string
  path?: string // * matches anything, ? one character
  target: string
}

// ALB path patterns: * matches any run of characters, ? exactly one.
function glob(p: string, s: string): boolean {
  if (!p) return !s
  if (p[0] === '*') return glob(p.slice(1), s) || (s.length > 0 && glob(p, s.slice(1)))
  return s.length > 0 && (p[0] === '?' || p[0] === s[0]) && glob(p.slice(1), s.slice(1))
}

// Lowest priority number first; the first rule whose conditions all match wins.
export function route(rules: Rule[], host: string, path: string, fallback = 'web'): string {
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    if ((!r.host || r.host === host) && (!r.path || glob(r.path, path))) return r.target
  }
  return fallback
}

route([{ priority: 30, path: '/api/*', target: 'api' }], 'shop.example.com', '/api/orders/42') // 'api'
route([{ priority: 1, path: '/*', target: 'web' }, { priority: 30, path: '/api/*', target: 'api' }], 'shop.example.com', '/api/orders/42') // 'web'`,
      },
      {
        title: 'A shallow health check (JavaScript)',
        language: 'javascript',
        source: `import express from 'express'

const app = express()
let ready = false // set once config is loaded and the database pool is open

const loadConfig = async () => {} // stand-ins for the app's real start-up work
const openPool = async () => {}

// Answers "should this task get traffic?", fast. It doesn't call other services:
// if a shared dependency is down, failing every task's check helps nobody.
app.get('/status', (req, res) => {
  if (!ready) return res.status(503).send('starting')
  res.status(200).send('ok')
})

app.listen(3001, async () => {
  await loadConfig()
  await openPool()
  ready = true
})`,
      },
      {
        title: 'Why is a target unhealthy? (bash)',
        language: 'bash',
        source: `aws elbv2 describe-target-health \\
  --target-group-arn arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/shop-api/0123456789abcdef \\
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason,TargetHealth.Description]' \\
  --output table
# 10.0.3.25  unhealthy  Target.Timeout  Request timed out
# 10.0.4.31  healthy
# 10.0.5.17  healthy`,
      },
    ],
    related: ['AWS VPC networking', 'ECS on Fargate', 'API gateway', 'Load balancing', 'Rate limiter', 'CDN'],
  },
  simulator,
}
