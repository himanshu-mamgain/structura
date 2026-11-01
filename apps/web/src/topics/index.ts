import { dockerVsVm } from './docker-vs-vm'
import { kafka } from './kafka'
import { rbacLoad, urlShortenerLoad } from './loadtests'
import { mint } from './mint'
import { paymentIdempotency } from './payment-idempotency'
import { pastebin } from './pastebin'
import { rbac } from './rbac'
import { twitterTimeline } from './twitter-timeline'
import type { StaticTopic } from './types'
import autoVideos from './videos.json'
import { uberSurge } from './uber-surge'
import { urlShortener } from './url-shortener'
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
  mint,
  pastebin,
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
