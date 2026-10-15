import { dockerVsVm } from './docker-vs-vm'
import { rbacLoad, urlShortenerLoad } from './loadtests'
import { rbac } from './rbac'
import { twitterTimeline } from './twitter-timeline'
import type { StaticTopic } from './types'
import { uberSurge } from './uber-surge'
import { urlShortener } from './url-shortener'
import { webCrawler } from './web-crawler'

export type { StaticTopic } from './types'

/** Hand-written topics: instant and identical every time. Add new ones here. */
export const STATIC_TOPICS: StaticTopic[] = [
  { ...urlShortener, loadTest: urlShortenerLoad },
  { ...rbac, loadTest: rbacLoad },
  uberSurge,
  dockerVsVm,
  twitterTimeline,
  webCrawler,
]
