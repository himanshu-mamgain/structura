import { shortNumber } from '../learn/numbers'
import type { Trace } from '@structura/shared'
import { partitionFor } from './kafka'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator publishes twelve real order events to a topic, picks each event's
// partition with Kafka's default partitioner (murmur2 of the key, from kafka.ts), lays
// out each partition's log with offsets, assigns partitions to the consumers of a group
// the way Kafka's RangeAssignor does, and works out whether the group keeps up.

const RATE = 120 // events a second on the topic in real traffic
const PER_CONSUMER = 50 // events a second one billing consumer can process
const MINUTES = 10

type Event = { key: string; type: 'placed' | 'paid' | 'delivered'; time: string }

const EVENTS: Event[] = [
  { key: 'order-4101', type: 'placed', time: '19:02:11' },
  { key: 'order-4102', type: 'placed', time: '19:02:40' },
  { key: 'order-4101', type: 'paid', time: '19:02:52' },
  { key: 'order-4104', type: 'placed', time: '19:03:05' },
  { key: 'order-4102', type: 'paid', time: '19:03:30' },
  { key: 'order-4109', type: 'placed', time: '19:03:41' },
  { key: 'order-4104', type: 'paid', time: '19:04:02' },
  { key: 'order-4101', type: 'delivered', time: '19:31:15' },
  { key: 'order-4109', type: 'paid', time: '19:31:50' },
  { key: 'order-4102', type: 'delivered', time: '19:35:08' },
  { key: 'order-4104', type: 'delivered', time: '19:40:44' },
  { key: 'order-4109', type: 'delivered', time: '19:52:19' },
]
const KEYS = [...new Set(EVENTS.map((e) => e.key))]
const CONSUMERS = ['Consumer A', 'Consumer B', 'Consumer C', 'Consumer D']

const PARTITIONS: Record<string, number> = { '1 partition': 1, '3 partitions': 3, '6 partitions': 6 }
const GROUP: Record<string, number> = { '1 consumer': 1, '2 consumers': 2, '3 consumers': 3, '4 consumers': 4 }
const THEN: Record<string, 'once' | 'second' | 'replay'> = {
  'Consume once': 'once',
  'A second group reads too': 'second',
  'Replay after a bug': 'replay',
}

/** The diagram box a partition is drawn in. */
const partNode = (p: number) => (p < 3 ? `Partition ${p}` : 'Partitions 3 to 5')

/** Kafka's RangeAssignor for one topic: consecutive partitions, the first few consumers get one extra. */
function assign(partitions: number, consumers: number): number[][] {
  const per = Math.floor(partitions / consumers)
  const extra = partitions % consumers
  const out: number[][] = []
  let next = 0
  for (let c = 0; c < consumers; c++) {
    const count = per + (c < extra ? 1 : 0)
    out.push(Array.from({ length: count }, (_, i) => next + i))
    next += count
  }
  return out
}

const describe = (e: Event) => `${e.key} ${e.type}`
const n = (x: number) => shortNumber(x)

const simulator: Simulator = {
  fields: [
    { id: 'partitions', label: 'Topic', options: Object.keys(PARTITIONS) },
    { id: 'consumers', label: 'Billing group', options: Object.keys(GROUP) },
    { id: 'then', label: 'Then', options: Object.keys(THEN) },
  ],
  defaults: { partitions: '3 partitions', consumers: '2 consumers', then: 'Consume once' },
  run({ partitions: pKey, consumers: cKey, then: tKey }) {
    const P = PARTITIONS[pKey] ?? 3
    const C = GROUP[cKey] ?? 2
    const then = THEN[tKey] ?? 'once'

    // Produce: each event goes to the partition its key hashes to, at the next offset.
    const logs: Event[][] = Array.from({ length: P }, () => [])
    for (const e of EVENTS) logs[partitionFor(e.key, P)].push(e)
    const assignment = assign(P, C)
    const owner = (p: number) => assignment.findIndex((ps) => ps.includes(p))
    const idle = assignment.map((ps, c) => (ps.length ? null : CONSUMERS[c])).filter(Boolean) as string[]
    const empty = logs.map((l, p) => (l.length ? null : p)).filter((p): p is number => p !== null)

    // Throughput, assuming real traffic spreads evenly over partitions.
    const perPartition = RATE / P
    const loads = assignment.map((ps) => ps.length * perPartition)
    const lagPerSec = loads.reduce((t, l) => t + Math.max(0, l - PER_CONSUMER), 0)
    const lag = lagPerSec * MINUTES * 60

    const steps: Trace['steps'] = [
      {
        text: `The Order Service publishes events to the orders topic as orders move along: ${EVENTS.length} events for ${KEYS.length} orders. Each event's key is its order id. Kafka's default partitioner hashes the key (murmur2) to choose one of the topic's ${P} ${P === 1 ? 'partition' : 'partitions'}, so every event of one order goes to the same partition.`,
        nodes: ['Order Service', 'Partitioner'],
        data: KEYS.map((k) => `${k} → murmur2 → partition ${partitionFor(k, P)}`).join('\n') + `\n\nproducer.send({ topic: 'orders', messages: [{ key: 'order-4101', value: '{"type":"placed"}' }] })`,
      },
      {
        text: `Each partition is an append-only log. A new event goes at the end with the next offset (0, 1, 2, …) and stays there: by default for 7 days, whether or not anyone has read it.${empty.length ? ` ${empty.length === 1 ? 'Partition' : 'Partitions'} ${empty.join(' and ')} got nothing: with only ${KEYS.length} keys, hashing can leave partitions empty. With thousands of keys they even out.` : ''}`,
        nodes: [...new Set(logs.map((_, p) => partNode(p)))].slice(0, 4),
        data: logs.map((l, p) => `P${p}: ${l.length ? l.map((e, o) => `[${o}] ${describe(e)}`).join(', ') : '(empty)'}`).join('\n'),
      },
      {
        text: `The billing service runs ${C} ${C === 1 ? 'consumer' : 'consumers'} in one consumer group. Kafka gives each partition to exactly one consumer in the group, so no event is processed twice by the group.${idle.length ? ` With ${P} ${P === 1 ? 'partition' : 'partitions'} and ${C} consumers, ${idle.join(' and ')} ${idle.length === 1 ? 'gets' : 'get'} nothing and ${idle.length === 1 ? 'sits' : 'sit'} idle.` : ''}`,
        nodes: CONSUMERS.slice(0, Math.min(C, 4)),
        data: assignment.map((ps, c) => `${CONSUMERS[c]} ← ${ps.length ? ps.map((p) => `P${p}`).join(', ') : 'nothing (idle)'}`).join('\n') + '\n(RangeAssignor: consecutive partitions per consumer)',
      },
      {
        text: `Each consumer reads its partitions from the lowest offset up. Within a partition the order is guaranteed, so order-4101 is always placed, then paid, then delivered. Across partitions there is no order: ${C > 1 && P > 1 ? 'one consumer may finish order-4102 before another has started order-4104.' : 'here one consumer reads everything, but in partition order, not in time order.'}`,
        nodes: [...new Set(assignment.flatMap((ps) => ps.map(partNode)))].slice(0, 2).concat(CONSUMERS.slice(0, Math.min(C, 2))),
        data: assignment
          .map((ps, c) => {
            const read = ps.flatMap((p) => logs[p].map((e, o) => `P${p}@${o} ${describe(e)}`))
            return `${CONSUMERS[c]}: ${read.length ? read.join(' → ') : '(nothing)'}`
          })
          .join('\n'),
      },
      {
        text: 'After processing, each consumer commits its position: for every partition, the offset of the next event to read. The commits live in Kafka itself, so a consumer that restarts carries on from there.',
        nodes: ['Consumer A', 'Committed Offsets'],
        data: logs.map((l, p) => `group billing · orders P${p}: committed offset ${l.length}${owner(p) >= 0 ? ` (by ${CONSUMERS[owner(p)]})` : ''}`).join('\n'),
      },
      {
        text: `In real traffic the topic receives about ${RATE} events a second and one billing consumer can process ${PER_CONSUMER}. ${lag ? `Some consumers own more than they can handle, so the group falls behind: its lag grows by ${n(lagPerSec)} events a second.` : 'Every consumer gets less than it can handle, so the group keeps up and the lag stays near zero.'}`,
        nodes: CONSUMERS.slice(0, Math.min(C, 3)).concat('Committed Offsets'),
        data:
          assignment.map((ps, c) => `${CONSUMERS[c]}: ${ps.length} × ${perPartition.toFixed(0)}/s = ${loads[c].toFixed(0)}/s of ${PER_CONSUMER}/s${loads[c] > PER_CONSUMER ? '  ✗ falling behind' : ps.length ? '  ✓' : '  (idle)'}`).join('\n') +
          `\nlag after ${MINUTES} minutes: ${n(lag)} events`,
      },
    ]

    if (then === 'second')
      steps.push({
        text: 'The analytics team starts a second consumer group on the same topic. It reads all 12 events from offset 0, with its own committed offsets. The billing group\'s position doesn\'t change, and nothing was deleted: unlike a queue, reading doesn\'t consume.',
        nodes: ['Partition 0', 'Partition 1', 'Analytics Consumer', 'Committed Offsets'],
        data: logs.map((l, p) => `orders P${p}: billing at ${l.length} · analytics at ${l.length} (after reading from 0)`).join('\n') + '\n\nkafka-consumer-groups.sh --describe --group analytics',
      })
    if (then === 'replay')
      steps.push({
        text: 'A bug in the invoice code charged the wrong GST on these orders. After the fix, the billing group\'s offsets are reset to the earliest, and the consumers read all 12 events again to rebuild the invoices. The events were still in the log, so nothing had to be re-sent.',
        nodes: ['Committed Offsets', 'Consumer A', 'Invoices DB'],
        data: `kafka-consumer-groups.sh --bootstrap-server kafka:9092 --group billing \\\n  --topic orders --reset-offsets --to-earliest --execute\n\n${logs.map((l, p) => `orders P${p}: ${l.length} → 0`).join('\n')}\nre-read: ${EVENTS.length} events (invoice writes must be idempotent: upsert by order id)`,
      })

    const lesson =
      P === 1 && C > 1
        ? 'A partition is read by one consumer per group, so one partition means one consumer\'s speed, however many you start.'
        : idle.length
          ? `More consumers than partitions leaves some idle. Partitions set the most consumers a group can use.`
          : lag
            ? 'The group is short of consumers for this traffic. Add consumers, up to the number of partitions.'
            : then === 'second'
              ? 'Every group gets every event and tracks its own offsets: Kafka is a log many readers share, not a queue that hands out jobs.'
              : then === 'replay'
                ? 'Because events stay for the retention period, fixing a bug can include re-reading history.'
                : 'Partitions give parallelism, keys keep each order\'s events in order, and offsets let consumers stop and resume.'

    steps.push({
      text: `Result: ${lag ? `the group falls ${n(lag)} events behind in ${MINUTES} minutes` : 'the group keeps up'}${idle.length ? ` with ${idle.length} idle ${idle.length === 1 ? 'consumer' : 'consumers'}` : ''}. ${lesson}`,
      nodes: ['Order Service', ...CONSUMERS.slice(0, Math.min(C, 2)), 'Invoices DB'],
      data: `partitions: ${P} · consumers: ${C} · active: ${Math.min(P, C)}\ncapacity: ${Math.min(P, C)} × ${PER_CONSUMER}/s = ${Math.min(P, C) * PER_CONSUMER}/s (if evenly spread) vs ${RATE}/s in\nlag after ${MINUTES} min: ${n(lag)}`,
    })
    return { input: `${pKey} · ${cKey} · ${tKey.toLowerCase()} → ${lag ? `${n(lag)} behind after ${MINUTES} min` : 'keeps up'}${idle.length ? `, ${idle.length} idle` : ''}`, steps }
  },
}

const run = (partitions: string, consumers: string, then = 'Consume once') => ({ partitions, consumers, then })

export const kafkaBasics: StaticTopic = {
  kind: 'static',
  difficulty: 'Beginner',
  id: 'kafka-basics',
  title: 'Kafka Basics: Topics, Partitions, Groups',
  blurb: 'Events in a log you only add to: keys pick partitions, consumer groups share them, and offsets let anyone read again',
  guides: ['the-ultimate-kafka-101-you-cannot-miss', 'why-is-kafka-fast', 'top-5-kafka-use-cases', 'types-of-message-queue', 'ref-apache-kafka-docs', 'ref-kafka-nodejs-tutorial'],
  story: {
    title: 'The events that wouldn\'t disappear',
    dek: 'Priya\'s food app sends order events to billing. Then analytics wants them too, billing needs to go faster, and a bug means reading yesterday again. Each time, Kafka\'s log answers differently from a queue.',
    chapters: [
      {
        heading: 'A log, not a queue',
        body: `The app's order events used to go into a Redis list, and the billing worker popped them off. Then the analytics team asked for the same events, and there was a problem: an event popped by billing was gone.

**Kafka** stores events in a **topic**, an append-only **log**. Producers add events at the end; consumers read them, and reading doesn't remove anything. Each event stays for the topic's retention time, 7 days by default. Billing and analytics can read the same events, each at its own pace.`,
        replay: { label: 'Add an analytics group', values: run('3 partitions', '3 consumers', 'A second group reads too') },
      },
      {
        heading: 'Keys keep an order in order',
        body: `A topic is split into **partitions**, separate logs that can live on different servers (**brokers**) and be read in parallel. Every event has a position in its partition, its **offset**.

Which partition? The producer sends each event with a **key**, here the order id. Kafka's default partitioner hashes the key with murmur2 and takes it modulo the number of partitions, so all of \`order-4101\`'s events land in the same partition, in the order they were sent. That's the only order Kafka promises: within a partition, not across them.`,
        replay: { label: 'See the partitions', values: run('3 partitions', '2 consumers') },
      },
      {
        heading: 'Consumer groups split the work',
        body: `Billing runs as a **consumer group**: several copies of the same consumer sharing one group id. Kafka gives each partition to exactly one member, so the group processes each event once, in parallel.

At dinner time billing fell behind: 120 events a second, and each consumer handles 50. With 3 partitions and 2 consumers, one consumer owned two partitions, 80 events a second, and its **lag** (how far behind the end of the log it is) grew by 30 a second.`,
        replay: { label: 'Two consumers at dinner', values: run('3 partitions', '2 consumers') },
      },
      {
        heading: 'The fourth consumer did nothing',
        body: `So they started 4 consumers. The fourth sat idle: with 3 partitions, a group can use at most 3 consumers. The number of partitions is the ceiling on a group's parallelism.

They moved to 6 partitions. Two caveats came with it. Adding partitions changes \`hash(key) % partitions\`, so an order's new events can land in a different partition than its old ones. And with only a few keys, some partitions stay empty while others are busy; with thousands of order ids, they even out.`,
        replay: { label: 'Four consumers, three partitions', values: run('3 partitions', '4 consumers') },
      },
      {
        heading: 'Reading yesterday again',
        body: `A bug in the invoice code charged the wrong GST for a day. In the old Redis queue, those events would have been long gone. In Kafka they were still in the log.

After the fix, someone reset the billing group's **committed offsets** (each consumer's saved position) to the earliest, and the consumers read the whole day again, rewriting the invoices. That only works because the invoice writes are idempotent: writing the same order twice gives the same row.

> A queue forgets what it delivered. A log remembers, so you can replay it.`,
        replay: { label: 'Replay after the bug', values: run('3 partitions', '3 consumers', 'Replay after a bug') },
      },
    ],
  },
  takeaways: [
    'A Kafka topic is a log you only add to: events stay for the retention period, and reading doesn\'t remove them.',
    'A topic is split into partitions; the key\'s hash picks the partition, so events with the same key stay in order.',
    'Order is kept only within a partition, never across the whole topic.',
    'In a consumer group, each partition goes to exactly one consumer, so the number of partitions limits how many consumers can work at once.',
    'Each group commits its own offsets, so groups read the same events separately, and a group can go back to replay.',
    'Lag, how far a group is behind the end of the log, is the number to watch.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'topic', label: 'Topic: orders' },
      { id: 'billing', label: 'Consumer group: billing' },
      { id: 'analytics', label: 'Consumer group: analytics' },
    ],
    nodes: [
      { id: 'producer', label: 'Order Service', shape: 'ellipse', color: 'blue', group: null },
      { id: 'partitioner', label: 'Partitioner', shape: 'diamond', color: 'violet', group: null },
      { id: 'p0', label: 'Partition 0', shape: 'rectangle', color: 'yellow', group: 'topic' },
      { id: 'p1', label: 'Partition 1', shape: 'rectangle', color: 'yellow', group: 'topic' },
      { id: 'p2', label: 'Partition 2', shape: 'rectangle', color: 'yellow', group: 'topic' },
      { id: 'p3', label: 'Partitions 3 to 5', shape: 'rectangle', color: 'yellow', group: 'topic' },
      { id: 'ca', label: 'Consumer A', shape: 'rectangle', color: 'orange', group: 'billing' },
      { id: 'cb', label: 'Consumer B', shape: 'rectangle', color: 'orange', group: 'billing' },
      { id: 'cc', label: 'Consumer C', shape: 'rectangle', color: 'orange', group: 'billing' },
      { id: 'cd', label: 'Consumer D', shape: 'rectangle', color: 'orange', group: 'billing' },
      { id: 'an', label: 'Analytics Consumer', shape: 'rectangle', color: 'orange', group: 'analytics' },
      { id: 'offsets', label: 'Committed Offsets', shape: 'rectangle', color: 'green', group: null },
      { id: 'db', label: 'Invoices DB', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'producer', to: 'partitioner', label: 'key = order id', dashed: false },
      { from: 'partitioner', to: 'p0', label: 'murmur2 % n', dashed: false },
      { from: 'partitioner', to: 'p1', label: '', dashed: false },
      { from: 'partitioner', to: 'p2', label: '', dashed: false },
      { from: 'partitioner', to: 'p3', label: '', dashed: true },
      { from: 'p0', to: 'ca', label: 'assigned', dashed: false },
      { from: 'p1', to: 'cb', label: 'assigned', dashed: false },
      { from: 'p2', to: 'cc', label: 'assigned', dashed: false },
      { from: 'p3', to: 'cd', label: 'assigned', dashed: true },
      { from: 'p0', to: 'an', label: 'every partition', dashed: true },
      { from: 'ca', to: 'db', label: 'invoices', dashed: false },
      { from: 'cb', to: 'db', label: 'invoices', dashed: false },
      { from: 'cc', to: 'db', label: 'invoices', dashed: false },
      { from: 'ca', to: 'offsets', label: 'commit', dashed: true },
      { from: 'cb', to: 'offsets', label: 'commit', dashed: true },
      { from: 'an', to: 'offsets', label: 'its own offsets', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Kafka Basics: Topics, Partitions, Groups',
    summary:
      'Kafka stores events in topics. A topic is a log you only add to, split into partitions. The hash of each event\'s key picks its partition, which keeps each key\'s events in order. Consumers in a group share the partitions, one consumer per partition, and save their place as offsets. So many groups can read the same events, and any of them can go back and read again.',
    sections: [
      {
        heading: 'Overview',
        body: '- Event (or record): a key, a value and a time, like order-4101 → {"type":"paid"}.\n- Topic: a named stream of events, such as orders.\n- Partition: one of a topic\'s logs; a topic has one or more.\n- Offset: an event\'s position in its partition: 0, 1, 2 and so on.\n- Broker: a Kafka server. Partitions are spread over brokers (and copied between them; see Kafka: Event Streaming).\n- Producer: sends events in; the key decides the partition.\n- Consumer group: consumers that share a group name; each partition is read by one member.\n- Committed offset: where a group will carry on in each partition.\n- Retention: how long events stay, read or not (7 days by default).\n\nThe simulator sends 12 real events, places them with Kafka\'s own partitioner (murmur2), shares out the partitions the way Kafka\'s RangeAssignor does, and works out whether the group keeps up with 120 events a second.',
      },
      {
        heading: 'Requirements',
        body: 'What it must do:\n- Billing and analytics both get every order event.\n- Each order\'s events are handled in order.\n- Events can be read again after a bug fix.\n\nHow well it must do it:\n- Billing keeps up with 120 events a second at dinner time.\n- Adding consumers adds speed.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Peak: 120 events a second; one billing consumer handles 50.\n- Consumers needed: 120 ÷ 50 = 2.4, so 3, which means at least 3 partitions.\n- 3 partitions and 2 consumers: one consumer gets 2 partitions × 40 = 80 a second, so it falls behind by 30 a second: 18k events in 10 minutes.\n- 1 partition: only one consumer can work, and it falls behind by 70 a second: 42k in 10 minutes.\n- Storage: 120 events a second × 1 KB × 86,400 seconds ≈ 10 GB a day; 7 days ≈ 70 GB per copy.',
      },
      {
        heading: 'Step by step',
        body: '1. The Order Service sends each event with its order ID as the key.\n2. The Partitioner hashes the key (murmur2), divides by the number of partitions, and adds the event to the end of Partition 0, Partition 1, Partition 2 or Partitions 3 to 5.\n3. The billing group\'s members, Consumer A, Consumer B, Consumer C and Consumer D, are each given whole partitions.\n4. Each consumer reads its partitions in offset order and writes invoices to the Invoices DB.\n5. Each consumer saves how far it has got in Committed Offsets.\n6. The Analytics Consumer, in another group, reads the same partitions with offsets of its own.',
      },
      {
        heading: 'Components',
        body: '- Order Service: the producer of order events.\n- Partitioner: picks a partition from the hash of the key.\n- Partition 0: one log of the orders topic.\n- Partition 1: another log, read separately.\n- Partition 2: a third log.\n- Partitions 3 to 5: the extra logs when the topic has 6 partitions.\n- Consumer A: a member of the billing group.\n- Consumer B: a member of the billing group.\n- Consumer C: a member of the billing group.\n- Consumer D: a member of the billing group; it sits idle when there are fewer partitions than consumers.\n- Analytics Consumer: a member of a different group, which reads every event too.\n- Committed Offsets: each group\'s saved place in each partition, kept in Kafka\'s own __consumer_offsets topic.\n- Invoices DB: where billing writes its results, in a way that\'s safe to repeat.',
      },
      {
        heading: 'Key decisions',
        body: '- The key: whatever must stay in order together, such as an order ID or a user ID. With no key, events are spread evenly, but with no order per key.\n- How many partitions: at least as many as the most consumers you expect in one group. More partitions cost the brokers more work, and adding partitions later moves keys to different partitions.\n- One group per separate use: billing, analytics, search.\n- Commit after processing, and make processing safe to repeat (idempotent), because a restart reads again from the last commit.\n- Keep events long enough to replay what you might need: days for most topics. Log compaction keeps just the latest value for each key.\n- Kafka or a queue: a queue when each job goes to one worker; Kafka when several readers need the same events, order per key, or the ability to replay.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Lag, how far a group is behind, is the health signal: alert when it keeps growing.\n- Hot keys: one very busy key puts all its events in one partition, read by one consumer.\n- When a consumer joins or leaves, the group rebalances: partitions are handed out again, and reading pauses for a moment.\n- A consumer that crashes before committing reads its last batch again after the rebalance. That means duplicates, unless processing is safe to repeat.\n- Copies, acks and failures are covered in Kafka: Event Streaming and Kafka Reliability.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How is Kafka different from a message queue?\n- How does Kafka keep events in order, and across what?\n- Why can\'t a group use more consumers than partitions?\n- What is consumer lag, and how would you reduce it?\n- What happens to key order if you add partitions?\n- How would you process the last day of events again?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A topic, by hand (bash)',
        language: 'bash',
        source: `# A topic with 3 partitions
kafka-topics.sh --bootstrap-server localhost:9092 --create --topic orders --partitions 3

# Produce keyed events: key and value separated by ':'
kafka-console-producer.sh --bootstrap-server localhost:9092 --topic orders \\
  --property parse.key=true --property key.separator=:
# order-4101:{"type":"placed"}
# order-4101:{"type":"paid"}

# Where is each group, and how far behind?
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group billing
# TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# orders  0          1532            1540            8`,
      },
      {
        title: 'Producing with a key',
        language: 'javascript',
        source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'order-service', brokers: ['localhost:9092'] })
const producer = kafka.producer()
await producer.connect()

// Same key, same partition: this order's events stay in order.
export async function publish(orderId, type) {
  await producer.send({
    topic: 'orders',
    messages: [{ key: orderId, value: JSON.stringify({ orderId, type, at: new Date().toISOString() }) }],
  })
}`,
        versions: [
          {
            language: 'java',
            source: `import java.time.Instant;
import java.util.Properties;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;

public class OrderPublisher {
  private final KafkaProducer<String, String> producer;

  public OrderPublisher() {
    Properties p = new Properties();
    p.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
    p.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    p.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    producer = new KafkaProducer<>(p);
  }

  // Same key, same partition: this order's events stay in order.
  public void publish(String orderId, String type) {
    String value = String.format("{\\"orderId\\":\\"%s\\",\\"type\\":\\"%s\\",\\"at\\":\\"%s\\"}", orderId, type, Instant.now());
    producer.send(new ProducerRecord<>("orders", orderId, value));
  }
}`,
          },
          {
            language: 'typescript',
            source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'order-service', brokers: ['localhost:9092'] })
const producer = kafka.producer()
await producer.connect()

// Same key, same partition: this order's events stay in order.
export async function publish(orderId: string, type: 'placed' | 'paid' | 'delivered') {
  await producer.send({
    topic: 'orders',
    messages: [{ key: orderId, value: JSON.stringify({ orderId, type, at: new Date().toISOString() }) }],
  })
}`,
          },
        ],
      },
      {
        title: 'A consumer in a group',
        language: 'javascript',
        source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'billing', brokers: ['localhost:9092'] })
// Every copy started with groupId 'billing' shares the partitions.
const consumer = kafka.consumer({ groupId: 'billing' })

await consumer.connect()
await consumer.subscribe({ topic: 'orders', fromBeginning: true })
await consumer.run({
  // Offsets are committed after eachMessage returns, so a crash re-reads, never skips.
  eachMessage: async ({ partition, message }) => {
    const event = JSON.parse(message.value.toString())
    await upsertInvoice(event) // idempotent: keyed by order id
    console.log(\`P\${partition}@\${message.offset} \${event.orderId} \${event.type}\`)
  },
})`,
        versions: [
          {
            language: 'java',
            source: `import java.time.Duration;
import java.util.List;
import java.util.Properties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;

public class BillingWorker {
  public static void main(String[] args) throws Exception {
    Properties p = new Properties();
    p.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
    p.put(ConsumerConfig.GROUP_ID_CONFIG, "billing"); // every copy with this group id shares the partitions
    p.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest"); // a new group starts at the beginning
    p.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
    p.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
    p.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
    ObjectMapper json = new ObjectMapper();

    try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(p)) {
      consumer.subscribe(List.of("orders"));
      while (true) {
        for (ConsumerRecord<String, String> m : consumer.poll(Duration.ofMillis(500))) {
          JsonNode event = json.readTree(m.value());
          upsertInvoice(event); // idempotent: keyed by order id
          System.out.printf("P%d@%d %s %s%n", m.partition(), m.offset(),
              event.get("orderId").asText(), event.get("type").asText());
        }
        consumer.commitSync(); // commit after processing, so a crash re-reads, never skips
      }
    }
  }
}`,
          },
          {
            language: 'typescript',
            source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'billing', brokers: ['localhost:9092'] })
// Every copy started with groupId 'billing' shares the partitions.
const consumer = kafka.consumer({ groupId: 'billing' })

await consumer.connect()
await consumer.subscribe({ topic: 'orders', fromBeginning: true })
await consumer.run({
  // Offsets are committed after eachMessage returns, so a crash re-reads, never skips.
  eachMessage: async ({ partition, message }) => {
    const event = JSON.parse(message.value!.toString())
    await upsertInvoice(event) // idempotent: keyed by order id
    console.log(\`P\${partition}@\${message.offset} \${event.orderId} \${event.type}\`)
  },
})

declare function upsertInvoice(e: unknown): Promise<void>`,
          },
        ],
      },
      {
        title: 'Replaying after a fix (bash)',
        language: 'bash',
        source: `# Stop the billing consumers first: offsets can only be reset for an inactive group.
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --group billing \\
  --topic orders --reset-offsets --to-datetime 2026-11-12T00:00:00.000 --execute

# Start them again: they re-read everything since midnight.`,
      },
    ],
    related: ['Kafka: Event Streaming', 'Kafka Reliability', 'Idempotent payments', 'Redis Basics', 'Notification system'],
  },
  simulator,
}
