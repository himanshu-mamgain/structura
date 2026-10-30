import type { Trace } from '@structura/shared'
import { json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A notification service for a shopping app: 20M daily users, ~5 notifications each.
// The simulator walks one event through dedup, preferences, templating, the channel
// queue, the worker and the provider, including retries with exponential backoff.

type Event = { id: string; title: string; channel: 'push' | 'email'; kind: 'transactional' | 'marketing' | 'urgent'; subject: string }

const EVENTS: Record<string, Event> = {
  'Order shipped': { id: 'order_shipped', title: 'Order shipped', channel: 'push', kind: 'transactional', subject: 'Your order #48213 has shipped' },
  'Weekly deals': { id: 'weekly_deals', title: 'Weekly deals', channel: 'email', kind: 'marketing', subject: 'This week: 30% off headphones' },
  'Login code': { id: 'login_code', title: 'Login code', channel: 'push', kind: 'urgent', subject: 'Your code is 482913' },
}

const USERS: Record<string, { id: string; marketing: boolean; local: string; quiet: boolean }> = {
  'Maya (no restrictions)': { id: 'u_1042', marketing: true, local: '14:05', quiet: false },
  'Ravi (opted out of marketing)': { id: 'u_2291', marketing: false, local: '14:05', quiet: false },
  'Anu (quiet hours, 23:30 local)': { id: 'u_3377', marketing: true, local: '23:30', quiet: true },
}

const BACKOFF_BASE_S = 2
const MAX_ATTEMPTS = 5

const simulator: Simulator = {
  fields: [
    { id: 'event', label: 'Event from the Order Service', options: Object.keys(EVENTS) },
    { id: 'user', label: 'Who gets it', options: Object.keys(USERS) },
    { id: 'scenario', label: 'What happens', options: ['Everything works', 'Provider times out twice, then works', 'Provider is down for good', 'Upstream sends the event twice'] },
  ],
  defaults: { event: 'Order shipped', user: 'Maya (no restrictions)', scenario: 'Everything works' },
  run({ event, user, scenario }) {
    const ev = EVENTS[event] ?? EVENTS['Order shipped']
    const u = USERS[user] ?? USERS['Maya (no restrictions)']
    const push = ev.channel === 'push'
    const worker = push ? 'Push Worker' : 'Email Worker'
    const provider = push ? 'FCM / APNs' : 'Email Provider (SES)'
    const dedupKey = `${ev.id}:${u.id}:48213`
    const hash = stableHash(dedupKey).toString(16).padStart(8, '0')
    const queue = ev.kind === 'urgent' ? 'notif.push.high' : `notif.${ev.channel}.normal`
    const input = `${event} → ${user.split(' (')[0]}, ${scenario.toLowerCase()}`
    const steps: Trace['steps'] = [
      {
        text: `The Order Service publishes "${ev.title}" for user ${u.id}. It sends an event, not a finished message: the Notification API decides who gets what.`,
        nodes: ['Upstream Service (Orders)', 'Notification API'],
        data: `POST /v1/notifications\n${json({ event: ev.id, user_id: u.id, order_id: 48213, idempotency_key: dedupKey })}`,
      },
      {
        text: `The API claims the idempotency key in the Dedup Store (Redis) with SET NX and a 24 hour expiry. The first claim wins.`,
        nodes: ['Notification API', 'Dedup Store (Redis)'],
        data: `SET dedup:${dedupKey} 1 NX EX 86400\n→ OK  (first time we've seen this event)`,
      },
    ]
    if (scenario.startsWith('Upstream')) {
      steps.push({
        text: 'The upstream service retried after a network blip and sent the same event again. The second SET NX fails, so the API answers "already accepted" and sends nothing. Without this, the user would get two pushes.',
        nodes: ['Notification API', 'Dedup Store (Redis)'],
        data: `SET dedup:${dedupKey} 1 NX EX 86400\n→ (nil)   duplicate\nHTTP 200 { "status": "duplicate", "ignored": true }`,
      })
    }

    // Preferences: marketing opt-out and quiet hours.
    steps.push({
      text: `The Preference Service looks up ${u.id}: which channels are on, whether marketing is allowed, and quiet hours.`,
      nodes: ['Preference Service', 'Preferences DB'],
      data: `SELECT push_enabled, email_enabled, marketing_opt_in, quiet_start, quiet_end\nFROM notification_prefs WHERE user_id = '${u.id}'\n→ ${json({ push_enabled: true, email_enabled: true, marketing_opt_in: u.marketing, quiet: '22:00–08:00', local_time: u.local })}`,
    })
    if (ev.kind === 'marketing' && !u.marketing) {
      steps.push({
        text: `${u.id} opted out of marketing, so the message is dropped here and recorded as suppressed. It never reaches a queue, and we never touch a provider. This check must be on the server: an unsubscribe has to hold even if some upstream service forgets.`,
        nodes: ['Preference Service', 'Notification Log DB'],
        data: `INSERT INTO notifications (user_id, type, channel, status, dedup_key)\nVALUES ('${u.id}', '${ev.id}', 'email', 'SUPPRESSED_OPT_OUT', '${dedupKey}')`,
      })
      return { input, steps }
    }
    let delayNote = ''
    if (ev.kind === 'marketing' && u.quiet) {
      const wait = 30_600
      steps.push({
        text: `It is ${u.local} for ${u.id}, inside quiet hours (22:00 to 08:00). Marketing waits: the API sets a send-after time of 08:00 local, 8.5 hours (${wait.toLocaleString()} seconds) away, and parks the message in the Retry Queue (delayed) until then.`,
        nodes: ['Preference Service', 'Retry Queue (delayed)'],
        data: `send_after = 08:00 local   (in ${wait.toLocaleString()} s)\nstatus = SCHEDULED`,
      })
      delayNote = ' (released at 08:00)'
    } else if (u.quiet && ev.kind !== 'marketing') {
      steps.push({
        text: `It is ${u.local}, inside quiet hours, but "${ev.title}" is ${ev.kind === 'urgent' ? 'urgent' : 'transactional'}: quiet hours only hold back marketing, so it goes straight through.`,
        nodes: ['Preference Service'],
        data: `type=${ev.kind} → bypass quiet hours`,
      })
    }

    steps.push(
      {
        text: `The Template Service fills the ${ev.channel} template for this event and the user's language. Content is built here, once, so every channel says the same thing.`,
        nodes: ['Template Service'],
        data: `template ${ev.id}.${ev.channel}.en\n${json({ title: ev.title, body: ev.subject })}`,
      },
      {
        text: `The API writes a row to the Notification Log DB (status QUEUED) and publishes to ${queue} on the Channel Queues (Kafka)${delayNote}. ${ev.kind === 'urgent' ? 'Urgent codes get their own high-priority queue, so a big marketing blast can never delay them.' : 'Queues are per channel and per priority, so a slow email provider cannot hold up pushes.'} The caller gets its answer now: 202 Accepted.`,
        nodes: ['Notification API', 'Channel Queues (Kafka)', 'Notification Log DB'],
        data: `kafka produce ${queue} key=${u.id}\nHTTP 202 { "notification_id": "n_${hash}", "status": "QUEUED" }`,
      },
      {
        text: `The ${worker} takes the message off the queue and calls ${provider}.`,
        nodes: ['Channel Queues (Kafka)', worker],
        data: push
          ? `FCM v1 send\n${json({ message: { token: 'fcm_8f3a…c91', notification: { title: ev.title, body: ev.subject }, android: { collapse_key: ev.id } } })}`
          : `SES SendEmail\n${json({ to: 'maya@example.com', subject: ev.subject, template: ev.id })}`,
      },
    )

    // Delivery attempts with exponential backoff.
    const failures = scenario.startsWith('Provider times') ? 2 : scenario.startsWith('Provider is down') ? MAX_ATTEMPTS : 0
    const delays: number[] = []
    for (let i = 0; i < failures; i++) delays.push(BACKOFF_BASE_S * 2 ** i)
    if (failures > 0) {
      const total = delays.reduce((a, b) => a + b, 0)
      steps.push({
        text: `${provider} times out ${failures === MAX_ATTEMPTS ? 'every time' : `${failures} times`}. The ${worker} does not retry in a tight loop, which would hammer a provider that is already struggling. It waits ${delays.join(' s, ')} s (doubling each time, with a little random jitter) in the Retry Queue (delayed).`,
        nodes: [worker, 'Retry Queue (delayed)'],
        data: delays.map((d, i) => `attempt ${i + 1}: timeout → retry in ${d}s`).join('\n') + `\nwaited ${total}s so far`,
      })
    }
    if (failures === MAX_ATTEMPTS) {
      const total = delays.reduce((a, b) => a + b, 0)
      steps.push(
        {
          text: `After ${MAX_ATTEMPTS} attempts (${total} s of waiting) the message moves to the Dead Letter Queue. An alert fires, and the notification is marked FAILED rather than lost silently.`,
          nodes: ['Retry Queue (delayed)', 'Dead Letter Queue', 'Notification Log DB'],
          data: `UPDATE notifications SET status = 'FAILED', attempts = ${MAX_ATTEMPTS} WHERE id = 'n_${hash}'\nDLQ depth: +1 → page on-call if it keeps rising`,
        },
      )
      return { input, steps }
    }
    steps.push({
      text: push
        ? `${provider} accepts it${failures ? ` on attempt ${failures + 1}` : ''} and pushes it to the phone over its always-open connection. Delivery to the User Device is best effort: the phone may be off, so the push may arrive later or never.`
        : `${provider} accepts it${failures ? ` on attempt ${failures + 1}` : ''} and delivers it to the user's mail server. A bounce or complaint comes back later as a webhook, and the log is updated then.`,
      nodes: push ? [provider, 'User Device'] : [provider],
      data: push ? `FCM → 200 { "name": "projects/shop/messages/0:1730281500123456%a1b2" }` : `SES → 200 { "MessageId": "0100018f-${hash}" }`,
    })
    steps.push({
      text: `The ${worker} marks the log row SENT, with the number of attempts. The log is what powers "why didn't I get my notification?" in support.`,
      nodes: [worker, 'Notification Log DB'],
      data: `UPDATE notifications SET status = 'SENT', attempts = ${failures + 1}, sent_at = now()\nWHERE id = 'n_${hash}'`,
    })
    return { input, steps }
  },
}

export const notificationSystem: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'notification-system',
  title: 'Notification System',
  blurb: 'Push, email and SMS at scale: dedup, preferences, queues, retries and dead letters',
  guides: [
    'how-does-a-typical-push-notification-system-work',
    'how-are-notifications-pushed-to-our-phones-or-pcs',
    'scale-scaling-push-messaging-for-millions-of-devices-at-netflix',
    'how-do-we-retry-on-failures',
    'top-6-cases-to-apply-idempotency',
    'primer-asynchronism',
    'scale-reprocessing-and-dead-letter-queues-with-kafka-at-uber',
  ],
  takeaways: [
    'Accept the event fast and send later: a queue between the API and the workers keeps spikes away from providers.',
    'Use one queue per channel and priority, so a marketing blast never delays a login code.',
    'Deduplicate with an idempotency key, because upstream services retry.',
    'Check preferences on the server (opt-outs, quiet hours); marketing waits, urgent messages do not.',
    'Retry with exponential backoff and jitter, then dead-letter the message instead of losing it.',
    'Delivery is at-least-once and best effort; log every attempt so you can answer "why didn\'t I get it?".',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'intake', label: 'Intake' },
      { id: 'delivery', label: 'Delivery' },
      { id: 'providers', label: 'Third-party providers' },
    ],
    nodes: [
      { id: 'upstream', label: 'Upstream Service (Orders)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'api', label: 'Notification API', shape: 'rectangle', color: 'violet', group: 'intake' },
      { id: 'dedup', label: 'Dedup Store (Redis)', shape: 'rectangle', color: 'red', group: 'intake' },
      { id: 'prefs', label: 'Preference Service', shape: 'diamond', color: 'violet', group: 'intake' },
      { id: 'prefsdb', label: 'Preferences DB', shape: 'rectangle', color: 'green', group: 'intake' },
      { id: 'templates', label: 'Template Service', shape: 'rectangle', color: 'violet', group: 'intake' },
      { id: 'queues', label: 'Channel Queues (Kafka)', shape: 'rectangle', color: 'yellow', group: 'delivery' },
      { id: 'push', label: 'Push Worker', shape: 'rectangle', color: 'orange', group: 'delivery' },
      { id: 'email', label: 'Email Worker', shape: 'rectangle', color: 'orange', group: 'delivery' },
      { id: 'retry', label: 'Retry Queue (delayed)', shape: 'rectangle', color: 'yellow', group: 'delivery' },
      { id: 'dlq', label: 'Dead Letter Queue', shape: 'rectangle', color: 'red', group: 'delivery' },
      { id: 'fcm', label: 'FCM / APNs', shape: 'cloud', color: 'blue', group: 'providers' },
      { id: 'ses', label: 'Email Provider (SES)', shape: 'cloud', color: 'blue', group: 'providers' },
      { id: 'log', label: 'Notification Log DB', shape: 'rectangle', color: 'green', group: null },
      { id: 'device', label: 'User Device', shape: 'ellipse', color: 'blue', group: null },
    ],
    edges: [
      { from: 'upstream', to: 'api', label: 'POST event', dashed: false },
      { from: 'api', to: 'dedup', label: 'SET NX', dashed: false },
      { from: 'api', to: 'prefs', label: 'allowed?', dashed: false },
      { from: 'prefs', to: 'prefsdb', label: 'read prefs', dashed: false },
      { from: 'api', to: 'templates', label: 'render', dashed: false },
      { from: 'api', to: 'queues', label: 'publish', dashed: false },
      { from: 'api', to: 'log', label: 'QUEUED', dashed: true },
      { from: 'queues', to: 'push', label: 'push topic', dashed: false },
      { from: 'queues', to: 'email', label: 'email topic', dashed: false },
      { from: 'push', to: 'fcm', label: 'send', dashed: false },
      { from: 'email', to: 'ses', label: 'send', dashed: false },
      { from: 'fcm', to: 'device', label: 'push', dashed: false },
      { from: 'push', to: 'retry', label: 'on failure', dashed: true },
      { from: 'email', to: 'retry', label: 'on failure', dashed: true },
      { from: 'retry', to: 'queues', label: 'after backoff', dashed: true },
      { from: 'retry', to: 'dlq', label: 'after 5 tries', dashed: true },
      { from: 'push', to: 'log', label: 'SENT / FAILED', dashed: true },
      { from: 'email', to: 'log', label: 'SENT / FAILED', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'notification_prefs',
        name: 'notification_prefs',
        columns: [
          { name: 'user_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'push_enabled', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'email_enabled', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'marketing_opt_in', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'quiet_start', type: 'time', pk: false, fk: null, nullable: true, unique: false },
          { name: 'quiet_end', type: 'time', pk: false, fk: null, nullable: true, unique: false },
          { name: 'timezone', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'device_tokens',
        name: 'device_tokens',
        columns: [
          { name: 'token', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'text', pk: false, fk: 'notification_prefs.user_id', nullable: false, unique: false },
          { name: 'platform', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'last_seen', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id) — all devices of a user'],
      },
      {
        id: 'notifications',
        name: 'notifications',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'text', pk: false, fk: 'notification_prefs.user_id', nullable: false, unique: false },
          { name: 'dedup_key', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'type', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'channel', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'attempts', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'sent_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(user_id, created_at DESC) — a user\'s history', '(dedup_key) unique'],
      },
    ],
    relations: [
      { from: 'notification_prefs', to: 'device_tokens', kind: 'one-to-many', label: 'has devices' },
      { from: 'notification_prefs', to: 'notifications', kind: 'one-to-many', label: 'receives' },
    ],
  },
  explanation: {
    title: 'Notification System',
    summary:
      'A notification system turns events ("your order shipped") into messages on the right channel (push, email, SMS) without annoying people or losing important ones. The core design is: accept events fast, check preferences, put messages on per-channel queues, and let workers deliver them with retries.',
    sections: [
      {
        heading: 'Overview',
        body: 'Every team wants to notify users. If each one calls FCM or an email provider directly, you get duplicate code, no shared opt-outs, and an outage at a provider takes down the calling service.\n\nA central notification system fixes this. Services send it an event. It decides whether to send, builds the message, queues it, and delivers it. Providers (Firebase Cloud Messaging for Android, APNs for iOS, an email service) do the last hop to the device; we cannot control that hop.',
      },
      {
        heading: 'Requirements',
        body: '- Channels: push, email and SMS.\n- Soft real-time: urgent messages in seconds, marketing can wait.\n- Respect preferences: opt-outs, quiet hours, per-channel switches.\n- No duplicates and no silent loss; at-least-once delivery is acceptable.\n- Scale: bursts when a campaign goes out.\n- Observability: for any notification, say what happened to it.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 20 million daily users, 5 notifications each.\n- 20,000,000 × 5 = 100,000,000 notifications a day.\n- Average: 100,000,000 / 86,400 s ≈ 1,157 per second. Peak at 10× the average (a campaign or a flash sale) ≈ 11,574 per second.\n- Mix of 60% push, 35% email, 5% SMS: 60M, 35M and 5M a day.\n- Event size about 1 KB: 11,574 × 1 KB ≈ 11.6 MB/s into the queues at peak.\n- Log rows at about 500 bytes: 100M × 500 B = 50 GB a day, 1.5 TB for 30 days of history.\n- If one worker sends 500 messages a second, peak needs 11,574 / 500 ≈ 24 workers; run 30 or so for headroom.',
      },
      {
        heading: 'Step by step',
        body: '1. The Upstream Service (Orders) posts an event with an idempotency key to the Notification API.\n2. The Notification API claims the key in the Dedup Store (Redis); a second claim means a duplicate and is ignored.\n3. The Preference Service reads the user\'s settings from the Preferences DB: opt-outs, channels, quiet hours.\n4. The Template Service renders the message for the channel and language.\n5. The Notification API records it in the Notification Log DB and publishes it to the Channel Queues (Kafka), then answers 202 Accepted.\n6. The Push Worker or Email Worker consumes its queue and calls the provider: FCM / APNs or Email Provider (SES).\n7. FCM / APNs delivers the push to the User Device.\n8. On failure, the worker puts the message in the Retry Queue (delayed), which waits with exponential backoff and returns it to the Channel Queues (Kafka).\n9. After 5 tries it goes to the Dead Letter Queue and an alert fires.\n10. Workers update the Notification Log DB with SENT or FAILED.',
      },
      {
        heading: 'Components',
        body: '- Upstream Service (Orders): any service that has something to tell a user; it sends events, not finished messages.\n- Notification API: the single front door; validates, dedups, enforces preferences, queues, and answers fast.\n- Dedup Store (Redis): remembers idempotency keys for 24 hours with SET NX, so retried events send nothing twice.\n- Preference Service: decides whether and when a user may be contacted (opt-outs, quiet hours).\n- Preferences DB: the user\'s channel switches, marketing consent, quiet hours and time zone.\n- Template Service: fills per-channel, per-language templates so wording lives in one place.\n- Channel Queues (Kafka): one topic per channel and priority; absorbs bursts and decouples us from slow providers.\n- Push Worker: consumes the push topic, looks up device tokens and calls FCM / APNs.\n- Email Worker: consumes the email topic and calls the email provider.\n- Retry Queue (delayed): holds failed or scheduled messages until their next attempt time.\n- Dead Letter Queue: where messages go after the last retry, for alerts and manual replay.\n- FCM / APNs: Google and Apple\'s push services; they hold a connection to every phone.\n- Email Provider (SES): sends the email and reports bounces and complaints.\n- Notification Log DB: one row per notification and its status; used for support and analytics.\n- User Device: the phone; it may be offline, so delivery is best effort.',
      },
      {
        heading: 'Key decisions',
        body: '- Queue per channel and priority: isolates a slow channel and lets login codes jump ahead of marketing.\n- Where to check preferences: on the server, in one place, so an unsubscribe cannot be bypassed by a forgetful caller.\n- Retries: exponential backoff (2, 4, 8, 16, 32 seconds) plus jitter, so thousands of failed messages do not retry in the same second.\n- Delivery guarantee: at-least-once. Exactly-once is not possible across a third party, so dedup keys keep duplicates rare.\n- Fan-out campaigns: a marketing blast to 5 million users is expanded by a batch job and fed in at a throttled rate, in the low-priority queue.\n- Bad tokens: when FCM says a device token is invalid, delete it, or you keep paying to send to dead phones.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Workers are stateless; add more as queue lag grows. Partition queues by user id so one user\'s messages stay in order.\n- If a provider is down, messages wait in the queue and retry; fail over to a second provider for email or SMS if the contract allows.\n- If Redis is down, prefer to send (a rare duplicate) over dropping a login code; the unique dedup_key on the log table is a second line of defence.\n- Rate-limit per user (for example, at most 3 marketing messages a day) so the product does not become spam.\n- Watch: queue lag, send success rate per provider, DLQ depth, and end-to-end latency for urgent messages.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How do you make sure a user never gets the same notification twice?\n- A campaign goes to 5 million users at 9am. How do you avoid overloading providers and delaying login codes?\n- How do you handle a user with three devices, or a token that has expired?\n- What would you change to guarantee delivery of a payment alert?\n- How would you let a user say "no marketing at night" and enforce it everywhere?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Accept an event: dedup, preferences, queue (TypeScript)',
        language: 'typescript',
        source: `export async function accept(e: { event: string; user_id: string; idempotency_key: string }) {
  // SET NX: only the first caller within 24h gets "OK".
  const first = await redis.set(\`dedup:\${e.idempotency_key}\`, '1', { NX: true, EX: 86_400 })
  if (!first) return { status: 'duplicate' }

  const prefs = await prefsService.get(e.user_id)
  const type = TYPES[e.event]
  if (type.kind === 'marketing' && !prefs.marketingOptIn) return suppress(e, 'OPT_OUT')

  const id = await log.insert({ ...e, status: 'QUEUED' })
  const topic = type.kind === 'urgent' ? 'notif.push.high' : \`notif.\${type.channel}.normal\`
  await kafka.send({ topic, messages: [{ key: e.user_id, value: JSON.stringify({ id, ...e }) }] })
  return { status: 'QUEUED', id } // 202: delivery happens later
}`,
      },
      {
        title: 'Retry with exponential backoff and jitter (Python)',
        language: 'python',
        source: `import random

MAX_ATTEMPTS = 5

def next_delay(attempt: int) -> float:
    # attempt 1 -> ~2s, 2 -> ~4s, 3 -> ~8s ... plus up to 1s of jitter
    return 2 * 2 ** (attempt - 1) + random.random()

def deliver(msg, send):
    try:
        send(msg)
    except TimeoutError:
        if msg.attempts + 1 >= MAX_ATTEMPTS:
            dead_letter(msg)  # alert, keep for replay
        else:
            retry_queue.put(msg, delay=next_delay(msg.attempts + 1))`,
      },
      {
        title: 'Log table and the "why no notification?" query (SQL)',
        language: 'sql',
        source: `CREATE TABLE notifications (
  id         text PRIMARY KEY,
  user_id    text NOT NULL,
  dedup_key  text NOT NULL UNIQUE,   -- second line of defence against duplicates
  type       text NOT NULL,
  channel    text NOT NULL,
  status     text NOT NULL,          -- QUEUED, SENT, FAILED, SUPPRESSED_OPT_OUT
  attempts   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX notifications_user_time ON notifications (user_id, created_at DESC);

-- Support: what happened to this user's messages today?
SELECT type, channel, status, attempts FROM notifications
WHERE user_id = 'u_1042' AND created_at > now() - interval '1 day';`,
      },
    ],
    related: ['Message queues', 'Idempotency', 'Exponential backoff', 'Dead letter queues', 'Rate limiting'],
  },
  simulator,
}
