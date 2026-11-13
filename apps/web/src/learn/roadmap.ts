import type { StaticTopic } from '../topics'
import type { Progress } from './progress'

// The learning roadmap: where to start and what comes next. Parts are in the
// order they build on each other (containers first, then the tools that run in
// them, then the cloud, then infrastructure as code). A step either opens a
// Structura topic (done when the topic is marked complete) or points at
// readings from the library and is ticked off by hand.
//
// When you add a topic, give it a step here. Topics without one still appear,
// at the end, under "More topics".

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

export interface RoadmapPart {
  id: string
  title: string
  tagline: string
  why: string
  optional?: boolean
  steps: RoadmapStep[]
}

export const ROADMAP: RoadmapPart[] = [
  {
    id: 'docker',
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
    id: 'redis',
    title: 'Redis',
    tagline: 'Caching and coordination',
    why: 'The first thing most systems add when one database is not fast enough.',
    steps: [
      { id: 'redis-types', title: 'Data types', detail: 'Strings, hashes, lists, sets and sorted sets, and which problem each one solves.', guides: ['the-ultimate-redis-101', 'how-can-redis-be-used', 'why-is-redis-so-fast'] },
      { id: 'redis-cache', title: 'Caching patterns', detail: 'Cache-aside, TTLs and invalidation, and what happens on a miss storm.', topic: 'query-cache', guides: ['top-5-caching-strategies'] },
      { id: 'redis-distributed', title: 'A cache across many nodes', detail: 'Sharding keys, replication and eviction when one Redis is not enough.', topic: 'distributed-cache', guides: ['memcached-vs-redis'] },
      { id: 'redis-rate-limit', title: 'Rate limiting with Redis', detail: 'Token buckets and sliding windows with atomic counters.', topic: 'rate-limiter' },
      { id: 'redis-locks', title: 'Distributed locks and their pitfalls', detail: 'SET NX with a TTL, fencing tokens, and when the database should hold the lock instead.', topic: 'locking' },
      { id: 'redis-persist', title: 'Persistence and pub/sub', detail: 'RDB snapshots vs the append-only file, and publishing messages to subscribers.', guides: ['how-does-redis-persist-data', 'build-a-simple-chat-application'] },
      { id: 'redis-practice', title: 'Add caching and a rate limiter to your Dockerised app', detail: 'Redis in the compose file, cache-aside on one slow endpoint, a limit on the login route.', practice: true },
    ],
  },
  {
    id: 'kafka',
    title: 'Kafka',
    tagline: 'Event streaming',
    why: 'How services talk without waiting for each other, and replay what happened.',
    steps: [
      { id: 'kafka-basics', title: 'Topics, partitions, offsets and consumer groups', detail: 'How a log is split for scale and how consumers share it.', topic: 'kafka', guides: ['the-ultimate-kafka-101-you-cannot-miss', 'why-is-kafka-fast'] },
      { id: 'kafka-delivery', title: 'Delivery guarantees and idempotent consumers', detail: 'At-least-once delivery means duplicates; idempotency keys make them harmless.', topic: 'payment-idempotency', guides: ['can-kafka-lose-messages'] },
      { id: 'kafka-choose', title: 'Kafka, Redis Streams or a simple queue?', detail: 'When a log beats a queue, and when it is overkill.', guides: ['types-of-message-queue', 'how-do-message-queue-architectures-evolve', 'top-5-kafka-use-cases'] },
      { id: 'kafka-practice', title: 'Run Kafka in Docker Compose with a Node producer and consumer', detail: 'Publish an event from your app and process it in a second service.', practice: true, guides: ['ref-kafka-nodejs-tutorial'] },
    ],
  },
  {
    id: 'essentials',
    title: 'System design essentials',
    tagline: 'The ideas that tie it together',
    why: 'The building blocks every design reuses, before running them in the cloud.',
    steps: [
      { id: 'sd-load-balancer', title: 'Load balancing', detail: 'Spreading requests, health checks, and layer 4 vs layer 7.', topic: 'load-balancer' },
      { id: 'sd-hashing', title: 'Consistent hashing', detail: 'Adding a server without moving every key.', topic: 'consistent-hashing' },
      { id: 'sd-sharding', title: 'Sharding a database', detail: 'Choosing a shard key, hot shards and resharding.', topic: 'database-sharding' },
      { id: 'sd-kv', title: 'A key-value store, Dynamo-style', detail: 'Replication, quorums and what CAP means in practice.', topic: 'key-value-store' },
      { id: 'sd-ids', title: 'Unique IDs at scale', detail: 'Snowflake IDs: sortable, unique and generated without coordination.', topic: 'unique-id-generator' },
      { id: 'sd-leader', title: 'Leader election', detail: 'How Raft picks one leader and keeps a log in agreement.', topic: 'leader-election' },
      { id: 'sd-cdn', title: 'CDNs', detail: 'Caching at the edge, close to users.', topic: 'cdn' },
      { id: 'sd-notifications', title: 'A notification system', detail: 'Queues, retries and fan-out to push, email and SMS.', topic: 'notification-system' },
      { id: 'sd-chat', title: 'A chat system', detail: 'WebSockets, presence and message ordering.', topic: 'chat-system' },
      { id: 'sd-timeline', title: 'A timeline with fan-out', detail: 'Push vs pull, and the celebrity problem.', topic: 'twitter-timeline' },
    ],
  },
  {
    id: 'aws',
    title: 'AWS',
    tagline: 'Running it in the cloud',
    why: 'The same pieces, run for you: learn them in this order, each building on the last.',
    steps: [
      { id: 'aws-overview', title: 'The big picture', detail: 'From one server to millions of users, and which AWS service does each job.', topic: 'scaling-aws', guides: ['what-are-the-most-important-aws-services-to-learn', 'aws-services-cheat-sheet'] },
      { id: 'aws-iam', title: 'IAM: users, roles and policies', detail: 'Who can do what. Roles for services, least privilege, and never long-lived keys in code.', guides: ['scale-scalable-iam-architecture-to-secure-access-to-100-aws-accounts-at-segm'] },
      { id: 'aws-vpc', title: 'VPC networking', detail: 'Subnets, route tables, NAT gateways and endpoints.', topic: 'aws-vpc', guides: ['tf-aws-vpc-simple'] },
      { id: 'aws-compute', title: 'Compute: EC2, then containers', detail: 'Instances, AMIs and Auto Scaling groups, and why most teams move to containers.', guides: ['aws-services-evolution', 'tf-aws-ecs-ec2-autoscaling'] },
      { id: 'aws-alb', title: 'Application Load Balancer', detail: 'Listeners, rules, target groups and health checks.', topic: 'aws-alb' },
      { id: 'aws-ecs', title: 'ECR and ECS on Fargate', detail: 'Task definitions, services, autoscaling and safe deploys.', topic: 'aws-ecs-fargate' },
      { id: 'aws-data', title: 'Data: RDS, DynamoDB, S3, ElastiCache and MSK', detail: 'Managed Postgres, a key-value database, object storage, and managed Redis and Kafka.', guides: ['understanding-database-types', 'what-happens-when-you-upload-a-file-to-amazon-s3', 'scale-sql-vs-nosql'] },
      { id: 'aws-observe', title: 'CloudWatch: logs, metrics and alarms', detail: 'Know when something breaks before your users tell you.', guides: ['logging-tracing-metrics', 'cloud-monitoring-cheat-sheet'] },
      { id: 'aws-cicd', title: 'CI/CD with blue/green deploys', detail: 'CodePipeline, CodeBuild and CodeDeploy, with an alarm that rolls back.', topic: 'aws-ecs-fullstack', guides: ['aws-ecs-fullstack-cicd', 'cicd-pipeline-explained-in-simple-terms'] },
    ],
  },
  {
    id: 'terraform',
    title: 'Terraform',
    tagline: 'Infrastructure as code',
    why: 'Learn it after you\'ve clicked through AWS once, so you know what you\'re describing.',
    steps: [
      { id: 'tf-basics', title: 'Providers, resources, variables, outputs and state', detail: 'How plan and apply turn code into cloud resources.', guides: ['how-does-terraform-turn-code-into-cloud', 'a-cheatsheet-on-infrastructure-as-code-landscape'] },
      { id: 'tf-state', title: 'Remote state with locking', detail: 'Keep state in S3 with a lock, so two people can never apply at once.', guides: ['how-does-terraform-turn-code-into-cloud'] },
      { id: 'tf-modules', title: 'Modules', detail: 'Use terraform-aws-vpc, terraform-aws-alb and terraform-aws-ecs instead of writing everything.', guides: ['tf-aws-vpc', 'tf-aws-alb', 'tf-aws-ecs'] },
      { id: 'tf-practice', title: 'Rebuild the full-stack ECS sample from its Terraform', detail: 'Plan it, read every resource it creates, apply it, then destroy it.', practice: true, guides: ['aws-ecs-fullstack-sample', 'aws-ecs-fullstack-modules'] },
    ],
  },
  {
    id: 'classics',
    title: 'Classic designs',
    tagline: 'Interview practice',
    why: 'Whole systems that combine everything above. Any order works; start with the beginner ones.',
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
      { id: 'cl-surge', title: 'Surge pricing', detail: 'Supply, demand and real-time pricing by area.', topic: 'uber-surge' },
    ],
  },
  {
    id: 'ai',
    title: 'AI systems',
    tagline: 'After the rest',
    why: 'Systems built around language models, using everything you learned above.',
    optional: true,
    steps: [
      { id: 'ai-rag', title: 'RAG pipeline', detail: 'Chunking, embeddings, hybrid search and citations.', topic: 'rag-pipeline' },
      { id: 'ai-vector', title: 'Vector database', detail: 'HNSW, IVF-PQ, recall and filtered search.', topic: 'vector-database' },
      { id: 'ai-gateway', title: 'LLM gateway', detail: 'Keys, budgets, routing, token limits and fallbacks.', topic: 'llm-gateway' },
      { id: 'ai-agent', title: 'AI agent with tools', detail: 'The agent loop, tool policy, prompt injection and idempotent actions.', topic: 'ai-agent' },
    ],
  },
  {
    id: 'project',
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

export const ROADMAP_STEPS = ROADMAP.flatMap((part) => part.steps.map((step) => ({ part, step })))

export function stepDone(step: RoadmapStep, progress: Progress): boolean {
  return step.topic ? Boolean(progress.topics[step.topic]?.completed) : Boolean(progress.roadmap?.[step.id])
}

export const partDone = (part: RoadmapPart, progress: Progress) => part.steps.filter((s) => stepDone(s, progress)).length

/** The first step not done yet, in order, or null when everything is. */
export function nextStep(progress: Progress) {
  return ROADMAP_STEPS.find(({ step }) => !stepDone(step, progress)) ?? null
}

/** Topics no part mentions yet (new ones), so they still have a place to be read. */
export function unplacedTopics(topics: StaticTopic[]): StaticTopic[] {
  const placed = new Set(ROADMAP_STEPS.map(({ step }) => step.topic).filter(Boolean))
  return topics.filter((t) => !placed.has(t.id))
}
