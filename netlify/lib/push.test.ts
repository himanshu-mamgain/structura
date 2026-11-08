// npm run test:push
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { afterSend, dueNotices, freshTopics, keyFor, newTopicsNotice, parseQueue, parseSubscription, payload, upsert } from './push'

const now = Date.parse('2026-11-08T13:30:00Z') // 19:00 in India
const HOUR = 3_600_000
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }
const notice = (id: string, at: number) => ({ id, kind: 'daily', at, title: 'Today: Continue Kafka', body: 'Read "Key decisions"', url: '/?topic=kafka' })

test('accepts real push services only', () => {
  assert.ok(parseSubscription(sub))
  assert.ok(parseSubscription({ ...sub, endpoint: 'https://web.push.apple.com/QGuQyavXutnMdx7' }))
  assert.equal(parseSubscription({ ...sub, endpoint: 'https://evil.example.com/x' }), null)
  assert.equal(parseSubscription({ ...sub, endpoint: 'http://fcm.googleapis.com/x' }), null)
  assert.equal(parseSubscription({ endpoint: sub.endpoint }), null)
})

test('keeps well-formed reminders for this site only', () => {
  const queue = parseQueue(
    [
      notice('daily:2026-11-09', now + 24 * HOUR),
      { ...notice('daily:2026-11-10', now + 48 * HOUR), body: '' },
      { ...notice('a', now), url: 'https://evil.example.com' },
      { ...notice('b', now), url: '//evil.example.com' },
      notice('too-late', now - 2 * 24 * HOUR),
      notice('too-far', now + 40 * 24 * HOUR),
      { ...notice('x', now), title: '' },
      notice('bad id <script>', now),
    ],
    now,
  )
  assert.deepEqual(queue.map((n) => n.id), ['daily:2026-11-09', 'daily:2026-11-10'])
})

test('sends what is due, once, and not when it is hours late', () => {
  const record = upsert(null, sub, [notice('old', now - 7 * HOUR), notice('due', now - 5 * 60_000), notice('later', now + HOUR)], true, now)
  assert.deepEqual(dueNotices(record, now).map((n) => n.id), ['due'])
  const after = afterSend(record, ['due'], now)
  assert.deepEqual(dueNotices(after, now), [])
  // The app re-syncs the same reminder: still not sent twice.
  const resynced = upsert(after, sub, [notice('due', now - 5 * 60_000), notice('later', now + HOUR)], true, now)
  assert.deepEqual(dueNotices(resynced, now), [])
  assert.deepEqual(dueNotices(resynced, now + HOUR).map((n) => n.id), ['later'])
})

test('announces only topics it has not announced', () => {
  const topics = [
    { id: 'kafka', title: 'Kafka', blurb: 'Event streaming' },
    { id: 'pastebin', title: 'Pastebin', blurb: 'Store and share text' },
    { id: 'proximity-service', title: 'Proximity Service', blurb: 'Find nearby places' },
  ]
  const fresh = freshTopics(topics, ['kafka'])
  assert.deepEqual(fresh.map((t) => t.id), ['pastebin', 'proximity-service'])
  const n = newTopicsNotice(fresh, now)
  assert.equal(n.title, '2 new topics')
  assert.equal(n.body, 'Pastebin and Proximity Service')
  assert.equal(n.url, '/?topic=pastebin')
  assert.equal(newTopicsNotice(fresh.slice(0, 1), now).title, 'New topic: Pastebin')
})

test('keys are stable and the payload is what the service worker reads', () => {
  assert.equal(keyFor(sub.endpoint), keyFor(sub.endpoint))
  assert.equal(keyFor(sub.endpoint).length, 64)
  assert.deepEqual(JSON.parse(payload(notice('daily:2026-11-08', now))), { id: 'daily:2026-11-08', title: 'Today: Continue Kafka', body: 'Read "Key decisions"', url: '/?topic=kafka', tag: 'daily' })
})
