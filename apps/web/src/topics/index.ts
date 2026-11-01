import { cdn } from './cdn'
import { chatSystem } from './chat-system'
import { consistentHashing } from './consistent-hashing'
import { dockerVsVm } from './docker-vs-vm'
import { kafka } from './kafka'
import { keyValueStore } from './key-value-store'
import { rbacLoad, urlShortenerLoad } from './loadtests'
import { notificationSystem } from './notification-system'
import { paymentIdempotency } from './payment-idempotency'
import { queryCache } from './query-cache'
import { rateLimiter } from './rate-limiter'
import { rbac } from './rbac'
import { salesRank } from './sales-rank'
import { scalingAws } from './scaling-aws'
import { socialGraph } from './social-graph'
import { twitterTimeline } from './twitter-timeline'
import type { StaticTopic } from './types'
import { uberSurge } from './uber-surge'
import { uniqueIdGenerator } from './unique-id-generator'
import { urlShortener } from './url-shortener'
import autoVideos from './videos.json'
import { webCrawler } from './web-crawler'

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
  keyValueStore,
  socialGraph,
  salesRank,
  queryCache,
  scalingAws,
  rateLimiter,
  consistentHashing,
  chatSystem,
  cdn,
  notificationSystem,
  uniqueIdGenerator,
]

/**
 * Hand-written topics: instant and identical every time. Add new ones above.
 * Topics without a hand-made video get the automatic one, when it has been
 * rendered (apps/video/scripts/render-topics.ts writes videos.json).
 */
export const STATIC_TOPICS: StaticTopic[] = BASE_TOPICS.map((t) => {
  const auto = (autoVideos as Record<string, { video: string; chapters: [number, string][] }>)[t.id]
  return t.video || !auto ? t : { ...t, video: auto.video, chapters: auto.chapters }
})
