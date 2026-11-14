import { AREA_OF, AREAS, type AreaId } from '../topics/areas'
import type { TopicMeta } from '../topics/catalog'
import type { Progress } from './progress'

// The learning roadmap: where to start and what comes next. Each area (Development,
// Infra, Databases, AI) is a track of four stages, Foundations → Intermediate →
// Advanced → Expert, and each stage holds a few small modules (a card on the roadmap
// page) of steps, in the order they build on each other. A final project uses all of
// them. A step either opens a Structura topic (done when the topic is marked complete)
// or points at readings from the library and is ticked off by hand.
//
// When you add a topic, give it a step here, in a module of its area and the right
// stage (a new module is fine). Topics without one still appear, at the end of their
// area, under "More topics".

export type Stage = 'Foundations' | 'Intermediate' | 'Advanced' | 'Expert'

export const STAGES: Stage[] = ['Foundations', 'Intermediate', 'Advanced', 'Expert']

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
}

/** A module: one card on the roadmap page, opening its steps (?page=roadmap&part=<id>). */
export interface RoadmapPart {
  id: string
  /** The track it belongs to; null for the final project, which spans them all. */
  area: AreaId | null
  stage: Stage
  title: string
  /** One line: what the module covers. */
  why: string
  steps: RoadmapStep[]
}

export const ROADMAP: RoadmapPart[] = [
  // Development
  {
    id: 'dev-first',
    area: 'development',
    stage: 'Foundations',
    title: 'First designs',
    why: 'Small, complete systems to start with: a short link, a paste bin, who can do what.',
    steps: [
      { id: 'cl-url', title: 'URL shortener', detail: 'Base62 codes, read-heavy caching and redirects.', topic: 'url-shortener' },
      { id: 'cl-paste', title: 'Pastebin', detail: 'Object storage for content, metadata in a database.', topic: 'pastebin' },
      { id: 'cl-rbac', title: 'Role-based access control', detail: 'Users, roles and permissions, checked on every request.', topic: 'rbac' },
    ],
  },
  {
    id: 'building-blocks',
    area: 'development',
    stage: 'Intermediate',
    title: 'Building blocks',
    why: 'The patterns inside almost every bigger design: IDs, notifications, chat and feeds.',
    steps: [
      { id: 'sd-ids', title: 'Unique IDs at scale', detail: 'Snowflake IDs: sortable, unique and generated without coordination.', topic: 'unique-id-generator' },
      { id: 'sd-notifications', title: 'A notification system', detail: 'Queues, retries and fan-out to push, email and SMS.', topic: 'notification-system' },
      { id: 'sd-chat', title: 'A chat system', detail: 'WebSockets, presence and message ordering.', topic: 'chat-system' },
      { id: 'sd-timeline', title: 'A timeline with fan-out', detail: 'Push vs pull, and the celebrity problem.', topic: 'twitter-timeline' },
    ],
  },
  {
    id: 'dev-search',
    area: 'development',
    stage: 'Intermediate',
    title: 'Search and discovery',
    why: 'Crawling the web, suggesting as you type, and finding what is nearby.',
    steps: [
      { id: 'cl-crawler', title: 'Web crawler', detail: 'A frontier queue, politeness and deduplication.', topic: 'web-crawler' },
      { id: 'cl-autocomplete', title: 'Search autocomplete', detail: 'Tries, top-k suggestions and precomputation.', topic: 'search-autocomplete' },
      { id: 'cl-proximity', title: 'Proximity service', detail: 'Geohashes and finding what is nearby.', topic: 'proximity-service' },
    ],
  },
  {
    id: 'dev-media',
    area: 'development',
    stage: 'Advanced',
    title: 'Media and files',
    why: 'Streaming video to millions and keeping files in sync across devices.',
    steps: [
      { id: 'cl-video', title: 'Video streaming', detail: 'Transcoding, adaptive bitrate and CDNs.', topic: 'video-streaming' },
      { id: 'cl-sync', title: 'File sync', detail: 'Chunking, deduplication and conflict handling.', topic: 'file-sync' },
    ],
  },
  {
    id: 'dev-data',
    area: 'development',
    stage: 'Advanced',
    title: 'Data pipelines',
    why: 'Systems that collect, aggregate and watch data: rankings, finance, metrics.',
    steps: [
      { id: 'cl-rank', title: 'Sales rank by category', detail: 'Batch aggregation with MapReduce-style jobs.', topic: 'sales-rank' },
      { id: 'cl-mint', title: 'Personal finance aggregator', detail: 'Pulling bank data on a schedule and categorising it.', topic: 'mint' },
      { id: 'cl-metrics', title: 'Metrics and monitoring', detail: 'Collecting time series, compressing them, and alerting without false pages.', topic: 'metrics-monitoring', guides: ['push-vs-pull-in-metrics-collecting-systems'] },
    ],
  },
  {
    id: 'dev-hard',
    area: 'development',
    stage: 'Expert',
    title: 'Hard problems',
    why: 'A social graph across shards, and pricing a marketplace in real time.',
    steps: [
      { id: 'cl-graph', title: 'Social graph', detail: 'Friends of friends across shards.', topic: 'social-graph' },
      { id: 'cl-surge', title: 'Surge pricing', detail: 'Supply, demand and real-time pricing by area.', topic: 'uber-surge' },
    ],
  },
  // Infra
  {
    id: 'docker',
    area: 'infra',
    stage: 'Foundations',
    title: 'Docker',
    why: 'Containers: build an image, run it, and run a whole stack with Compose.',
    steps: [
      { id: 'docker-why', title: 'Containers vs virtual machines', detail: 'What a container shares with its host, what it doesn\'t, and why it starts in milliseconds.', topic: 'docker-vs-vm', guides: ['how-does-docker-work'] },
      { id: 'docker-images', title: 'Images, Dockerfiles and layers', detail: 'Write a Dockerfile, build and tag an image, and keep it small with layer caching and multi-stage builds.', guides: ['top-8-must-know-docker-concepts', 'ref-docker-curriculum', '9-docker-best-practices-you-must-know'] },
      { id: 'docker-run', title: 'Running containers', detail: 'Ports, environment variables, volumes and logs: everything you pass to docker run.', guides: ['ref-docker-curriculum'] },
      { id: 'docker-compose', title: 'Docker Compose', detail: 'Run your Node app, Redis and Postgres together with one file and one command.', guides: ['ref-docker-curriculum'] },
      { id: 'docker-practice', title: 'Containerise one of your own Node projects', detail: 'A Dockerfile, a .dockerignore, a compose file with its database, and it runs on a clean machine.', practice: true },
    ],
  },
  {
    id: 'aws-start',
    area: 'infra',
    stage: 'Foundations',
    title: 'AWS basics',
    why: 'What the cloud is and why, the big picture, and who can do what with IAM.',
    steps: [
      { id: 'aws-basics', title: 'What AWS is, and why', detail: 'Buying vs renting servers, regions and Availability Zones, Auto Scaling, Lambda, and what each one costs.', topic: 'aws-basics', guides: ['2-decades-of-cloud-evolution', 'hidden-costs-of-the-cloud'] },
      { id: 'aws-overview', title: 'The big picture', detail: 'From one server to millions of users, and which AWS service does each job.', topic: 'scaling-aws', guides: ['what-are-the-most-important-aws-services-to-learn', 'aws-services-cheat-sheet'] },
      { id: 'aws-iam', title: 'IAM: users, roles and policies', detail: 'Who can do what. Roles for services, least privilege, explicit deny, and never long-lived keys in code.', topic: 'aws-iam', guides: ['scale-scalable-iam-architecture-to-secure-access-to-100-aws-accounts-at-segm'] },
    ],
  },
  {
    id: 'traffic',
    area: 'infra',
    stage: 'Foundations',
    title: 'Serving traffic',
    why: 'Load balancers spread requests; CDNs cache close to users.',
    steps: [
      { id: 'sd-load-balancer', title: 'Load balancing', detail: 'Spreading requests, health checks, and layer 4 vs layer 7.', topic: 'load-balancer' },
      { id: 'sd-cdn', title: 'CDNs', detail: 'Caching at the edge, close to users.', topic: 'cdn' },
    ],
  },
  {
    id: 'kafka',
    area: 'infra',
    stage: 'Intermediate',
    title: 'Kafka',
    why: 'Topics, partitions and consumer groups, a real pipeline, and delivery guarantees.',
    steps: [
      { id: 'kafka-basics', title: 'Topics, partitions, offsets and consumer groups', detail: 'Events in an append-only log: keys pick partitions, a group shares them, offsets let you replay.', topic: 'kafka-basics', guides: ['the-ultimate-kafka-101-you-cannot-miss', 'why-is-kafka-fast'] },
      { id: 'kafka-pipeline', title: 'Replication and a real pipeline', detail: 'Brokers, replicas, acks, two consumer groups and a dead-letter topic, end to end.', topic: 'kafka' },
      { id: 'kafka-delivery', title: 'Delivery guarantees and idempotent consumers', detail: 'At-least-once delivery means duplicates; idempotency keys make them harmless.', topic: 'payment-idempotency', guides: ['can-kafka-lose-messages'] },
      { id: 'kafka-choose', title: 'Kafka, Redis Streams or a simple queue?', detail: 'When a log beats a queue, and when it is overkill.', guides: ['types-of-message-queue', 'how-do-message-queue-architectures-evolve', 'top-5-kafka-use-cases'] },
      { id: 'kafka-practice', title: 'Run Kafka in Docker Compose with a Node producer and consumer', detail: 'Publish an event from your app and process it in a second service.', practice: true, guides: ['ref-kafka-nodejs-tutorial'] },
    ],
  },
  {
    id: 'aws-build',
    area: 'infra',
    stage: 'Intermediate',
    title: 'AWS building blocks',
    why: 'Your own network, compute, load balancers, containers, data and monitoring.',
    steps: [
      { id: 'aws-vpc', title: 'VPC networking', detail: 'Subnets, route tables, NAT gateways and endpoints.', topic: 'aws-vpc', guides: ['tf-aws-vpc-simple'] },
      { id: 'aws-compute', title: 'Compute: EC2, then containers', detail: 'Instances, AMIs and Auto Scaling groups, and why most teams move to containers.', guides: ['aws-services-evolution', 'tf-aws-ecs-ec2-autoscaling'] },
      { id: 'aws-alb', title: 'Application Load Balancer', detail: 'Listeners, rules, target groups and health checks.', topic: 'aws-alb' },
      { id: 'aws-ecs', title: 'ECR and ECS on Fargate', detail: 'Task definitions, services, autoscaling and safe deploys.', topic: 'aws-ecs-fargate' },
      { id: 'aws-data', title: 'Data: RDS, DynamoDB, S3, ElastiCache and MSK', detail: 'Managed Postgres, a key-value database, object storage, and managed Redis and Kafka.', guides: ['understanding-database-types', 'what-happens-when-you-upload-a-file-to-amazon-s3', 'scale-sql-vs-nosql', 'db-storage'] },
      { id: 'aws-observe', title: 'CloudWatch: logs, metrics and alarms', detail: 'Know when something breaks before your users tell you.', guides: ['logging-tracing-metrics', 'cloud-monitoring-cheat-sheet'] },
    ],
  },
  {
    id: 'terraform',
    area: 'infra',
    stage: 'Intermediate',
    title: 'Terraform',
    why: 'Infrastructure as code: plan, apply and state, then remote state with locking.',
    steps: [
      { id: 'tf-basics', title: 'Providers, resources, variables, outputs and state', detail: 'How plan and apply turn code into cloud resources, in-place vs replace, drift, and why state matters.', topic: 'terraform-basics', guides: ['how-does-terraform-turn-code-into-cloud', 'a-cheatsheet-on-infrastructure-as-code-landscape'] },
      { id: 'tf-state', title: 'Remote state with locking', detail: 'Keep state in S3 with a lock, so two people can never apply at once.', topic: 'terraform-state', guides: ['how-does-terraform-turn-code-into-cloud'] },
    ],
  },
  {
    id: 'kafka-reliability',
    area: 'infra',
    stage: 'Advanced',
    title: 'Kafka reliability',
    why: 'Not losing events: replicas, acks, idempotent producers and transactions.',
    steps: [
      { id: 'kafka-reliability', title: 'Durability and exactly-once', detail: 'ISR and min.insync.replicas, unclean leader election, idempotent producers, transactions and rebalances.', topic: 'kafka-reliability', guides: ['can-kafka-lose-messages'] },
    ],
  },
  {
    id: 'aws-ship',
    area: 'infra',
    stage: 'Advanced',
    title: 'Shipping and surviving',
    why: 'Blue/green deploys that roll back on their own, and recovering from a lost region.',
    steps: [
      { id: 'aws-cicd', title: 'CI/CD with blue/green deploys', detail: 'CodePipeline, CodeBuild and CodeDeploy, with an alarm that rolls back.', topic: 'aws-ecs-fullstack', guides: ['aws-ecs-fullstack-cicd', 'cicd-pipeline-explained-in-simple-terms'] },
      { id: 'aws-dr', title: 'Disaster recovery across regions', detail: 'RTO and RPO, the four strategies from backup and restore to active/active, and why replicas are not backups.', topic: 'aws-disaster-recovery', guides: ['cloud-disaster-recovery-strategies'] },
    ],
  },
  {
    id: 'terraform-scale',
    area: 'infra',
    stage: 'Expert',
    title: 'Terraform for a team',
    why: 'Versioned modules, an environment per root, and rebuilding a real stack from code.',
    steps: [
      { id: 'tf-modules', title: 'Modules and environments', detail: 'Versioned modules, a root per environment, promotion from dev to prod, and guards against destroy.', topic: 'terraform-modules', guides: ['tf-aws-vpc', 'tf-aws-alb', 'tf-aws-ecs'] },
      { id: 'tf-practice', title: 'Rebuild the full-stack ECS sample from its Terraform', detail: 'Plan it, read every resource it creates, apply it, then destroy it.', practice: true, guides: ['aws-ecs-fullstack-sample', 'aws-ecs-fullstack-modules'] },
    ],
  },
  // Databases
  {
    id: 'redis-start',
    area: 'databases',
    stage: 'Foundations',
    title: 'Redis basics',
    why: 'Data types and commands, TTLs, and why every command is atomic.',
    steps: [
      { id: 'redis-types', title: 'Data types and commands', detail: 'Strings, hashes, lists, sets and sorted sets, TTLs, and why every command is atomic.', topic: 'redis-basics', guides: ['the-ultimate-redis-101', 'how-can-redis-be-used', 'why-is-redis-so-fast'] },
    ],
  },
  {
    id: 'db-inside',
    area: 'databases',
    stage: 'Foundations',
    title: 'How databases work inside',
    why: 'B-trees, LSM-trees, transactions and query plans: the reading behind every choice.',
    steps: [
      { id: 'sd-db-internals', title: 'How a database works inside', detail: 'B-trees and LSM-trees, transactions and isolation levels, and how a query is planned: the reading list behind every database choice.', guides: ['ref-awesome-database-learning', 'db-b-tree', 'db-lsm-tree', 'db-isolation-levels', 'db-query-optimizer'] },
    ],
  },
  {
    id: 'redis-cache',
    area: 'databases',
    stage: 'Intermediate',
    title: 'Caching',
    why: 'Cache-aside, invalidation, a cache across many nodes, and adding it to your app.',
    steps: [
      { id: 'redis-cache', title: 'Caching patterns', detail: 'Cache-aside, TTLs and invalidation, and what happens on a miss storm.', topic: 'query-cache', guides: ['top-5-caching-strategies'] },
      { id: 'redis-distributed', title: 'A cache across many nodes', detail: 'Sharding keys, replication and eviction when one Redis is not enough.', topic: 'distributed-cache', guides: ['memcached-vs-redis'] },
      { id: 'redis-practice', title: 'Add caching and a rate limiter to your Dockerised app', detail: 'Redis in the compose file, cache-aside on one slow endpoint, a limit on the login route.', practice: true },
    ],
  },
  {
    id: 'redis-coordination',
    area: 'databases',
    stage: 'Intermediate',
    title: 'Coordination with Redis',
    why: 'Rate limits, distributed locks and pub/sub, and where each one breaks.',
    steps: [
      { id: 'redis-rate-limit', title: 'Rate limiting with Redis', detail: 'Token buckets and sliding windows with atomic counters.', topic: 'rate-limiter' },
      { id: 'redis-locks', title: 'Distributed locks and their pitfalls', detail: 'SET NX with a TTL, fencing tokens, and when the database should hold the lock instead.', topic: 'locking', guides: ['db-isolation-levels'] },
      { id: 'redis-pubsub', title: 'Pub/sub', detail: 'Publishing messages to subscribers, and why a subscriber that was offline never sees them.', guides: ['build-a-simple-chat-application'] },
    ],
  },
  {
    id: 'redis-durability',
    area: 'databases',
    stage: 'Advanced',
    title: 'Persistence and failover',
    why: 'RDB and AOF, replicas and Sentinel, and killing the primary on purpose.',
    steps: [
      { id: 'redis-persist', title: 'Persistence, replication and failover', detail: 'RDB vs the AOF, replicas and Sentinel, and what each kind of failure really loses.', topic: 'redis-persistence', guides: ['how-does-redis-persist-data', 'how-redis-architecture-evolve'] },
      { id: 'redis-practice-failover', title: 'Kill the primary on purpose', detail: 'Run a primary, a replica and three Sentinels in Docker Compose, stop the primary, and time the failover.', practice: true },
    ],
  },
  {
    id: 'partitioning',
    area: 'databases',
    stage: 'Advanced',
    title: 'Partitioning data',
    why: 'Consistent hashing and sharding: splitting data across machines without pain.',
    steps: [
      { id: 'sd-hashing', title: 'Consistent hashing', detail: 'Adding a server without moving every key.', topic: 'consistent-hashing' },
      { id: 'sd-sharding', title: 'Sharding a database', detail: 'Choosing a shard key, hot shards and resharding.', topic: 'database-sharding', guides: ['db-data-partitioning'] },
    ],
  },
  {
    id: 'consensus',
    area: 'databases',
    stage: 'Expert',
    title: 'Replication and consensus',
    why: 'A Dynamo-style store with quorums, and Raft keeping replicas in agreement.',
    steps: [
      { id: 'sd-kv', title: 'A key-value store, Dynamo-style', detail: 'Replication, quorums and what CAP means in practice.', topic: 'key-value-store', guides: ['db-replication-consistency'] },
      { id: 'sd-leader', title: 'Leader election', detail: 'How Raft picks one leader and keeps a log in agreement.', topic: 'leader-election', guides: ['db-consensus'] },
    ],
  },
  // AI
  {
    id: 'ai-rag',
    area: 'ai',
    stage: 'Intermediate',
    title: 'RAG pipelines',
    why: 'Chunking, embeddings, hybrid search and answers with citations.',
    steps: [
      { id: 'ai-rag', title: 'RAG pipeline', detail: 'Chunking, embeddings, hybrid search and citations.', topic: 'rag-pipeline' },
    ],
  },
  {
    id: 'ai-gateway',
    area: 'ai',
    stage: 'Intermediate',
    title: 'LLM gateway',
    why: 'One front door for models: keys, budgets, routing and fallbacks.',
    steps: [
      { id: 'ai-gateway', title: 'LLM gateway', detail: 'Keys, budgets, routing, token limits and fallbacks.', topic: 'llm-gateway' },
    ],
  },
  {
    id: 'ai-vector',
    area: 'ai',
    stage: 'Advanced',
    title: 'Vector databases',
    why: 'HNSW and IVF-PQ indexes, recall, and filtered search.',
    steps: [
      { id: 'ai-vector', title: 'Vector database', detail: 'HNSW, IVF-PQ, recall and filtered search.', topic: 'vector-database' },
    ],
  },
  {
    id: 'ai-agent',
    area: 'ai',
    stage: 'Advanced',
    title: 'Agents with tools',
    why: 'The agent loop, tool policy, prompt injection and safe actions.',
    steps: [
      { id: 'ai-agent', title: 'AI agent with tools', detail: 'The agent loop, tool policy, prompt injection and idempotent actions.', topic: 'ai-agent' },
    ],
  },
  // Final project
  {
    id: 'project',
    area: null,
    stage: 'Expert',
    title: 'Final project',
    why: 'One app, the whole path: Docker, Redis, Kafka, AWS and Terraform together.',
    steps: [
      { id: 'project-docker', title: 'Dockerise a Node app with Redis caching', detail: 'Parts 1 and 2: compose file, cache-aside and a rate limiter.', practice: true },
      { id: 'project-kafka', title: 'Publish its events to Kafka', detail: 'Part 3: one producer, one consumer that is safe to run twice.', practice: true },
      { id: 'project-aws', title: 'Deploy it on ECS Fargate behind an ALB in your own VPC', detail: 'Part 5: private subnets, a NAT gateway per zone, autoscaling on CPU.', practice: true },
      { id: 'project-terraform', title: 'Write all of it in Terraform with a blue/green pipeline', detail: 'Part 6: remote state, modules, and a 5xx alarm that rolls back.', practice: true },
    ],
  },
]

export const ROADMAP_STEPS = ROADMAP.flatMap((part) => part.steps.map((step) => ({ part, step })))

export function stepDone(step: RoadmapStep, progress: Progress): boolean {
  return step.topic ? Boolean(progress.topics[step.topic]?.completed) : Boolean(progress.roadmap?.[step.id])
}

export const partDone = (part: RoadmapPart, progress: Progress) => part.steps.filter((s) => stepDone(s, progress)).length

/** An area's modules, in order; the final project belongs to none. */
export const partsOf = (area: AreaId | null) => ROADMAP.filter((part) => part.area === area)

export const partById = (id: string | null | undefined) => ROADMAP.find((part) => part.id === id)

/** The module after this one in its track (the final project has none). */
export function nextPart(part: RoadmapPart): RoadmapPart | null {
  const track = partsOf(part.area)
  return track[track.indexOf(part) + 1] ?? null
}

/** The next topic after this one in its area's track, to keep reading in order. */
export function nextTopicAfter(topicId: string): string | null {
  const at = ROADMAP_STEPS.findIndex(({ step }) => step.topic === topicId)
  if (at < 0) return null
  const area = ROADMAP_STEPS[at].part.area
  return ROADMAP_STEPS.slice(at + 1).find(({ part, step }) => part.area === area && step.topic && step.topic !== topicId)?.step.topic ?? null
}

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
