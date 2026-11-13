# Scaling to Millions of Users on AWS: Five Stages, One Bottleneck at a Time

> 💡 **TL;DR**: Nobody starts with a sharded fleet. Start with **one server**, then add one idea each time a **measured** number runs out: move the **database** to its own managed instance; put a **load balancer** in front of several **stateless** servers across AZs, with sessions in a **cache**, **read replicas** and a **CDN** for static files; add **Auto Scaling**, split web and API tiers, and move slow work to **queues and workers**; and only at the very top **shard** the database or move hot data to **DynamoDB**. Measure, find the bottleneck, fix that one thing, repeat.

Builds on [AWS Basics](/?topic=aws-basics&read). Each stage leans on another topic: [Application Load Balancer](/?topic=aws-alb&read), [Distributed Cache](/?topic=distributed-cache&read), [Database Sharding](/?topic=database-sharding&read).

---

## The stages at a glance

| Stage | Users | What breaks first | What you add |
| --- | --- | --- | --- |
| 1 | Up to ~10,000 | Nothing yet; one box is fine | One EC2 instance with the app and the database, DNS, backups |
| 2 | ~10,000 to 100,000 | App and database fight for the same CPU, memory and disk | RDS for the database, S3 for files, a private subnet |
| 3 | ~100,000 to 1 million | One web server can't keep up; the database is mostly busy with reads | Load balancer, 2+ stateless servers in 2 AZs, ElastiCache, read replicas, CloudFront |
| 4 | ~1 to 10 million | Traffic swings; slow work blocks requests; one tier needs scaling separately | Auto Scaling, separate web and API tiers, SQS and workers, monitoring and alarms |
| 5 | 10 million+ | Every write still goes to one primary database | Federation, sharding, denormalisation, DynamoDB for simple hot data |

The user counts are rough guides. What moves you to the next stage is a **number** (CPU, p99 latency, connections, replica lag, error rate), not a headcount.

---

## The capacity math

The topic's simulator uses this model:

- A monthly user makes about **3,000 requests a month** (about 100 a day).
- A month has 30 × 86,400 = **2,592,000 seconds**; the busiest hour runs about **3×** the average.
- A tuned web server handles about **400 requests a second**. Handy rule: 400 req/s is about **1 billion requests a month** (400 × 2,592,000 = 1.04 billion).

| Monthly users | Requests a month | Average req/s | Peak req/s (3×) | Web servers at 400 req/s |
| --- | --- | --- | --- | --- |
| 100,000 | 300 million | 116 | 348 | 1 (run 2 for availability) |
| 1 million | 3 billion | 1,157 | 3,473 | 9 |
| 10 million | 30 billion | 11,574 | 34,723 | 87 |

With reads outnumbering writes 100 to 1 and an **80% cache hit rate**, only 20% of reads reach SQL. At 10 million users that's roughly 34,723 × 100/101 × 0.2 ≈ **6,900 reads a second** across the replicas, and about **344 writes a second** on the primary.

---

## Stage 1: one box

```text
Users → Route 53 → Elastic IP → EC2 (Nginx + Node + Postgres) → EBS
```

- One EC2 instance runs everything. An **Elastic IP** keeps its address when you replace it; **Route 53** points your domain at it.
- **Scale up** (a bigger instance type) when it's busy: the simplest fix there is, and often good for a long time.
- Turn on **EBS snapshots** (daily backups) from the first day.
- Security group: 443 and 80 open; SSH through SSM Session Manager, not port 22.

What it can't do: survive the instance or its AZ failing, or grow past the largest instance.

---

## Stage 2: split the database off

```text
Users → Route 53 → EC2 (app) ──► RDS Postgres (Multi-AZ, private subnet)
                        └──────► S3 (uploads, static files)
```

- Move the database to **RDS**: AWS handles backups, patches and failover to a **standby in another AZ** (about 1 to 2 minutes).
- Move user uploads and static files to **S3**. Servers become disposable: nothing on them you can't rebuild.
- Put the database in a **private subnet**; its security group accepts 5432 only from the app's security group.
- Now the app and database scale separately: a bigger app instance or a bigger database, whichever is the bottleneck.

---

## Stage 3: balance, cache, replicate

```text
Users → Route 53 → CloudFront ─► S3 (static)
                       └─► ALB ─► EC2 web servers (zone a, zone b)  ← no sessions on disk or in memory
                                     ├─► ElastiCache Redis (sessions, hot reads)
                                     ├─► RDS primary (writes) ─► read replicas (reads)
```

- An **Application Load Balancer** across **two AZs** spreads requests and skips unhealthy servers.
- **Stateless servers**: sessions go to Redis (or a signed cookie), uploads to S3. Any server can serve any request, so you can add and remove them freely.
- **ElastiCache** in front of the database: a cache hit costs well under a millisecond and no SQL.
- **Read replicas** take read-only queries; the primary handles writes. RDS for MySQL and Postgres allows up to 15 replicas.
- **CloudFront** serves static files from edge locations near users, and can cache API responses that are the same for everyone.

```javascript
import Redis from 'ioredis';
import pg from 'pg';

const cache = new Redis(process.env.REDIS_URL);
const primary = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const replica = new pg.Pool({ connectionString: process.env.REPLICA_URL });

// Cache-aside: try Redis, fall back to a replica, then fill the cache.
export async function getPost(id) {
  const hit = await cache.get(`post:${id}`);
  if (hit) return JSON.parse(hit);

  const { rows } = await replica.query('SELECT id, user_id, body, created_at FROM posts WHERE id = $1', [id]);
  if (rows[0]) await cache.set(`post:${id}`, JSON.stringify(rows[0]), 'EX', 300); // 5 minutes
  return rows[0] ?? null;
}

// Writes go to the primary; drop the cached copy so the next read refills it.
export async function editPost(id, body) {
  await primary.query('UPDATE posts SET body = $1 WHERE id = $2', [body, id]);
  await cache.del(`post:${id}`);
}
```

**Replication lag**: a replica can be a few milliseconds (or, under load, seconds) behind. After a user edits their own post, read it from the **primary** (or from the cache you just updated) so they see their change: **read-your-writes**.

---

## Stage 4: auto scale and go asynchronous

```text
ALB ─► Web tier (Auto Scaling) ─► API tier (Auto Scaling)
                                     ├─► ElastiCache, RDS primary + replicas
                                     └─► SQS queue ─► Workers (Auto Scaling on queue depth) ─► S3, email, push
CloudWatch: p99 latency, 5xx rate, CPU, queue age, replica lag → alarms
```

- **Auto Scaling groups** (or ECS services) for each tier, with **target tracking** (say average CPU 50 to 70%, or requests per target). Minimum 2, in different AZs.
- **Split tiers** that scale differently: the web tier (pages), the API tier (business logic), workers (background jobs).
- **Queues** for anything slow or failure-prone: emails, image resizing, payments webhooks, reports. The request returns at once; a worker does the job.
- **Monitoring** becomes a requirement: you can't scale what you can't see.

```javascript
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: 'ap-south-1' });
const QUEUE = process.env.THUMBNAIL_QUEUE_URL;

// In the API: enqueue and answer straight away
await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: JSON.stringify({ photoKey: 'uploads/7f3a.jpg' }) }));

// In a worker: long-poll, process, then delete. If the worker dies first, the message
// becomes visible again after the visibility timeout and another worker retries it.
while (true) {
  const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: QUEUE, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }));
  for (const m of Messages) {
    await makeThumbnail(JSON.parse(m.Body).photoKey); // must be idempotent: SQS delivers at least once
    await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE, ReceiptHandle: m.ReceiptHandle }));
  }
}
```

Add a **dead-letter queue** (after, say, 5 failed receives) so one poison message doesn't loop forever, and scale workers on **queue age**, not CPU.

---

## Stage 5: scale writes

Replicas multiply reads, but **every write still lands on one primary**. Options, cheapest first:

| Technique | What it means | Cost |
| --- | --- | --- |
| Tune and scale up | Indexes, fewer queries per request, bigger instance, Aurora | Least effort; buys time |
| Federation | Split databases by function: users, posts, payments each get their own | Joins across them move into code |
| Denormalisation | Store data the way it's read (a post with its author's name) | More writes, risk of stale copies |
| Sharding | Split one table across many databases by a **shard key** | Cross-shard queries and transactions get hard; resharding is painful |
| NoSQL for hot, simple data | DynamoDB for sessions, carts, feeds, counters | Design around access patterns up front |

```javascript
// Hash sharding: the same user always lands on the same shard
import { createHash } from 'node:crypto';

const SHARDS = ['posts-0', 'posts-1', 'posts-2', 'posts-3'];

export function shardFor(userId) {
  const h = createHash('md5').update(String(userId)).digest().readUInt32BE(0);
  return SHARDS[h % SHARDS.length];
}
// shardFor(42) → one of the four, every time. Changing SHARDS.length moves most keys:
// use consistent hashing or many virtual shards mapped to fewer servers to grow gently.
```

**Choosing a shard key**: one that spreads load evenly **and** keeps a request's data on one shard (`user_id` for a user's posts). A celebrity user can still make one shard hot; split their data further or cache it harder. More in [Database Sharding](/?topic=database-sharding&read) and [Consistent Hashing](/?topic=consistent-hashing&read).

---

## Caching, the problems that come with it

| Problem | What happens | Fix |
| --- | --- | --- |
| Stale data | Cache serves an old value after a write | Delete or update the key on write; short TTLs for things that change |
| Stampede | A hot key expires and 1,000 requests hit the database at once | A lock so one request refills it, or refresh before expiry |
| Cache node dies | The whole read load lands on the database | Replicas in ElastiCache, headroom on the database, rate limits |
| Cold start after deploy | Empty cache, slow first minutes | Warm the hottest keys; don't flush on every deploy |
| Penetration | Requests for keys that don't exist always miss | Cache the "not found" briefly |

---

## How to choose what to add next

```text
CPU or memory high on the one box?                      → scale up, then split the DB off (stage 2)
App servers busy, DB fine?                              → more app servers behind an ALB (stage 3)
DB busy with reads?                                     → cache first, then read replicas (stage 3)
Traffic swings through the day?                         → Auto Scaling with target tracking (stage 4)
Requests slow because of email, images, webhooks?       → queue + workers (stage 4)
DB primary busy with writes after tuning?               → federation, then sharding or DynamoDB (stage 5)
Users far away, static files slow?                      → CloudFront (any stage)
Users on other continents, or region-level failure?     → multi-region (see disaster recovery)
```

---

## ⚠️ Critical Mistakes

- Building stage 5 on day one: microservices, sharding and Kubernetes for 500 users.
- Scaling without **measuring**: adding servers when the database is the bottleneck.
- **Sessions in server memory**: users get logged out whenever a server goes or the load balancer switches them.
- Writing user uploads to the **server's disk** instead of S3.
- **One AZ** for everything, or one NAT gateway for all zones.
- Reading from a **replica right after a write** and showing the user stale data.
- Cache keys with **no TTL** and no invalidation: stale data forever.
- Doing slow work **inside the request** (emails, PDFs, image processing).
- Workers that aren't **idempotent**: SQS delivers at least once, so a retry double-charges or double-sends.
- Picking a **shard key** that makes one shard hot (date, a celebrity user, a country).
- Auto Scaling with a **minimum of 1**: one failure or one deploy and you're at zero.
- No alarms on **queue age** and **replica lag**: problems grow silently.

---

## Interview Q&As

**Q: How would you design a system that scales to millions of users on AWS?**

A: Start simple and evolve on measurements. One instance; then RDS for the database and S3 for files; then an ALB over stateless servers in two AZs, sessions in ElastiCache, read replicas and CloudFront; then Auto Scaling, separate web and API tiers, SQS with workers and proper monitoring; and at the top, federation, sharding or DynamoDB to scale writes. At each step, say which number told you to move on.

**Q: How do you know it's time to move to the next stage?**

A: A metric crosses a line you set: CPU or memory sustained over about 70%, p99 latency over your target, database connections or IOPS near the limit, replica lag growing, error rate rising, or queue age climbing. Load test to find the next bottleneck before users do.

**Q: What breaks if web servers keep sessions in memory?**

A: The load balancer can send a user's next request to another server, which doesn't know them; when a server is replaced or scaled in, its users are logged out; and you can't add or remove servers freely. Keep sessions in Redis, a database, or a signed cookie.

**Q: Cache first or read replicas first?**

A: Cache first for hot, repeated reads: a hit costs well under a millisecond and no database work at all. Replicas add raw read capacity for queries that can't be cached (search, varied filters). Most systems end up with both.

**Q: A cache node dies at peak. What happens and how do you protect the database?**

A: Every read it was absorbing hits the database at once and can overload it. Protect with ElastiCache replicas and automatic failover, headroom on the database, request coalescing so one miss refills a key, rate limiting, and serving stale data if the cache returns slowly.

**Q: How do you pick a shard key, and what if one shard gets hot?**

A: Pick a key with high cardinality that spreads load evenly and keeps each request's data on one shard, such as `user_id` for a user's own data. Avoid dates and low-variety values. For a hot shard: split it, give the hot key its own shard or extra caching, or add a random suffix to spread a single hot key's writes and merge on read.

**Q: Why use a queue between the API and slow work?**

A: Requests return fast, spikes are absorbed by the queue instead of the API, workers scale on queue depth, and failures retry automatically with a dead-letter queue for poison messages. The cost is eventual completion and the need for idempotent workers.

**Q: Vertical or horizontal scaling?**

A: Vertical (a bigger machine) first because it's simple and needs no code change, until the largest instance isn't enough or one machine is too risky. Horizontal (more machines) gives elasticity and fault tolerance, but needs stateless servers and a load balancer.

---

## Related topics

- [AWS Basics](/?topic=aws-basics&read): the services each stage uses
- [Application Load Balancer](/?topic=aws-alb&read): stage 3's front door
- [Distributed Cache](/?topic=distributed-cache&read): what ElastiCache is doing
- [Database Sharding](/?topic=database-sharding&read) and [Consistent Hashing](/?topic=consistent-hashing&read): stage 5
- [VPC Networking](/?topic=aws-vpc&read): public and private subnets for each tier
- [Disaster Recovery Across AWS Regions](/?topic=aws-disaster-recovery&read): when one region isn't enough

---

## Sources

- The five stages follow [Design a system that scales to millions of users on AWS](https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/scaling_aws/README.md) from the System Design Primer by Donne Martin ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Structura's changes: the text, numbers, code and examples here are rewritten and extended.
- [Amazon RDS read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [Target tracking scaling policies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html)
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Caching strategies for ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html)

---

## Why This Matters

✅ "Design X to scale to millions of users" is the most common system design prompt, and this staged answer is the expected shape.

✅ Tying every step to a measured bottleneck (and the numbers above) shows judgment, not a list of buzzwords.

✅ Statelessness, cache-aside, read-your-writes and idempotent workers are the patterns every later topic builds on.
