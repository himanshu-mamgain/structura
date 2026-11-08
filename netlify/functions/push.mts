import { getStore } from '@netlify/blobs'
import type { Config } from '@netlify/functions'
import { sendNotification } from 'web-push'
import { keyFor, parseQueue, parseSubscription, payload, type PushRecord, upsert } from '../lib/push'
import { vapid } from '../lib/vapid'

// /api/push, called by the app (apps/web/src/pwa/push.ts):
//   GET     the public key to subscribe with
//   POST    { subscription, queue, newTopics }  save or update this browser's reminders
//   POST    { subscription, test: true }        push a test notification now
//   POST    { subscription, previousEndpoint }  the browser renewed its subscription
//   DELETE  { endpoint }                        stop, and forget this browser

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export default async (req: Request) => {
  const keys = vapid()
  if (!keys) return json({ error: 'Push is not configured on this site.' }, 503)
  if (req.method === 'GET') return json({ publicKey: keys.publicKey })
  if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405)
  if (Number(req.headers.get('content-length') ?? 0) > 64 * 1024) return json({ error: 'Too large' }, 413)

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return json({ error: 'Expected JSON' }, 400)
  const store = getStore('push-subscriptions')
  const now = Date.now()

  if (req.method === 'DELETE') {
    if (typeof body.endpoint !== 'string') return json({ error: 'Expected an endpoint' }, 400)
    await store.delete(keyFor(body.endpoint))
    return new Response(null, { status: 204 })
  }

  const subscription = parseSubscription(body.subscription)
  if (!subscription) return json({ error: 'Not a push subscription' }, 400)
  const key = keyFor(subscription.endpoint)

  if (body.test === true) {
    try {
      await sendNotification(subscription, payload({ id: `test:${now}`, kind: 'test', at: now, title: 'Notifications are on', body: "Structura will remind you here. Tap to open it.", url: '/' }), { TTL: 600 })
      return json({ ok: true })
    } catch (error) {
      return json({ error: `The push service said ${(error as { statusCode?: number }).statusCode ?? 'no'}.` }, 502)
    }
  }

  if (typeof body.previousEndpoint === 'string') {
    // Same browser, new subscription: carry its reminders over.
    const oldKey = keyFor(body.previousEndpoint)
    const old = (await store.get(oldKey, { type: 'json' })) as PushRecord | null
    if (old) {
      await store.setJSON(key, { ...old, subscription, updatedAt: now })
      await store.delete(oldKey)
    }
    return json({ ok: true })
  }

  const previous = (await store.get(key, { type: 'json' })) as PushRecord | null
  const record = upsert(previous, subscription, parseQueue(body.queue, now), body.newTopics !== false, now)
  await store.setJSON(key, record)
  return json({ ok: true, queued: record.queue.length })
}

export const config: Config = { path: '/api/push' }
