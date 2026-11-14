// Structura's four areas. Every topic belongs to one, and Explore, Home, search, the
// roadmap and each topic page are organised by them. A new topic needs a line in
// AREA_OF (scripts/export-catalog.ts refuses to build without one).

export type AreaId = 'development' | 'infra' | 'databases' | 'ai'

export interface Area {
  id: AreaId
  title: string
  /** One line: what's in it. */
  tagline: string
}

/** In the order they're shown. */
export const AREAS: Area[] = [
  { id: 'development', title: 'Development', tagline: 'Designing the apps you build: APIs, feeds, chat, payments and search' },
  { id: 'infra', title: 'Infra', tagline: 'Containers, traffic, messaging, the cloud and infrastructure as code' },
  { id: 'databases', title: 'Databases', tagline: 'Storage, caching, sharding, replication and consistency' },
  { id: 'ai', title: 'AI', tagline: 'LLM apps: retrieval, vector search, gateways and agents' },
]

export const AREA_IDS = AREAS.map((a) => a.id)
export const isArea = (id: string | null | undefined): id is AreaId => Boolean(id && (AREA_IDS as string[]).includes(id))
export const areaById = (id: AreaId): Area => AREAS.find((a) => a.id === id)!

/** Each topic's area, by topic id. */
export const AREA_OF: Record<string, AreaId> = {
  // Development: whole systems and the patterns apps are built from
  'url-shortener': 'development',
  pastebin: 'development',
  rbac: 'development',
  'rate-limiter': 'development',
  'payment-idempotency': 'development',
  'unique-id-generator': 'development',
  'notification-system': 'development',
  'chat-system': 'development',
  'twitter-timeline': 'development',
  'search-autocomplete': 'development',
  'web-crawler': 'development',
  'proximity-service': 'development',
  'video-streaming': 'development',
  'file-sync': 'development',
  'social-graph': 'development',
  'sales-rank': 'development',
  mint: 'development',
  'uber-surge': 'development',

  // Infra: where and how it runs
  'docker-vs-vm': 'infra',
  'load-balancer': 'infra',
  cdn: 'infra',
  'kafka-basics': 'infra',
  kafka: 'infra',
  'kafka-reliability': 'infra',
  'aws-basics': 'infra',
  'scaling-aws': 'infra',
  'aws-iam': 'infra',
  'aws-vpc': 'infra',
  'aws-alb': 'infra',
  'aws-ecs-fargate': 'infra',
  'aws-ecs-fullstack': 'infra',
  'aws-disaster-recovery': 'infra',
  'terraform-basics': 'infra',
  'terraform-state': 'infra',
  'terraform-modules': 'infra',

  // Databases: keeping data, fast and consistent
  'redis-basics': 'databases',
  'query-cache': 'databases',
  'distributed-cache': 'databases',
  locking: 'databases',
  'redis-persistence': 'databases',
  'consistent-hashing': 'databases',
  'database-sharding': 'databases',
  'key-value-store': 'databases',
  'leader-election': 'databases',

  // AI: systems built around language models
  'rag-pipeline': 'ai',
  'vector-database': 'ai',
  'llm-gateway': 'ai',
  'ai-agent': 'ai',
}

/**
 * Library categories (library.json) that belong to an area, so an area's page can show
 * its own reading. General ones (core concepts, fundamentals, broad scalability reading)
 * belong to none and show under All.
 */
export const LIBRARY_AREAS: Record<AreaId, string[]> = {
  development: [
    'primer-solutions',
    'api-web-development',
    'real-world-case-studies',
    'payment-and-fintech',
    'software-architecture',
    'software-development',
    'devtools-productivity',
    'security',
    'how-it-works',
    'technical-interviews',
    'scalability-architecture',
    'scalability-interview',
  ],
  infra: ['cloud-distributed-systems', 'devops-cicd', 'aws-sample', 'aws-terraform', 'aws-roadmap', 'scalability-availability', 'scalability-stability'],
  databases: ['database-and-storage', 'caching-performance', 'db-learning', 'scalability-performance'],
  ai: ['ai-machine-learning', 'scalability-intelligence'],
}
