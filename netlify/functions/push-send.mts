import { getStore } from '@netlify/blobs'
import type { Config } from '@netlify/functions'
import { sendNotification } from 'web-push'
import { afterSend, dueNotices, freshTopics, isGone, newTopicsNotice, payload, type PushRecord, type QueuedNotice, type TopicSummary } from '../lib/push'
import { vapid } from '../lib/vapid'

// Every 15 minutes (production only): sends each subscribed browser the
// reminders that have come due, and announces topics added since the last run.
// Topics come from the deployed site's /topics.json (written at build time).

export default async () => {
  if (!vapid()) return
  const store = getStore('push-subscriptions')
  const meta = getStore('push-meta')
  const now = Date.now()

  // New topics: compared with what was announced before. The first run only remembers.
  let fresh: TopicSummary[] = []
  try {
    const response = await fetch(`${process.env.URL}/topics.json`, { headers: { 'Cache-Control': 'no-cache' } })
    if (response.ok) {
      const topics = (await response.json()) as TopicSummary[]
      const announced = (await meta.get('announced', { type: 'json' })) as string[] | null
      fresh = announced ? freshTopics(topics, announced) : []
      if (!announced || fresh.length) await meta.setJSON('announced', topics.map((t) => t.id))
    }
  } catch {
    // No topic list this time: try again next run.
  }
  const broadcast = fresh.length ? newTopicsNotice(fresh, now) : null

  const { blobs } = await store.list()
  let sentCount = 0
  for (const { key } of blobs) {
    const record = (await store.get(key, { type: 'json' })) as PushRecord | null
    if (!record) continue
    const due: QueuedNotice[] = [...dueNotices(record, now), ...(broadcast && record.newTopics ? [broadcast] : [])]
    if (!due.length) continue
    const sent: string[] = []
    let gone = false
    for (const notice of due) {
      try {
        // Held by the push service for up to 6 hours if the phone is offline.
        await sendNotification(record.subscription, payload(notice), { TTL: 6 * 60 * 60 })
        sent.push(notice.id)
      } catch (error) {
        if (isGone((error as { statusCode?: number }).statusCode)) {
          gone = true
          break
        }
        // Anything else may be temporary: it stays due and is retried next run.
      }
    }
    if (gone) await store.delete(key)
    else await store.setJSON(key, afterSend(record, sent, now))
    sentCount += sent.length
  }
  console.log(`push-send: ${blobs.length} subscriptions, ${sentCount} sent${fresh.length ? `, announced ${fresh.map((t) => t.id).join(', ')}` : ''}`)
}

export const config: Config = { schedule: '*/15 * * * *' }
