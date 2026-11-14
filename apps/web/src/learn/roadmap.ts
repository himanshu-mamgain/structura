import { AREA_OF, AREAS, type AreaId } from '../topics/areas'
import type { TopicMeta } from '../topics/catalog'
import type { Progress } from './progress'

// The learning roadmap: where to start and what comes next. It has a track per area
// (Development, Infra, Databases, AI, in that order), each made of parts in the order
// they build on each other, and a final project that uses all of them. A step either
// opens a Structura topic (done when the topic is marked complete) or points at
// readings from the library and is ticked off by hand.
//
// When you add a topic, give it a step here, in a part of its area. Topics without one
// still appear, at the end of their area, under "More topics".

export type RoadmapLevel = 'Basics' | 'Intermediate' | 'Advanced'

export const LEVEL_TAGLINE: Record<RoadmapLevel, string> = {
  Basics: 'Start here',
  Intermediate: 'Using it in real systems',
  Advanced: 'When it breaks, and at scale',
}

export interface RoadmapStep {
  /** Stable id: progress for hand-ticked steps is stored under it. */
  id: string
  title: string
  /** One line: what to get out of this step. */
  detail: string
  /** A Structura topic id. */
  topic?: string
  /** Library guide slugs, for reading around it. */
  guides?: string[]
  /** Something to build yourself. */
  practice?: boolean
  /** Where it sits in its track. Consecutive steps with the same level are shown under one heading. */
  level?: RoadmapLevel
}

export interface RoadmapPart {
  id: string
  /** The track it belongs to; null for the final project, which spans them all. */
  area: AreaId | null
  title: string
  tagline: string
  why: string
  optional?: boolean
  steps: RoadmapStep[]
}

export const ROADMAP: RoadmapPart[] = [
  {
    id: 'building-blocks',
    area: 'development',
    title: 'Building blocks',
    tagline: 'Patterns every app reuses',
    why: 'IDs, notifications, chat and feeds: the pieces that turn up inside almost every larger design.',
    steps: [
      { id: 'sd-ids', title: 'Unique IDs at scale', detail: 'Snowflake IDs: sortable, unique and generated without coordination.', topic: 'unique-id-generator' },
      { id: 'sd-notifications', title: 'A notification system', detail: 'Queues, retries and fan-out to push, email and SMS.', topic: 'notification-system' },
      { id: 'sd-chat', title: 'A chat system', detail: 'WebSockets, presence and message ordering.', topic: 'chat-system' },
      { id: 'sd-timeline', title: 'A timeline with fan-out', detail: 'Push vs pull, and the celebrity problem.', topic: 'twitter-timeline' },
    ],
  },
  {
    id: 'classics',
    area: 'development',
    title: 'Classic designs',
    tagline: 'Interview practice',
    why: 'Whole systems that combine the building blocks. Any order works; start with the beginner ones.',
    steps: [
      { id: 'cl-url', title: 'URL shortener', detail: 'Base62 codes, read-heavy caching and redirects.', topic: 'url-shortener' },
      { id: 'cl-paste', title: 'Pastebin', detail: 'Object storage for content, metadata in a database.', topic: 'pastebin' },
      { id: 'cl-rbac', title: 'Role-based access control', detail: 'Users, roles and permissions, checked on every request.', topic: 'rbac' },
      { id: 'cl-crawler', title: 'Web crawler', detail: 'A frontier queue, politeness and deduplication.', topic: 'web-crawler' },
      { id: 'cl-autocomplete', title: 'Search autocomplete', detail: 'Tries, top-k suggestions and precomputation.', topic: 'search-autocomplete' },
      { id: 'cl-proximity', title: 'Proximity service', detail: 'Geohashes and finding what is nearby.', topic: 'proximity-service' },
      { id: 'cl-video', title: 'Video streaming', detail: 'Transcoding, adaptive bitrate and CDNs.', topic: 'video-streaming' },
      { id: 'cl-sync', title: 'File sync', detail: 'Chunking, deduplication and conflict handling.', topic: 'file-sync' },
      { id: 'cl-graph', title: 'Social graph', detail: 'Friends of friends across shards.', topic: 'social-graph' },
      { id: 'cl-rank', title: 'Sales rank by category', detail: 'Batch aggregation with MapReduce-style jobs.', topic: 'sales-rank' },
      { id: 'cl-mint', title: 'Personal finance aggregator', detail: 'Pulling bank data on a schedule and categorising it.', topic: 'mint' },
      { id: 'cl-metrics', title: 'Metrics and monitoring', detail: 'Collecting time series, compressing them, and alerting without false pages.', topic: 'metrics-monitoring', guides: ['push-vs-pull-in-metrics-collecting-systems'] },
      { id: 'cl-surge', title: 'Surge pricing', detail: 'Supply, demand and real-time pricing by area.', topic: 'uber-surge' },
    ],
  },
  {
    id: 'docker',
    area: 'infra',
    title: 'Docker',
    tagline: 'The foundation',
    why: 'Everything later runs in containers, so start here.',
    steps: [
      { id: 'docker-why', title: 'Containers vs virtual machines', detail: 'What a container shares with its host, what it doesn\'t, and why it starts in milliseconds.', topic: 'docker-vs-vm', guides: ['how-does-docker-work'] },
      { id: 'docker-images', title: 'Images, Dockerfiles and layers', detail: 'Write a Dockerfile, build and tag an image, and keep it small with layer caching and multi-stage builds.', guides: ['top-8-must-know-docker-concepts', 'ref-docker-curriculum', '9-docker-best-practices-you-must-know'] },
      { id: 'docker-run', title: 'Running containers', detail: 'Ports, environment variables, volumes and logs: everything you pass to docker run.', guides: ['ref-docker-curriculum'] },
      { id: 'docker-compose', title: 'Docker Compose', detail: 'Run your Node app, Redis and Postgres together with one file and one command.', guides: ['ref-docker-curriculum'] },
      { id: 'docker-practice', title: 'Containerise one of your own Node projects', detail: 'A Dockerfile, a .dockerignore, a compose file with its database, and it runs on a clean machine.', practice: true },
    ],
  },
  {
    id: 'traffic',
    area: 'infra',
    title: 'Serving traffic',
    tagline: 'Load balancers and CDNs',
    why: 'How requests reach your containers: spread across servers, and cached close to users.',
    steps: [
      { id: 'sd-load-balancer', title: 'Load balancing', detail: 'Spreading requests, health checks, and layer 4 vs layer 7.', topic: 'load-balancer' },
      { id: 'sd-cdn', title: 'CDNs', detail: 'Caching at the edge, close to users.', topic: 'cdn' },
    ],
  },
  {
    id: 'kafka',
    area: 'infra',
    title: 'Kafka',
    tagline: 'Event streaming',
    why: 'How services talk without waiting for each other, and replay what happened.',
    steps: [
      { id: 'kafka-basics', level: 'Basics', title: 'Topics, partitions, offsets and consumer groups', detail: 'Events in an append-only log: keys pick partitions, a group shares them, offsets let you replay.', topic: 'kafka-basics', guides: ['the-ultimate-kafka-101-you-cannot-miss', 'why-is-kafka-fast'] },
      { id: 'kafka-pipeline', level: 'Intermediate', title: 'Replication and a real pipeline', detail: 'Brokers, replicas, acks, two consumer groups and a dead-letter topic, end to end.', topic: 'kafka' },
      { id: 'kafka-delivery', level: 'Intermediate', title: 'Delivery guarantees and idempotent consumers', detail: 'At-least-once delivery means duplicates; idempotency keys make them harmless.', topic: 'payment-idempotency', guides: ['can-kafka-lose-messages'] },
      { id: 'kafka-choose', level: 'Intermediate', title: 'Kafka, Redis Streams or a simple queue?', detail: 'When a log beats a queue, and when it is overkill.', guides: ['types-of-message-queue', 'how-do-message-queue-architectures-evolve', 'top-5-kafka-use-cases'] },
      { id: 'kafka-practice', level: 'Intermediate', title: 'Run Kafka in Docker Compose with a Node producer and consumer', detail: 'Publish an event from your app and process it in a second service.', practice: true, guides: ['ref-kafka-nodejs-tutorial'] },
      { id: 'kafka-reliability', level: 'Advanced', title: 'Durability and exactly-once', detail: 'ISR and min.insync.replicas, unclean leader election, idempotent producers, transactions and rebalances.', topic: 'kafka-reliability', guides: ['can-kafka-lose-messages'] },
    ],
  },
  {
    id: 'aws',
    area: 'infra',
    title: 'AWS',
    tagline: 'Running it in the cloud',
    why: 'The same pieces, run for you: learn them in this order, each building on the last.',
    steps: [
      { id: 'aws-basics', level: 'Basics', title: 'What AWS is, and why', detail: 'Buying vs renting servers, regions and Availability Zones, Auto Scaling, Lambda, and what each one costs.', topic: 'aws-basics', guides: ['2-decades-of-cloud-evolution', 'hidden-costs-of-the-cloud'] },
      { id: 'aws-overview', level: 'Basics', title: 'The big picture', detail: 'From one server to millions of users, and which AWS service does each job.', topic: 'scaling-aws', guides: ['what-are-the-most-important-aws-services-to-learn', 'aws-services-cheat-sheet'] },
      { id: 'aws-iam', level: 'Basics', title: 'IAM: users, roles and policies', detail: 'Who can do what. Roles for services, least privilege, explicit deny, and never long-lived keys in code.', topic: 'aws-iam', guides: ['scale-scalable-iam-architecture-to-secure-access-to-100-aws-accounts-at-segm'] },
      { id: 'aws-vpc', level: 'Intermediate', title: 'VPC networking', detail: 'Subnets, route tables, NAT gateways and endpoints.', topic: 'aws-vpc', guides: ['tf-aws-vpc-simple'] },
      { id: 'aws-compute', level: 'Intermediate', title: 'Compute: EC2, then containers', detail: 'Instances, AMIs and Auto Scaling groups, and why most teams move to containers.', guides: ['aws-services-evolution', 'tf-aws-ecs-ec2-autoscaling'] },
      { id: 'aws-alb', level: 'Intermediate', title: 'Application Load Balancer', detail: 'Listeners, rules, target groups and health checks.', topic: 'aws-alb' },
      { id: 'aws-ecs', level: 'Intermediate', title: 'ECR and ECS on Fargate', detail: 'Task definitions, services, autoscaling and safe deploys.', topic: 'aws-ecs-fargate' },
      { id: 'aws-data', level: 'Intermediate', title: 'Data: RDS, DynamoDB, S3, ElastiCache and MSK', detail: 'Managed Postgres, a key-value database, object storage, and managed Redis and Kafka.', guides: ['understanding-database-types', 'what-happens-when-you-upload-a-file-to-amazon-s3', 'scale-sql-vs-nosql', 'db-storage'] },
      { id: 'aws-observe', level: 'Intermediate', title: 'CloudWatch: logs, metrics and alarms', detail: 'Know when something breaks before your users tell you.', guides: ['logging-tracing-metrics', 'cloud-monitoring-cheat-sheet'] },
      { id: 'aws-cicd', level: 'Advanced', title: 'CI/CD with blue/green deploys', detail: 'CodePipeline, CodeBuild and CodeDeploy, with an alarm that rolls back.', topic: 'aws-ecs-fullstack', guides: ['aws-ecs-fullstack-cicd', 'cicd-pipeline-explained-in-simple-terms'] },
      { id: 'aws-dr', level: 'Advanced', title: 'Disaster recovery across regions', detail: 'RTO and RPO, the four strategies from backup and restore to active/active, and why replicas are not backups.', topic: 'aws-disaster-recovery', guides: ['cloud-disaster-recovery-strategies'] },
    ],
  },
  {
    id: 'terraform',
    area: 'infra',
    title: 'Terraform',
    tagline: 'Infrastructure as code',
    why: 'Learn it after you\'ve clicked through AWS once, so you know what you\'re describing.',
    steps: [
      { id: 'tf-basics', level: 'Basics', title: 'Providers, resources, variables, outputs and state', detail: 'How plan and apply turn code into cloud resources, in-place vs replace, drift, and why state matters.', topic: 'terraform-basics', guides: ['how-does-terraform-turn-code-into-cloud', 'a-cheatsheet-on-infrastructure-as-code-landscape'] },
      { id: 'tf-state', level: 'Intermediate', title: 'Remote state with locking', detail: 'Keep state in S3 with a lock, so two people can never apply at once.', topic: 'terraform-state', guides: ['how-does-terraform-turn-code-into-cloud'] },
      { id: 'tf-modules', level: 'Advanced', title: 'Modules and environments', detail: 'Versioned modules, a root per environment, promotion from dev to prod, and guards against destroy.', topic: 'terraform-modules', guides: ['tf-aws-vpc', 'tf-aws-alb', 'tf-aws-ecs'] },
      { id: 'tf-practice', level: 'Advanced', title: 'Rebuild the full-stack ECS sample from its Terraform', detail: 'Plan it, read every resource it creates, apply it, then destroy it.', practice: true, guides: ['aws-ecs-fullstack-sample', 'aws-ecs-fullstack-modules'] },
    ],
  },
  {
    id: 'redis',
    area: 'databases',
    title: 'Redis',
    tagline: 'Caching and coordination',
    why: 'The first thing most systems add when one database is not fast enough.',
    steps: [
      { id: 'redis-types', level: 'Basics', title: 'Data types and commands', detail: 'Strings, hashes, lists, sets and sorted sets, TTLs, and why every command is atomic.', topic: 'redis-basics', guides: ['the-ultimate-redis-101', 'how-can-redis-be-used', 'why-is-redis-so-fast'] },
      { id: 'redis-cache', level: 'Intermediate', title: 'Caching patterns', detail: 'Cache-aside, TTLs and invalidation, and what happens on a miss storm.', topic: 'query-cache', guides: ['top-5-caching-strategies'] },
      { id: 'redis-distributed', level: 'Intermediate', title: 'A cache across many nodes', detail: 'Sharding keys, replication and eviction when one Redis is not enough.', topic: 'distributed-cache', guides: ['memcached-vs-redis'] },
      { id: 'redis-rate-limit', level: 'Intermediate', title: 'Rate limiting with Redis', detail: 'Token buckets and sliding windows with atomic counters.', topic: 'rate-limiter' },
      { id: 'redis-locks', level: 'Intermediate', title: 'Distributed locks and their pitfalls', detail: 'SET NX with a TTL, fencing tokens, and when the database should hold the lock instead.', topic: 'locking', guides: ['db-isolation-levels'] },
      { id: 'redis-pubsub', level: 'Intermediate', title: 'Pub/sub', detail: 'Publishing messages to subscribers, and why a subscriber that was offline never sees them.', guides: ['build-a-simple-chat-application'] },
      { id: 'redis-practice', level: 'Intermediate', title: 'Add caching and a rate limiter to your Dockerised app', detail: 'Redis in the compose file, cache-aside on one slow endpoint, a limit on the login route.', practice: true },
      { id: 'redis-persist', level: 'Advanced', title: 'Persistence, replication and failover', detail: 'RDB vs the AOF, replicas and Sentinel, and what each kind of failure really loses.', topic: 'redis-persistence', guides: ['how-does-redis-persist-data', 'how-redis-architecture-evolve'] },
      { id: 'redis-practice-failover', level: 'Advanced', title: 'Kill the primary on purpose', detail: 'Run a primary, a replica and three Sentinels in Docker Compose, stop the primary, and time the failover.', practice: true },
    ],
  },
  {
    id: 'distributed-data',
    area: 'databases',
    title: 'Distributed databases',
    tagline: 'Sharding, replication and consensus',
    why: 'What happens when one database is no longer enough: how data is split, copied and kept in agreement.',
    steps: [
      { id: 'sd-db-internals', title: 'How a database works inside', detail: 'B-trees and LSM-trees, transactions and isolation levels, and how a query is planned: the reading list behind every database choice.', guides: ['ref-awesome-database-learning', 'db-b-tree', 'db-lsm-tree', 'db-isolation-levels', 'db-query-optimizer'] },
      { id: 'sd-hashing', title: 'Consistent hashing', detail: 'Adding a server without moving every key.', topic: 'consistent-hashing' },
      { id: 'sd-sharding', title: 'Sharding a database', detail: 'Choosing a shard key, hot shards and resharding.', topic: 'database-sharding', guides: ['db-data-partitioning'] },
      { id: 'sd-kv', title: 'A key-value store, Dynamo-style', detail: 'Replication, quorums and what CAP means in practice.', topic: 'key-value-store', guides: ['db-replication-consistency'] },
      { id: 'sd-leader', title: 'Leader election', detail: 'How Raft picks one leader and keeps a log in agreement.', topic: 'leader-election', guides: ['db-consensus'] },
    ],
  },
  {
    id: 'ai',
    area: 'ai',
    title: 'AI systems',
    tagline: 'LLM apps',
    why: 'Systems built around language models, using everything you learned above.',
    steps: [
      { id: 'ai-rag', title: 'RAG pipeline', detail: 'Chunking, embeddings, hybrid search and citations.', topic: 'rag-pipeline' },
      { id: 'ai-vector', title: 'Vector database', detail: 'HNSW, IVF-PQ, recall and filtered search.', topic: 'vector-database' },
      { id: 'ai-gateway', title: 'LLM gateway', detail: 'Keys, budgets, routing, token limits and fallbacks.', topic: 'llm-gateway' },
      { id: 'ai-agent', title: 'AI agent with tools', detail: 'The agent loop, tool policy, prompt injection and idempotent actions.', topic: 'ai-agent' },
    ],
  },
  {
    id: 'project',
    area: null,
    title: 'Final project',
    tagline: 'Put it all together',
    why: 'One app, the whole path: this is what proves you can do it.',
    steps: [
      { id: 'project-docker', title: 'Dockerise a Node app with Redis caching', detail: 'Parts 1 and 2: compose file, cache-aside and a rate limiter.', practice: true },
      { id: 'project-kafka', title: 'Publish its events to Kafka', detail: 'Part 3: one producer, one consumer that is safe to run twice.', practice: true },
      { id: 'project-aws', title: 'Deploy it on ECS Fargate behind an ALB in your own VPC', detail: 'Part 5: private subnets, a NAT gateway per zone, autoscaling on CPU.', practice: true },
      { id: 'project-terraform', title: 'Write all of it in Terraform with a blue/green pipeline', detail: 'Part 6: remote state, modules, and a 5xx alarm that rolls back.', practice: true },
    ],
  },
]

/** A part's steps in runs of the same level, for the headings on the roadmap page. */
export function levelGroups(part: RoadmapPart): { level?: RoadmapLevel; steps: RoadmapStep[] }[] {
  const groups: { level?: RoadmapLevel; steps: RoadmapStep[] }[] = []
  for (const step of part.steps) {
    const last = groups[groups.length - 1]
    if (last && last.level === step.level) last.steps.push(step)
    else groups.push({ level: step.level, steps: [step] })
  }
  return groups
}

export const ROADMAP_STEPS = ROADMAP.flatMap((part) => part.steps.map((step) => ({ part, step })))

export function stepDone(step: RoadmapStep, progress: Progress): boolean {
  return step.topic ? Boolean(progress.topics[step.topic]?.completed) : Boolean(progress.roadmap?.[step.id])
}

export const partDone = (part: RoadmapPart, progress: Progress) => part.steps.filter((s) => stepDone(s, progress)).length

/** An area's parts, in order; the final project belongs to none. */
export const partsOf = (area: AreaId | null) => ROADMAP.filter((part) => part.area === area)

/**
 * The first step not done yet, in order, or null when everything is. Given an area,
 * only that track counts.
 */
export function nextStep(progress: Progress, area?: AreaId) {
  return ROADMAP_STEPS.find(({ part, step }) => (!area || part.area === area) && !stepDone(step, progress)) ?? null
}

/**
 * The track you're on: the area of the topic you opened most recently, or the first
 * area if you haven't opened one yet.
 */
export function currentArea(progress: Progress): AreaId {
  let latest: { at: number; area: AreaId } | null = null
  for (const [id, p] of Object.entries(progress.topics)) {
    const area = AREA_OF[id]
    if (area && p.lastOpenedAt && (!latest || p.lastOpenedAt > latest.at)) latest = { at: p.lastOpenedAt, area }
  }
  return latest?.area ?? AREAS[0].id
}

/** Topics no part mentions yet (new ones), so they still have a place to be read. */
export function unplacedTopics(topics: TopicMeta[], area?: AreaId): TopicMeta[] {
  const placed = new Set(ROADMAP_STEPS.map(({ step }) => step.topic).filter(Boolean))
  return topics.filter((t) => !placed.has(t.id) && (!area || AREA_OF[t.id] === area))
}
