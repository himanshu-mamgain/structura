import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, with the Amazon SQS, Amazon SNS, RabbitMQ,
// Redis and BullMQ docs as references (linked, not copied). The simulator plays a lunch rush
// through one queue in tenths of a second, so order, waits, losses and duplicates are computed.

const STEP = 0.1 // seconds per tick
const LIMIT = 8 // the bounded queue's size, in waiting messages
const STATUSES = ['placed', 'paid', 'cooking', 'ready']
const ORDERS = [101, 102, 103, 104, 105, 106]
const GOLD = new Set([102, 105]) // Gold members' orders go first in the priority queue
const OFFSETS = [0, 0.4, 2, 3.2] // seconds after an order starts that each update is sent
const SPACING = 1 // seconds between orders starting

export const TYPES = ['Standard (best-effort order)', 'FIFO (in order per order id)', 'Priority (Gold orders first)']
export const LIMITS = ['No limit', `Limit ${LIMIT}: make the sender wait`, `Limit ${LIMIT}: refuse new messages`, `Limit ${LIMIT}: drop the oldest`]
const WORKERS: Record<string, number> = { '1 worker': 1, '2 workers': 2, '3 workers': 3 }

/** A small seeded random generator (mulberry32), so a run gives the same numbers every time. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Message {
  id: number
  order: number
  /** 1 to 4: placed, paid, cooking, ready. */
  seq: number
  gold: boolean
  /** When the Order Service wants to send it, in ticks. */
  due: number
  /** Ticks a worker needs for it (the same in every run, so runs compare fairly). */
  work: number
  /** A second delivery of a message that was already handled. */
  copy?: boolean
}

export interface Handled {
  msg: Message
  worker: number
  sent: number
  start: number
  done: number
}

export interface Run {
  /** Every delivery, in the order the workers took them. */
  handled: Handled[]
  /** Messages the queue refused, or threw away to make room. */
  refused: Message[]
  dropped: Message[]
  /** Waiting messages at the end of each second (index = second). */
  depth: number[]
  /** The most the Order Service had to wait to send one message, in ticks, and how many waited. */
  senderWait: number
  sendersWaited: number
  /** When the last update was done, in ticks. */
  end: number
  /** FIFO: ticks a worker sat free while every waiting message's order was already in progress. */
  idle: number
}

/** The lunch rush: 6 orders, 4 updates each, sent over 11 seconds. */
export function workload(seed = 11): Message[] {
  const rand = random(seed)
  const msgs: Omit<Message, 'id'>[] = []
  ORDERS.forEach((order, i) =>
    OFFSETS.forEach((offset, s) => msgs.push({ order, seq: s + 1, gold: GOLD.has(order), due: Math.round((i * SPACING + offset) / STEP), work: 6 + Math.floor(rand() * 9) })),
  )
  // Sent in time order; at the same moment, the earlier order first.
  msgs.sort((a, b) => a.due - b.due || a.order - b.order)
  return msgs.map((m, id) => ({ ...m, id }))
}

/** The standard queue delivers this update a second time, as SQS standard queues sometimes do: 101 "paid". */
const DUPLICATE = { order: 101, seq: 2 }

export function simulate(type: string, limit: string, workers: number, seed = 5): Run {
  const rand = random(seed)
  const kind = TYPES.indexOf(type)
  const policy = LIMITS.indexOf(limit)
  const msgs = workload()
  const outbox: Message[] = [] // sends the Order Service is waiting to make
  const queue: { msg: Message; sent: number }[] = []
  const busy: ({ msg: Message; sent: number; start: number } | null)[] = Array(workers).fill(null)
  const inFlight = new Set<number>() // orders with a message being worked on (FIFO: one at a time)
  const handled: Handled[] = []
  const refused: Message[] = []
  const dropped: Message[] = []
  const depth: number[] = []
  let duplicated = false
  let senderWait = 0
  let sendersWaited = 0
  let next = 0
  let end = 0
  let idle = 0
  for (let t = 0; t < 3000; t++) {
    // Workers that finish now.
    busy.forEach((job, w) => {
      if (!job || job.start + job.msg.work > t) return
      handled.push({ msg: job.msg, worker: w, sent: job.sent, start: job.start, done: t })
      inFlight.delete(job.msg.order)
      busy[w] = null
      end = t
      // The delete didn't reach the queue in time, so it hands the message out again.
      if (kind === 0 && job.msg.order === DUPLICATE.order && job.msg.seq === DUPLICATE.seq && !duplicated) {
        duplicated = true
        queue.push({ msg: { ...job.msg, copy: true }, sent: t })
      }
    })
    // New sends, then whatever fits.
    while (next < msgs.length && msgs[next].due === t) outbox.push(msgs[next++])
    while (outbox.length) {
      const msg = outbox[0]
      if (policy > 0 && queue.length >= LIMIT) {
        if (policy === 1) break // the sender waits for room
        outbox.shift()
        if (policy === 2) {
          refused.push(msg)
          continue
        }
        dropped.push(queue.shift()!.msg)
        queue.push({ msg, sent: t })
        continue
      }
      outbox.shift()
      if (t > msg.due) {
        sendersWaited++
        senderWait = Math.max(senderWait, t - msg.due)
      }
      queue.push({ msg, sent: t })
    }
    // Free workers take the next message, by the queue's rule.
    busy.forEach((job, w) => {
      if (job || !queue.length) return
      let i = 0
      if (kind === 0) i = Math.floor(rand() * Math.min(3, queue.length)) // best effort: any of the first few
      if (kind === 1) i = queue.findIndex((q) => !inFlight.has(q.msg.order)) // FIFO: the next of an idle order
      if (kind === 2) i = Math.max(0, queue.findIndex((q) => q.msg.gold)) // priority: Gold first, then oldest
      if (i < 0) {
        idle++
        return
      }
      const [q] = queue.splice(i, 1)
      inFlight.add(q.msg.order)
      busy[w] = { msg: q.msg, sent: q.sent, start: t }
    })
    if (t % 10 === 9) depth.push(queue.length)
    if (next >= msgs.length && !outbox.length && !queue.length && busy.every((b) => !b)) break
  }
  return { handled, refused, dropped, depth, senderWait, sendersWaited, end, idle }
}

/** What each customer's tracking screen showed, update by update, in the order the updates were done. */
export function screens(run: Run) {
  return ORDERS.map((order) => {
    const shown = run.handled
      .filter((h) => h.msg.order === order)
      .sort((a, b) => a.done - b.done || a.msg.seq - b.msg.seq)
      .map((h) => h.msg)
    let high = 0
    let backwards = 0
    for (const m of shown) {
      if (m.seq < high) backwards++
      high = Math.max(high, m.seq)
    }
    const lost = [...run.refused, ...run.dropped].filter((m) => m.order === order).map((m) => STATUSES[m.seq - 1])
    const twice = shown.filter((m) => m.copy).map((m) => STATUSES[m.seq - 1])
    return { order, gold: GOLD.has(order), shown: shown.map((m) => STATUSES[m.seq - 1]), backwards, lost, twice, final: shown.length ? STATUSES[shown[shown.length - 1].seq - 1] : 'nothing' }
  })
}

const sec = (ticks: number) => `${(ticks * STEP).toFixed(1)} s`
const label = (m: Message) => `${m.order} ${STATUSES[m.seq - 1]}`
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
const WORDS = ['No', 'One', 'Two', 'Three']

/** Waiting messages at the end of each second, as text bars; two seconds a row when it runs long. */
function depthChart(depth: number[], bounded: boolean): string {
  const width = depth.length > 14 ? 2 : 1
  const rows: string[] = []
  for (let s = 0; s < depth.length; s += width) {
    const d = Math.max(...depth.slice(s, s + width))
    rows.push(`${String(s + width).padStart(3)} s  ${String(d).padStart(2)} ${'█'.repeat(d)}`.trimEnd())
  }
  return [`waiting, ${width === 1 ? 'each second' : 'every 2 s'}${bounded ? ` (limit ${LIMIT})` : ''}`, ...rows].join('\n')
}

/** Names as short lines of three, for a code block on a phone. */
const inLines = (msgs: Message[]) =>
  msgs
    .map(label)
    .reduce<string[][]>((rows, name, i) => (i % 3 ? rows[rows.length - 1].push(name) : rows.push([name]), rows), [])
    .map((row) => row.join(', '))
    .join('\n')

const simulator: Simulator = {
  fields: [
    { id: 'type', label: 'Queue type', options: TYPES },
    { id: 'limit', label: 'When it fills up', options: LIMITS },
    { id: 'workers', label: 'Tracking workers', options: Object.keys(WORKERS) },
  ],
  defaults: { type: TYPES[0], limit: LIMITS[0], workers: '2 workers' },
  run({ type, limit, workers }) {
    const kind = Math.max(0, TYPES.indexOf(type))
    const policy = Math.max(0, LIMITS.indexOf(limit))
    const count = WORKERS[workers] ?? 2
    const r = simulate(TYPES[kind], LIMITS[policy], count)
    const msgs = workload()
    const firsts = r.handled.filter((h) => !h.msg.copy)
    const waits = firsts.map((h) => h.start - h.msg.due)
    const peak = Math.max(0, ...r.depth)
    const shown = screens(r)
    const backwards = shown.filter((s) => s.backwards > 0)
    const lost = shown.filter((s) => s.lost.length > 0)
    const copy = r.handled.find((h) => h.msg.copy)
    const original = copy && r.handled.find((h) => !h.msg.copy && h.msg.id === copy.msg.id)
    const log = r.handled
      .slice()
      .sort((a, b) => a.start - b.start || a.worker - b.worker)
      .slice(0, 9)
      .map((h) => `${sec(h.start).padStart(6)}  w${h.worker + 1} ← ${label(h.msg)}${h.msg.copy ? ' again' : ''}`)
    const rule = [
      ['type:      standard', 'order:     best effort', 'delivery:  at least once'],
      ['type:      FIFO', 'group id:  the order id', 'in flight: 1 per order'],
      ['type:      priority', 'Gold:      priority 9', 'others:    priority 1'],
    ][kind]
    const limitLine = policy === 0 ? 'limit:     none' : `limit:     ${LIMIT}, then ${['', 'wait', 'refuse', 'drop oldest'][policy]}`

    const steps: Trace['steps'] = [
      {
        text: `Lunch rush: 6 orders in 6 seconds. Each order sends 4 updates to the queue (placed, paid, cooking, ready), so 24 messages arrive in about 8 seconds, roughly 3 a second. Orders 102 and 105 belong to Gold members. A worker needs 0.6 to 1.4 seconds per update.`,
        nodes: ['Customer App', 'Order Service'],
        data: [...msgs.slice(0, 7).map((m) => `${sec(m.due).padStart(6)}  ${label(m)}${m.gold ? ' (Gold)' : ''}`), `   … ${msgs.length - 7} more, the last at ${sec(msgs[msgs.length - 1].due)}`].join('\n'),
      },
      {
        text: [
          'The Order Events Topic copies each update into the Order Updates Queue. As a standard queue, it keeps a rough order only: a worker may get any of the next few messages, and now and then one comes twice. In return, it scales almost without limit.',
          'The Order Events Topic copies each update into the Order Updates Queue. As a FIFO queue, each message carries a group id, here the order id. One order\'s updates come out in the order they went in, one at a time; different orders still run in parallel.',
          'The Order Events Topic copies each update into the Order Updates Queue. As a priority queue, it hands out the highest priority first: Gold orders get 9, the rest 1. At the same priority, the oldest goes first.',
        ][kind],
        nodes: ['Order Events Topic', 'Order Updates Queue'],
        data: [...rule, limitLine, `workers:   ${count}`].join('\n'),
      },
      {
        text: `${WORDS[count]} Tracking Worker${count === 1 ? ' takes' : 's take'} updates as ${count === 1 ? 'it is' : 'they are'} free. The first deliveries ("w1" is worker 1):${
          kind === 1 && r.idle > 0 ? ' A free worker sometimes waits, because the only updates left belong to orders already in progress.' : ''
        }`,
        nodes: ['Order Updates Queue', 'Tracking Workers'],
        data: log.join('\n'),
      },
      {
        text: `Updates arrive at about 3 a second, and ${WORDS[count].toLowerCase()} worker${count === 1 ? ' finishes' : 's finish'} about ${count} a second. ${
          peak >= 6 ? `So the queue grows: up to ${peak} messages waited at once.` : `So the queue stays short: at most ${peak} waiting at once.`
        }${policy > 0 && peak >= LIMIT ? ` It hit its limit of ${LIMIT}.` : ''}`,
        nodes: ['Order Updates Queue'],
        data: depthChart(r.depth, policy > 0),
      },
      {
        text: [
          `No limit, so nothing was refused or lost. Overload became waiting instead: the slowest update waited ${sec(Math.max(...waits))}. In a longer rush, an unbounded queue keeps growing until the broker runs out of memory or disk.`,
          r.sendersWaited
            ? `The queue was full, so the Order Service had to wait before sending ${plural(r.sendersWaited, 'update')}, for up to ${sec(r.senderWait)}. Nothing was lost, but the slowness moved back to the sender: this is backpressure. In a web request, the customer's app would spin.`
            : `The queue never reached ${LIMIT}, so the Order Service never had to wait.`,
          r.refused.length
            ? `${plural(r.refused.length, 'update was', 'updates were')} refused with "queue full". The Order Service has to retry ${r.refused.length === 1 ? 'it' : 'them'} later or tell the customer "busy, try again". If it does neither, ${r.refused.length === 1 ? 'it is' : 'they are'} lost.`
            : `The queue never reached ${LIMIT}, so nothing was refused.`,
          r.dropped.length
            ? `To make room, the queue threw away ${plural(r.dropped.length, 'update')}, the oldest waiting one each time. Nobody was told. That suits data where only the latest value matters, like a courier's location, not order updates.`
            : `The queue never reached ${LIMIT}, so nothing was thrown away.`,
        ][policy],
        nodes: ['Order Service', 'Order Updates Queue'],
        data: [
          `refused: ${r.refused.length}\ndropped: ${r.dropped.length}\nmost waiting at once: ${peak}`,
          `sends that waited: ${r.sendersWaited}\nlongest wait to send: ${sec(r.senderWait)}\nlost: 0`,
          r.refused.length ? `refused:\n${inLines(r.refused)}` : 'refused: 0',
          r.dropped.length ? `dropped:\n${inLines(r.dropped)}` : 'dropped: 0',
        ][policy],
      },
      {
        text:
          kind === 0
            ? copy && original
              ? `The queue delivered "${label(copy.msg)}" twice. The worker finished it, but its delete reached the queue too late, so the message came back. A standard queue delivers at least once, so every handler must be safe to run twice.`
              : 'No update came twice this time. A standard queue still may deliver a message twice, so every handler must be safe to run twice.'
            : kind === 1
              ? `No update ran twice: a FIFO queue keeps one message per order in flight, and drops a resend with the same deduplication id within 5 minutes. The price: ${
                  r.idle > 0 ? `workers sat idle for ${sec(r.idle)} in total while other orders' updates waited behind busy ones.` : 'one slow update holds up the rest of its order.'
                }`
              : 'No update ran twice here. A priority queue still delivers at least once, though, so keep the handler safe to run twice.',
        nodes: ['Tracking Workers'],
        data:
          copy && original
            ? `${label(copy.msg)}, 1st: done at ${sec(original.done)}\n${label(copy.msg)}, 2nd: done at ${sec(copy.done)}`
            : kind === 1
              ? `duplicates: 0\nidle while orders were busy: ${sec(r.idle)}`
              : 'duplicates: 0',
      },
      {
        text: `What each customer's tracking screen showed, in the order the updates were applied. ${
          backwards.length
            ? `${plural(backwards.length, 'screen')} went backwards: an older update was applied after a newer one. Fix it with a FIFO queue, or by keeping each order's last step number and ignoring anything older.`
            : 'No screen went backwards.'
        }${lost.length ? ` ${plural(lost.length, 'customer')} never saw some updates.` : ''}`,
        nodes: ['Customer App', 'Tracking Workers'],
        data: shown
          .flatMap((s) => [
            `${s.order} ${s.shown.join('→')}`,
            ...(s.backwards ? [`    ✗ went back${s.final === 'ready' ? '' : `; ends on ${s.final}`}`] : []),
            ...(s.lost.length ? [`    ✗ lost: ${s.lost.join(', ')}`] : []),
          ])
          .join('\n'),
      },
      {
        text:
          kind === 2
            ? `Gold updates waited ${avg(firsts.filter((h) => h.msg.gold).map((h) => (h.start - h.msg.due) * STEP)).toFixed(1)} s on average; the others ${avg(firsts.filter((h) => !h.msg.gold).map((h) => (h.start - h.msg.due) * STEP)).toFixed(1)} s. Priority helps a few by making the rest wait longer. In a long rush, low-priority messages can wait forever: that is called starvation.`
            : `Every order waited about the same: ${avg(waits.map((w) => w * STEP)).toFixed(1)} s on average. ${
                kind === 1 ? 'FIFO keeps each order in step, but it can\'t put one order ahead of another.' : 'Try the priority queue to put Gold orders first, or FIFO to keep each order in step.'
              }`,
        nodes: ['Order Updates Queue', 'Tracking Workers'],
        data: [
          `Gold, average wait:   ${sec(Math.round(avg(firsts.filter((h) => h.msg.gold).map((h) => h.start - h.msg.due))))}`,
          `others, average wait: ${sec(Math.round(avg(firsts.filter((h) => !h.msg.gold).map((h) => h.start - h.msg.due))))}`,
          `longest wait:         ${sec(Math.max(...waits))}`,
          `last update done at:  ${sec(r.end)}`,
        ].join('\n'),
      },
    ]
    return { input: `${TYPES[kind].split(' (')[0]} queue, ${LIMITS[policy].toLowerCase()}, ${workers in WORKERS ? workers : '2 workers'}`, steps }
  },
}

export const queueTypes: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'queue-types',
  title: 'Types of Queues',
  blurb: 'Standard, FIFO, priority, delay, pub/sub, request/reply, in-memory and bounded queues: what each promises',
  guides: ['types-of-message-queue', 'explaining-the-4-most-commonly-used-types-of-queues-in-a-single-diagram', 'scale-pub-sub-messaging', 'scale-dynein-distributed-delayed-job-queueing-system-at-airbnb', 'scale-scaling-job-queue-with-redis-at-slack'],
  takeaways: [
    'A standard queue is fast, but keeps order only roughly and may deliver a message twice, so handlers must be safe to repeat.',
    'A FIFO queue keeps order within a group, such as one order id, while different groups run in parallel.',
    'A priority queue serves urgent messages first, but in a long rush the rest can wait forever.',
    'A delay queue hides a message until later: SQS allows up to 15 minutes, a scheduler or BullMQ longer.',
    'Pub/sub copies each message to every subscriber\'s queue; point-to-point gives it to just one worker.',
    'Give a queue a limit, and choose what happens when it is full: make the sender wait, refuse, or drop the oldest.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'fanout', label: 'Pub/sub fan-out' },
      { id: 'delay', label: 'Delay queue' },
      { id: 'rpc', label: 'Request / reply' },
      { id: 'memory', label: 'In memory' },
    ],
    nodes: [
      { id: 'customer', label: 'Customer App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'orders', label: 'Order Service', shape: 'rectangle', color: 'violet', group: null },
      { id: 'topic', label: 'Order Events Topic', shape: 'rectangle', color: 'yellow', group: 'fanout' },
      { id: 'updates', label: 'Order Updates Queue', shape: 'rectangle', color: 'yellow', group: 'fanout' },
      { id: 'email', label: 'Email Queue', shape: 'rectangle', color: 'yellow', group: 'fanout' },
      { id: 'courier', label: 'Courier Queue', shape: 'rectangle', color: 'yellow', group: 'fanout' },
      { id: 'tracking', label: 'Tracking Workers', shape: 'rectangle', color: 'orange', group: null },
      { id: 'mailer', label: 'Email Workers', shape: 'rectangle', color: 'orange', group: null },
      { id: 'dispatch', label: 'Courier Dispatcher', shape: 'rectangle', color: 'orange', group: null },
      { id: 'timeout', label: 'Payment Timeout Queue', shape: 'rectangle', color: 'yellow', group: 'delay' },
      { id: 'canceller', label: 'Timeout Worker', shape: 'rectangle', color: 'orange', group: 'delay' },
      { id: 'quotes', label: 'Quote Requests', shape: 'rectangle', color: 'yellow', group: 'rpc' },
      { id: 'pricing', label: 'Pricing Service', shape: 'rectangle', color: 'violet', group: 'rpc' },
      { id: 'replies', label: 'Quote Replies', shape: 'rectangle', color: 'yellow', group: 'rpc' },
      { id: 'photos', label: 'Photo Jobs (Redis)', shape: 'rectangle', color: 'yellow', group: 'memory' },
      { id: 'resizer', label: 'Photo Worker', shape: 'rectangle', color: 'orange', group: 'memory' },
    ],
    edges: [
      { from: 'customer', to: 'orders', label: 'place order', dashed: false },
      { from: 'orders', to: 'topic', label: 'publish event', dashed: false },
      { from: 'topic', to: 'updates', label: 'copy', dashed: false },
      { from: 'topic', to: 'email', label: 'copy', dashed: false },
      { from: 'topic', to: 'courier', label: 'copy', dashed: false },
      { from: 'updates', to: 'tracking', label: 'in order per order', dashed: false },
      { from: 'email', to: 'mailer', label: 'any order, maybe twice', dashed: false },
      { from: 'courier', to: 'dispatch', label: 'Gold first', dashed: false },
      { from: 'tracking', to: 'customer', label: 'status', dashed: true },
      { from: 'updates', to: 'orders', label: 'full: slow down', dashed: true },
      { from: 'orders', to: 'timeout', label: 'check in 15 min', dashed: false },
      { from: 'timeout', to: 'canceller', label: 'after the delay', dashed: false },
      { from: 'canceller', to: 'orders', label: 'cancel if unpaid', dashed: true },
      { from: 'orders', to: 'quotes', label: 'fee? reply-to + id', dashed: false },
      { from: 'quotes', to: 'pricing', label: 'request', dashed: false },
      { from: 'pricing', to: 'replies', label: '₹50, same id', dashed: false },
      { from: 'replies', to: 'orders', label: 'reply', dashed: true },
      { from: 'orders', to: 'photos', label: 'LPUSH job', dashed: false },
      { from: 'photos', to: 'resizer', label: 'BRPOP', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'queues',
        name: 'queues',
        columns: [
          { name: 'name', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'kind', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'max_length', type: 'int', pk: false, fk: null, nullable: true, unique: false },
          { name: 'when_full', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'delay_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'visibility_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'jobs',
        name: 'jobs',
        columns: [
          { name: 'job_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'queue', type: 'text', pk: false, fk: 'queues.name', nullable: false, unique: false },
          { name: 'payload', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
          { name: 'group_key', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'priority', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'run_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'dedup_id', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'reply_to', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'correlation_id', type: 'uuid', pk: false, fk: null, nullable: true, unique: false },
          { name: 'locked_until', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
          { name: 'attempts', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(queue, priority DESC, run_at, job_id) — the next job to take', '(queue, group_key, job_id) — FIFO: the head of each group', '(queue, dedup_id) unique'],
      },
    ],
    relations: [{ from: 'jobs', to: 'queues', kind: 'one-to-many', label: 'waits in' }],
  },
  explanation: {
    title: 'Types of Queues',
    summary:
      'A queue holds messages until a worker takes them, but queues make different promises. A standard queue is fast and keeps order only roughly. A FIFO queue keeps order within a group. A priority queue serves urgent work first. A delay queue hides a message until later. Pub/sub copies one message to many queues, request/reply sends an answer back, an in-memory queue trades safety for speed, and a bounded queue decides what happens when it is full.',
    sections: [
      {
        heading: 'Overview',
        body: 'A food-delivery app uses several queues, and each one needs a different promise.\n\nThe tracking screen must show each order\'s updates in order: placed, paid, cooking, ready. That needs a FIFO queue. Receipt emails can go in any order, so a cheaper standard queue is fine. Couriers should go to Gold members\' orders first: a priority queue. An unpaid order should be cancelled after 15 minutes: a delay queue. And one "order placed" event must reach tracking, email and couriers: pub/sub.\n\nAll of them hand work from a producer (the sender) to a consumer (the worker) without making the producer wait. They differ in order, priority, timing, copies, speed and what happens when they fill up.',
      },
      {
        heading: 'Requirements',
        body: '- Show each order\'s updates on the tracking screen in the order they happened.\n- Send each receipt email once, in any order.\n- Assign couriers to Gold members\' orders first.\n- Cancel an order that is still unpaid 15 minutes after it was placed.\n- Get one "order placed" event to three different consumers.\n- Get the delivery fee from the Pricing Service while the customer waits.\n- Resize menu photos quickly; a lost job can be redone.\n- During a rush, slow down or refuse senders instead of running out of memory.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Say 2 million orders a day, with 4 updates each: 8 million updates a day.\n- Average: 8,000,000 ÷ 86,400 seconds = about 93 updates a second.\n- Lunch peak, 10 times the average: about 926 a second.\n- Fan-out to 3 queues: 926 × 3 = about 2,778 copies a second at peak.\n- An SQS FIFO queue takes 300 sends a second per partition, or 3,000 with batches of 10. In high-throughput mode, Mumbai allows up to 9,000 a second. So 926 a second needs batching or high-throughput mode.\n- If a Tracking Worker spends 20 ms on an update, one worker does 50 a second: 926 ÷ 50 = about 19 workers at peak, so run about 25.',
      },
      {
        heading: 'Step by step',
        body: '1. The Customer App places an order with the Order Service.\n2. The Order Service publishes each order event to the Order Events Topic.\n3. The topic copies the event into the Order Updates Queue, the Email Queue and the Courier Queue. This is pub/sub fan-out.\n4. Tracking Workers read the Order Updates Queue. It is FIFO, grouped by order id, so each order\'s updates arrive in order.\n5. Email Workers read the Email Queue. It is a standard queue: order doesn\'t matter, and the workers skip an email they already sent.\n6. The Courier Dispatcher reads the Courier Queue. It is a priority queue, so Gold orders come out first.\n7. The Order Service also puts a message in the Payment Timeout Queue with a 15-minute delay. The Timeout Worker then cancels the order if it is still unpaid.\n8. For the delivery fee, the Order Service sends a message to Quote Requests with a reply-to queue and a correlation id. The Pricing Service answers on Quote Replies with the same id.\n9. Photo resizing goes to Photo Jobs (Redis), an in-memory queue, and the Photo Worker takes jobs from it.\n10. If the Order Updates Queue is full, it pushes back: the Order Service must wait or refuse new orders.',
      },
      {
        heading: 'Components',
        body: "- Customer App: places orders and shows the tracking screen.\n- Order Service: takes orders and publishes order events; waits or refuses when a queue is full.\n- Order Events Topic: pub/sub; copies every event to each subscribed queue, like Amazon SNS or a RabbitMQ fanout exchange.\n- Order Updates Queue: a FIFO queue grouped by order id, so each order's updates stay in order.\n- Email Queue: a standard queue; fast, rough order, may deliver a message twice.\n- Courier Queue: a priority queue; Gold members' orders first.\n- Tracking Workers: apply each update to the order's tracking screen.\n- Email Workers: send receipts, skipping any already sent.\n- Courier Dispatcher: gives the most urgent order to the nearest free courier.\n- Payment Timeout Queue: a delay queue; each message stays hidden for 15 minutes.\n- Timeout Worker: cancels orders that are still unpaid.\n- Quote Requests: the request queue for delivery fees; each message carries a reply-to and a correlation id.\n- Pricing Service: works out the fee and sends the answer to the reply queue.\n- Quote Replies: the reply queue the Order Service listens on.\n- Photo Jobs (Redis): an in-memory queue, a Redis list or BullMQ, for quick jobs that can be redone.\n- Photo Worker: resizes menu photos.",
      },
      {
        heading: 'Key decisions',
        body: "- Standard or FIFO: a standard queue scales almost without limit, but order is best effort and a message may come twice. FIFO keeps order per group and removes duplicate sends, at lower throughput.\n- The FIFO group id: the order id keeps each order in order and lets different orders run in parallel. One group id for everything means one message at a time.\n- Priority: use a few levels, not hundreds. Watch for starvation: raise old messages' priority, or give each level a share of the workers.\n- Delay: SQS delays go up to 15 minutes. For longer, use a scheduler, a database table with a run_at column, or BullMQ's delayed jobs.\n- Pub/sub or point-to-point: pub/sub gives every subscriber its own copy; point-to-point gives each message to one worker. Most designs use both: a topic fans out to queues, and each queue has competing workers.\n- Request/reply: only when the caller must wait for the answer. Always set a timeout. Often a plain HTTP call is simpler.\n- In memory: a Redis queue is very fast, but a crash can lose jobs unless Redis saves to disk. Redis Streams add acknowledgements.\n- When full: block the sender (backpressure), refuse with an error such as 429, or drop the oldest. Never grow without limit.",
      },
      {
        heading: 'Scaling and failure',
        body: "- Add workers to drain a standard queue faster. A FIFO queue's parallelism is limited by how many groups have messages waiting.\n- A message that always fails blocks its FIFO group. After a few tries, move it to a dead-letter queue so the group can move on.\n- In practice every one of these queues can deliver a message twice, so handlers must be idempotent.\n- Watch the queue depth and the age of the oldest message, and alert when either keeps growing.\n- Scale workers on the backlog: messages waiting ÷ messages one worker handles a second.\n- If a caller dies, its replies pile up. Use a temporary reply queue that is deleted with the caller, or RabbitMQ's direct reply-to.",
      },
      {
        heading: 'Interview follow-ups',
        body: "- Why not make every queue FIFO?\n- Two workers handle updates for the same order. How do you keep the screen correct?\n- How would you cancel an unpaid order after 30 minutes, when SQS delays stop at 15?\n- What should happen when a queue fills up?\n- When would you choose Redis over SQS or RabbitMQ?",
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'SQS: a FIFO queue per order, and a delay',
        language: 'javascript',
        source: `// Amazon SQS: a FIFO queue for each order's updates, a delay for the payment timeout.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'

const sqs = new SQSClient({ region: 'ap-south-1' })
const base = 'https://sqs.ap-south-1.amazonaws.com/123456789012'

// FIFO: one group per order keeps its updates in order; orders still run in parallel.
// The same deduplication id within 5 minutes is dropped, so a resend can't double up.
export async function sendUpdate(orderId, seq, status) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: \`\${base}/order-updates.fifo\`,
    MessageBody: JSON.stringify({ orderId, seq, status }),
    MessageGroupId: \`order-\${orderId}\`,
    MessageDeduplicationId: \`order-\${orderId}-\${seq}\`,
  }))
}

// Delay: hidden for 15 minutes (the most SQS allows). Per-message delays need a standard queue.
export async function checkPaymentLater(orderId) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: \`\${base}/payment-timeouts\`,
    MessageBody: JSON.stringify({ orderId }),
    DelaySeconds: 900,
  }))
}`,
        versions: [{ language: 'java', source: `import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.SendMessageRequest;

// Amazon SQS: a FIFO queue for each order's updates, a delay for the payment timeout.
public class OrderQueues {
  static final SqsClient sqs = SqsClient.builder().region(Region.AP_SOUTH_1).build();
  static final String BASE = "https://sqs.ap-south-1.amazonaws.com/123456789012";

  // FIFO: one group per order keeps its updates in order; orders still run in parallel.
  // The same deduplication id within 5 minutes is dropped, so a resend can't double up.
  static void sendUpdate(long orderId, int seq, String status) {
    sqs.sendMessage(SendMessageRequest.builder()
        .queueUrl(BASE + "/order-updates.fifo")
        .messageBody(String.format("{\\"orderId\\":%d,\\"seq\\":%d,\\"status\\":\\"%s\\"}", orderId, seq, status))
        .messageGroupId("order-" + orderId)
        .messageDeduplicationId("order-" + orderId + "-" + seq)
        .build());
  }

  // Delay: hidden for 15 minutes (the most SQS allows). Per-message delays need a standard queue.
  static void checkPaymentLater(long orderId) {
    sqs.sendMessage(SendMessageRequest.builder()
        .queueUrl(BASE + "/payment-timeouts")
        .messageBody("{\\"orderId\\":" + orderId + "}")
        .delaySeconds(900)
        .build());
  }
}` }],
      },
      {
        title: 'RabbitMQ: fan-out, competing workers and priority',
        language: 'javascript',
        source: `// RabbitMQ: pub/sub fan-out to three queues, competing workers, and a priority queue.
import amqp from 'amqplib'

const conn = await amqp.connect('amqp://localhost')
const ch = await conn.createChannel()

// A fanout exchange copies every message to each queue bound to it (pub/sub).
await ch.assertExchange('order-events', 'fanout', { durable: true })
await ch.assertQueue('order-updates', { durable: true })
await ch.assertQueue('emails', { durable: true })
await ch.assertQueue('courier-jobs', { durable: true, maxPriority: 10 }) // a priority queue
for (const queue of ['order-updates', 'emails', 'courier-jobs']) await ch.bindQueue(queue, 'order-events', '')

// One publish, three copies. Gold orders get a higher priority in courier-jobs.
const placed = { type: 'OrderPlaced', orderId: 102, gold: true }
ch.publish('order-events', '', Buffer.from(JSON.stringify(placed)), { persistent: true, priority: placed.gold ? 9 : 1 })

// Point-to-point: workers on the same queue compete; each message goes to one of them.
await ch.prefetch(1) // one unacked message per worker, so priority and fairness still apply
await ch.consume('emails', async (msg) => {
  await sendReceipt(JSON.parse(msg.content.toString())) // must be safe to run twice
  ch.ack(msg)
})`,
        versions: [{ language: 'java', source: `import com.rabbitmq.client.*;
import java.nio.charset.StandardCharsets;
import java.util.Map;

// RabbitMQ: pub/sub fan-out to three queues, competing workers, and a priority queue.
public class OrderEvents {
  public static void main(String[] args) throws Exception {
    ConnectionFactory factory = new ConnectionFactory();
    factory.setHost("localhost");
    Connection conn = factory.newConnection();
    Channel ch = conn.createChannel();

    // A fanout exchange copies every message to each queue bound to it (pub/sub).
    ch.exchangeDeclare("order-events", BuiltinExchangeType.FANOUT, true);
    ch.queueDeclare("order-updates", true, false, false, null);
    ch.queueDeclare("emails", true, false, false, null);
    ch.queueDeclare("courier-jobs", true, false, false, Map.of("x-max-priority", 10)); // a priority queue
    for (String queue : new String[] {"order-updates", "emails", "courier-jobs"}) ch.queueBind(queue, "order-events", "");

    // One publish, three copies. Gold orders get a higher priority in courier-jobs.
    AMQP.BasicProperties gold = new AMQP.BasicProperties.Builder().deliveryMode(2).priority(9).build();
    ch.basicPublish("order-events", "", gold, "{\\"type\\":\\"OrderPlaced\\",\\"orderId\\":102,\\"gold\\":true}".getBytes(StandardCharsets.UTF_8));

    // Point-to-point: workers on the same queue compete; each message goes to one of them.
    ch.basicQos(1); // one unacked message per worker, so priority and fairness still apply
    ch.basicConsume("emails", false, (tag, delivery) -> {
      sendReceipt(new String(delivery.getBody(), StandardCharsets.UTF_8)); // must be safe to run twice
      ch.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
    }, tag -> {});
  }

  static void sendReceipt(String json) { /* look up the order, skip if already sent, send */ }
}` }],
      },
      {
        title: 'Request/reply with a correlation id',
        language: 'javascript',
        source: `// Request/reply over RabbitMQ: ask the Pricing Service for a fee and wait for the answer.
import amqp from 'amqplib'
import { randomUUID } from 'node:crypto'

const conn = await amqp.connect('amqp://localhost')
const ch = await conn.createChannel()

// The caller: a private reply queue, and a correlation id to match the answer to the question.
export async function deliveryFee(km, timeoutMs = 2000) {
  const { queue: replyTo } = await ch.assertQueue('', { exclusive: true, autoDelete: true })
  const correlationId = randomUUID()
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply in time')), timeoutMs)
    ch.consume(replyTo, (msg) => {
      if (msg.properties.correlationId !== correlationId) return // someone else's answer
      clearTimeout(timer)
      resolve(JSON.parse(msg.content.toString()))
    }, { noAck: true })
  })
  ch.sendToQueue('quote-requests', Buffer.from(JSON.stringify({ km })), { replyTo, correlationId })
  try {
    return await answer // e.g. { fee: 40 }
  } finally {
    await ch.deleteQueue(replyTo) // nothing should pile up after a timeout
  }
}

// The Pricing Service: answer on the reply-to queue, with the same correlation id.
await ch.assertQueue('quote-requests', { durable: true })
await ch.consume('quote-requests', (msg) => {
  const { km } = JSON.parse(msg.content.toString())
  const fee = 25 + Math.ceil(km) * 5 // ₹25 base + ₹5 a km: 4.2 km → ₹50
  ch.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify({ fee })), { correlationId: msg.properties.correlationId })
  ch.ack(msg)
})`,
        versions: [{ language: 'java', source: `import com.rabbitmq.client.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

// Request/reply over RabbitMQ: ask the Pricing Service for a fee and wait for the answer.
public class FeeClient {
  // The caller: a private reply queue, and a correlation id to match the answer to the question.
  static String deliveryFee(Channel ch, double km) throws Exception {
    String replyTo = ch.queueDeclare().getQueue(); // server-named, exclusive, deleted with the connection
    String correlationId = UUID.randomUUID().toString();
    CompletableFuture<String> answer = new CompletableFuture<>();
    String tag = ch.basicConsume(replyTo, true, (t, delivery) -> {
      if (correlationId.equals(delivery.getProperties().getCorrelationId())) // ignore anyone else's answer
        answer.complete(new String(delivery.getBody(), StandardCharsets.UTF_8));
    }, t -> {});
    AMQP.BasicProperties props = new AMQP.BasicProperties.Builder().replyTo(replyTo).correlationId(correlationId).build();
    ch.basicPublish("", "quote-requests", props, ("{\\"km\\":" + km + "}").getBytes(StandardCharsets.UTF_8));
    try {
      return answer.get(2, TimeUnit.SECONDS); // e.g. {"fee":50}
    } finally {
      ch.basicCancel(tag);
      ch.queueDelete(replyTo); // nothing should pile up after a timeout
    }
  }

  // The Pricing Service: answer on the reply-to queue, with the same correlation id.
  static void serve(Channel ch) throws Exception {
    ch.queueDeclare("quote-requests", true, false, false, null);
    ch.basicConsume("quote-requests", false, (t, delivery) -> {
      String body = new String(delivery.getBody(), StandardCharsets.UTF_8);
      double km = Double.parseDouble(body.replaceAll("[^0-9.]", ""));
      long fee = 25 + (long) Math.ceil(km) * 5; // ₹25 base + ₹5 a km: 4.2 km → ₹50
      AMQP.BasicProperties reply = new AMQP.BasicProperties.Builder().correlationId(delivery.getProperties().getCorrelationId()).build();
      ch.basicPublish("", delivery.getProperties().getReplyTo(), reply, ("{\\"fee\\":" + fee + "}").getBytes(StandardCharsets.UTF_8));
      ch.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
    }, t -> {});
  }
}` }],
      },
      {
        title: 'A bounded queue: wait, refuse or drop the oldest',
        language: 'javascript',
        source: `// A bounded queue in memory: when it is full, the caller picks what happens.
export class BoundedQueue {
  constructor(limit, whenFull = 'wait') {
    this.limit = limit
    this.whenFull = whenFull // 'wait' | 'refuse' | 'drop-oldest'
    this.items = []
    this.senders = [] // senders waiting for room
    this.takers = [] // workers waiting for a message
  }

  async put(item) {
    if (this.takers.length) {
      this.takers.shift()(item) // a worker is waiting: hand it over directly
      return true
    }
    if (this.items.length < this.limit) {
      this.items.push(item)
      return true
    }
    if (this.whenFull === 'refuse') return false // the caller answers "busy, try again" (429)
    if (this.whenFull === 'drop-oldest') {
      this.items.shift() // only fine when the newest value is all that matters
      this.items.push(item)
      return true
    }
    await new Promise((resolve) => this.senders.push(resolve)) // backpressure: wait for room
    return this.put(item)
  }

  async take() {
    if (!this.items.length) return new Promise((resolve) => this.takers.push(resolve))
    const item = this.items.shift()
    this.senders.shift()?.() // there is room now: let one waiting sender in
    return item
  }
}

const q = new BoundedQueue(2, 'refuse')
console.log(await q.put('101 placed'), await q.put('101 paid'), await q.put('102 placed')) // true true false
console.log(await q.take()) // 101 placed`,
        versions: [{ language: 'java', source: `import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

// A bounded queue in memory: when it is full, the caller picks what happens.
public class Bounded {
  public static void main(String[] args) throws InterruptedException {
    BlockingQueue<String> q = new ArrayBlockingQueue<>(2);

    // Refuse: offer() returns false when full, so the caller can answer "busy, try again" (429).
    System.out.println(q.offer("101 placed") + " " + q.offer("101 paid") + " " + q.offer("102 placed")); // true true false

    // Drop the oldest: only fine when the newest value is all that matters.
    while (!q.offer("courier at 12.97,77.59")) q.poll();

    System.out.println(q.take()); // 101 paid (101 placed was dropped to make room)

    // Wait (backpressure): put() blocks until a worker takes something.
    q.put("103 placed");
    System.out.println(q.size()); // 2
  }
}` }],
      },
    ],
    related: ['Message queues', 'Kafka (a log, not a queue)', 'Backpressure', 'Idempotency', 'Dead-letter queues', 'Scheduling jobs'],
  },
  simulator,
}
