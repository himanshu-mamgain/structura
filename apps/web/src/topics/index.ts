import { adClickAggregator } from './ad-click-aggregator'
import { apiGateway } from './api-gateway'
import { agentContext } from './agent-context'
import { aiAgent } from './ai-agent'
import { langchain } from './langchain'
import { langgraph } from './langgraph'
import { toolCalling } from './tool-calling'
import { awsAlb } from './aws-alb'
import { awsEcsFargate } from './aws-ecs-fargate'
import { awsEcsFullstack } from './aws-ecs-fullstack'
import { awsVpc } from './aws-vpc'
import { cdn } from './cdn'
import { circuitBreaker } from './circuit-breaker'
import { chatSystem } from './chat-system'
import { collaborativeEditing } from './collaborative-editing'
import { consistentHashing } from './consistent-hashing'
import { databaseSharding } from './database-sharding'
import { dockerVsVm } from './docker-vs-vm'
import { globalLoadBalancing } from './global-load-balancing'
import { fileSync } from './file-sync'
import { jobScheduler } from './job-scheduler'
import { leaderElection } from './leader-election'
import { loadBalancer } from './load-balancer'
import { llmGateway } from './llm-gateway'
import { llmGuardrails } from './llm-guardrails'
import { llmInference } from './llm-inference'
import { locking } from './locking'
import { distributedCache } from './distributed-cache'
import { awsBasics } from './aws-basics'
import { awsDisasterRecovery } from './aws-disaster-recovery'
import { awsIam } from './aws-iam'
import { kafka } from './kafka'
import { kafkaBasics } from './kafka-basics'
import { kafkaReliability } from './kafka-reliability'
import { redisBasics } from './redis-basics'
import { redisPersistence } from './redis-persistence'
import { redisReplication } from './redis-replication'
import { keyValueStore } from './key-value-store'
import { rbacLoad, urlShortenerLoad } from './loadtests'
import { messageQueue } from './message-queue'
import { queueTypes } from './queue-types'
import { metricsMonitoring } from './metrics-monitoring'
import { mint } from './mint'
import { notificationSystem } from './notification-system'
import { pastebin } from './pastebin'
import { paymentIdempotency } from './payment-idempotency'
import { proximityService } from './proximity-service'
import { queryCache } from './query-cache'
import { ragPipeline } from './rag-pipeline'
import { rateLimiter } from './rate-limiter'
import { retryBackoff } from './retry-backoff'
import { rbac } from './rbac'
import { salesRank } from './sales-rank'
import { terraformBasics } from './terraform-basics'
import { terraformModules } from './terraform-modules'
import { terraformState } from './terraform-state'
import { scalingAws } from './scaling-aws'
import { searchAutocomplete } from './search-autocomplete'
import { socialGraph } from './social-graph'
import { ticketBooking } from './ticket-booking'
import { twitterTimeline } from './twitter-timeline'
import type { StaticTopic } from './types'
import { uberSurge } from './uber-surge'
import { uniqueIdGenerator } from './unique-id-generator'
import { urlShortener } from './url-shortener'
import { vectorDatabase } from './vector-database'
import { videoStreaming } from './video-streaming'
import autoVideos from './videos.json'
import { webCrawler } from './web-crawler'
import { websocketScaling } from './websocket-scaling'

export type { StaticTopic } from './types'

const BASE_TOPICS: StaticTopic[] = [
  { ...urlShortener, loadTest: urlShortenerLoad },
  { ...rbac, loadTest: rbacLoad },
  uberSurge,
  dockerVsVm,
  twitterTimeline,
  webCrawler,
  kafka,
  paymentIdempotency,
  mint,
  pastebin,
  keyValueStore,
  socialGraph,
  salesRank,
  queryCache,
  scalingAws,
  rateLimiter,
  retryBackoff,
  apiGateway,
  consistentHashing,
  chatSystem,
  websocketScaling,
  cdn,
  notificationSystem,
  uniqueIdGenerator,
  ticketBooking,
  jobScheduler,
  searchAutocomplete,
  proximityService,
  videoStreaming,
  metricsMonitoring,
  circuitBreaker,
  fileSync,
  collaborativeEditing,
  leaderElection,
  messageQueue,
  queueTypes,
  locking,
  distributedCache,
  databaseSharding,
  ragPipeline,
  vectorDatabase,
  llmGateway,
  aiAgent,
  llmInference,
  llmGuardrails,
  agentContext,
  toolCalling,
  langchain,
  langgraph,
  awsVpc,
  awsAlb,
  globalLoadBalancing,
  awsEcsFargate,
  awsEcsFullstack,
  loadBalancer,
  redisBasics,
  redisPersistence,
  redisReplication,
  awsBasics,
  awsIam,
  awsDisasterRecovery,
  kafkaBasics,
  kafkaReliability,
  terraformBasics,
  terraformState,
  terraformModules,
  adClickAggregator,
]

/**
 * Hand-written topics: instant and identical every time. Add new ones above.
 * Topics without a hand-made video get the automatic one, when it has been
 * rendered (apps/video/scripts/render-topics.ts writes videos.json).
 */
export const STATIC_TOPICS: StaticTopic[] = BASE_TOPICS.map((t) => {
  const auto = (autoVideos as unknown as Record<string, { video: string; chapters: [number, string][] }>)[t.id]
  return t.video || !auto ? t : { ...t, video: auto.video, chapters: auto.chapters }
})
