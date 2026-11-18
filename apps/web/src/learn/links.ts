// Deep links between topics. When a topic's text mentions something another topic
// teaches ("Redis Sentinel", "rate limiter", "consistent hashing"), the first mention
// in each section links there, to the exact section in Read mode when there is one.
// The rules are written by hand, so a link always means "this is explained over there";
// `npm run test:links` checks that every target topic and section exists.

import type { Block, Rich } from './notesFormat'

export interface LinkRule {
  /** The topic that explains it. */
  topic: string
  /** A heading in that topic's Read mode (its deep note's ## sections, or its explanation's). */
  section?: string
  /** Words that link there, singular and plural spelled out. Case doesn't matter unless `exact`. */
  terms: string[]
  /** Match the capitals exactly: for names and acronyms (RAG, IAM, Raft). */
  exact?: boolean
  /** Link only if the same paragraph also matches this, or the text is from one of `nearTopics`. */
  near?: RegExp
  nearTopics?: string[]
  /** Don't link if the same paragraph matches this. */
  far?: RegExp
  /** Link from its own topic too: for a section of its Read-mode article that explains the term. */
  inTopic?: boolean
}

const REDIS = /\bRedis\b|\bSentinel/
const REDIS_TOPICS = ['redis-basics', 'redis-persistence', 'redis-replication', 'distributed-cache', 'locking']

// Earlier rules win when two match the same words, so the specific ones come first.
export const LINK_RULES: LinkRule[] = [
  // Redis: replication, Sentinel, Cluster
  { topic: 'redis-replication', section: 'Sentinel: automatic failover', terms: ['Redis Sentinel', 'Sentinels', 'Sentinel'], exact: true },
  { topic: 'redis-replication', section: 'Redis Cluster: sharding with failover', terms: ['Redis Cluster', 'Redis clusters', 'cluster mode', 'hash slot', 'hash slots', 'hash tag', 'hash tags', 'CROSSSLOT'] },
  { topic: 'redis-replication', section: 'Redis Cluster: sharding with failover', terms: ['shards', 'shard', 'sharded', 'sharding'], near: REDIS, nearTopics: REDIS_TOPICS },
  { topic: 'redis-replication', section: 'Moving slots: MOVED and ASK', terms: ['MOVED', 'ASK redirect', 'resharding'], exact: true },
  { topic: 'redis-replication', section: 'Full sync and partial resync', terms: ['partial resync', 'partial resynchronization', 'full resync', 'full sync', 'replication backlog', 'repl-backlog-size', 'PSYNC'] },
  { topic: 'redis-replication', section: 'Asynchronous: what a failover can lose', terms: ['min-replicas-to-write', 'asynchronous replication', 'replication is asynchronous'] },
  { topic: 'redis-replication', section: 'How replication works', terms: ['Redis replica', 'Redis replicas', 'Redis replication', 'replication', 'replicas', 'replica', 'read replicas', 'read replica'], near: REDIS, nearTopics: REDIS_TOPICS },
  { topic: 'redis-persistence', terms: ['AOF', 'RDB snapshot', 'RDB snapshots', 'RDB', 'appendfsync'], exact: true },
  { topic: 'redis-persistence', terms: ['append-only file'], near: REDIS, nearTopics: REDIS_TOPICS },
  { topic: 'redis-persistence', terms: ['persistence', 'fsync'], near: REDIS, nearTopics: ['redis-basics', 'redis-replication', 'distributed-cache'] },
  { topic: 'locking', terms: ['distributed lock', 'distributed locks', 'Redis lock', 'Redis locks', 'fencing token', 'fencing tokens', 'Redlock'] },
  { topic: 'redis-basics', terms: ['sorted set', 'sorted sets'] },
  { topic: 'redis-basics', terms: ['Redis'], exact: true },

  // Patterns
  { topic: 'rate-limiter', section: 'How rules are stored', terms: ['Rules Store', 'rules store', 'rate limit rules', 'rate-limit rules'], inTopic: true },
  { topic: 'rate-limiter', section: 'Fail open or fail closed', terms: ['fail open', 'fail closed', 'fails open', 'fails closed', 'fail-open', 'fail-closed'], inTopic: true },
  { topic: 'rate-limiter', section: 'The fallback limiter', terms: ['Local Fallback Limiter', 'fallback limiter', 'local fallback'], inTopic: true },
  { topic: 'rate-limiter', terms: ['rate limiter', 'rate limiters', 'rate limiting', 'rate-limiting', 'rate limit', 'rate limits', 'token bucket', 'token buckets', 'sliding window', 'leaky bucket'] },
  { topic: 'retry-backoff', section: 'What a retry storm is', terms: ['retry storm', 'retry storms'], inTopic: true },
  { topic: 'retry-backoff', section: 'Limits: tries, budgets and layers', terms: ['retry budget', 'retry budgets'], inTopic: true },
  { topic: 'retry-backoff', section: 'Jitter: the random part', terms: ['Backoff + Jitter', 'full jitter', 'equal jitter', 'decorrelated jitter', 'jittered backoff', 'jitter'], far: /bandwidth|latency|buffering/i, inTopic: true },
  { topic: 'retry-backoff', section: 'How exponential backoff works', terms: ['exponential backoff', 'exponential back-off', 'backoff'], inTopic: true },
  // Retries, backoff and jitter link to retry-backoff above; the breaker itself links to its own topic.
  { topic: 'circuit-breaker', section: 'Circuit breaker: the three states', terms: ['circuit breaker', 'circuit breakers', 'half-open', 'cascading failure', 'cascading failures'], far: /deploy|rollback|rolling|\btasks?\b|task definition|bad image/i },
  { topic: 'circuit-breaker', section: 'Bulkheads: separate pools', terms: ['bulkhead', 'bulkheads'] },
  { topic: 'api-gateway', terms: ['API gateway', 'API gateways', 'API Gateway'] },
  { topic: 'consistent-hashing', terms: ['consistent hashing', 'hash ring', 'virtual nodes', 'vnodes'] },
  { topic: 'database-sharding', terms: ['shard key', 'shard keys', 'sharding', 'sharded', 'shards', 'resharding', 'scatter-gather'] },
  { topic: 'distributed-cache', terms: ['cache-aside', 'cache stampede', 'cache stampedes', 'thundering herd', 'distributed cache', 'single-flight'] },
  { topic: 'query-cache', terms: ['LRU', 'least recently used'] },
  { topic: 'key-value-store', terms: ['read repair', 'hinted handoff', 'sloppy quorum', 'LSM tree', 'LSM-tree', 'LSM trees', 'SSTable', 'SSTables', 'memtable', 'quorum reads', 'quorum writes'] },
  { topic: 'leader-election', terms: ['Raft'], exact: true },
  { topic: 'leader-election', terms: ['leader election', 'election timeout'] },
  { topic: 'leader-election', terms: ['consensus'], far: /\bSentinel/ },
  { topic: 'unique-id-generator', terms: ['Snowflake ID', 'Snowflake IDs', 'Snowflake-style', 'Snowflake'], exact: true },
  { topic: 'unique-id-generator', terms: ['unique ID generator', 'ID generator'] },
  { topic: 'payment-idempotency', terms: ['idempotency key', 'idempotency keys', 'Idempotency-Key'] },
  { topic: 'queue-types', section: 'Standard and FIFO queues', terms: ['FIFO queue', 'FIFO queues', 'standard queue', 'standard queues', 'message group id'], inTopic: true },
  { topic: 'queue-types', section: 'Priority queues', terms: ['priority queue', 'priority queues'], inTopic: true },
  { topic: 'queue-types', section: 'Delay queues', terms: ['delay queue', 'delay queues'], inTopic: true },
  { topic: 'queue-types', section: 'Pub/sub and point-to-point', terms: ['pub/sub', 'publish/subscribe', 'point-to-point', 'fanout exchange'], inTopic: true },
  { topic: 'queue-types', section: 'Request/reply', terms: ['request/reply', 'correlation id', 'direct reply-to'], inTopic: true },
  { topic: 'queue-types', section: 'Bounded queues and backpressure', terms: ['backpressure', 'bounded queue', 'bounded queues'], inTopic: true },
  { topic: 'queue-types', section: 'In-memory queues: Redis and BullMQ', terms: ['BullMQ', 'Redis Streams'], exact: true, inTopic: true },
  { topic: 'message-queue', terms: ['message queue', 'message queues', 'visibility timeout', 'dead-letter queue', 'dead-letter queues', 'DLQ'], far: /shared memory/i },
  { topic: 'kafka-reliability', terms: ['exactly-once', 'idempotent producer', 'acks=all', 'in-sync replicas', 'ISR'] },
  { topic: 'kafka-basics', terms: ['consumer group', 'consumer groups', 'Kafka partition', 'Kafka partitions', 'Kafka topic', 'Kafka topics'] },
  { topic: 'kafka-basics', terms: ['Kafka'], exact: true },
  { topic: 'kafka', terms: ['event streaming', 'event stream', 'change data capture'] },
  { topic: 'load-balancer', terms: ['load balancer', 'load balancers', 'load balancing', 'round robin', 'least connections'] },
  { topic: 'cdn', terms: ['CDN', 'CDNs'], exact: true },
  { topic: 'cdn', terms: ['content delivery network', 'edge cache', 'edge caches'] },
  { topic: 'url-shortener', terms: ['base62', 'base 62', 'URL shortener'] },
  { topic: 'twitter-timeline', terms: ['fan-out on write', 'fan-out on read', 'fanout', 'home timeline'] },
  { topic: 'notification-system', terms: ['push notification', 'push notifications'] },
  { topic: 'search-autocomplete', terms: ['autocomplete', 'typeahead', 'trie'] },
  { topic: 'proximity-service', terms: ['geohash', 'geohashes', 'quadtree'] },
  { topic: 'metrics-monitoring', terms: ['Prometheus', 'time-series database', 'time series database'] },
  { topic: 'web-crawler', terms: ['web crawler', 'simhash'] },
  { topic: 'social-graph', terms: ['breadth-first search', 'bidirectional search'] },
  { topic: 'sales-rank', terms: ['MapReduce'] },
  { topic: 'video-streaming', terms: ['adaptive bitrate', 'HLS'] },
  { topic: 'file-sync', terms: ['content-defined chunking', 'delta sync'] },
  { topic: 'chat-system', terms: ['WebSocket', 'WebSockets'] },
  { topic: 'uber-surge', terms: ['surge pricing'] },
  { topic: 'rbac', terms: ['RBAC', 'JWT', 'JWTs'], exact: true },
  { topic: 'rbac', terms: ['role-based access control'] },

  // AI
  { topic: 'rag-pipeline', terms: ['RAG'], exact: true },
  { topic: 'rag-pipeline', terms: ['retrieval-augmented generation'] },
  { topic: 'vector-database', terms: ['vector database', 'vector databases', 'vector search', 'HNSW', 'embeddings', 'embedding'] },
  { topic: 'llm-gateway', terms: ['LLM gateway', 'model gateway'] },
  { topic: 'ai-agent', terms: ['AI agent', 'AI agents'] },

  // Infra
  { topic: 'docker-vs-vm', section: 'Writing a Dockerfile', terms: ['Dockerfile', 'Dockerfiles'], exact: true },
  { topic: 'docker-vs-vm', section: 'Container vs virtual machine', terms: ['virtual machine', 'virtual machines', 'hypervisor'] },
  { topic: 'docker-vs-vm', terms: ['Docker'], exact: true },
  { topic: 'aws-vpc', section: 'Security groups and network ACLs', terms: ['security group', 'security groups', 'network ACL', 'network ACLs'] },
  { topic: 'aws-vpc', section: 'Route tables: what makes a subnet public', terms: ['route table', 'route tables'], near: /\b(VPC|subnets?|NAT|internet gateway|CIDR|0\.0\.0\.0)/i, nearTopics: ['aws-basics', 'aws-ecs-fargate', 'aws-ecs-fullstack', 'aws-alb', 'scaling-aws', 'aws-disaster-recovery'] },
  { topic: 'aws-vpc', section: 'Getting out: Internet Gateway, NAT gateway, egress-only', terms: ['NAT gateway', 'NAT gateways', 'internet gateway'] },
  { topic: 'aws-vpc', section: 'VPC endpoints: reaching AWS without the internet', terms: ['VPC endpoint', 'VPC endpoints', 'gateway endpoint'] },
  { topic: 'aws-vpc', section: 'CIDR in five minutes', terms: ['CIDR'], exact: true },
  { topic: 'aws-vpc', terms: ['VPC', 'VPCs'], exact: true },
  { topic: 'aws-vpc', terms: ['private subnet', 'private subnets', 'public subnet', 'public subnets'] },
  { topic: 'aws-iam', section: 'Roles and temporary credentials', terms: ['IAM role', 'IAM roles', 'task role', 'task roles', 'instance profile'] },
  { topic: 'aws-iam', section: 'Least privilege in practice', terms: ['least privilege', 'least-privilege'] },
  { topic: 'aws-iam', terms: ['IAM'], exact: true },
  { topic: 'aws-alb', section: 'Health checks', terms: ['health check', 'health checks'], near: /\b(ALB|target|load balancer)/i, nearTopics: ['aws-alb', 'aws-ecs-fargate', 'aws-ecs-fullstack', 'load-balancer'] },
  { topic: 'aws-alb', terms: ['Application Load Balancer', 'Application Load Balancers', 'target group', 'target groups'] },
  { topic: 'aws-alb', terms: ['ALB', 'ALBs'], exact: true },
  { topic: 'aws-ecs-fargate', section: 'What a vCPU is', terms: ['vCPU', 'vCPUs', 'CPU units', 'CPU unit'], exact: true, inTopic: true },
  { topic: 'aws-ecs-fargate', section: 'A task definition, line by line', terms: ['task definition', 'task definitions'] },
  { topic: 'aws-ecs-fargate', terms: ['Fargate', 'ECS'], exact: true },
  { topic: 'aws-ecs-fullstack', section: 'Blue/green on ECS, underneath', terms: ['blue/green', 'blue-green'] },
  { topic: 'aws-ecs-fullstack', terms: ['CodeDeploy', 'CodePipeline', 'CodeBuild'], exact: true },
  { topic: 'aws-disaster-recovery', section: 'Setting RTO and RPO', terms: ['RPO', 'RTO'], exact: true },
  { topic: 'aws-disaster-recovery', section: 'The four strategies', terms: ['pilot light', 'warm standby', 'disaster recovery'] },
  { topic: 'aws-basics', section: 'Regions, Availability Zones and edge locations', terms: ['Availability Zone', 'Availability Zones', 'AZs'] },
  { topic: 'aws-basics', section: 'Compute: EC2, containers or Lambda', terms: ['EC2', 'Lambda'], exact: true },
  { topic: 'scaling-aws', terms: ['read replica', 'read replicas', 'Auto Scaling group', 'Auto Scaling groups'] },
  { topic: 'terraform-state', terms: ['remote state', 'state locking', 'state file'] },
  { topic: 'terraform-modules', terms: ['Terraform module', 'Terraform modules'] },
  { topic: 'terraform-basics', terms: ['Terraform'], exact: true },
]

/** The id Read mode gives a section's heading, so a link can land on it. */
export const anchor = (heading: string) => `read-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

/** Where a rule's link goes: the section in Read mode, or the topic itself. */
export function hrefOf(rule: LinkRule, read: boolean): string {
  if (rule.section) return `/topic/${rule.topic}/?read#${anchor(rule.section)}`
  return `/topic/${rule.topic}/${read ? '?read' : ''}`
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One pattern per rule. A term must stand alone: not inside a longer word, a file name,
// a URL, a hyphenated name (rate-limiter.ts) or a {hash tag}. No lookbehind, which older
// Safari can't parse: the character before is captured instead.
const PATTERNS = LINK_RULES.map((rule) => {
  const terms = [...rule.terms].sort((a, b) => b.length - a.length).map(escape)
  return new RegExp(`(^|[^\\w/@{.-])(${terms.join('|')})(?![\\w/@}-]|\\.\\w)`, rule.exact ? 'g' : 'gi')
})

export interface Linked {
  text: string
  rule?: LinkRule
}

/** What "already linked" is kept by: a topic, or one section of it. */
const keyOf = (rule: LinkRule) => `${rule.topic}#${rule.section ?? ''}`

/**
 * Splits text into plain parts and links. `from` is the topic the text belongs to (it
 * doesn't link to itself, except `inTopic` rules); `here` is the Read-mode section the
 * text is in, never linked to; `used` holds the targets already linked in this section,
 * and is updated, so each target is linked once per section.
 */
export function linkText(text: string, from: string, used: Set<string>, here?: string): Linked[] {
  const found: { start: number; end: number; rule: number }[] = []
  // Words this topic teaches, or already linked here, still count as matches: they stop a
  // shorter term inside them ("Load Balancer" in "Application Load Balancer") from linking.
  PATTERNS.forEach((pattern, i) => {
    const rule = LINK_RULES[i]
    if (rule.near && !rule.nearTopics?.includes(from) && !rule.near.test(text)) return
    if (rule.far?.test(text)) return
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const start = m.index + m[1].length
      found.push({ start, end: start + m[2].length, rule: i })
      pattern.lastIndex = start + m[2].length
    }
  })
  if (!found.length) return [{ text }]
  // The earliest match first; at the same place the longer one, then the earlier rule.
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.rule - b.rule)
  const out: Linked[] = []
  let at = 0 // where the next match may start
  let plain = 0 // where the text not yet output starts
  for (const f of found) {
    const rule = LINK_RULES[f.rule]
    if (f.start < at) continue
    const self = rule.topic === from && (!rule.inTopic || rule.section === here)
    if (self || used.has(keyOf(rule))) {
      at = f.end // taken, but not linked
      continue
    }
    if (f.start > plain) out.push({ text: text.slice(plain, f.start) })
    out.push({ text: text.slice(f.start, f.end), rule })
    used.add(keyOf(rule))
    at = plain = f.end
  }
  if (plain < text.length) out.push({ text: text.slice(plain) })
  return out
}

/** Links plain runs of a deep note's rich text; code and existing links stay as they are. */
export function linkRich(rich: Rich[], from: string, used: Set<string>, read: boolean, here?: string): Rich[] {
  const out: Rich[] = []
  for (const run of rich) {
    const [text, marks = '', href] = run
    if (href || marks.includes('c')) {
      out.push(run)
      continue
    }
    for (const part of linkText(text, from, used, here)) {
      out.push(part.rule ? [part.text, marks, hrefOf(part.rule, read)] : marks ? [part.text, marks] : [part.text])
    }
  }
  return out
}

/** A deep note's section with its first mentions linked. Headings, code and images are left alone. */
export function linkBlocks(blocks: Block[], from: string, here?: string, used = new Set<string>()): Block[] {
  const rich = (r: Rich[]) => linkRich(r, from, used, true, here)
  return blocks.map((b): Block => {
    switch (b.t) {
      case 'p':
      case 'quote':
      case 'toggle':
      case 'callout':
        return { ...b, r: rich(b.r), ...(b.c && { c: linkBlocks(b.c, from, here, used) }) }
      case 'ul':
      case 'ol':
      case 'todo':
        return { ...b, items: b.items.map((item) => ({ ...item, r: rich(item.r), ...(item.c && { c: linkBlocks(item.c, from, here, used) }) })) }
      case 'table':
        return { ...b, rows: b.rows.map((row, i) => (b.head && i === 0 ? row : row.map(rich))) }
      default:
        return b
    }
  })
}
