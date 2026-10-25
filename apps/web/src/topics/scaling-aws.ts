import type { Trace } from '@structura/shared'
import type { Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design a system that scales to millions of users on AWS" in the
// System Design Primer by Donne Martin (CC BY 4.0). The stage-by-stage path
// (one box, split the database, balance and cache, queue, shard) follows the
// primer; the sizing model, walkthrough, simulator and code are Structura's.

const SECONDS_PER_MONTH = 30 * 24 * 3600
/** Requests one monthly user makes: about 100 a day. */
const REQUESTS_PER_USER_MONTH = 3_000
/** A well-tuned web server handles about 400 requests a second (primer rule: 400 rps ≈ 1 billion a month). */
const RPS_PER_WEB_SERVER = 400
/** Busy hour versus the average second. */
const PEAK_FACTOR = 3
/** Share of reads the cache answers once it exists. */
const CACHE_HIT = 0.8
/** One RDS read replica, and one primary's write limit, in queries a second. */
const READS_PER_REPLICA = 1_500
const WRITES_PER_PRIMARY = 3_000

const USERS: Record<string, number> = {
  '1,000 monthly users': 1_000,
  '10,000 monthly users': 10_000,
  '100,000 monthly users': 100_000,
  '1 million monthly users': 1_000_000,
  '10 million monthly users': 10_000_000,
}

/** Reads per write. */
const MIXES: Record<string, number> = {
  'Read-heavy (100 reads per write)': 100,
  'Balanced (10 reads per write)': 10,
  'Write-heavy (2 reads per write)': 2,
}

const fmt = (n: number) => n.toLocaleString('en-US')

/** The stage of the architecture a given user count needs. */
function stageOf(users: number): number {
  if (users < 10_000) return 1
  if (users < 100_000) return 2
  if (users < 1_000_000) return 3
  if (users < 10_000_000) return 4
  return 5
}

const STAGE_NAMES = [
  '',
  'Stage 1: one box',
  'Stage 2: split the database off',
  'Stage 3: balance, cache and replicate',
  'Stage 4: auto scale and go async',
  'Stage 5: shard the data',
]

function size(users: number, readsPerWrite: number) {
  const avgRps = (users * REQUESTS_PER_USER_MONTH) / SECONDS_PER_MONTH
  const peakRps = Math.ceil(avgRps * PEAK_FACTOR)
  const reads = Math.round((peakRps * readsPerWrite) / (readsPerWrite + 1))
  const writes = peakRps - reads
  const stage = stageOf(users)
  const hit = stage >= 3 ? CACHE_HIT : 0
  const dbReads = Math.ceil(reads * (1 - hit))
  const webServers = Math.max(stage >= 3 ? 2 : 1, Math.ceil(peakRps / RPS_PER_WEB_SERVER))
  const replicas = stage >= 3 ? Math.max(1, Math.ceil(dbReads / READS_PER_REPLICA)) : 0
  const shards = stage >= 5 ? Math.max(2, Math.ceil(writes / WRITES_PER_PRIMARY)) : 1
  return { avgRps, peakRps, reads, writes, stage, hit, dbReads, webServers, replicas, shards }
}

const simulator: Simulator = {
  fields: [
    { id: 'users', label: 'How many users', options: Object.keys(USERS) },
    { id: 'mix', label: 'Traffic mix', options: Object.keys(MIXES) },
    { id: 'action', label: 'What to see', options: ['Follow one read request', 'Follow one write request', 'Size the fleet'] },
  ],
  defaults: { users: '1 million monthly users', mix: 'Read-heavy (100 reads per write)', action: 'Follow one read request' },
  run({ users, mix, action }) {
    const u = USERS[users] ?? USERS['1 million monthly users']
    const ratio = MIXES[mix] ?? 100
    const s = size(u, ratio)
    const steps: Trace['steps'] = []
    const input = `${users}, ${mix.split(' (')[0].toLowerCase()} traffic`
    const rpsLine = `average ${s.avgRps.toFixed(1)} req/s → peak ${fmt(s.peakRps)} req/s (×${PEAK_FACTOR})\nreads ${fmt(s.reads)}/s, writes ${fmt(s.writes)}/s`

    if (action === 'Size the fleet') {
      steps.push({
        text: `${users} make ${fmt(REQUESTS_PER_USER_MONTH)} requests each a month, about 100 a day. That is ${fmt(u * REQUESTS_PER_USER_MONTH)} requests a month. The busy hour runs at ${PEAK_FACTOR} times the average, and you size for the busy hour.`,
        nodes: ['Users'],
        data: `${fmt(u)} users × ${fmt(REQUESTS_PER_USER_MONTH)} req ÷ ${fmt(SECONDS_PER_MONTH)} s\n${rpsLine}`,
      })
      steps.push({
        text: s.stage >= 3
          ? `One web server handles about ${RPS_PER_WEB_SERVER} requests a second, so the peak needs ${s.webServers} behind the Load Balancer (ELB), spread over two availability zones.`
          : `One web server handles about ${RPS_PER_WEB_SERVER} requests a second, so ${s.webServers} server${s.webServers > 1 ? 's' : ''} cover the peak. ${s.stage === 1 ? 'No load balancer yet: it would be one more thing to run.' : 'Still a single web server: scale it up (a bigger instance), not out.'}`,
        nodes: s.stage >= 3 ? ['Load Balancer (ELB)', 'Web Servers (Auto Scaling)'] : ['Web Servers (Auto Scaling)'],
        data: `ceil(${fmt(s.peakRps)} ÷ ${RPS_PER_WEB_SERVER}) = ${Math.ceil(s.peakRps / RPS_PER_WEB_SERVER)}${s.stage >= 3 ? ` (minimum 2 for availability)` : ''} → ${s.webServers} web server${s.webServers > 1 ? 's' : ''}`,
      })
      if (s.stage >= 3) {
        steps.push({
          text: `The Memory Cache (ElastiCache) answers ${Math.round(s.hit * 100)}% of reads, so only ${fmt(s.dbReads)} of ${fmt(s.reads)} reads a second reach SQL. Each read replica serves about ${fmt(READS_PER_REPLICA)} reads a second, so that needs ${s.replicas} replica${s.replicas > 1 ? 's' : ''}.`,
          nodes: ['Memory Cache (ElastiCache)', 'SQL Read Replicas (RDS)'],
          data: `${fmt(s.reads)} reads × (1 − ${s.hit}) = ${fmt(s.dbReads)} reads/s\nceil(${fmt(s.dbReads)} ÷ ${fmt(READS_PER_REPLICA)}) = ${s.replicas} replica${s.replicas > 1 ? 's' : ''}`,
        })
      }
      steps.push({
        text: s.stage >= 5
          ? `${fmt(s.writes)} writes a second is ${s.writes > WRITES_PER_PRIMARY ? `more than one primary can take (about ${fmt(WRITES_PER_PRIMARY)})` : 'near the limit of one primary'}. Replicas do not help writes, so the data is sharded: ${s.shards} SQL Primary (RDS) shards, each owning a slice of users.`
          : `${fmt(s.writes)} writes a second fits on one SQL Primary (RDS), whose limit is about ${fmt(WRITES_PER_PRIMARY)}. Sharding would be premature.`,
        nodes: ['SQL Primary (RDS)'],
        data: s.stage >= 5 ? `ceil(${fmt(s.writes)} ÷ ${fmt(WRITES_PER_PRIMARY)}) = ${Math.ceil(s.writes / WRITES_PER_PRIMARY)} → ${s.shards} shards (minimum 2)` : `${fmt(s.writes)} writes/s < ${fmt(WRITES_PER_PRIMARY)} → 1 primary`,
      })
      steps.push({
        text: `${STAGE_NAMES[s.stage]}. That is the cheapest design that survives this load; the next stage only pays off when a number above hits its limit.`,
        nodes: ['Users', 'Web Servers (Auto Scaling)'],
        data: `stage ${s.stage} of 5`,
      })
      return { input, steps }
    }

    const write = action === 'Follow one write request'
    const key = write ? 'POST /api/v1/posts' : 'GET /api/v1/feed?user_id=4821'
    steps.push({
      text: s.stage >= 2
        ? `The Users' browser asks DNS (Route 53) for the site's address. DNS is the first thing you move off the box: it also lets you change servers later without telling anyone.`
        : `The Users' browser asks DNS (Route 53) for the site's address and gets the Elastic IP of the one server.`,
      nodes: ['Users', 'DNS (Route 53)'],
      data: s.stage >= 3 ? 'app.example.com → Load Balancer (ELB) address' : 'app.example.com → 54.210.17.8 (Elastic IP)',
    })
    if (s.stage >= 3 && !write) {
      steps.push({
        text: 'Static files (images, scripts, styles) never reach the web servers: the CDN (CloudFront) serves them from an edge near the user, which cuts latency and load together.',
        nodes: ['Users', 'CDN (CloudFront)', 'Object Store (S3)'],
        data: 'GET /static/app.4f2c.js → edge cache HIT (served in ~15 ms)',
      })
    }
    steps.push(
      s.stage >= 3
        ? { text: `The Load Balancer (ELB) spreads requests across ${s.webServers} Web Servers (Auto Scaling) in two availability zones and stops sending traffic to one that fails its health check.`, nodes: ['Users', 'Load Balancer (ELB)', 'Web Servers (Auto Scaling)'], data: `${key}\n→ web-${(u % s.webServers) + 1} of ${s.webServers}` }
        : { text: 'The request goes straight to the single server, which runs the web app and its code together.', nodes: ['Users', 'Web Servers (Auto Scaling)'], data: key },
    )
    if (s.stage >= 4) {
      steps.push({ text: 'The web servers are stateless and only render and route; the business logic runs on separate API Servers (Auto Scaling), so each tier scales on its own.', nodes: ['Web Servers (Auto Scaling)', 'API Servers (Auto Scaling)'], data: 'sessions live in the cache, not on the server: any server can take any request' })
    }
    const app = s.stage >= 4 ? 'API Servers (Auto Scaling)' : 'Web Servers (Auto Scaling)'
    if (write) {
      steps.push({
        text: s.stage >= 5
          ? `The write goes to the one SQL Primary (RDS) shard that owns this user: shard = user_id mod ${s.shards}. Only that shard's primary takes the write.`
          : 'The write goes to the SQL Primary (RDS). Writes always go to the primary, never to a replica.',
        nodes: [app, 'SQL Primary (RDS)'],
        data: s.stage >= 5 ? `4821 mod ${s.shards} = ${4821 % s.shards} → shard ${4821 % s.shards}\nINSERT INTO posts (user_id, body) VALUES (4821, 'hello');` : `INSERT INTO posts (user_id, body) VALUES (4821, 'hello');`,
      })
      if (s.stage >= 3) {
        steps.push({ text: 'The primary copies the change to its read replicas. That copy is asynchronous, so a replica can be a few milliseconds behind: a reader may briefly not see a post that was just made.', nodes: ['SQL Primary (RDS)', 'SQL Read Replicas (RDS)'], data: 'replication lag ≈ 5–50 ms' })
        steps.push({ text: 'The now-stale cached feed is deleted so the next read rebuilds it.', nodes: [app, 'Memory Cache (ElastiCache)'], data: 'DEL feed:4821' })
      }
      if (s.stage >= 4) {
        steps.push({ text: 'Slow follow-up work (resizing an uploaded image, sending notifications) is put on the Queue (SQS) and the user gets their answer straight away. Workers (Auto Scaling) pick it up, and the fleet grows when the queue gets long.', nodes: [app, 'Queue (SQS)', 'Workers (Auto Scaling)', 'Object Store (S3)'], data: 'SendMessage { "job": "resize", "key": "uploads/9f3.jpg" }\nqueue depth 120 → scale workers 2 → 6' })
      }
      steps.push({ text: 'The server answers once the write is saved.', nodes: [app, 'Users'], data: 'HTTP/1.1 201 Created' })
      return { input, steps }
    }
    if (s.stage >= 3) {
      steps.push({
        text: `The server checks the Memory Cache (ElastiCache) first. About ${Math.round(s.hit * 100)}% of reads hit, so only ${fmt(s.dbReads)} of ${fmt(s.reads)} reads a second go on to SQL.`,
        nodes: [app, 'Memory Cache (ElastiCache)'],
        data: `GET feed:4821 → HIT (80%) | MISS (20%)\ncache absorbs ${fmt(s.reads - s.dbReads)} reads/s`,
      })
      steps.push({
        text: `On a miss it reads from one of ${s.replicas} SQL Read Replicas (RDS) and refills the cache. The primary stays free for writes.`,
        nodes: [app, 'SQL Read Replicas (RDS)'],
        data: `SELECT * FROM posts WHERE user_id = 4821 ORDER BY created_at DESC LIMIT 20;\n→ replica ${(4821 % s.replicas) + 1} of ${s.replicas}\nSET feed:4821 <result> EX 60`,
      })
    } else {
      steps.push({
        text: s.stage === 1 ? 'The server queries the database on the same machine.' : 'The server queries SQL Primary (RDS), a managed database on its own machine, with backups and failover handled by AWS.',
        nodes: [app, 'SQL Primary (RDS)'],
        data: 'SELECT * FROM posts WHERE user_id = 4821 ORDER BY created_at DESC LIMIT 20;',
      })
    }
    steps.push({ text: 'The server returns the page.', nodes: [app, 'Users'], data: 'HTTP/1.1 200 OK' })
    return { input, steps }
  },
}

export const scalingAws: StaticTopic = {
  kind: 'static',
  id: 'scaling-aws',
  title: 'Scaling to Millions of Users on AWS',
  blurb: 'From one server to a load-balanced, cached, sharded fleet, one bottleneck at a time',
  difficulty: 'Intermediate',
  adaptedFrom: {
    title: 'Design a system that scales to millions of users on AWS',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/scaling_aws/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: [
    'primer-design-a-system-that-scales-to-millions-of-users-on-aws',
    'primer-load-balancer',
    'primer-cache',
    'primer-database',
    'primer-content-delivery-network',
    'primer-asynchronism',
  ],
  takeaways: [
    'Start with one box and scale only when a measured number says so.',
    'Scale up first (a bigger machine), then out; keep web servers stateless so they can be copied.',
    'Move static files to object storage behind a CDN and hot reads into a cache before adding database replicas.',
    'Replicas multiply reads, not writes: past one primary, shard by user.',
    'Put slow work on a queue so the user gets an answer and workers scale on queue depth.',
    'Size for the busy hour, not the average, and keep every tier in at least two availability zones.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'edge', label: 'Edge' },
      { id: 'app', label: 'Application tier' },
      { id: 'data', label: 'Data tier' },
    ],
    nodes: [
      { id: 'users', label: 'Users', shape: 'ellipse', color: 'blue', group: null },
      { id: 'dns', label: 'DNS (Route 53)', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'cdn', label: 'CDN (CloudFront)', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'lb', label: 'Load Balancer (ELB)', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'web', label: 'Web Servers (Auto Scaling)', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'api', label: 'API Servers (Auto Scaling)', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'queue', label: 'Queue (SQS)', shape: 'rectangle', color: 'yellow', group: 'app' },
      { id: 'workers', label: 'Workers (Auto Scaling)', shape: 'rectangle', color: 'orange', group: 'app' },
      { id: 'cache', label: 'Memory Cache (ElastiCache)', shape: 'rectangle', color: 'red', group: 'data' },
      { id: 'primary', label: 'SQL Primary (RDS)', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'replicas', label: 'SQL Read Replicas (RDS)', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'objects', label: 'Object Store (S3)', shape: 'rectangle', color: 'green', group: 'data' },
    ],
    edges: [
      { from: 'users', to: 'dns', label: 'resolve name', dashed: true },
      { from: 'users', to: 'cdn', label: 'static files', dashed: false },
      { from: 'users', to: 'lb', label: 'HTTPS', dashed: false },
      { from: 'cdn', to: 'objects', label: 'origin', dashed: true },
      { from: 'lb', to: 'web', label: 'health-checked', dashed: false },
      { from: 'web', to: 'api', label: 'app logic', dashed: false },
      { from: 'api', to: 'cache', label: 'hot reads', dashed: false },
      { from: 'api', to: 'primary', label: 'writes', dashed: false },
      { from: 'api', to: 'replicas', label: 'cache misses', dashed: false },
      { from: 'primary', to: 'replicas', label: 'replication', dashed: true },
      { from: 'api', to: 'queue', label: 'slow jobs', dashed: false },
      { from: 'queue', to: 'workers', label: 'pull', dashed: false },
      { from: 'workers', to: 'objects', label: 'results', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'email', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'posts',
        name: 'posts',
        columns: [
          { name: 'post_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'body', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'image_key', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id, created_at DESC) — a user\'s feed; the shard key is user_id'],
      },
    ],
    relations: [{ from: 'posts', to: 'users', kind: 'one-to-many', label: 'writes' }],
  },
  explanation: {
    title: 'Scaling to Millions of Users on AWS',
    summary:
      'No system starts at millions of users. This topic follows one app from a single server to a sharded fleet, adding one idea at each stage: split the database off, balance and cache, auto scale and go async, then shard. You add each piece only when a measured number runs out.',
    sections: [
      {
        heading: 'Overview',
        body: 'The rule is: benchmark, profile, find the bottleneck, fix that one thing, repeat. Adding everything on day one costs money and complexity you do not need.\n\nThe five stages:\n- 1 to 10,000 users: one box.\n- 10,000 to 100,000: split the web server from the database.\n- 100,000 to 1 million: a load balancer, a cache, read replicas and a CDN.\n- 1 to 10 million: auto scaling, separate API servers, queues and workers.\n- 10 million and up: shard (split) the database.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A user reads and writes content through a web app and an API.\n- The app starts small and must grow to tens of millions of users without a rewrite.\n- Reads far outnumber writes.\n- High availability: one failed machine or one availability zone must not take the site down.\n\nOut of scope: analytics pipelines, search, and multi-region failover.',
      },
      {
        heading: 'Capacity estimates',
        body: 'The model used in the simulator:\n- A monthly user makes about 3,000 requests a month, roughly 100 a day.\n- A month has 2,592,000 seconds, and the busy hour runs about 3 times the average.\n- A tuned web server handles about 400 requests a second. As a rule of thumb, 400 requests per second is about 1 billion requests a month.\n\nWhich gives:\n- 1 million users: 3 billion requests a month, about 1,157 a second on average and 3,473 at the peak, so 9 web servers.\n- 10 million users: about 11,574 a second on average and 34,723 at the peak, so 87 web servers.\n- With a read-heavy 100:1 mix, a cache hit rate of 80% leaves only about 20% of reads for SQL.',
      },
      {
        heading: 'Step by step',
        body: '1. Users ask DNS (Route 53) for the site address.\n2. Static files come from the CDN (CloudFront), which pulls from the Object Store (S3) on a miss.\n3. Dynamic requests reach the Load Balancer (ELB), which sends them to a healthy one of the Web Servers (Auto Scaling).\n4. The Web Servers (Auto Scaling) pass work to the API Servers (Auto Scaling).\n5. Reads try the Memory Cache (ElastiCache) first; on a miss they read the SQL Read Replicas (RDS).\n6. Writes go to the SQL Primary (RDS), which copies them to the replicas.\n7. Slow work goes to the Queue (SQS), and Workers (Auto Scaling) process it and store results in the Object Store (S3).',
      },
      {
        heading: 'Components',
        body: '- Users: browsers and mobile apps; they reach the site by name.\n- DNS (Route 53): maps the site name to the right address, so servers can change behind it.\n- CDN (CloudFront): caches static files at edge locations near users.\n- Load Balancer (ELB): spreads requests across servers and skips unhealthy ones.\n- Web Servers (Auto Scaling): stateless servers; a group that adds or removes machines with load.\n- API Servers (Auto Scaling): the business logic, scaled separately from the web tier.\n- Queue (SQS): holds slow jobs so requests stay fast.\n- Workers (Auto Scaling): pull jobs from the queue; the group grows with queue depth.\n- Memory Cache (ElastiCache): in-memory store (Redis or Memcached) for hot reads and sessions.\n- SQL Primary (RDS): the one writable copy of the data.\n- SQL Read Replicas (RDS): read-only copies that share the read load.\n- Object Store (S3): cheap, durable storage for images, files and results.',
      },
      {
        heading: 'Key decisions',
        body: '- Scale up before out. A bigger instance is the simplest fix, until the biggest one is not enough or its failure is too costly.\n- Stateless web tier. Keep sessions in the cache, not in server memory, so any server can serve any request and the group can add or drop machines freely.\n- Cache before replicas. A cache hit costs microseconds and no database work.\n- Managed services (RDS, ElastiCache, SQS) trade money for fewer operations, which suits a small team.\n- Multi-AZ everywhere. Run at least two of each tier in different availability zones (separate data centres).\n- Read replicas versus sharding. Replicas multiply read capacity but every write still hits the one primary; sharding is the only way past that.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Auto Scaling targets a metric such as 50% average CPU; it adds machines before they saturate and removes them when quiet.\n- Replication lag: a replica may be milliseconds behind, so read your own writes from the primary when it matters.\n- Sharding costs a lot. Cross-shard joins and transactions get hard, rebalancing is painful, and a hot user can overload one shard. Federate by function and denormalize first.\n- Use NoSQL (for example DynamoDB) for data with simple access patterns and huge write volume.\n- Lock down the network: web servers in a public subnet, databases in a private one, security groups that allow only the tier above.\n- Watch it: alarms on latency, error rate, queue depth and replication lag.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you tell that it is time to move from stage 3 to stage 4?\n- What breaks if web servers keep sessions in memory?\n- How do you pick a shard key, and what happens when one shard is hotter than the rest?\n- A cache node dies at peak. What happens to the database, and how do you protect it?\n- How would you survive the loss of a whole region?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Cache-aside with replica reads',
        language: 'typescript',
        source: `import Redis from 'ioredis'
import { Pool } from 'pg'

const redis = new Redis(process.env.CACHE_URL)
const primary = new Pool({ connectionString: process.env.DB_PRIMARY })
const replicas = process.env.DB_REPLICAS!.split(',').map((url) => new Pool({ connectionString: url }))

export async function getFeed(userId: number) {
  const hit = await redis.get(\`feed:\${userId}\`)
  if (hit) return JSON.parse(hit) // ~80% of reads end here

  const replica = replicas[userId % replicas.length] // spread reads
  const { rows } = await replica.query(
    'SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [userId],
  )
  await redis.set(\`feed:\${userId}\`, JSON.stringify(rows), 'EX', 60) // short TTL bounds staleness
  return rows
}

export async function addPost(userId: number, body: string) {
  await primary.query('INSERT INTO posts (user_id, body) VALUES ($1, $2)', [userId, body])
  await redis.del(\`feed:\${userId}\`) // drop the stale copy
}`,
      },
      {
        title: 'Choosing a shard',
        language: 'typescript',
        source: `import { Pool } from 'pg'

const SHARDS = [0, 1, 2, 3].map((i) => new Pool({ connectionString: process.env[\`DB_SHARD_\${i}\`] }))

/** Same user, same shard, every time: a user's posts never need a cross-shard join. */
export const shardFor = (userId: number) => SHARDS[userId % SHARDS.length]

// Plain modulo means adding a shard moves almost every user.
// Consistent hashing, or many small logical shards mapped onto few servers, avoids that.`,
      },
      {
        title: 'Scale the web fleet on CPU',
        language: 'bash',
        source: `# Keep average CPU near 50%: add servers when busier, remove when quieter.
aws autoscaling put-scaling-policy \\
  --policy-name cpu-50 \\
  --auto-scaling-group-name web-asg \\
  --policy-type TargetTrackingScaling \\
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ASGAverageCPUUtilization"},
    "TargetValue": 50.0
  }'`,
      },
    ],
    related: ['Horizontal scaling', 'Load balancer', 'Read replicas', 'Cache-aside', 'Sharding', 'Auto Scaling', 'Availability zone'],
  },
  simulator,
}
