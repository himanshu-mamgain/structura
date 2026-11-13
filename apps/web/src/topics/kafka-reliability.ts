import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator plays a failure against a producer configuration and a topic
// configuration, and works out what Kafka's rules say happens: which acknowledged
// messages are lost, how many duplicates appear, and how long writes fail. The rules
// are Kafka's: acks=all waits for the in-sync replicas (ISR), min.insync.replicas
// only applies to acks=all, a leader is elected from the ISR unless unclean election
// is on, idempotent producers drop retried duplicates by sequence number, and
// transactions hide aborted writes from read_committed consumers.

const RATE = 1000 // messages a second to the payments topic
const REPLICATION_LAG_MS = 10 // a healthy follower is a few milliseconds behind
const BEHIND_S = 30 // in the lagging case, followers stopped keeping up this long ago
const LEADER_ELECTION_S = 9 // KRaft: broker.session.timeout.ms 9 s, then a new leader
const B1_BACK_MIN = 5 // the dead broker restarts after this long
const IN_FLIGHT = 200 // messages in the batch whose acknowledgement was lost
const BATCH = 500 // consumer batch size
const CRASH_AFTER = 300 // the consumer crashed after producing this many of the batch
const SESSION_TIMEOUT_S = 45 // session.timeout.ms default since Kafka 3.0

type Producer = 'acks1' | 'idempotent' | 'transactional'
type TopicCfg = 'min1' | 'min2' | 'unclean'
type Failure = 'leader' | 'lagging' | 'retry' | 'consumer'

const PRODUCER: Record<string, Producer> = {
  'acks=1, no idempotence': 'acks1',
  'acks=all, idempotent (default)': 'idempotent',
  'acks=all + transactions': 'transactional',
}
const TOPIC: Record<string, TopicCfg> = {
  'RF 3, min.insync.replicas=1': 'min1',
  'RF 3, min.insync.replicas=2': 'min2',
  'RF 3, min.insync=1, unclean election on': 'unclean',
}
const FAILURE: Record<string, Failure> = {
  'Leader dies, followers in sync': 'leader',
  'Leader dies while followers lag': 'lagging',
  'Ack lost, producer retries': 'retry',
  'Consumer crashes mid-batch': 'consumer',
}

const PRODUCER_CONFIG: Record<Producer, string> = {
  acks1: 'acks=1\nenable.idempotence=false\nretries=2147483647',
  idempotent: 'acks=all\nenable.idempotence=true   (default since Kafka 3.0)',
  transactional: 'acks=all\nenable.idempotence=true\ntransactional.id=invoicer-1',
}
const TOPIC_CONFIG: Record<TopicCfg, string> = {
  min1: 'replication.factor=3\nmin.insync.replicas=1\nunclean.leader.election.enable=false',
  min2: 'replication.factor=3\nmin.insync.replicas=2\nunclean.leader.election.enable=false',
  unclean: 'replication.factor=3\nmin.insync.replicas=1\nunclean.leader.election.enable=true',
}

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const dur = (s: number) => (s < 60 ? `${n(s)} s` : `${n(s / 60)} min`)

interface Outcome {
  steps: Trace['steps']
  lost: number
  duplicates: number
  downS: number
  lesson: string
}

function leaderDies(p: Producer): Outcome {
  const unreplicated = (RATE * REPLICATION_LAG_MS) / 1000
  const lost = p === 'acks1' ? unreplicated : 0
  return {
    steps: [
      {
        text: `Broker 1, leader of the partition, loses power. Brokers 2 and 3 are in the ISR (the in-sync replicas), about ${REPLICATION_LAG_MS} ms behind. ${p === 'acks1' ? `With acks=1, Broker 1 confirmed each write as soon as it had it, so the last ${REPLICATION_LAG_MS} ms of confirmed messages exist only on Broker 1.` : 'With acks=all, Broker 1 confirmed a write only once every ISR member had it, so nothing confirmed is missing from Brokers 2 and 3.'}`,
        nodes: ['Broker 1 (Leader)', 'Broker 2', 'Broker 3'],
        data: `ISR before: [1, 2, 3]\nconfirmed but only on Broker 1: ${n(lost)} messages${p === 'acks1' ? ` (${REPLICATION_LAG_MS} ms × ${n(RATE)}/s)` : ''}`,
      },
      {
        text: `The controller notices Broker 1 is gone after about ${LEADER_ELECTION_S} s and makes Broker 2, an ISR member, the new leader. Producers get NOT_LEADER errors, refresh their metadata and retry against Broker 2.`,
        nodes: ['Controller', 'Broker 2', 'Payments Service'],
        data: `controller: broker 1 session expired (${LEADER_ELECTION_S} s)\npartition payments-0: leader 1 → 2, ISR [2, 3]\nproducer: NOT_LEADER_OR_FOLLOWER → refresh metadata → retry`,
      },
    ],
    lost,
    duplicates: 0,
    downS: LEADER_ELECTION_S,
    lesson:
      p === 'acks1'
        ? 'acks=1 confirms before the followers have the message, so a leader crash loses what they hadn\'t fetched. acks=all closes that gap.'
        : 'With acks=all and a healthy ISR, a leader crash costs a few seconds of retries and no confirmed messages.',
  }
}

function lagging(p: Producer, t: TopicCfg): Outcome {
  const window = BEHIND_S * RATE
  // min.insync.replicas only applies to acks=all. With the ISR down to 1, acks=all writes
  // need at least that many in-sync copies.
  const refused = p !== 'acks1' && t === 'min2'
  const onlyOnLeader = refused ? 0 : window
  const steps: Trace['steps'] = [
    {
      text: `Brokers 2 and 3 have slow disks and stop keeping up. After replica.lag.time.max.ms (30 s) the leader removes them from the ISR, which shrinks to Broker 1 alone. ${refused ? `Now min.insync.replicas=2 can't be met, so the leader refuses acks=all writes with NOT_ENOUGH_REPLICAS. For ${BEHIND_S} s the payments service gets errors and must retry or hold the payments.` : p === 'acks1' ? `With acks=1 (min.insync.replicas is ignored for acks=1) Broker 1 keeps confirming writes on its own: ${BEHIND_S} s of them, ${n(window)} messages, exist only on Broker 1.` : `With min.insync.replicas=1, a single in-sync copy is enough, so acks=all keeps confirming writes with Broker 1 alone: ${n(window)} messages in ${BEHIND_S} s exist only there.`}`,
      nodes: ['Broker 1 (Leader)', 'Broker 2', 'Broker 3', 'Payments Service'],
      data: `ISR: [1, 2, 3] → [1]\n${refused ? `produce → error NOT_ENOUGH_REPLICAS (min.insync.replicas=2, ISR size 1)\nconfirmed in these ${BEHIND_S} s: 0` : `produce → OK (acks=${p === 'acks1' ? '1' : 'all'}, ISR [1])\nconfirmed only on Broker 1: ${n(window)}`}`,
    },
    {
      text: 'Then Broker 1 dies. Every remaining replica is out of sync.',
      nodes: ['Broker 1 (Leader)', 'Controller'],
      data: 'ISR: [1], and broker 1 is down\nBrokers 2 and 3: alive, 30 s behind',
    },
  ]
  if (t !== 'unclean') {
    steps.push({
      text: `Unclean leader election is off, so the controller won't make an out-of-sync broker the leader. The partition has no leader: nobody can write or read it until Broker 1 comes back, ${B1_BACK_MIN} minutes later, with its data intact.`,
      nodes: ['Controller', 'Broker 2', 'Broker 1 (Leader)'],
      data: `partition payments-0: leader none (OfflinePartitionsCount 1)\n+${B1_BACK_MIN} min: broker 1 back → leader 1, followers catch up\nconfirmed messages lost: 0`,
    })
    return {
      steps,
      lost: 0,
      duplicates: 0,
      downS: (refused ? BEHIND_S : 0) + B1_BACK_MIN * 60,
      lesson: refused
        ? 'min.insync.replicas=2 refused writes it couldn\'t protect, and with unclean election off nothing confirmed was lost. The price is availability: errors while the ISR was short, and an offline partition until Broker 1 returned.'
        : 'Unclean election off kept the data: the partition waited for the only broker that had it. Without that, those confirmed messages would be gone.',
    }
  }
  steps.push({
    text: `Unclean leader election is on, so the controller makes Broker 2 the leader at once, even though it is ${BEHIND_S} s behind. When Broker 1 returns, it truncates its log to match the new leader: whatever only it had is deleted.`,
    nodes: ['Controller', 'Broker 2', 'Broker 1 (Leader)'],
    data: `partition payments-0: leader 1 → 2 (unclean)\nBroker 1 rejoins: truncate log to Broker 2's end offset\nconfirmed messages lost: ${n(onlyOnLeader)}`,
  })
  return {
    steps,
    lost: onlyOnLeader,
    duplicates: 0,
    downS: (refused ? BEHIND_S : 0) + LEADER_ELECTION_S,
    lesson: refused
      ? 'Unclean election would have dropped whatever only Broker 1 had, but min.insync.replicas=2 had already refused those writes, so this time nothing confirmed was lost.'
      : `Unclean election chose availability over data: back in seconds, with ${n(onlyOnLeader)} confirmed payments gone for good.`,
  }
}

function retry(p: Producer): Outcome {
  const dupes = p === 'acks1' ? IN_FLIGHT : 0
  return {
    steps: [
      {
        text: `The leader writes a batch of ${IN_FLIGHT} payment events, but the network drops its acknowledgement. The producer can't tell whether the batch arrived, so after request.timeout.ms it sends the batch again.`,
        nodes: ['Payments Service', 'Broker 1 (Leader)'],
        data: `batch: ${IN_FLIGHT} messages, offsets 88,200 to ${n(88200 + IN_FLIGHT - 1)} written\nack: lost on the way back\nproducer: timeout → retry the same batch`,
      },
      {
        text:
          p === 'acks1'
            ? `Without idempotence the broker can't recognise the retry and appends the batch again: ${IN_FLIGHT} duplicate payments in the log, and the same order can now be charged twice by anyone downstream who doesn't deduplicate.`
            : `The idempotent producer has a producer id and numbers every batch per partition. The broker sees sequence numbers it has already written, keeps the first copy and acknowledges the retry: no duplicates.`,
        nodes: ['Broker 1 (Leader)', 'Payments Topic'],
        data:
          p === 'acks1'
            ? `offsets ${n(88200 + IN_FLIGHT)} to ${n(88200 + 2 * IN_FLIGHT - 1)}: the same ${IN_FLIGHT} payments again\nduplicates: ${IN_FLIGHT}`
            : `producerId 4021, epoch 0, partition payments-0\nbatch sequence 1,442 already written → DUPLICATE_SEQUENCE, ack with original offsets\nduplicates: 0`,
      },
    ],
    lost: 0,
    duplicates: dupes,
    downS: 0,
    lesson: p === 'acks1' ? 'Retries without idempotence turn a lost acknowledgement into duplicates. enable.idempotence=true (the default since Kafka 3.0) makes retries safe within a partition.' : 'Idempotence makes producer retries safe: each message is written once per partition, however many times it is sent.',
  }
}

function consumerCrash(p: Producer): Outcome {
  const exactlyOnce = p === 'transactional'
  const lagBuilt = SESSION_TIMEOUT_S * RATE
  return {
    steps: [
      {
        text: `The invoicer reads payments and, for each, produces an invoice event to the invoices topic, then commits its offsets. It reads a batch of ${BATCH}, produces ${CRASH_AFTER} invoices and crashes before committing.${exactlyOnce ? ' It was doing all of that inside a transaction: the invoices and the offset commit succeed together or not at all.' : ''}`,
        nodes: ['Payments Topic', 'Invoicer', 'Invoices Topic'],
        data: `${exactlyOnce ? 'beginTransaction()\n' : ''}read payments-0 offsets 90,000 to 90,499\nproduced ${CRASH_AFTER} invoices\ncrash before ${exactlyOnce ? 'sendOffsetsToTransaction + commitTransaction' : 'commitSync()'}\ncommitted offset still: 90,000`,
      },
      {
        text: `The group coordinator stops hearing from the invoicer and, after session.timeout.ms (${SESSION_TIMEOUT_S} s), rebalances: another member takes the partition. Meanwhile ${n(lagBuilt)} payments queue up unread.`,
        nodes: ['Group Coordinator', 'Invoicer', 'Standby Invoicer'],
        data: `no heartbeat for ${SESSION_TIMEOUT_S} s → member removed → rebalance\npayments-0 → standby invoicer, starting at committed offset 90,000\nlag built up: ${SESSION_TIMEOUT_S} s × ${n(RATE)}/s = ${n(lagBuilt)}`,
      },
      {
        text: exactlyOnce
          ? `The new member's producer, with the same transactional.id, fences the dead one and aborts its open transaction. Consumers of invoices use isolation.level=read_committed, so they never saw the ${CRASH_AFTER} aborted invoices. The batch is processed again, and committed once.`
          : `The new member starts from offset 90,000 and processes the whole batch again. The ${CRASH_AFTER} invoices produced before the crash are produced a second time: at-least-once delivery means duplicates.`,
        nodes: ['Standby Invoicer', 'Invoices Topic', 'Ledger Consumer'],
        data: exactlyOnce
          ? `initTransactions(): epoch 1 fences epoch 0, aborts its transaction\nread_committed consumers: skip the ${CRASH_AFTER} aborted records\nvisible invoices for the batch: ${BATCH}, each once`
          : `re-produced: ${BATCH} invoices, ${CRASH_AFTER} of them duplicates\nduplicates visible to the ledger: ${CRASH_AFTER}${p === 'idempotent' ? '\n(idempotence doesn\'t help: it is a new producer session sending new messages)' : ''}`,
      },
    ],
    lost: 0,
    duplicates: exactlyOnce ? 0 : CRASH_AFTER,
    downS: SESSION_TIMEOUT_S,
    lesson: exactlyOnce
      ? 'Transactions make read-process-write exactly-once inside Kafka: outputs and the offset commit land together, and read_committed readers never see a half-done batch. Effects outside Kafka (an email, a card charge) still need their own idempotency.'
      : `Commit after processing gives at-least-once: a crash replays the batch.${p === 'idempotent' ? ' The idempotent producer only removes duplicates from retries within one session, not from reprocessing.' : ''} Use transactions, or make the consumer of the duplicates idempotent.`,
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'producer', label: 'Producer', options: Object.keys(PRODUCER) },
    { id: 'topic', label: 'Topic', options: Object.keys(TOPIC) },
    { id: 'failure', label: 'Failure', options: Object.keys(FAILURE) },
  ],
  defaults: { producer: 'acks=all, idempotent (default)', topic: 'RF 3, min.insync.replicas=1', failure: 'Leader dies while followers lag' },
  run({ producer, topic, failure }) {
    const p = PRODUCER[producer] ?? 'idempotent'
    const t = TOPIC[topic] ?? 'min2'
    const f = FAILURE[failure] ?? 'leader'
    const out = f === 'leader' ? leaderDies(p) : f === 'lagging' ? lagging(p, t) : f === 'retry' ? retry(p) : consumerCrash(p)
    const steps: Trace['steps'] = [
      {
        text: `The payments service writes about ${n(RATE)} payment events a second to the payments topic. The topic keeps 3 copies of each partition (replication factor 3) on Brokers 1, 2 and 3; Broker 1 leads this partition and the others follow, fetching what it writes.`,
        nodes: ['Payments Service', 'Broker 1 (Leader)', 'Broker 2', 'Broker 3'],
        data: `producer:\n${PRODUCER_CONFIG[p]}\n\ntopic payments:\n${TOPIC_CONFIG[t]}`,
      },
      ...out.steps,
      {
        text: `Result: ${out.lost ? `${n(out.lost)} confirmed messages lost` : 'no confirmed messages lost'}, ${out.duplicates ? `${n(out.duplicates)} duplicates` : 'no duplicates'}${out.downS ? `, and about ${dur(out.downS)} of failed or delayed processing` : ''}. ${out.lesson}`,
        nodes: ['Payments Service', 'Payments Topic', ...(f === 'consumer' ? ['Ledger Consumer'] : ['Controller'])],
        data: `confirmed but lost: ${n(out.lost)}\nduplicates: ${n(out.duplicates)}\nunavailable or delayed: ${dur(out.downS)}`,
      },
    ]
    return { input: `${producer} · ${topic} · ${failure.toLowerCase()} → ${n(out.lost)} lost, ${n(out.duplicates)} duplicates`, steps }
  },
}

const run = (producer: string, topic: string, failure: string) => ({ producer, topic, failure })

export const kafkaReliability: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'kafka-reliability',
  title: 'Kafka Reliability: Durability, Exactly-Once',
  blurb: 'ISR, acks and min.insync.replicas, unclean leader election, idempotent producers, transactions and rebalances',
  guides: ['can-kafka-lose-messages', 'ref-apache-kafka-docs', 'why-is-kafka-fast', 'the-ultimate-kafka-101-you-cannot-miss'],
  story: {
    title: 'The payments that Kafka "lost"',
    dek: 'A payments team trusted Kafka to never lose a message. Over one quarter it lost some, duplicated others and stalled for minutes, each time exactly as its configuration said it would.',
    chapters: [
      {
        heading: 'Replicas and the ISR',
        body: `Every partition of the payments topic had 3 copies (**replication factor 3**): a **leader** on one broker taking writes and two **followers** fetching from it. The followers that are caught up form the **ISR**, the in-sync replicas. Only an ISR member can be promoted if the leader dies.

The producer's \`acks\` setting decides when a write counts as done. \`acks=1\`: when the leader has it. \`acks=all\`: when every ISR member has it. The team had inherited \`acks=1\`, and one night a leader's power cut took the last few milliseconds of confirmed payments with it.`,
        replay: { label: 'Leader dies with acks=1', values: run('acks=1, no idempotence', 'RF 3, min.insync.replicas=1', 'Leader dies, followers in sync') },
      },
      {
        heading: 'acks=all is only as good as the ISR',
        body: `They switched to \`acks=all\`. Weeks later two followers' disks slowed down; after 30 seconds Kafka dropped them from the ISR, leaving the leader alone. \`acks=all\` now meant "all of one": writes kept being confirmed with a single copy. Then the leader died, and the partition was offline for five minutes until it came back. Had its disk died with it, 30,000 confirmed payments would have gone too.

The fix is **min.insync.replicas**: with \`acks=all\`, a write is refused unless at least that many replicas are in sync. With replication factor 3, the usual setting is 2. The producer got \`NOT_ENOUGH_REPLICAS\` errors instead of confirmations it couldn't trust.`,
        replay: { label: 'The ISR shrinks to one', values: run('acks=all, idempotent (default)', 'RF 3, min.insync.replicas=1', 'Leader dies while followers lag') },
      },
      {
        heading: 'Available or correct',
        body: `With every in-sync replica dead, Kafka has two choices. With \`unclean.leader.election.enable=false\` (the default) it waits for an in-sync replica to return: the partition is offline, and nothing confirmed is lost. With \`true\`, it promotes a lagging follower at once, and whatever only the old leader had is deleted when it comes back.

That's the CAP trade-off as a single flag. For payments the team kept it off; for a metrics topic, they turned it on.`,
        replay: { label: 'Unclean election', values: run('acks=all, idempotent (default)', 'RF 3, min.insync=1, unclean election on', 'Leader dies while followers lag') },
      },
      {
        heading: 'The retry that charged twice',
        body: `A network blip dropped a broker's acknowledgement. The producer, not knowing the batch had landed, sent it again, and the log had 200 payments twice.

An **idempotent producer** fixes that: it gets a producer id and numbers its batches, and the broker discards a batch it has already written. It needs \`acks=all\`, and since Kafka 3.0 it's on by default. The team had overridden the default years ago.`,
        replay: { label: 'Replay the retry', values: run('acks=1, no idempotence', 'RF 3, min.insync.replicas=2', 'Ack lost, producer retries') },
      },
      {
        heading: 'Exactly once, inside Kafka',
        body: `The invoicer read payments, produced invoices and committed its offsets. When it crashed between producing and committing, the group **rebalanced**: after \`session.timeout.ms\` (45 s by default) another member took the partition, started from the last committed offset and produced 300 invoices again. Idempotence didn't help, because these were new sends, not retries.

**Transactions** did. With a \`transactional.id\`, the invoices and the offset commit go in one transaction; a crash aborts it, the new instance fences the old one, and consumers reading with \`isolation.level=read_committed\` never see the aborted invoices.

> Exactly-once in Kafka means within Kafka. An email or a card charge still needs its own idempotency key.`,
        replay: { label: 'Crash with transactions', values: run('acks=all + transactions', 'RF 3, min.insync.replicas=2', 'Consumer crashes mid-batch') },
      },
    ],
  },
  takeaways: [
    'The ISR is the set of replicas caught up with the leader; only they can take over safely.',
    'acks=all waits for the whole ISR, so pair it with min.insync.replicas=2 on a replication factor of 3, or "all" can mean one.',
    'Unclean leader election trades confirmed data for availability; keep it off for data you can\'t lose.',
    'Idempotent producers (the default since Kafka 3.0) make retries safe; they need acks=all.',
    'Transactions make read-process-write exactly-once within Kafka, with read_committed consumers.',
    'Committing offsets after processing gives at-least-once delivery, so effects outside Kafka must be idempotent.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'cluster', label: 'Kafka cluster' },
      { id: 'invoicing', label: 'Consumer group: invoicer' },
    ],
    nodes: [
      { id: 'producer', label: 'Payments Service', shape: 'ellipse', color: 'blue', group: null },
      { id: 'b1', label: 'Broker 1 (Leader)', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'b2', label: 'Broker 2', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'b3', label: 'Broker 3', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'controller', label: 'Controller', shape: 'diamond', color: 'violet', group: 'cluster' },
      { id: 'payments', label: 'Payments Topic', shape: 'rectangle', color: 'yellow', group: 'cluster' },
      { id: 'invoices', label: 'Invoices Topic', shape: 'rectangle', color: 'yellow', group: 'cluster' },
      { id: 'coordinator', label: 'Group Coordinator', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'invoicer', label: 'Invoicer', shape: 'rectangle', color: 'orange', group: 'invoicing' },
      { id: 'standby', label: 'Standby Invoicer', shape: 'rectangle', color: 'orange', group: 'invoicing' },
      { id: 'ledger', label: 'Ledger Consumer', shape: 'rectangle', color: 'orange', group: null },
    ],
    edges: [
      { from: 'producer', to: 'b1', label: 'produce (acks)', dashed: false },
      { from: 'b1', to: 'b2', label: 'follower fetch', dashed: true },
      { from: 'b1', to: 'b3', label: 'follower fetch', dashed: true },
      { from: 'controller', to: 'b2', label: 'elect leader', dashed: true },
      { from: 'b1', to: 'payments', label: 'leader of', dashed: false },
      { from: 'payments', to: 'invoicer', label: 'consume', dashed: false },
      { from: 'invoicer', to: 'invoices', label: 'produce in a transaction', dashed: false },
      { from: 'invoicer', to: 'coordinator', label: 'heartbeats, commits', dashed: true },
      { from: 'coordinator', to: 'standby', label: 'rebalance', dashed: true },
      { from: 'standby', to: 'invoices', label: 'produce', dashed: false },
      { from: 'invoices', to: 'ledger', label: 'read_committed', dashed: false },
    ],
  },
  database: null,
  explanation: {
    title: 'Kafka Reliability: Durability, Exactly-Once',
    summary:
      'Kafka\'s guarantees come from configuration. Replication with acks=all and min.insync.replicas decides which confirmed messages survive a broker failure; unclean leader election chooses between availability and data; idempotent producers remove duplicates from retries; and transactions make read-process-write exactly-once within Kafka.',
    sections: [
      {
        heading: 'Overview',
        body: '- Replication factor: copies of each partition, one leader and the rest followers.\n- ISR (in-sync replicas): the leader plus followers caught up within replica.lag.time.max.ms (30 s).\n- acks: 0 (don\'t wait), 1 (the leader has it), all (every ISR member has it).\n- min.insync.replicas: the fewest in-sync copies an acks=all write needs, or it is refused.\n- Unclean leader election: whether an out-of-sync replica may become leader when no ISR member is left.\n- Idempotent producer: producer id plus per-partition sequence numbers, so the broker drops duplicated batches.\n- Transactions: atomic writes across partitions plus the consumer offset commit; read_committed consumers skip aborted data.\n- Rebalance: when group membership changes, partitions are reassigned.\n\nThe simulator applies these rules to a payments topic at 1,000 messages a second and counts confirmed messages lost, duplicates and downtime.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Every confirmed payment event survives a broker failure.\n- Each payment produces exactly one invoice.\n\nNon-functional:\n- Survive one broker failure without losing confirmed writes.\n- Recover from a consumer crash within a minute.\n- Keep producing during routine broker restarts.',
      },
      {
        heading: 'Capacity estimates',
        body: '- acks=1 and a leader crash: about 10 ms of unreplicated writes × 1,000/s ≈ 10 messages lost.\n- ISR shrunk to the leader for 30 s with min.insync.replicas=1: 30 × 1,000 = 30,000 confirmed messages on one copy.\n- Leader election after a broker dies: about 9 s (KRaft broker.session.timeout.ms).\n- A consumer crash with session.timeout.ms 45 s: 45 × 1,000 = 45,000 messages of lag before another member takes over.\n- Replication factor 3 triples storage and inter-broker traffic.',
      },
      {
        heading: 'Step by step',
        body: '1. The Payments Service produces to Broker 1 (Leader) for its partition of the Payments Topic.\n2. Broker 2 and Broker 3 fetch from the leader; caught-up ones form the ISR.\n3. With acks=all the leader confirms only when the ISR has the write, and refuses it if the ISR is smaller than min.insync.replicas.\n4. If the leader dies, the Controller elects a new leader from the ISR (or, if allowed, an out-of-sync replica).\n5. The Invoicer consumes payments and produces to the Invoices Topic, committing offsets through the Group Coordinator.\n6. If the Invoicer dies, the Group Coordinator rebalances its partitions to the Standby Invoicer, which resumes from the last commit; the Ledger Consumer reads invoices with read_committed.',
      },
      {
        heading: 'Components',
        body: '- Payments Service: the producer, with its acks and idempotence settings.\n- Broker 1 (Leader): holds the leader replica and takes all writes for the partition.\n- Broker 2: a follower replica.\n- Broker 3: another follower replica.\n- Controller: tracks brokers and elects partition leaders (KRaft quorum).\n- Payments Topic: the replicated topic of payment events.\n- Invoices Topic: the output topic, written transactionally.\n- Group Coordinator: the broker that manages a consumer group\'s membership and offsets.\n- Invoicer: a consumer that reads payments and produces invoices.\n- Standby Invoicer: another member of the group that takes over after a rebalance.\n- Ledger Consumer: reads invoices with isolation.level=read_committed.',
      },
      {
        heading: 'Key decisions',
        body: '- For data you can\'t lose: replication.factor=3, min.insync.replicas=2, acks=all, unclean.leader.election.enable=false.\n- For throughput-first data (metrics, logs): acks=1 or unclean election may be acceptable.\n- Keep enable.idempotence=true (the default); don\'t override it.\n- Use transactions for consume-transform-produce pipelines; set isolation.level=read_committed on readers.\n- For side effects outside Kafka, make the consumer idempotent with a key (see Idempotent Payments).\n- Rebalance cost: cooperative-sticky assignment and static membership (group.instance.id) avoid stop-the-world rebalances on restarts.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Spread replicas across racks or Availability Zones (broker.rack) so one zone failure leaves an ISR.\n- Watch UnderReplicatedPartitions, the ISR shrink rate and OfflinePartitionsCount.\n- min.insync.replicas=2 on RF 3 tolerates one broker down for writes; two down stops writes for affected partitions.\n- Transactions add latency (commit markers) and need transaction.timeout.ms tuned for long batches.\n- Consumers that take longer than max.poll.interval.ms between polls are kicked out, causing rebalances and reprocessing.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the ISR, and when does a replica leave it?\n- Why is acks=all not enough on its own?\n- What does unclean leader election trade away?\n- How does the idempotent producer detect duplicates?\n- What does "exactly-once" mean in Kafka, and where does it stop?\n- What happens during a consumer group rebalance?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A topic that keeps what it confirms (bash)',
        language: 'bash',
        source: `kafka-topics.sh --bootstrap-server localhost:9092 --create --topic payments \\
  --partitions 6 --replication-factor 3 \\
  --config min.insync.replicas=2 \\
  --config unclean.leader.election.enable=false

# Which replicas are in sync right now?
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic payments
# Topic: payments  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3`,
      },
      {
        title: 'A safe producer (TypeScript)',
        language: 'typescript',
        source: `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'payments', brokers: ['b1:9092', 'b2:9092', 'b3:9092'] })

// Idempotent: retries can't create duplicates. It needs acks=-1 (all); one request
// in flight per connection keeps the order of retried batches simple.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 })
await producer.connect()

export async function recordPayment(p: { id: string; orderId: string; paise: number }) {
  await producer.send({ topic: 'payments', acks: -1, messages: [{ key: p.orderId, value: JSON.stringify(p) }] })
}`,
      },
      {
        title: 'Exactly-once read-process-write (Java)',
        language: 'java',
        source: `// The consumer uses isolation.level=read_committed and enable.auto.commit=false.
producer.initTransactions(); // fences any older producer with this transactional.id
while (true) {
  ConsumerRecords<String, String> batch = consumer.poll(Duration.ofMillis(500));
  if (batch.isEmpty()) continue;
  producer.beginTransaction();
  try {
    for (ConsumerRecord<String, String> r : batch) {
      producer.send(new ProducerRecord<>("invoices", r.key(), toInvoice(r.value())));
    }
    // The offsets commit inside the same transaction as the invoices.
    producer.sendOffsetsToTransaction(nextOffsets(batch), consumer.groupMetadata());
    producer.commitTransaction();
  } catch (KafkaException e) {
    producer.abortTransaction(); // read_committed consumers never see these
    rewindToCommitted(consumer);
  }
}`,
      },
      {
        title: 'Consumer settings for calm rebalances (bash)',
        language: 'bash',
        source: `cat > invoicer.properties <<'EOF'
group.id=invoicer
isolation.level=read_committed
enable.auto.commit=false
# Survive a quick restart without a rebalance:
group.instance.id=invoicer-1
session.timeout.ms=45000
# Rebalance incrementally instead of stopping every member:
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
max.poll.interval.ms=300000
EOF`,
      },
    ],
    related: ['Kafka Basics', 'Kafka: Event Streaming', 'Idempotent payments', 'Leader election', 'Redis persistence and replication'],
  },
  simulator,
}
