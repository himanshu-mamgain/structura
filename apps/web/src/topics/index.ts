import { rbac } from './rbac'
import type { AiTopic, StaticTopic, Topic } from './types'
import { urlShortener } from './url-shortener'

export type { AiTopic, StaticTopic, Topic } from './types'

/** Hand-written topics: instant and identical every time. Add new ones here. */
export const STATIC_TOPICS: StaticTopic[] = [urlShortener, rbac]

const ai = (id: string, title: string, blurb: string): AiTopic => ({
  kind: 'ai',
  id,
  title,
  blurb,
  prompt: `Design ${title}`,
})

/** Classic topics the AI designs on demand, until they get a hand-written version. */
export const AI_TOPICS: AiTopic[] = [
  ai('rate-limiter', 'a rate limiter', 'Token bucket, sliding window, distributed counters'),
  ai('chat', 'a chat application', 'WebSockets, presence, message ordering and fan-out'),
  ai('news-feed', 'a news feed', 'Fan-out on write vs read, ranking, caching'),
  ai('notifications', 'a notification system', 'Queues, retries, push, email and SMS providers'),
  ai('payments', 'a payment system', 'Idempotency, ledgers, reconciliation'),
  ai('file-storage', 'a file storage service like Dropbox', 'Chunking, deduplication, sync'),
  ai('web-crawler', 'a web crawler', 'Frontier, politeness, deduplication at scale'),
]

export const ALL_TOPICS: Topic[] = [...STATIC_TOPICS, ...AI_TOPICS]
