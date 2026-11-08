import { createHash } from 'node:crypto'

// What the push functions store and send, kept free of Netlify and network code
// so it can be tested on its own (netlify/lib/push.test.ts).
//
// Nothing here knows the learner's progress: the app works out its reminders
// (apps/web/src/learn/notify.ts) and sends only what each notification says
// and when. Records are keyed by a hash of the push endpoint; there are no accounts.

export interface Subscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export interface QueuedNotice {
  id: string
  kind: string
  at: number
  title: string
  body: string
  url: string
}

export interface PushRecord {
  subscription: Subscription
  queue: QueuedNotice[]
  /** Wants "new topic" broadcasts. */
  newTopics: boolean
  /** Ids already sent, so a re-sync never sends one twice. */
  sent: string[]
  updatedAt: number
}

export interface TopicSummary {
  id: string
  title: string
  blurb: string
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** A reminder this late (phone off, function down) is dropped instead of sent. */
export const SEND_WINDOW = 6 * HOUR
const MAX_QUEUE = 60

// Browsers' push services. Anything else isn't a real subscription.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/]

const isText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max

export function parseSubscription(x: unknown): Subscription | null {
  const s = x as Partial<Subscription> | null
  if (!s || !isText(s.endpoint, 1000) || !isText(s.keys?.p256dh, 200) || !isText(s.keys?.auth, 100)) return null
  let url: URL
  try {
    url = new URL(s.endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((host) => host.test(url.hostname))) return null
  return { endpoint: s.endpoint, expirationTime: typeof s.expirationTime === 'number' ? s.expirationTime : null, keys: { p256dh: s.keys!.p256dh, auth: s.keys!.auth } }
}

/** Keeps well-formed reminders due between a day ago and 30 days ahead; drops the rest. */
export function parseQueue(x: unknown, now: number): QueuedNotice[] {
  if (!Array.isArray(x)) return []
  const out: QueuedNotice[] = []
  for (const n of x.slice(0, MAX_QUEUE) as Partial<QueuedNotice>[]) {
    if (!n || !isText(n.id, 160) || !/^[\w:,.-]+$/.test(n.id)) continue
    if (typeof n.at !== 'number' || !Number.isFinite(n.at) || n.at < now - DAY || n.at > now + 30 * DAY) continue
    if (!isText(n.title, 140) || (n.body !== undefined && (typeof n.body !== 'string' || n.body.length > 300))) continue
    // Paths on this site only: a notification can't send anyone elsewhere.
    if (!isText(n.url, 300) || !n.url.startsWith('/') || n.url.startsWith('//')) continue
    out.push({ id: n.id, kind: isText(n.kind, 20) ? n.kind : 'reminder', at: n.at, title: n.title, body: n.body ?? '', url: n.url })
  }
  return out.sort((a, b) => a.at - b.at)
}

export const keyFor = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex')

/** A new or updated record: the latest queue, keeping what was already sent. */
export function upsert(previous: PushRecord | null, subscription: Subscription, queue: QueuedNotice[], newTopics: boolean, now: number): PushRecord {
  return { subscription, queue, newTopics, sent: (previous?.sent ?? []).slice(-200), updatedAt: now }
}

/** Reminders to send now: due, not too late, not sent yet. At most 3, oldest first. */
export function dueNotices(record: PushRecord, now: number): QueuedNotice[] {
  const sent = new Set(record.sent)
  return record.queue.filter((n) => n.at <= now && n.at > now - SEND_WINDOW && !sent.has(n.id)).slice(0, 3)
}

/** The record after a run: sent ids remembered, long-past reminders dropped. */
export function afterSend(record: PushRecord, sentIds: string[], now: number): PushRecord {
  return { ...record, sent: [...record.sent, ...sentIds].slice(-200), queue: record.queue.filter((n) => n.at > now - DAY) }
}

/** Topics in `current` that weren't announced yet. */
export function freshTopics(current: TopicSummary[], announced: string[]): TopicSummary[] {
  const seen = new Set(announced)
  return current.filter((t) => !seen.has(t.id))
}

export function newTopicsNotice(fresh: TopicSummary[], now: number): QueuedNotice {
  const titles = fresh.map((t) => t.title)
  return {
    id: `new:${fresh.map((t) => t.id).join(',')}`,
    kind: 'new',
    at: now,
    title: fresh.length === 1 ? `New topic: ${fresh[0].title}` : `${fresh.length} new topics`,
    body: fresh.length === 1 ? fresh[0].blurb : titles.length > 3 ? `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more` : titles.length < 3 ? titles.join(' and ') : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`,
    url: `/?topic=${fresh[0].id}`,
  }
}

/** What the service worker receives (public/notify-sw.js). */
export const payload = (n: QueuedNotice) => JSON.stringify({ id: n.id, title: n.title, body: n.body, url: n.url, tag: n.kind })

/** Push services answer these when a subscription is gone for good. */
export const isGone = (statusCode: number | undefined) => statusCode === 404 || statusCode === 410
