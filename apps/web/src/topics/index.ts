import { rbacLoad, urlShortenerLoad } from './loadtests'
import { rbac } from './rbac'
import type { StaticTopic } from './types'
import { urlShortener } from './url-shortener'

export type { StaticTopic } from './types'

/** Hand-written topics: instant and identical every time. Add new ones here. */
export const STATIC_TOPICS: StaticTopic[] = [
  { ...urlShortener, loadTest: urlShortenerLoad },
  { ...rbac, loadTest: rbacLoad },
]
