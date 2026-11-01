import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written from scratch for Structura (no third-party text). Capacity numbers
// are worked out in the "Capacity estimates" section from stated assumptions.

/** Message ids are time-sortable: 41 bits of milliseconds, 10 of server, 12 of sequence. */
const ID_EPOCH = Date.UTC(2024, 0, 1)
const SENT_AT = Date.UTC(2026, 9, 28, 9, 15, 30, 123)
const messageId = (server: bigint, seq: bigint) => ((BigInt(SENT_AT - ID_EPOCH) << 22n) | (server << 12n) | seq).toString()

/** Share of recipients that are connected when the message arrives, in the "Mixed" case. */
const MIXED_ONLINE = 0.75

const fmt = (n: number) => n.toLocaleString('en-US')

const simulator: Simulator = {
  fields: [
    { id: 'chat', label: 'Chat type', options: ['1:1 message', 'Group of 5', 'Group of 100', 'Group of 500'] },
    { id: 'recipients', label: 'Recipients are', options: ['All online', 'Mixed (3 in 4 online)', 'All offline'] },
  ],
  defaults: { chat: 'Group of 5', recipients: 'Mixed (3 in 4 online)' },
  run({ chat, recipients }) {
    const members = chat === '1:1 message' ? 2 : Number(/\d+/.exec(chat ?? '')?.[0] ?? 5)
    const group = chat !== '1:1 message'
    const n = members - 1
    const online = recipients === 'All online' ? n : recipients === 'All offline' ? 0 : Math.round(n * MIXED_ONLINE)
    const offline = n - online
    const id = messageId(37n, 5n)
    const conv = group ? 'grp_8841' : 'dm_1207_3390'
    const steps: Trace['steps'] = []

    steps.push(
      { text: `Maya taps send in ${group ? `a group of ${members}` : 'a 1:1 chat'}. The Sender App already has a WebSocket open to the WebSocket Gateway, so the message goes down that connection: no new HTTP request, no new handshake.`, nodes: ['Sender App', 'WebSocket Gateway'], data: json({ type: 'send', client_msg_id: 'c-7f3a', conversation: conv, text: 'running 10 min late' }) },
      { text: 'The gateway only holds connections; it forwards the frame to the Chat Service. The Chat Service gives the message a time-sortable id (timestamp + server + sequence), so ids order messages without a global counter.', nodes: ['WebSocket Gateway', 'Chat Service'], data: `message_id = (ms since 2024-01-01 << 22) | (server 37 << 12) | seq 5\n          = (${SENT_AT - ID_EPOCH} << 22) | (37 << 12) | 5\n          = ${id}` },
      { text: 'The message is stored once, before anyone is told about it. If the next steps crash, nothing is lost: the message is in the Message Store and can be delivered later. One write per message, however many people are in the chat.', nodes: ['Chat Service', 'Message Store (Cassandra)'], data: `INSERT INTO messages (conversation_id, bucket, message_id, sender_id, body)\nVALUES ('${conv}', 202610, ${id}, 1207, 'running 10 min late');\n\n→ 1 write (not ${fmt(n)})` },
      { text: 'Maya\'s app gets an ack and shows one tick: the server has the message. The client_msg_id lets her app retry safely, because the server drops a repeat of the same id.', nodes: ['Chat Service', 'WebSocket Gateway', 'Sender App'], data: json({ type: 'ack', client_msg_id: 'c-7f3a', message_id: id, state: 'sent' }) },
    )
    if (group) {
      steps.push({ text: `For a group, the Chat Service asks the Group Service for the member list: ${fmt(n)} recipients besides the sender. Groups are capped (here at 500) because every message costs one delivery per member.`, nodes: ['Chat Service', 'Group Service'], data: `members(${conv}) → ${fmt(members)} user ids\nrecipients = ${fmt(members)} − 1 sender = ${fmt(n)}` })
    }
    steps.push({ text: `The Chat Service looks up where each recipient is connected in the Session Registry (user → gateway, kept fresh by connection heartbeats). ${fmt(online)} ${online === 1 ? 'is' : 'are'} online, ${fmt(offline)} ${offline === 1 ? 'is' : 'are'} offline.`, nodes: ['Chat Service', 'Session Registry (Redis)'], data: `MGET session:<${fmt(n)} user ids>\n→ online:  ${fmt(online)}  (e.g. gw-418)\n→ offline: ${fmt(offline)}  (nil)` })
    if (online > 0) {
      steps.push(
        { text: `For the ${fmt(online)} online recipient${online === 1 ? '' : 's'}, the Chat Service publishes to the Message Queue, one topic per gateway. The queue absorbs bursts and decouples the Chat Service from gateways that are busy or restarting.`, nodes: ['Chat Service', 'Message Queue'], data: `PUBLISH gw-418 {"to": 3390, "message_id": ${id}}\n… ${fmt(online)} deliveries in total` },
        { text: 'The gateway that owns the recipient\'s connection reads the queue and writes the message to their open WebSocket. It arrives within milliseconds.', nodes: ['Message Queue', 'WebSocket Gateway', 'Recipient App'], data: json({ type: 'message', conversation: conv, message_id: id, from: 1207, text: 'running 10 min late' }) },
        { text: 'The Recipient App acks, and the receipt travels back the same way. Maya sees two ticks. At scale this is "at least once" delivery plus de-duplication by message_id on the client.', nodes: ['Recipient App', 'WebSocket Gateway', 'Chat Service', 'Sender App'], data: json({ type: 'ack', message_id: id, state: 'delivered' }) },
      )
    }
    if (offline > 0) {
      steps.push(
        { text: `${fmt(offline)} recipient${offline === 1 ? ' has' : 's have'} no live connection. The Push Notification Service sends a wake-up through the phone vendor (APNs or FCM). Messages are end-to-end encrypted in many apps, so the push often carries no text, only "you have a new message".`, nodes: ['Chat Service', 'Push Notification Service'], data: `push × ${fmt(offline)}  { "collapse_key": "${conv}", "message_id": ${id} }\nbody: "New message" (no content)` },
        { text: 'The Presence Service records last-seen for those users. Presence is separate from messaging: it is soft state that can be a few seconds stale, and it must never delay a message.', nodes: ['Presence Service'], data: 'SET last_seen:3390 1793179890123 EX 86400\nstatus = offline' },
        { text: 'When a recipient opens the app, it connects to a gateway and asks for everything after the last message_id it has. The Message Store answers with a range scan, so nothing sent while they were offline is missed.', nodes: ['Recipient App', 'WebSocket Gateway', 'Message Store (Cassandra)'], data: `SELECT * FROM messages\nWHERE conversation_id = '${conv}' AND bucket = 202610\n  AND message_id > 373761600000000000\nLIMIT 100;` },
      )
    }
    if (online > 0) {
      steps.push({ text: 'Meanwhile the Presence Service shows who is online: each gateway heartbeats every few seconds, and a user with no heartbeat for about 30 seconds counts as offline.', nodes: ['WebSocket Gateway', 'Presence Service'], data: 'HEARTBEAT user:3390 gw-418 every 5s\nTTL 30s → offline if missed ×6' })
    }
    const cost = `${fmt(n)} ${n === 1 ? 'delivery' : 'deliveries'}, 1 store write, ${fmt(offline)} push${offline === 1 ? '' : 'es'}`
    return { input: `${chat}, recipients ${recipients?.toLowerCase()}: ${cost}`, steps }
  },
}

export const chatSystem: StaticTopic = {
  kind: 'static',
  id: 'chat-system',
  title: 'Chat System (WhatsApp-style)',
  blurb: 'WebSockets, store-then-deliver, groups, presence and offline push',
  difficulty: 'Intermediate',
  guides: [
    'how-do-we-design-a-chat-application-like-whatsapp-facebook-messenger-or-discord',
    'shortlong-polling-sse-websocket',
    'how-does-a-typical-push-notification-system-work',
    'how-discord-stores-trillions-of-messages',
    'delivery-semantics',
    'scale-real-time-presence-platform-at-linkedin',
  ],
  takeaways: [
    'A chat client keeps one WebSocket open, so the server can push a message the moment it exists.',
    'Store the message first, then deliver: a crash during delivery loses nothing.',
    'Gateways hold connections and nothing else; a Session Registry says which gateway owns which user.',
    'Group chat costs one delivery per member, so groups have a size cap.',
    'Offline users get a content-free push and sync from their last message id when they return.',
    'Presence is soft state with a TTL: let it be slightly stale rather than slow down messages.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'edge', label: 'Connections' },
      { id: 'core', label: 'Messaging' },
      { id: 'data', label: 'State and storage' },
    ],
    nodes: [
      { id: 'sender', label: 'Sender App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'recipient', label: 'Recipient App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'WebSocket Gateway', shape: 'rectangle', color: 'violet', group: 'edge' },
      { id: 'chat', label: 'Chat Service', shape: 'rectangle', color: 'violet', group: 'core' },
      { id: 'groups', label: 'Group Service', shape: 'rectangle', color: 'light-violet', group: 'core' },
      { id: 'presence', label: 'Presence Service', shape: 'rectangle', color: 'light-violet', group: 'core' },
      { id: 'queue', label: 'Message Queue', shape: 'rectangle', color: 'yellow', group: 'core' },
      { id: 'push', label: 'Push Notification Service', shape: 'rectangle', color: 'orange', group: 'core' },
      { id: 'sessions', label: 'Session Registry (Redis)', shape: 'rectangle', color: 'red', group: 'data' },
      { id: 'store', label: 'Message Store (Cassandra)', shape: 'rectangle', color: 'green', group: 'data' },
    ],
    edges: [
      { from: 'sender', to: 'gateway', label: 'WebSocket', dashed: false },
      { from: 'gateway', to: 'chat', label: 'send', dashed: false },
      { from: 'chat', to: 'store', label: 'store first', dashed: false },
      { from: 'chat', to: 'groups', label: 'members?', dashed: false },
      { from: 'chat', to: 'sessions', label: 'who is where?', dashed: false },
      { from: 'chat', to: 'queue', label: 'deliver', dashed: false },
      { from: 'queue', to: 'gateway', label: 'per-gateway topic', dashed: false },
      { from: 'gateway', to: 'recipient', label: 'WebSocket', dashed: false },
      { from: 'chat', to: 'push', label: 'offline users', dashed: true },
      { from: 'push', to: 'recipient', label: 'APNs / FCM', dashed: true },
      { from: 'gateway', to: 'presence', label: 'heartbeats', dashed: true },
      { from: 'gateway', to: 'sessions', label: 'register', dashed: true },
      { from: 'recipient', to: 'store', label: 'sync after reconnect', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'phone', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'last_seen', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'conversations',
        name: 'conversations',
        columns: [
          { name: 'conversation_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'kind', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'members',
        name: 'members',
        columns: [
          { name: 'conversation_id', type: 'text', pk: true, fk: 'conversations.conversation_id', nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: true, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'last_read_id', type: 'bigint', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(user_id) — my conversations'],
      },
      {
        id: 'messages',
        name: 'messages',
        columns: [
          { name: 'conversation_id', type: 'text', pk: true, fk: 'conversations.conversation_id', nullable: false, unique: false },
          { name: 'bucket', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'message_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'sender_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'body', type: 'blob', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['PRIMARY KEY ((conversation_id, bucket), message_id DESC) — newest first'],
      },
    ],
    relations: [
      { from: 'members', to: 'users', kind: 'many-to-many', label: 'belongs to' },
      { from: 'members', to: 'conversations', kind: 'many-to-many', label: 'joins' },
      { from: 'messages', to: 'conversations', kind: 'one-to-many', label: 'contains' },
    ],
  },
  explanation: {
    title: 'Chat System (WhatsApp-style)',
    summary:
      'Users keep a WebSocket open to a gateway. A sent message is stored first, then delivered through a queue to the gateway holding the recipient\'s connection. Offline users get a push notification and catch up from their last message id when they return.',
    sections: [
      {
        heading: 'Overview',
        body: 'A chat system looks simple (send text, receive text) but has three hard parts:\n- Real-time delivery: the server must push to a phone that did not ask. That needs a long-lived connection (WebSocket), not request/response.\n- Reliability: a message must never be lost, even if the recipient is offline or a server crashes.\n- Scale: hundreds of millions of open connections, and groups that multiply every message.\n\nThe design keeps connections in a thin gateway layer, keeps messages in a store that is written first, and treats presence as soft state.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- 1:1 and group chat (up to 500 members).\n- Online and offline delivery, with sent and delivered ticks.\n- Message history, in order.\n- Online status (presence).\n\nOut of scope: voice and video calls, end-to-end encryption details, media transcoding, search.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions: 500 million daily active users, 40 messages sent per user per day, about 100 bytes per message, 20% of users connected at the same time, 50,000 connections per gateway server.\n\nWhich works out to:\n- 500 million × 40 = 20 billion messages a day, about 231,000 per second (about 700,000 per second at a 3× peak).\n- 20 billion × 100 bytes = 2 TB a day, about 2.2 PB over three years (before replication).\n- 20% of 500 million = 100 million open connections, so about 2,000 gateway servers.\n\nWrites dominate and are append-only, which suits a log-structured store such as Cassandra.',
      },
      {
        heading: 'Step by step',
        body: '1. The Sender App sends the message over its open connection to the WebSocket Gateway.\n2. The WebSocket Gateway forwards it to the Chat Service, which assigns a time-sortable message id.\n3. The Chat Service stores the message in the Message Store (Cassandra) before anything else.\n4. It acks the sender (one tick) through the WebSocket Gateway.\n5. For a group, the Chat Service asks the Group Service for the members.\n6. It looks up each recipient in the Session Registry (Redis) to see who is online and on which gateway.\n7. For online recipients it publishes to the Message Queue; the owning WebSocket Gateway writes it to the Recipient App.\n8. For offline recipients the Push Notification Service sends a wake-up push; the Presence Service records last-seen.\n9. When the Recipient App reconnects it syncs the missed messages from the Message Store (Cassandra).',
      },
      {
        heading: 'Components',
        body: '- Sender App: the sending client; keeps one WebSocket open and retries with a client message id.\n- Recipient App: the receiving client; de-duplicates by message id and syncs after reconnecting.\n- WebSocket Gateway: holds the open connections (about 50,000 each) and nothing else, so it can be restarted freely.\n- Chat Service: stateless; assigns ids, stores, looks up recipients and routes.\n- Group Service: group membership and size limits; cached because it is read on every group message.\n- Presence Service: online and last-seen status from gateway heartbeats, with a short TTL.\n- Message Queue: one topic per gateway; buffers bursts and decouples routing from delivery.\n- Push Notification Service: talks to APNs and FCM for users with no live connection.\n- Session Registry (Redis): maps user id to the gateway holding their connection.\n- Message Store (Cassandra): messages partitioned by conversation and time bucket, newest first.',
      },
      {
        heading: 'Key decisions',
        body: '- WebSocket vs polling. Polling wastes requests and adds delay; one persistent connection per client lets the server push instantly.\n- Store, then deliver. Writing first makes the store the source of truth and delivery a retryable side effect.\n- Delivery guarantee. Aim for at-least-once and de-duplicate by message id; exactly-once over a network is not on offer.\n- Ordering. Order within a conversation by message id (time-sortable); no global order is needed.\n- Partition key. (conversation_id, bucket) keeps one conversation together while time buckets (for example one per month) stop a hot chat from growing one partition forever.\n- Presence as soft state. Heartbeats with a TTL; never block message delivery on it.\n- Group fan-out. Write the message once, deliver N times; cap the group size.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A gateway dies: its clients reconnect (with jittered backoff, so 50,000 clients do not stampede) to another gateway, re-register, and sync from their last message id.\n- Add gateways horizontally; the Session Registry is the only shared lookup, so shard it by user id.\n- The Message Queue absorbs spikes; consumers per gateway scale with connections.\n- Hot conversations (a 500-person group in the middle of a match) are bounded by the group cap and the time bucket.\n- Presence at scale: do not broadcast every change to every contact; fetch status on demand or only for the open chat.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you support the same account on a phone and a laptop?\n- How do read receipts work, and what do they cost in a 500-member group?\n- Would you pick a message queue or direct gateway-to-gateway RPC for delivery, and why?\n- How would end-to-end encryption change the server\'s job?\n- How do you keep message order if two servers assign ids in the same millisecond?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Gateway: receive, store, ack',
        language: 'typescript',
        source: `import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ port: 8080 })
const seen = new Set<string>() // de-duplicate client retries (use Redis in production)

wss.on('connection', (socket, req) => {
  const userId = authenticate(req) // from the token on the upgrade request
  registerSession(userId, GATEWAY_ID) // Session Registry: user -> this gateway

  socket.on('message', async (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'send') return
    if (seen.has(m.client_msg_id)) return // a retry: already stored, ack again below
    seen.add(m.client_msg_id)
    const id = await chatService.store(userId, m.conversation, m.text) // store first
    socket.send(JSON.stringify({ type: 'ack', client_msg_id: m.client_msg_id, message_id: id, state: 'sent' }))
  })
})`,
      },
      {
        title: 'Time-sortable message id',
        language: 'typescript',
        source: `const EPOCH = Date.UTC(2024, 0, 1)
let lastMs = 0n
let seq = 0n

/** 41 bits time | 10 bits server | 12 bits sequence: ids sort by send time. */
export function nextId(serverId: bigint): bigint {
  let ms = BigInt(Date.now() - EPOCH)
  if (ms === lastMs) {
    seq = (seq + 1n) & 0xfffn // up to 4,096 ids per millisecond per server
    if (seq === 0n) ms = lastMs + 1n // sequence used up: borrow the next millisecond
  } else {
    seq = 0n
  }
  lastMs = ms
  return (ms << 22n) | (serverId << 12n) | seq
}`,
      },
      {
        title: 'Message table and sync query',
        language: 'sql',
        source: `-- One partition per conversation per month, newest message first.
CREATE TABLE messages (
  conversation_id text,
  bucket          int,      -- yyyymm
  message_id      bigint,
  sender_id       bigint,
  body            blob,
  PRIMARY KEY ((conversation_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- After reconnecting: everything newer than the last id the client has.
SELECT message_id, sender_id, body FROM messages
WHERE conversation_id = 'grp_8841' AND bucket = 202610
  AND message_id > 373761600000000000
ORDER BY message_id ASC;`,
      },
    ],
    related: ['WebSockets', 'Fan-out', 'Message queues', 'Presence', 'Snowflake ids', 'At-least-once delivery'],
  },
  simulator,
}
