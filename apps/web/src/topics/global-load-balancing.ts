import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator follows one user's request through three layers: a global layer that
// picks a region (Route 53 DNS or Global Accelerator), an API gateway that checks and
// routes it, and a regional load balancer (ALB) that picks a server. Then it breaks a
// region or a zone, and works out how long users fail before each layer notices.
// Round-trip times are illustrative. Health-check and quota numbers are AWS defaults.

type City = 'Delhi' | 'Dubai' | 'London'
type Region = 'Mumbai' | 'Frankfurt'

const RTT: Record<City, Record<Region, number>> = {
  // Illustrative round trips over the internet, in milliseconds.
  Delhi: { Mumbai: 30, Frankfurt: 130 },
  Dubai: { Mumbai: 40, Frankfurt: 110 },
  London: { Mumbai: 120, Frankfurt: 20 },
}
const CODE: Record<Region, string> = { Mumbai: 'ap-south-1', Frankfurt: 'eu-central-1' }
const RATE = 1000 // requests a second from each city's users
const R53_THRESHOLD = 3 // failed checks in a row before Route 53 marks an endpoint unhealthy
const ALB_UNHEALTHY = 2 // ALB default: failed checks in a row before a target is taken out
const APIGW_RPS = 10_000 // API Gateway (HTTP APIs here): requests a second per account per Region
const APIGW_BURST = 5_000

type Failure = 'none' | 'region' | 'zone'

interface Options {
  city: City
  global: 'dns' | 'anycast'
  failure: Failure
  ttl: number
  interval: number
}

function plan(o: Options) {
  const best = (Object.keys(RTT[o.city]) as Region[]).sort((a, b) => RTT[o.city][a] - RTT[o.city][b])[0]
  const other: Region = best === 'Mumbai' ? 'Frankfurt' : 'Mumbai'
  const regionDown = o.failure === 'region' && best === 'Mumbai'
  const zoneDown = o.failure === 'zone' && best === 'Mumbai'
  const detect = o.interval * R53_THRESHOLD
  // DNS: users keep the cached answer until it expires, at a random point within the TTL.
  const worst = regionDown ? (o.global === 'dns' ? detect + o.ttl : detect) : 0
  const average = regionDown ? (o.global === 'dns' ? detect + o.ttl / 2 : detect) : 0
  const albDetect = o.interval * ALB_UNHEALTHY
  // A dead zone holds half the targets: half the requests fail until the ALB takes them out.
  const zoneFailed = zoneDown ? RATE * 0.5 * albDetect : 0
  const servedBy: Region = regionDown ? other : best
  return { best, other, regionDown, zoneDown, detect, worst, average, failed: RATE * average + zoneFailed, albDetect, zoneFailed, servedBy, rtt: RTT[o.city][servedBy] }
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')

const simulator: Simulator = {
  fields: [
    { id: 'city', label: 'User in', options: ['Delhi', 'Dubai', 'London'] },
    { id: 'global', label: 'Global layer', options: ['Route 53 latency routing (DNS)', 'Global Accelerator (anycast IPs)'] },
    { id: 'failure', label: 'What breaks', options: ['Nothing', 'The Mumbai region', 'One zone in Mumbai'] },
    { id: 'ttl', label: 'DNS record TTL', options: ['60 s', '300 s'] },
    { id: 'interval', label: 'Health checks', options: ['Every 30 s (default)', 'Every 10 s (fast)'] },
  ],
  defaults: { city: 'Delhi', global: 'Route 53 latency routing (DNS)', failure: 'Nothing', ttl: '60 s', interval: 'Every 30 s (default)' },
  run(values) {
    const o: Options = {
      city: (values.city as City) ?? 'Delhi',
      global: values.global.startsWith('Global') ? 'anycast' : 'dns',
      failure: values.failure.startsWith('The') ? 'region' : values.failure.startsWith('One') ? 'zone' : 'none',
      ttl: values.ttl.startsWith('300') ? 300 : 60,
      interval: values.interval.includes('10') ? 10 : 30,
    }
    const r = plan(o)
    const steps: Trace['steps'] = []
    const dns = o.global === 'dns'
    const apiGw = `API Gateway (${r.servedBy})`
    const alb = `ALB (${r.servedBy})`
    const tasks = `Orders Tasks (${r.servedBy})`

    steps.push({
      text: dns
        ? `A user in ${o.city} opens the app, which calls api.shopkart.in. Route 53 has one record for each region, and answers with the region that has the lowest latency from the user's DNS resolver: ${r.best}.`
        : `A user in ${o.city} opens the app, which calls api.shopkart.in. The name always resolves to the same two static IP addresses. They are anycast: the same addresses are announced from AWS edge locations worldwide, so the user's packets enter AWS's own network at the nearest one, then travel to the nearest healthy region: ${r.best}.`,
      nodes: dns ? ['User', 'Route 53'] : ['User', 'Global Accelerator'],
      data: [
        `round trip from ${o.city} (illustrative):`,
        ...(['Mumbai', 'Frankfurt'] as Region[]).map((g) => `  ${g.padEnd(10)} ${CODE[g].padEnd(13)} ${RTT[o.city][g]} ms${g === r.best ? '  ← closest' : ''}`),
        dns ? `answer cached for ${o.ttl} s (the record's TTL)` : 'answer: 2 static IPs, the same for everyone',
      ].join('\n'),
    })

    steps.push({
      text: `Is the region healthy? Health Checkers in many places send GET /health/deep to each region every ${o.interval} s. A region that fails ${R53_THRESHOLD} checks in a row is marked unhealthy: that takes ${r.detect} s. Route 53 counts an endpoint healthy while more than 18% of its checkers say so.`,
      nodes: ['Health Checkers', 'Healthy Region?'],
      data: [
        `check every:        ${o.interval} s`,
        `unhealthy after:    ${R53_THRESHOLD} failures in a row`,
        `time to notice:     ${o.interval} × ${R53_THRESHOLD} = ${r.detect} s`,
        `the check calls:    /health/deep (the API and its database)`,
      ].join('\n'),
    })

    if (r.regionDown) {
      steps.push({
        text: dns
          ? `At 0 s the Mumbai region stops answering. After ${r.detect} s Route 53 stops giving out Mumbai's address. But resolvers and phones that cached it keep using it until their copy expires: up to ${o.ttl} s more. ${o.city}'s users fail for up to ${r.worst} s; ${r.average} s on average.`
          : `At 0 s the Mumbai region stops answering. After ${r.detect} s Global Accelerator marks it unhealthy, and new connections go to Frankfurt at once. The IP addresses never change, so there's no cached DNS answer to wait for. Open connections to Mumbai break, and the app reconnects.`,
        nodes: dns ? ['Route 53', 'Healthy Region?', 'API Gateway (Frankfurt)'] : ['Global Accelerator', 'Healthy Region?', 'API Gateway (Frankfurt)'],
        data: [
          `0 s      Mumbai stops answering`,
          `${`${r.detect} s`.padEnd(8)} marked unhealthy (${R53_THRESHOLD} × ${o.interval} s)`,
          dns ? `${`${r.worst} s`.padEnd(8)} the last cached answers expire (+ TTL ${o.ttl} s)` : `${`${r.detect} s`.padEnd(8)} new connections go to Frankfurt`,
          `requests failed: about ${int(RATE * r.average)} (${int(RATE)}/s × ${r.average} s)`,
        ].join('\n'),
      })
    } else {
      steps.push({
        text: o.failure === 'region'
          ? `The Mumbai region is down, but ${o.city}'s users were already going to Frankfurt. They notice nothing. Frankfurt must now also carry Mumbai's users, so it needs room to grow.`
          : `Both regions are healthy, so ${o.city}'s users go to ${r.best}.${dns ? ` Their resolver remembers the answer for ${o.ttl} s, then asks again.` : ''}`,
        nodes: ['Healthy Region?', apiGw],
        data: `${o.city} → ${r.servedBy} (${r.rtt} ms round trip)`,
      })
    }

    steps.push({
      text: `In ${r.servedBy}, the request reaches ${apiGw}. It checks the user's token, applies rate limits and maps POST /api/orders to the orders service. The account may send ${int(APIGW_RPS)} requests a second through API Gateway in each region, with bursts of up to ${int(APIGW_BURST)} (a token bucket). A call to the service may take at most 30 s.`,
      nodes: [apiGw],
      data: [
        `POST /api/orders`,
        `Authorization: Bearer eyJhbGciOi…   → valid, user 4471`,
        `throttle: ${int(RATE)} of ${int(APIGW_RPS)} requests/s used`,
        `route: /api/orders/* → VPC link → internal ALB`,
      ].join('\n'),
    })

    steps.push({
      text: `${alb} is the local load balancer. Its rule sends /api/orders/* to the orders target group, and it picks a healthy task in either of the region's two zones. It checks each task's /status every ${o.interval} s, and takes a task out after ${ALB_UNHEALTHY} failures in a row: ${r.albDetect} s.`,
      nodes: [alb, tasks],
      data: [
        `rule:    path /api/orders/* → tg-orders`,
        `targets: 10.0.1.17 (zone a), 10.0.2.40 (zone b)`,
        `health:  GET /status every ${o.interval} s, out after ${ALB_UNHEALTHY} failures (${r.albDetect} s)`,
      ].join('\n'),
    })

    if (r.zoneDown) {
      steps.push({
        text: `One of Mumbai's zones goes dark. The region is still healthy (the other zone answers), so the global layer does nothing, and it shouldn't. ${alb} keeps sending half the requests to the dead zone until its health checks take those tasks out: ${r.albDetect} s.`,
        nodes: [alb, tasks, 'Healthy Region?'],
        data: [
          `requests to the dead zone: 50% for ${r.albDetect} s`,
          `failed: about ${int(r.zoneFailed)} (${int(RATE)}/s × 0.5 × ${r.albDetect} s)`,
          `then: every request goes to zone b`,
        ].join('\n'),
      })
    }

    steps.push({
      text: r.regionDown
        ? `The order is served from Frankfurt. It works, but a round trip from ${o.city} is now ${r.rtt} ms instead of ${RTT[o.city].Mumbai}, and the orders must already be in Frankfurt's database: that's why the two databases replicate.`
        : `The task saves the order in ${r.servedBy}'s database and answers. Each layer made one decision: the global layer chose the region, API Gateway checked and routed the request, and the ALB chose the server.`,
      nodes: [tasks, `Orders DB (${r.servedBy})`, 'User'],
      data: [
        `served by:   ${r.servedBy} (${CODE[r.servedBy]})`,
        `round trip:  ${r.rtt} ms (illustrative)`,
        `failed requests during the incident: about ${int(r.failed)}`,
      ].join('\n'),
    })

    return {
      input: `${o.city} · ${dns ? `DNS, TTL ${o.ttl} s` : 'anycast'} · checks every ${o.interval} s · ${o.failure === 'none' ? 'all healthy' : o.failure === 'region' ? 'Mumbai down' : 'one Mumbai zone down'} → ${r.servedBy}${r.failed ? `, about ${int(r.failed)} failed` : ''}`,
      steps,
    }
  },
}

export const globalLoadBalancing: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'global-load-balancing',
  title: 'Global vs Local Load Balancing',
  blurb: 'Route 53, Global Accelerator, API Gateway and ALB: which layer picks the region, which checks the request, which picks the server, and how fast each fails over',
  guides: ['api-gateway-101'],
  takeaways: [
    'A global load balancer picks the region, an API gateway checks and routes the request, and a local load balancer picks the server: three layers, three decisions.',
    'Route 53 balances with DNS answers, so a failover also waits for cached answers to expire: detection plus the TTL.',
    'Global Accelerator gives users two static anycast IP addresses, so failover needs no DNS change: only the time to notice.',
    'Health checks decide how fast you fail over: 3 failures every 30 s is 90 s; every 10 s it is 30 s.',
    'A zone failure is the local load balancer\'s job; a region failure is the global layer\'s. Don\'t make the global layer react to one bad server.',
    'Failing over a region only works if the other region has the data and the spare capacity to take the traffic.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'global', label: 'Global layer' },
      { id: 'mumbai', label: 'Mumbai (ap-south-1)' },
      { id: 'frankfurt', label: 'Frankfurt (eu-central-1)' },
    ],
    nodes: [
      { id: 'user', label: 'User', shape: 'ellipse', color: 'blue', group: null },
      { id: 'r53', label: 'Route 53', shape: 'rectangle', color: 'violet', group: 'global' },
      { id: 'ga', label: 'Global Accelerator', shape: 'rectangle', color: 'violet', group: 'global' },
      { id: 'healthy', label: 'Healthy Region?', shape: 'diamond', color: 'violet', group: 'global' },
      { id: 'checkers', label: 'Health Checkers', shape: 'rectangle', color: 'orange', group: 'global' },
      { id: 'cdn', label: 'CloudFront', shape: 'cloud', color: 'red', group: null },
      { id: 'apiM', label: 'API Gateway (Mumbai)', shape: 'rectangle', color: 'violet', group: 'mumbai' },
      { id: 'albM', label: 'ALB (Mumbai)', shape: 'rectangle', color: 'violet', group: 'mumbai' },
      { id: 'tasksM', label: 'Orders Tasks (Mumbai)', shape: 'rectangle', color: 'violet', group: 'mumbai' },
      { id: 'dbM', label: 'Orders DB (Mumbai)', shape: 'rectangle', color: 'green', group: 'mumbai' },
      { id: 'apiF', label: 'API Gateway (Frankfurt)', shape: 'rectangle', color: 'violet', group: 'frankfurt' },
      { id: 'albF', label: 'ALB (Frankfurt)', shape: 'rectangle', color: 'violet', group: 'frankfurt' },
      { id: 'tasksF', label: 'Orders Tasks (Frankfurt)', shape: 'rectangle', color: 'violet', group: 'frankfurt' },
      { id: 'dbF', label: 'Orders DB (Frankfurt)', shape: 'rectangle', color: 'green', group: 'frankfurt' },
    ],
    edges: [
      { from: 'user', to: 'r53', label: 'DNS lookup', dashed: false },
      { from: 'user', to: 'ga', label: 'or: anycast IPs', dashed: true },
      { from: 'user', to: 'cdn', label: 'images, scripts', dashed: false },
      { from: 'r53', to: 'healthy', label: 'latency record', dashed: false },
      { from: 'ga', to: 'healthy', label: 'nearest healthy region', dashed: false },
      { from: 'checkers', to: 'healthy', label: 'every 30 s', dashed: false },
      { from: 'healthy', to: 'apiM', label: 'Mumbai', dashed: false },
      { from: 'healthy', to: 'apiF', label: 'Frankfurt', dashed: false },
      { from: 'checkers', to: 'apiM', label: 'GET /health/deep', dashed: true },
      { from: 'checkers', to: 'apiF', label: 'GET /health/deep', dashed: true },
      { from: 'apiM', to: 'albM', label: 'VPC link', dashed: false },
      { from: 'albM', to: 'tasksM', label: '/api/orders/*', dashed: false },
      { from: 'tasksM', to: 'dbM', label: 'SQL', dashed: false },
      { from: 'apiF', to: 'albF', label: 'VPC link', dashed: false },
      { from: 'albF', to: 'tasksF', label: '/api/orders/*', dashed: false },
      { from: 'tasksF', to: 'dbF', label: 'SQL', dashed: false },
      { from: 'dbM', to: 'dbF', label: 'replication', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Global vs Local Load Balancing',
    summary:
      'An app that runs in two regions needs three kinds of routing. A global load balancer (Route 53 with DNS, or Global Accelerator with anycast IP addresses) sends each user to a healthy region near them. An API gateway checks each request (tokens, rate limits) and routes it to the right service. A local load balancer (an ALB) spreads requests across healthy servers in the region\'s zones. Each layer handles a different failure, at a different speed.',
    sections: [
      {
        heading: 'Overview',
        body: 'Load balancing happens at more than one level. Inside a region, a load balancer such as AWS\'s Application Load Balancer (ALB) spreads requests across servers in two or three availability zones (separate data centres in the region). Across regions, something has to choose the region before the request even leaves the user\'s phone.\n\nThat global choice is made in one of two ways. Route 53 (AWS\'s DNS service) answers the name lookup with the address of the best region. Global Accelerator gives the app two fixed IP addresses that are announced from AWS edge locations everywhere, and routes inside AWS\'s network.\n\nBetween the two, an API gateway is not really a load balancer: it is the front door for APIs, checking tokens and limits and routing by path to services. The simulator sends a user in Delhi, Dubai or London through all three layers, then breaks a region or a zone.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Send each user to the nearest healthy region.\n- Move users to the other region when one fails, without a code change or a manual step.\n- Check tokens and rate limits before requests reach services; route /api/orders and other paths to the right service.\n- Spread requests across healthy servers in at least two zones per region.\n\nNon-functional:\n- Region failover in under 2 minutes; zone failover in under 1 minute.\n- No single point of failure in any layer.\n- Each region can take the other\'s traffic.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Each city\'s users: 1,000 requests a second.\n- Route 53 health checks: 3 failures in a row before an endpoint is unhealthy. Every 30 s: 90 s to notice; every 10 s (fast, costs extra): 30 s.\n- With DNS, users also wait for cached answers to expire: up to the TTL. A 60 s TTL makes the worst case 90 + 60 = 150 s; a 300 s TTL makes it 390 s.\n- Failed requests from Delhi during a Mumbai outage, on average: 1,000 × (90 + 30) = 120,000 with DNS and a 60 s TTL; 1,000 × 90 = 90,000 with Global Accelerator; 30,000 with Global Accelerator and 10 s checks.\n- A zone outage: half the requests go to dead tasks for 2 × 30 = 60 s, so 1,000 × 0.5 × 60 = 30,000 fail.\n- API Gateway (an HTTP API here): 10,000 requests a second per account per region by default, bursts up to 5,000; payloads up to 10 MB; a call to the service may take at most 30 s.',
      },
      {
        heading: 'Step by step',
        body: '1. The User\'s app looks up api.shopkart.in. Route 53 answers with the closest healthy region; or, with Global Accelerator, the name always gives the same two anycast IP addresses.\n2. Health Checkers call each region\'s /health/deep every 30 s; Healthy Region? decides which regions may receive users.\n3. Images and scripts come from CloudFront, close to the user; API calls go to the chosen region.\n4. API Gateway (Mumbai) checks the token and rate limit, and routes /api/orders through a VPC link (a private connection into the region\'s network) to ALB (Mumbai).\n5. ALB (Mumbai) matches the path rule and picks a healthy task among the Orders Tasks (Mumbai), in either zone.\n6. The task writes to Orders DB (Mumbai), which replicates to Orders DB (Frankfurt).\n7. If Mumbai fails, Healthy Region? sends users to API Gateway (Frankfurt), then ALB (Frankfurt) and the Orders Tasks (Frankfurt).',
      },
      {
        heading: 'Components',
        body: '- User: someone using the app, in Delhi, Dubai or London.\n- Route 53: AWS\'s DNS service; latency-based records answer with the region closest to the user\'s resolver, skipping unhealthy ones.\n- Global Accelerator: two static anycast IP addresses; traffic enters AWS at the nearest edge location and goes to the nearest healthy region.\n- Healthy Region?: the decision both global options make: is this region allowed to receive users?\n- Health Checkers: probes in many locations that call each region\'s deep health endpoint.\n- CloudFront: AWS\'s CDN (content delivery network), serving images and scripts from near the user.\n- API Gateway (Mumbai): checks tokens, applies rate limits and routes API paths to services in Mumbai.\n- ALB (Mumbai): the local load balancer; routes by path and spreads requests across healthy tasks in two zones.\n- Orders Tasks (Mumbai): the orders service\'s containers in Mumbai.\n- Orders DB (Mumbai): Mumbai\'s database; replicates to Frankfurt.\n- API Gateway (Frankfurt): the same front door in Frankfurt.\n- ALB (Frankfurt): Frankfurt\'s local load balancer.\n- Orders Tasks (Frankfurt): the orders service\'s containers in Frankfurt.\n- Orders DB (Frankfurt): Frankfurt\'s copy of the data, ready to take over.',
      },
      {
        heading: 'Key decisions',
        body: '- DNS or anycast: Route 53 is simple, cheap and works for anything with a name, but failover waits for cached answers. Global Accelerator fails over without DNS, keeps fixed IP addresses (useful when customers allow-list them), and handles TCP and UDP; it costs more.\n- Routing policy: latency (closest region), geolocation (by country, for data rules), weighted (shift 10% to a new region), failover (active and standby).\n- Health checks that mean something: the global check should ask "can this region serve an order?" (the API and its database), while the ALB\'s check on each task stays shallow.\n- TTL: 60 s for records that may move. Alias records to AWS endpoints use the target\'s TTL.\n- API gateway or not: use one for authentication, rate limits, API keys and routing across many services; a small app can put an ALB straight behind the global layer.\n- Active-active or active-passive: both regions serving halves the blast radius but needs data written in both places; a standby region is simpler but its capacity sits idle.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A region failure is the global layer\'s job; a zone or server failure is the ALB\'s. A global check that fails on one bad server moves a whole region\'s users for nothing.\n- The surviving region must take the other\'s traffic: keep headroom, or scale it before you need it.\n- Data: failover only helps if the other region has the data. Replication is usually asynchronous, so the last seconds of writes may be missing.\n- DNS caching is out of your control: some resolvers and apps keep answers longer than the TTL. Global Accelerator avoids this.\n- Flapping: a region that fails and recovers again and again moves users back and forth. Require several healthy checks before moving users back.\n- Test failover regularly by switching a region off on purpose.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the difference between a global load balancer, an API gateway and a local load balancer?\n- Why does DNS failover take longer than the health checks alone?\n- How does anycast let Global Accelerator fail over without changing DNS?\n- What should a region\'s health check test, and what should a server\'s?\n- One zone fails. Which layer should react, and how quickly?\n- What has to be true about the data before you fail over a region?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A deep health check for the region',
        language: 'javascript',
        source: `import express from 'express'
import { pool } from './db.js'

const app = express()

// For the ALB: "can this process serve?" Fast, and no calls to other services,
// or one slow database would take every task out at once.
app.get('/status', (req, res) => res.json({ ok: true }))

// For Route 53 or Global Accelerator: "can this region take an order?"
// It checks the database, with a short timeout, so a broken region is moved out.
app.get('/health/deep', async (req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ])
    res.json({ ok: true, region: process.env.AWS_REGION })
  } catch (err) {
    res.status(503).json({ ok: false, region: process.env.AWS_REGION, error: err.message })
  }
})

app.listen(8080)`,
        versions: [
          {
            language: 'java',
            source: `import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.sql.Connection;
import java.sql.DriverManager;

public class Health {
  public static void main(String[] args) throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
    String region = System.getenv("AWS_REGION");

    // For the ALB: "can this process serve?" Fast, no calls to other services.
    server.createContext("/status", ex -> reply(ex, 200, "{\\"ok\\":true}"));

    // For Route 53 or Global Accelerator: "can this region take an order?" Checks the database.
    server.createContext("/health/deep", ex -> {
      try (Connection db = DriverManager.getConnection(System.getenv("DATABASE_URL"))) {
        boolean ok = db.isValid(2); // seconds
        reply(ex, ok ? 200 : 503, "{\\"ok\\":" + ok + ",\\"region\\":\\"" + region + "\\"}");
      } catch (Exception e) {
        reply(ex, 503, "{\\"ok\\":false,\\"region\\":\\"" + region + "\\"}");
      }
    });
    server.start();
  }

  static void reply(com.sun.net.httpserver.HttpExchange ex, int status, String body) throws java.io.IOException {
    byte[] bytes = body.getBytes();
    ex.getResponseHeaders().add("Content-Type", "application/json");
    ex.sendResponseHeaders(status, bytes.length);
    ex.getResponseBody().write(bytes);
    ex.close();
  }
}`,
          },
        ],
      },
      {
        title: 'Route 53 latency records with health checks (bash)',
        language: 'bash',
        source: `cat > dns.tf <<'EOF'
# One health check and one latency record per region. Both records have the same
# name; Route 53 answers with the closest region whose health check passes.
resource "aws_route53_health_check" "mumbai" {
  fqdn              = "mumbai.api.shopkart.in"
  type              = "HTTPS"
  port              = 443
  resource_path     = "/health/deep"
  request_interval  = 30   # or 10, for faster failover at extra cost
  failure_threshold = 3    # 3 failures in a row: 90 s to notice
}

resource "aws_route53_record" "api_mumbai" {
  zone_id         = aws_route53_zone.main.zone_id
  name            = "api.shopkart.in"
  type            = "A"
  set_identifier  = "mumbai"
  health_check_id = aws_route53_health_check.mumbai.id
  latency_routing_policy { region = "ap-south-1" }
  alias {
    # Mumbai's API Gateway custom domain for api.shopkart.in
    name                   = aws_apigatewayv2_domain_name.mumbai.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.mumbai.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false # the health check above decides
  }
}
# ...and the same two resources for Frankfurt (eu-central-1).
EOF

terraform apply
dig +noall +answer api.shopkart.in   # from Delhi: Mumbai's addresses`,
      },
    ],
    related: ['Load balancer', 'API gateway', 'AWS Application Load Balancer', 'Disaster recovery on AWS', 'CDN', 'Rate limiter'],
  },
  simulator,
}
