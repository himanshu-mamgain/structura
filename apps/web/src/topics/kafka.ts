import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Kafka as an order-events pipeline: 3 brokers, a 3-partition topic, two consumer
// groups. The simulator uses Kafka's real default partitioner (murmur2 of the
// key, the same function as Utils.murmur2 in the Kafka client; it reproduces
// Kafka's own test values), so the partitions it shows are the ones Kafka picks.

const PARTITIONS = 3

/** Kafka's murmur2 (org.apache.kafka.common.utils.Utils.murmur2). */
export function murmur2(data: Uint8Array): number {
  const length = data.length
  const m = 0x5bd1e995
  let h = 0x9747b28c ^ length
  for (let i = 0; i < length >> 2; i++) {
    const i4 = i * 4
    let k = (data[i4] & 0xff) + ((data[i4 + 1] & 0xff) << 8) + ((data[i4 + 2] & 0xff) << 16) + ((data[i4 + 3] & 0xff) << 24)
    k = Math.imul(k, m)
    k ^= k >>> 24
    k = Math.imul(k, m)
    h = Math.imul(h, m)
    h ^= k
  }
  // The last 1 to 3 bytes (Kafka's switch with fall-through, written as ifs).
  const tail = length & ~3
  const rest = length % 4
  if (rest >= 3) h ^= (data[tail + 2] & 0xff) << 16
  if (rest >= 2) h ^= (data[tail + 1] & 0xff) << 8
  if (rest >= 1) {
    h ^= data[tail] & 0xff
    h = Math.imul(h, m)
  }
  h ^= h >>> 13
  h = Math.imul(h, m)
  h ^= h >>> 15
  return h | 0
}

/** The partition Kafka's default partitioner picks for a key. */
export const partitionFor = (key: string, partitions = PARTITIONS) => (murmur2(new TextEncoder().encode(key)) & 0x7fffffff) % partitions

const BROKERS = ['Broker 1 · P0 leader', 'Broker 2 · P1 leader', 'Broker 3 · P2 leader']
// The billing group's two consumers split the three partitions.
const OWNER = ['Billing Consumer 1', 'Billing Consumer 1', 'Billing Consumer 2']

const simulator: Simulator = {
  fields: [
    { id: 'key', label: 'Order key', options: ['order-1001', 'order-1003', 'order-1000'] },
    { id: 'acks', label: 'Producer acks', options: ['acks=all', 'acks=1', 'acks=0'] },
    { id: 'scenario', label: 'What happens', options: ['A normal day', 'The leader broker crashes right after the write', 'The consumer crashes before committing'] },
  ],
  defaults: { key: 'order-1001', acks: 'acks=all', scenario: 'A normal day' },
  run({ key, acks, scenario }) {
    const h = murmur2(new TextEncoder().encode(key))
    const p = (h & 0x7fffffff) % PARTITIONS
    const leader = BROKERS[p]
    const follower = BROKERS[(p + 1) % PARTITIONS]
    const owner = OWNER[p]
    const offset = 48_210 + p * 1_337
    const record = { key, value: { order_id: key, amount_inr: 1499, status: 'PAID' } }
    const leaderCrash = scenario.startsWith('The leader')
    const consumerCrash = scenario.startsWith('The consumer')
    const steps: Trace['steps'] = [
      {
        text: `The Order Service produces an "order paid" event to the orders topic, keyed by the order id, with ${acks}.`,
        nodes: ['Producer (Order Service)'],
        data: `producer.send({ topic: 'orders', acks: ${acks === 'acks=all' ? -1 : acks === 'acks=1' ? 1 : 0} })\n${json(record)}`,
      },
      {
        text: `The partitioner hashes the key with murmur2 and takes it modulo ${PARTITIONS}: every event for ${key} lands on partition ${p}, so they stay in order.`,
        nodes: ['Partitioner (hash of key)'],
        data: `murmur2("${key}") = ${h}\n(${h} & 0x7fffffff) % ${PARTITIONS} = ${p}\n→ partition ${p}, leader: ${leader}`,
      },
      {
        text: `${leader} appends the event to the end of partition ${p}'s log at offset ${offset}. A partition is just an append-only file: writes are sequential, which is why Kafka is fast.`,
        nodes: [leader],
        data: `orders-${p}/00000000000000048000.log\n… ${offset - 1}: { key: "order-…", … }\n  ${offset}: ${JSON.stringify(record)}   ← new`,
      },
    ]

    if (acks === 'acks=all') {
      steps.push({
        text: `With acks=all, the leader waits until the in-sync replicas (here ${follower.split(' ·')[0]}) have copied it, then confirms. min.insync.replicas=2 means two copies exist before the producer hears "done".`,
        nodes: [leader, follower],
        data: `replication.factor=3, min.insync.replicas=2\nISR(orders-${p}) = [${p + 1}, ${((p + 1) % PARTITIONS) + 1}, ${((p + 2) % PARTITIONS) + 1}]\nack → producer after 2 of 3 replicas have offset ${offset}`,
      })
    } else if (acks === 'acks=1') {
      steps.push({
        text: 'With acks=1, the leader confirms as soon as it has written the event itself. Followers copy it a few milliseconds later.',
        nodes: [leader],
        data: `ack → producer immediately (offset ${offset})\nfollowers: still fetching…`,
      })
    } else {
      steps.push({
        text: "With acks=0, the producer doesn't wait for any answer. Fastest, but it never knows whether the event arrived.",
        nodes: ['Producer (Order Service)'],
        data: 'no response expected',
      })
    }

    if (leaderCrash) {
      if (acks === 'acks=all') {
        steps.push({
          text: `${leader} crashes. The KRaft Controller makes the in-sync follower the new leader. It already has offset ${offset}, so nothing is lost.`,
          nodes: ['KRaft Controller', follower],
          data: `controller: broker ${p + 1} offline\nnew leader for orders-${p}: broker ${((p + 1) % PARTITIONS) + 1} (in ISR, has ${offset})\n✓ event survives`,
        })
      } else {
        steps.push({
          text: `${leader} crashes before the followers copied the event. The new leader never had offset ${offset}: the event is gone, although ${acks === 'acks=1' ? 'the producer was told it succeeded' : 'nobody will ever know'}. This is why payments use acks=all.`,
          nodes: ['KRaft Controller', follower],
          data: `new leader for orders-${p}: broker ${((p + 1) % PARTITIONS) + 1}, log ends at ${offset - 1}\n✗ order ${key} lost${acks === 'acks=1' ? ' (producer saw success)' : ''}`,
        })
        return { input: `${key} with ${acks}, leader crash`, steps }
      }
    }

    steps.push({
      text: `In the billing group, partition ${p} belongs to ${owner}. Each partition has exactly one consumer per group, so the order's events are handled in order, by one consumer.`,
      nodes: [owner],
      data: `group billing: P0, P1 → Billing Consumer 1; P2 → Billing Consumer 2\npoll() → [offset ${offset}] ${key}`,
    })

    if (consumerCrash) {
      const other = owner === 'Billing Consumer 1' ? 'Billing Consumer 2' : 'Billing Consumer 1'
      steps.push(
        {
          text: `${owner} writes the invoice to the Billing DB, then crashes before committing offset ${offset + 1}.`,
          nodes: [owner, 'Billing DB'],
          data: `INSERT INTO invoices (order_id, amount_inr) VALUES ('${key}', 1499);  ✓\ncommit(${offset + 1})  ✗ crashed first`,
        },
        {
          text: `The group rebalances: ${other} takes over partition ${p} and resumes from the last committed offset, ${offset}. So it processes ${key} a second time: at-least-once delivery.`,
          nodes: [other, '__consumer_offsets'],
          data: `committed offset (billing, orders-${p}) = ${offset}\n${other}: poll() → [offset ${offset}] ${key}   ← again`,
        },
        {
          text: 'Because the write is idempotent (upsert by order id), the duplicate changes nothing. Always design consumers for duplicates.',
          nodes: [other, 'Billing DB'],
          data: `INSERT INTO invoices (order_id, amount_inr) VALUES ('${key}', 1499)\nON CONFLICT (order_id) DO NOTHING;   → 0 rows (already invoiced)`,
        },
      )
    } else {
      steps.push(
        {
          text: `${owner} creates the invoice in the Billing DB, idempotently, so a retry could never charge twice.`,
          nodes: [owner, 'Billing DB'],
          data: `INSERT INTO invoices (order_id, amount_inr) VALUES ('${key}', 1499)\nON CONFLICT (order_id) DO NOTHING;`,
        },
        {
          text: `Then it commits offset ${offset + 1} to __consumer_offsets: "next time, start after this event".`,
          nodes: [owner, '__consumer_offsets'],
          data: json({ group: 'billing', topic: 'orders', partition: p, committed_offset: offset + 1 }),
        },
      )
    }
    steps.push({
      text: `Separately, the Analytics Consumer reads the same event at its own pace. Consumer groups don't take events away from each other: each group has its own offsets.`,
      nodes: ['Analytics Consumer'],
      data: `group analytics, orders-${p}: committed offset ${offset - 2_431} (it's behind, and that's fine)`,
    })
    return { input: `${key} with ${acks}${leaderCrash ? ', leader crash' : consumerCrash ? ', consumer crash' : ''}`, steps }
  },
}

export const kafka: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'kafka',
  title: 'Kafka: Event Streaming',
  blurb: 'Topics, partitions, consumer groups, copies across brokers, and what "delivered" really means',
  guides: [
    'ref-apache-kafka-docs',
    'ref-kafka-nodejs-tutorial',
    'the-ultimate-kafka-101-you-cannot-miss',
    'why-is-kafka-fast',
    'can-kafka-lose-messages',
    'top-5-kafka-use-cases',
    'how-do-message-queue-architectures-evolve',
    'primer-asynchronism',
  ],
  takeaways: [
    'A topic is split into partitions: logs you only add to, spread across brokers.',
    'The key decides the partition, and order is kept only within a partition.',
    'Each partition goes to one consumer per group, so more partitions means more consumers can work at once.',
    'acks=all with min.insync.replicas=2 is what stops a broker crash from losing events.',
    'Consumers commit offsets after processing, so events arrive at least once: make handlers safe to repeat.',
    'Each consumer group keeps its own offsets, so many systems can read the same events.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'cluster', label: 'Kafka cluster' },
      { id: 'billing', label: 'Group: billing' },
      { id: 'analytics', label: 'Group: analytics' },
    ],
    nodes: [
      { id: 'producer', label: 'Producer (Order Service)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'partitioner', label: 'Partitioner (hash of key)', shape: 'diamond', color: 'violet', group: null },
      { id: 'b1', label: 'Broker 1 · P0 leader', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'b2', label: 'Broker 2 · P1 leader', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'b3', label: 'Broker 3 · P2 leader', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'controller', label: 'KRaft Controller', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'offsets', label: '__consumer_offsets', shape: 'rectangle', color: 'yellow', group: 'cluster' },
      { id: 'c1', label: 'Billing Consumer 1', shape: 'rectangle', color: 'orange', group: 'billing' },
      { id: 'c2', label: 'Billing Consumer 2', shape: 'rectangle', color: 'orange', group: 'billing' },
      { id: 'analytics', label: 'Analytics Consumer', shape: 'rectangle', color: 'orange', group: 'analytics' },
      { id: 'db', label: 'Billing DB', shape: 'rectangle', color: 'green', group: null },
      { id: 'dlq', label: 'orders.DLQ (dead letters)', shape: 'rectangle', color: 'red', group: null },
    ],
    edges: [
      { from: 'producer', to: 'partitioner', label: 'send(key, event)', dashed: false },
      { from: 'partitioner', to: 'b1', label: 'P0', dashed: false },
      { from: 'partitioner', to: 'b2', label: 'P1', dashed: false },
      { from: 'partitioner', to: 'b3', label: 'P2', dashed: false },
      { from: 'b1', to: 'b2', label: 'replicate', dashed: true },
      { from: 'b2', to: 'b3', label: 'replicate', dashed: true },
      { from: 'controller', to: 'b1', label: 'leader election', dashed: true },
      { from: 'b1', to: 'c1', label: 'P0', dashed: false },
      { from: 'b2', to: 'c1', label: 'P1', dashed: false },
      { from: 'b3', to: 'c2', label: 'P2', dashed: false },
      { from: 'b2', to: 'analytics', label: 'P0–P2', dashed: false },
      { from: 'c1', to: 'db', label: 'idempotent write', dashed: false },
      { from: 'c2', to: 'db', label: 'idempotent write', dashed: false },
      { from: 'c1', to: 'offsets', label: 'commit offset', dashed: true },
      { from: 'c2', to: 'offsets', label: 'commit offset', dashed: true },
      { from: 'c1', to: 'dlq', label: 'poison message', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'invoices',
        name: 'invoices',
        columns: [
          { name: 'order_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'amount_inr', type: 'numeric(12,2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'processed_events',
        name: 'processed_events',
        columns: [
          { name: 'topic', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'partition', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'event_offset', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'order_id', type: 'text', pk: false, fk: 'invoices.order_id', nullable: false, unique: false },
          { name: 'processed_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [{ from: 'processed_events', to: 'invoices', kind: 'one-to-many', label: 'produced' }],
  },
  explanation: {
    title: 'Kafka: Event Streaming',
    summary:
      'Kafka is a log of events, spread across several servers and kept safely on disk. Producers add events to topics, which are split into partitions spread over brokers. Consumers read at their own pace and remember their place with offsets. Services no longer have to call each other directly, traffic spikes wait in the log, and many systems can react to the same event.',
    sections: [
      {
        heading: 'Overview',
        body: 'Without Kafka, the Order Service would call billing, analytics, email and search itself. If one of them is slow or down, orders fail. With Kafka, the Order Service writes one event, "order paid", and moves on. Every system that cares reads it when it\'s ready.\n\nThe core idea is the log: an ordered list of events that you only add to, kept for days, or forever. Unlike a classic queue, reading an event doesn\'t delete it. Each reader just remembers where it is.',
      },
      {
        heading: 'Core concepts',
        body: '- Topic: a named stream of events, like orders.\n- Partition: a piece of a topic, each one an ordered log on one broker. Partitions are what let several consumers work at once.\n- Offset: an event\'s position in its partition (0, 1, 2…).\n- Broker: a Kafka server that stores partitions. A cluster has several.\n- Copies (replication): each partition has a leader and followers on other brokers. Followers that are fully caught up are the in-sync replicas (ISR).\n- Consumer group: consumers that share the work. Each partition goes to exactly one consumer in the group.\n- KRaft: the way Kafka\'s servers agree among themselves (it replaced ZooKeeper from Kafka 3.3); it picks each partition\'s leader.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 50,000 order events a second at the peak, about 1 KB each.\n- 50 MB a second written; with 3 copies, 150 MB a second of disk writes across the cluster.\n- Kept for 7 days: 50 MB a second × 604,800 seconds ≈ 30 TB per copy, about 90 TB with all 3 copies.\n- If one consumer handles 5,000 events a second, one group needs at least 10 partitions to keep up at the peak. Teams often choose 2 to 3 times that for room to grow, because adding partitions later moves keys around.',
      },
      {
        heading: 'Step by step',
        body: '1. The Producer (Order Service) sends an event with a key (the order ID).\n2. The Partitioner (hash of key) turns the key into a partition number, so one order\'s events stay in order.\n3. That partition\'s leader, say Broker 1 · P0 leader, adds the event to the end of its log.\n4. Followers copy it; with acks=all, the producer gets its answer once the in-sync copies have the event.\n5. In the billing group, the consumer that owns the partition (Billing Consumer 1 or Billing Consumer 2) reads it.\n6. It writes to the Billing DB in a way that\'s safe to repeat, then commits its offset to __consumer_offsets.\n7. Events it still can\'t process after a few retries go to orders.DLQ (dead letters) for a person to look at.\n8. The Analytics Consumer reads the same events with its own offsets.\n9. If a broker dies, the KRaft Controller makes a caught-up follower the new leader.',
      },
      {
        heading: 'Components',
        body: '- Producer (Order Service): sends events, grouped and compressed to go faster.\n- Partitioner (hash of key): murmur2(key) divided by the number of partitions; the remainder is the partition, so equal keys always land in the same one.\n- Broker 1 · P0 leader: stores partitions and handles reads and writes for the ones it leads.\n- Broker 2 · P1 leader: also holds copies of other partitions, ready to take over.\n- Broker 3 · P2 leader: the third broker; three brokers allow three copies of everything.\n- KRaft Controller: keeps track of the brokers and picks a new leader when one fails.\n- __consumer_offsets: Kafka\'s own topic where each group records how far it has read.\n- Billing Consumer 1: in the billing group; owns partitions 0 and 1.\n- Billing Consumer 2: owns partition 2; if a consumer dies, the group hands its partitions to the others.\n- Analytics Consumer: in a separate group, so it gets every event too.\n- Billing DB: where invoices are written, with a unique order ID so a repeat does nothing.\n- orders.DLQ (dead letters): a topic for events that keep failing, so one bad event can\'t block a partition.',
      },
      {
        heading: 'Key decisions',
        body: '- The partition key: choose the thing whose events must stay in order (an order ID, a user ID). A lopsided key, like one huge customer, makes one partition much busier than the rest.\n- How many partitions: this caps how many consumers in a group can work at once. Changing it later moves keys to new partitions and breaks order during the change.\n- acks and min.insync.replicas: acks=all with min.insync.replicas=2 and 3 copies survives losing a broker without losing any confirmed event. acks=1 is faster but can lose them.\n- What "delivered" means: committing after processing gives "at least once", so repeats are possible. "Exactly once" needs idempotent producers plus transactions, or consumers that are safe to repeat.\n- Keep by time or compact: time-based retention keeps everything for N days; log compaction keeps only the latest value for each key, which suits state like "current price".',
      },
      {
        heading: 'Scaling and failure',
        body: '- More partitions and brokers mean more speed: add brokers and move partitions onto them.\n- Consumer lag (how far a group is behind) is the main health number. If it keeps growing, add consumers (up to the number of partitions) or make processing faster.\n- When a broker fails, new leaders are picked for its partitions; with in-sync copies, nothing confirmed is lost.\n- Rebalances pause reading for a moment; cooperative rebalancing and static membership keep the pauses short.\n- A poison message (one that always fails) would block its partition forever: retry a few times, then send it to a dead-letter topic.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How do you make sure all of one user\'s events are handled in order?\n- What happens to order if you add partitions?\n- How would you make sure a payment event is never lost and never charged twice?\n- Your consumer lag keeps growing. What do you check, and what do you change?\n- When would you choose a classic queue like RabbitMQ or SQS over Kafka?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Producer: durable, ordered per key (kafkajs)',
        language: 'javascript',
        source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'order-service', brokers: ['kafka-1:9092', 'kafka-2:9092', 'kafka-3:9092'] })
// idempotent: retries can't create duplicates in the log.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 })
await producer.connect()

export async function orderPaid(orderId, amountInr) {
  await producer.send({
    topic: 'orders',
    acks: -1, // acks=all: wait for the in-sync replicas
    messages: [{ key: orderId, value: JSON.stringify({ order_id: orderId, amount_inr: amountInr, status: 'PAID' }) }],
  })
}`,
        versions: [
          {
            language: 'typescript',
            source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'order-service', brokers: ['kafka-1:9092', 'kafka-2:9092', 'kafka-3:9092'] })
// idempotent: retries can't create duplicates in the log.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 })
await producer.connect()

export async function orderPaid(orderId: string, amountInr: number) {
  await producer.send({
    topic: 'orders',
    acks: -1, // acks=all: wait for the in-sync replicas
    messages: [{ key: orderId, value: JSON.stringify({ order_id: orderId, amount_inr: amountInr, status: 'PAID' }) }],
  })
}`,
          },
        ],
      },
      {
        title: 'Consumer: commit after processing, idempotent write',
        language: 'javascript',
        source: `import { Kafka } from 'kafkajs'
import { pool } from './db'

const consumer = new Kafka({ clientId: 'billing', brokers: ['kafka-1:9092'] }).consumer({ groupId: 'billing' })
await consumer.connect()
await consumer.subscribe({ topic: 'orders' })

await consumer.run({
  autoCommit: false, // commit only after the invoice is written
  eachMessage: async ({ topic, partition, message }) => {
    const event = JSON.parse(message.value.toString())
    // A redelivered event (after a crash or rebalance) inserts nothing.
    await pool.query(
      'INSERT INTO invoices (order_id, amount_inr, created_at) VALUES ($1, $2, now()) ON CONFLICT (order_id) DO NOTHING',
      [event.order_id, event.amount_inr],
    )
    await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }])
  },
})`,
        versions: [
          {
            language: 'typescript',
            source: `import { Kafka } from 'kafkajs'
import { pool } from './db'

const consumer = new Kafka({ clientId: 'billing', brokers: ['kafka-1:9092'] }).consumer({ groupId: 'billing' })
await consumer.connect()
await consumer.subscribe({ topic: 'orders' })

await consumer.run({
  autoCommit: false, // commit only after the invoice is written
  eachMessage: async ({ topic, partition, message }) => {
    const event = JSON.parse(message.value!.toString())
    // A redelivered event (after a crash or rebalance) inserts nothing.
    await pool.query(
      'INSERT INTO invoices (order_id, amount_inr, created_at) VALUES ($1, $2, now()) ON CONFLICT (order_id) DO NOTHING',
      [event.order_id, event.amount_inr],
    )
    await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }])
  },
})`,
          },
          {
            language: 'go',
            source: `r := kafka.NewReader(kafka.ReaderConfig{
\tBrokers: []string{"kafka-1:9092"},
\tGroupID: "billing",
\tTopic:   "orders",
})
for {
\tm, err := r.FetchMessage(ctx) // doesn't commit yet
\tif err != nil {
\t\tbreak
\t}
\tif err := saveInvoice(ctx, m.Key, m.Value); err != nil { // idempotent upsert
\t\tcontinue // retried on next fetch; send to a DLQ after N tries
\t}
\tr.CommitMessages(ctx, m) // at-least-once: commit after processing
}`,
          },
        ],
      },
    ],
    related: ['Message queues', 'Event sourcing', 'Exactly-once semantics', 'Change data capture', 'Stream processing'],
  },
  simulator,
}
