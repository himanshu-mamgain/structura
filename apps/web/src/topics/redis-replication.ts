import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator follows one food-delivery app's carts and sessions through Redis
// replication, Sentinel and Redis Cluster. It works out real numbers from the model
// below: how much a cut-off replica missed and whether the backlog still holds it,
// how long a failover takes and how many acknowledged writes it loses, and which
// hash slot (CRC16 of the key, or of its {hash tag}, mod 16384) owns a key.

const WRITES = 6000 // writes a second from four App Servers
const BYTES = 100 // one write command in the replication stream, on average
const STREAM_KB = (WRITES * BYTES) / 1000 // 600 KB/s
const DATA_GB = 6
const RDB_GB = 2.4 // the snapshot a full sync sends: 6 GB compresses to about 40%
const NET_MB_S = 125 // 1 Gbit/s between machines
const LOAD_MB_S = 100 // a replica reading and decoding the RDB
const LAG_MS = 20 // how far a healthy replica runs behind
const CUT = 30 // seconds a replica, or the primary, is cut off
const DOWN_AFTER = 5 // sentinel down-after-milliseconds, and cluster-node-timeout
const SENTINEL_FAILOVER = 6 // seconds of failed writes: 5 s to notice, then agree, elect, promote
const CLUSTER_FAILOVER = 6.5 // 5 s timeout, FAIL agreed, the replica's 0.5-1 s delay, the vote
const MAX_LAG = 10 // min-replicas-max-lag
const STRANDED = WRITES / 4 // App Server A is cut off with the old primary
const SHARDS = 3
const SLOTS = 16384
const OUTPUT_LIMIT_MB = 256 // client-output-buffer-limit replica 256mb 64mb 60

const SETUP = { sentinel: 'Sentinel: 1 primary, 2 replicas', cluster: 'Cluster: 3 shards, 1 replica each' }
const EVENT = {
  cut: `A replica is cut off for ${CUT} s`,
  crash: 'The primary crashes',
  split: `A ${CUT} s network split`,
  read: 'A client reads a key',
  move: 'A slot moves to another shard',
}
const BACKLOG = { small: '1 MB (the default)', big: '64 MB' }
const GUARD = { off: 'Off (the default)', on: 'min-replicas-to-write 1' }

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const mb = (x: number) => (x < 10 && !Number.isInteger(x) ? x.toFixed(1) : n(x))
const secs = (x: number) => `${Number.isInteger(x) ? x : x.toFixed(1)} s`
/** Short times read better in milliseconds. */
const quick = (x: number) => (x < 1 ? `${n(x * 1000)} ms` : secs(Math.round(x * 10) / 10))

/** CRC16/XMODEM, the checksum Redis Cluster hashes keys with. */
function crc16(text: string): number {
  let crc = 0
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

/** The part of a key that is hashed: what's inside the first {...}, if it isn't empty. */
function hashedPart(key: string): string {
  const open = key.indexOf('{')
  if (open < 0) return key
  const close = key.indexOf('}', open + 1)
  return close > open + 1 ? key.slice(open + 1, close) : key
}

const slotOf = (key: string) => crc16(hashedPart(key)) % SLOTS
const SHARD = [
  { name: 'A', from: 0, to: 5460, primary: 'Shard A Primary', replica: 'Shard A Replica', ip: '10.0.1.21', replicaIp: '10.0.2.21' },
  { name: 'B', from: 5461, to: 10922, primary: 'Shard B Primary', replica: 'Shard B Replica', ip: '10.0.1.22', replicaIp: '10.0.2.22' },
  { name: 'C', from: 10923, to: 16383, primary: 'Shard C Primary', replica: 'Shard C Replica', ip: '10.0.1.23', replicaIp: '10.0.2.23' },
]
const shardOf = (slot: number) => SHARD.find((s) => slot >= s.from && slot <= s.to)!

const REPLID = '8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb'
const REPLID_NEW = 'c4e1f9a2d07b3e58a6f1029b7d4c8e3f5a1b6d20'
const OFFSET = 4_820_331_607

type Step = Trace['steps'][number]
type Run = { steps: Step[]; summary: string }

// ---- The pieces of a story ----

function sentinelIntro(): Step {
  return {
    text: `The App Server asks the Sentinels where the primary is, then sends all ${n(WRITES)} writes a second to the Redis Primary. It applies each one, replies, and only then streams it to Replica 1 and Replica 2. That order is why replication is asynchronous: the replicas run about ${LAG_MS} ms behind.`,
    nodes: ['App Server', 'Sentinels', 'Redis Primary', 'Replica 1', 'Replica 2'],
    data: `> SENTINEL get-master-addr-by-name carts\n1) "10.0.1.11"\n2) "6379"\n\n> INFO replication   (on the Redis Primary)\nrole:master\nconnected_slaves:2\nslave0:ip=10.0.2.11,port=6379,state=online,offset=${OFFSET},lag=0\nslave1:ip=10.0.3.11,port=6379,state=online,offset=${OFFSET - 600},lag=0\nmaster_replid:${REPLID}\nmaster_repl_offset:${OFFSET + (WRITES * BYTES * LAG_MS) / 1000}`,
  }
}

function clusterIntro(): Step {
  return {
    text: `The ${n(DATA_GB)} GB of carts is split across three shards. Every key belongs to one of ${n(SLOTS)} hash slots, and each primary owns about a third of them. The App Server's client keeps a Slot Map, so it sends each command straight to the right primary: about ${n(WRITES / SHARDS)} writes a second each.`,
    nodes: ['App Server', 'Slot Map', 'Shard A Primary', 'Shard B Primary', 'Shard C Primary'],
    data: `> CLUSTER SHARDS   (shortened)\nslots 0-5460       primary 10.0.1.21   replica 10.0.2.21\nslots 5461-10922   primary 10.0.1.22   replica 10.0.2.22\nslots 10923-16383  primary 10.0.1.23   replica 10.0.2.23\n\neach shard: ${n(DATA_GB / SHARDS)} GB, ${n(WRITES / SHARDS)} writes/s`,
  }
}

function replicaCut(cluster: boolean, bigBacklog: boolean): Run {
  const rate = cluster ? STREAM_KB / SHARDS : STREAM_KB // KB/s that this replica's primary writes
  const missedMb = (CUT * rate) / 1000
  const backlogMb = bigBacklog ? 64 : 1
  const fits = missedMb <= backlogMb
  const primary = cluster ? 'Shard B Primary' : 'Redis Primary'
  const replica = cluster ? 'Shard B Replica' : 'Replica 1'
  const gb = cluster ? RDB_GB / SHARDS : RDB_GB
  const send = (gb * 1000) / NET_MB_S
  const load = (gb * 1000) / LOAD_MB_S
  const buffered = ((send + load) * rate) / 1000
  const holds = (backlogMb * 1000) / rate
  const steps: Step[] = [
    cluster ? clusterIntro() : sentinelIntro(),
    {
      text: `A switch port fails, and ${replica} loses its link to ${primary} for ${CUT} s. The primary carries on and keeps writing into its Replication Backlog, a ring buffer of the latest writes. The replica still answers reads, with data that grows staler every second.`,
      nodes: [primary, 'Replication Backlog', replica],
      data: `replica log: Connection with master lost.\nreplica log: MASTER <-> REPLICA sync started   (retrying every second)\n\nmissed while cut off: ${CUT} s × ${n(rate)} KB/s = ${mb(missedMb)} MB\nrepl-backlog-size ${bigBacklog ? '64mb' : '1mb'}: holds the last ${mb(backlogMb)} MB ≈ ${secs(Math.round(holds * 10) / 10)} of writes`,
    },
    {
      text: `The link comes back. The replica sends PSYNC with the replication ID it knows and the offset it reached: "give me everything after this byte". ${fits ? `The primary still has those ${mb(missedMb)} MB in its backlog, so it replies +CONTINUE.` : `The primary's backlog only goes back ${secs(Math.round(holds * 10) / 10)}, and the replica needs ${CUT} s, so it can't continue. It replies +FULLRESYNC.`}`,
      nodes: [replica, primary, 'Replication Backlog'],
      data: `replica → primary: PSYNC ${REPLID} ${OFFSET + 1}\nprimary: backlog covers offsets ${n(OFFSET + missedMb * 1e6 - backlogMb * 1e6)} to ${n(OFFSET + missedMb * 1e6)}\nprimary → replica: ${fits ? `+CONTINUE ${REPLID}` : `+FULLRESYNC ${REPLID} ${OFFSET + missedMb * 1e6}`}`,
    },
  ]
  if (fits) {
    steps.push({
      text: `Partial resync: the primary sends just the ${mb(missedMb)} MB the replica missed, in about ${quick(missedMb / NET_MB_S)}, and the stream carries on. No fork, no snapshot, nothing deleted.`,
      nodes: [primary, replica],
      data: `replica log: Successful partial resynchronization with master.\nreplica log: MASTER <-> REPLICA sync: Master accepted a Partial Resynchronization.\nsent: ${mb(missedMb)} MB at ${NET_MB_S} MB/s ≈ ${quick(missedMb / NET_MB_S)}`,
    })
    return { steps, summary: `partial resync: ${mb(missedMb)} MB sent, back in sync in under a second` }
  }
  steps.push(
    {
      text: `Full sync. The primary forks, and the child process writes a snapshot of the whole dataset: ${mb(gb)} GB. It is sent at ${NET_MB_S} MB/s, which takes ${secs(Math.round(send * 10) / 10)}. New writes meanwhile wait in the replica's output buffer on the primary.`,
      nodes: [primary, replica],
      data: `primary: Starting BGSAVE for SYNC with target: replicas sockets\nfork of ${mb(cluster ? DATA_GB / SHARDS : DATA_GB)} GB ≈ ${n((cluster ? DATA_GB / SHARDS : DATA_GB) * 13)} ms pause\nsnapshot: ${mb(gb)} GB ÷ ${NET_MB_S} MB/s = ${secs(Math.round(send * 10) / 10)}`,
    },
    {
      text: `The replica throws away its old copy and loads the snapshot: ${secs(Math.round(load * 10) / 10)} at ${LOAD_MB_S} MB/s, answering LOADING meanwhile. Then the primary sends the ${mb(buffered)} MB of writes it buffered, well under the ${OUTPUT_LIMIT_MB} MB limit that would drop the replica and start again.`,
      nodes: [replica, primary],
      data: `replica log: MASTER <-> REPLICA sync: Flushing old data\nreplica log: MASTER <-> REPLICA sync: Loading DB in memory\nreplica log: MASTER <-> REPLICA sync: Finished with success\n\nfull sync: ${secs(Math.round(send * 10) / 10)} + ${secs(Math.round(load * 10) / 10)} = ${secs(Math.round((send + load) * 10) / 10)}\nbuffered meanwhile: ${secs(Math.round((send + load) * 10) / 10)} × ${n(rate)} KB/s = ${mb(buffered)} MB`,
    },
  )
  return {
    steps,
    summary: `full sync: ${mb(gb)} GB copied, ${secs(Math.round((send + load) * 10) / 10)} until the replica is back; a backlog of ${n(Math.ceil(missedMb))} MB or more would have avoided it`,
  }
}

function crash(cluster: boolean, key: string): Run {
  if (!cluster) {
    const lost = (WRITES * LAG_MS) / 1000
    return {
      steps: [
        sentinelIntro(),
        {
          text: `The Redis Primary's machine loses power. The ${n(lost)} writes it had acknowledged in the last ${LAG_MS} ms never reached a replica.`,
          nodes: ['Redis Primary', 'Replica 1', 'Replica 2'],
          data: `writes acknowledged but not yet replicated: ${LAG_MS} ms × ${n(WRITES)}/s = ${n(lost)}\nReplica 1 offset: ${OFFSET}\nReplica 2 offset: ${OFFSET - 600}`,
        },
        {
          text: `Each Sentinel PINGs the Redis Primary every second. After ${DOWN_AFTER} s with no reply, each marks it subjectively down (+sdown). They ask each other, 2 agree (the quorum), and it becomes objectively down (+odown).`,
          nodes: ['Sentinels', 'Redis Primary'],
          data: `sentinel down-after-milliseconds carts ${DOWN_AFTER * 1000}\n+sdown master carts 10.0.1.11 6379\n+odown master carts 10.0.1.11 6379 #quorum 2/2`,
        },
        {
          text: 'Before acting, the Sentinels elect one leader; it needs votes from a majority of all Sentinels, 2 of 3. The leader picks the replica with the lowest replica-priority and then the highest offset: Replica 1, which got 600 bytes further than Replica 2.',
          nodes: ['Sentinels', 'Replica 1', 'Replica 2'],
          data: `+new-epoch 12\n+vote-for-leader 3f9a… 12\n+elected-leader master carts 10.0.1.11 6379\n+selected-slave slave 10.0.2.11:6379 @ carts   (offset ${OFFSET} > ${OFFSET - 600})`,
        },
        {
          text: `The leader sends Replica 1 REPLICAOF NO ONE, and it becomes the new primary with a new replication ID. Replica 2 follows it and only needs a partial resync, because the new primary remembers the old ID too. The App Server hears +switch-master and moves over: about ${SENTINEL_FAILOVER} s of failed writes in all.`,
          nodes: ['Sentinels', 'Replica 1', 'Replica 2', 'App Server'],
          data: `→ Replica 1: REPLICAOF NO ONE\n+promoted-slave slave 10.0.2.11:6379 @ carts\n+switch-master carts 10.0.1.11 6379 10.0.2.11 6379\n\nnew primary: master_replid:${REPLID_NEW}\n             master_replid2:${REPLID}   (the old history, so PSYNC can continue)\nReplica 2 → PSYNC ${REPLID} ${OFFSET - 599} → +CONTINUE`,
        },
      ],
      summary: `${secs(SENTINEL_FAILOVER)} of failed writes, ${n(lost)} acknowledged writes lost`,
    }
  }
  const slot = slotOf(key)
  const owner = shardOf(slot)
  const lost = ((WRITES / SHARDS) * LAG_MS) / 1000
  return {
    steps: [
      clusterIntro(),
      {
        text: `Shard B Primary's machine loses power. Slots 5461 to 10922, a third of the keys, have no primary now. Keys on shards A and C keep working as if nothing happened.`,
        nodes: ['Shard B Primary', 'Shard B Replica', 'Shard A Primary', 'Shard C Primary'],
        data: `lost with it: ${LAG_MS} ms × ${n(WRITES / SHARDS)} writes/s = ${n(lost)} writes not yet on Shard B Replica\nyour key ${key}: slot ${slot}, shard ${owner.name}${owner.name === 'B' ? ' → failing until the failover' : ' → still working'}`,
      },
      {
        text: `The nodes PING each other over the Cluster Bus. After cluster-node-timeout (${DOWN_AFTER} s) the others mark Shard B Primary PFAIL ("possibly failed"). When a majority of primaries report it, it becomes FAIL, and that news is gossiped to every node.`,
        nodes: ['Cluster Bus', 'Shard A Primary', 'Shard C Primary', 'Shard B Primary'],
        data: `cluster-node-timeout ${DOWN_AFTER * 1000}\nnode 10.0.1.21: 10.0.1.22 is PFAIL\nnode 10.0.1.23: 10.0.1.22 is PFAIL\n→ 2 of 3 primaries agree: FAIL 10.0.1.22, broadcast to all nodes`,
      },
      {
        text: `Shard B Replica waits a short random delay (about 0.5 to 1 s, longer if other replicas are further ahead), then asks every primary for its vote. Shard A Primary and Shard C Primary vote yes: 2 of 3 primaries is a majority.`,
        nodes: ['Shard B Replica', 'Cluster Bus', 'Shard A Primary', 'Shard C Primary'],
        data: `delay = 500 ms + random(0-500 ms) + rank 0 × 1000 ms\nFAILOVER_AUTH_REQUEST, currentEpoch 9\n10.0.1.21: FAILOVER_AUTH_ACK\n10.0.1.23: FAILOVER_AUTH_ACK\n→ 2 votes of 3 primaries: elected`,
      },
      {
        text: `Shard B Replica promotes itself, takes slots 5461 to 10922 with a new configEpoch, and tells everyone. The client can't reach the old node, so it reloads its Slot Map, and any node it asks about these slots answers MOVED to the new primary. No Sentinel is needed: the cluster does it by itself, in about ${secs(CLUSTER_FAILOVER)}.`,
        nodes: ['Shard B Replica', 'Cluster Bus', 'Slot Map', 'App Server'],
        data: `10.0.2.22: Failover election won. configEpoch set to 10\n10.0.2.22: role master, slots 5461-10922\n\nApp Server → 10.0.1.22: connection refused\nApp Server → CLUSTER SHARDS: slots 5461-10922 now on 10.0.2.22`,
      },
    ],
    summary: `${secs(CLUSTER_FAILOVER)} of failed writes for a third of the keys, ${n(lost)} acknowledged writes lost`,
  }
}

function split(cluster: boolean, guard: boolean): Run {
  if (!cluster) {
    const window = guard ? MAX_LAG : CUT
    const lost = window * STRANDED
    return {
      steps: [
        sentinelIntro(),
        {
          text: `A switch fails. For ${CUT} s the Redis Primary, one Sentinel and App Server A (a quarter of the traffic) can't reach anything else. Replica 1, Replica 2 and the other two Sentinels are on the other side, with App Servers B, C and D.`,
          nodes: ['Redis Primary', 'Sentinels', 'Replica 1', 'Replica 2', 'App Server'],
          data: `rack 1: Redis Primary, Sentinel 1, App Server A (${n(STRANDED)} writes/s)\nrack 2: Replica 1, Sentinel 2, App Servers B, C\nrack 3: Replica 2, Sentinel 3, App Server D`,
        },
        {
          text: `Sentinels 2 and 3 can't see the Redis Primary. They are 2 of 3, a majority, so they can fail over: after ${secs(SENTINEL_FAILOVER)} Replica 1 is a primary. Sentinel 1 alone can't do anything. Now there are two primaries: split brain.`,
          nodes: ['Sentinels', 'Replica 1'],
          data: `Sentinels 2, 3: +odown, +elected-leader, +switch-master carts 10.0.1.11 6379 10.0.2.11 6379\nSentinel 1: no quorum, waits`,
        },
        {
          text: guard
            ? `App Server A still writes to the old Redis Primary. But no replica has acknowledged for ${MAX_LAG} s, so with min-replicas-to-write 1 it starts refusing writes. App Server A gets errors instead of losing data for the rest of the split.`
            : `App Server A still writes to the old Redis Primary for all ${CUT} s, and every write is acknowledged. Nothing tells the old Redis Primary that it has been replaced.`,
          nodes: ['App Server', 'Redis Primary'],
          data: guard
            ? `min-replicas-to-write 1\nmin-replicas-max-lag ${MAX_LAG}\nafter ${MAX_LAG} s:\n> HINCRBY cart:{user:1001} sku-2291 1\n(error) NOREPLICAS Not enough good replicas to write.`
            : `old primary: ${CUT} s × ${n(STRANDED)} writes/s accepted`,
        },
        {
          text: 'The network heals. Sentinel 1 learns of the newer epoch, and the old Redis Primary is turned into a replica of the new one. It deletes its data and copies the new primary, and every write it took after the split is gone.',
          nodes: ['Sentinels', 'Redis Primary', 'Replica 1'],
          data: `+convert-to-slave slave 10.0.1.11:6379 @ carts 10.0.2.11 6379\nlost: ${window} s × ${n(STRANDED)} writes/s = ${n(lost)} acknowledged writes`,
        },
      ],
      summary: `${n(lost)} acknowledged writes lost to split brain${guard ? '' : '; min-replicas-to-write 1 would cut it to ' + n(MAX_LAG * STRANDED)}`,
    }
  }
  const rate = STRANDED / SHARDS
  const lost = DOWN_AFTER * rate
  return {
    steps: [
      clusterIntro(),
      {
        text: `A switch fails. For ${CUT} s Shard B Primary and App Server A are cut off from every other node. App Server A still sends shard B's writes to it: ${n(rate)} a second.`,
        nodes: ['Shard B Primary', 'App Server', 'Cluster Bus'],
        data: `minority side: Shard B Primary, App Server A\nmajority side: Shard A and C primaries, all three replicas, App Servers B, C, D`,
      },
      {
        text: `On the majority side, Shard B Replica wins a failover after about ${secs(CLUSTER_FAILOVER)}. On the minority side, Shard B Primary notices it can't reach a majority of primaries for cluster-node-timeout (${DOWN_AFTER} s), and it stops accepting writes.`,
        nodes: ['Shard B Replica', 'Cluster Bus', 'Shard B Primary'],
        data: `10.0.2.22: Failover election won\n10.0.1.22 (minority): after ${DOWN_AFTER * 1000} ms without a majority:\n> HINCRBY cart:{user:1001} sku-2291 1\n(error) CLUSTERDOWN The cluster is down`,
      },
      {
        text: `The network heals and the old Shard B Primary rejoins as a replica of the new one. The writes it took in those first ${DOWN_AFTER} s are lost. The node timeout bounds split brain in Cluster, much like min-replicas-to-write does with Sentinel.`,
        nodes: ['Shard B Primary', 'Shard B Replica'],
        data: `lost: ${DOWN_AFTER} s × ${n(rate)} writes/s = ${n(lost)} acknowledged writes\n(Sentinel without min-replicas-to-write: ${CUT} s × ${n(STRANDED)} = ${n(CUT * STRANDED)})`,
      },
    ],
    summary: `${n(lost)} acknowledged writes lost, bounded by cluster-node-timeout`,
  }
}

function read(cluster: boolean, key: string): Run {
  if (!cluster) {
    return {
      steps: [
        sentinelIntro(),
        {
          text: `A user adds a dish to their cart. The write goes to the Redis Primary, which replies at once. ${LAG_MS} ms later the replicas have it too.`,
          nodes: ['App Server', 'Redis Primary'],
          data: `t=0 ms   → Redis Primary: HINCRBY ${key} sku-2291 1\n         ← (integer) 1`,
        },
        {
          text: `To spread reads, the app reads from Replica 2. The read arrives 5 ms after the write, before the change has, so the cart looks empty. Reading from replicas trades freshness for capacity.`,
          nodes: ['App Server', 'Replica 2'],
          data: `t=5 ms   → Replica 2: HGET ${key} sku-2291\n         ← (nil)      the write arrives at t=${LAG_MS} ms`,
        },
        {
          text: 'The fix: read a user\'s own data from the Redis Primary, and use replicas for data that can be a little old, such as menus and leaderboards. Or call WAIT 1 100 after the write, which waits until a replica has it.',
          nodes: ['App Server', 'Redis Primary', 'Replica 1'],
          data: `> HINCRBY ${key} sku-2291 1\n(integer) 1\n> WAIT 1 100\n(integer) 1      1 replica has it, after about ${LAG_MS} ms`,
        },
      ],
      summary: 'reads from a replica can be up to the replication lag behind; read your own writes from the primary',
    }
  }
  const part = hashedPart(key)
  const slot = slotOf(key)
  const owner = shardOf(slot)
  const tagged = part !== key
  const tag = tagged ? part : 'user:1001'
  const pair = [`cart:{${tag}}`, `profile:{${tag}}`]
  const plain = ['cart:user:1001', 'profile:user:1001']
  return {
    steps: [
      clusterIntro(),
      {
        text: tagged
          ? `The client hashes only the part of "${key}" inside the braces, "${part}": CRC16 gives ${crc16(part)}, and ${crc16(part)} mod ${n(SLOTS)} is slot ${slot}.`
          : `The client hashes the whole key "${key}": CRC16 gives ${crc16(key)}, and ${crc16(key)} mod ${n(SLOTS)} is slot ${slot}.`,
        nodes: ['App Server', 'Slot Map'],
        data: `CRC16("${part}") = ${crc16(part)}\n${crc16(part)} mod ${SLOTS} = ${slot}\n> CLUSTER KEYSLOT "${key}"\n(integer) ${slot}`,
      },
      {
        text: `The Slot Map says slot ${slot} belongs to shard ${owner.name} (slots ${owner.from} to ${owner.to}), so the command goes straight to ${owner.primary}. One network hop, no proxy in between.`,
        nodes: ['Slot Map', owner.primary],
        data: `slot ${slot} → ${owner.primary} ${owner.ip}:6379\n→ ${owner.ip}: HGETALL ${key}\n← 1) "sku-2291"  2) "1"`,
      },
      {
        text: `A command with several keys only works if they are in one slot. ${pair[0]} and ${pair[1]} hash just "${tag}", so both are in slot ${slotOf(pair[0])}. Without braces, ${plain[0]} and ${plain[1]} land in slots ${slotOf(plain[0])} and ${slotOf(plain[1])}, and Redis refuses.`,
        nodes: ['App Server', owner.primary],
        data: `> MGET ${pair[0]} ${pair[1]}\n1) ...  2) ...   (both in slot ${slotOf(pair[0])})\n\n> MGET ${plain[0]} ${plain[1]}\n(error) CROSSSLOT Keys in request don't hash to the same slot`,
      },
    ],
    summary: `${key} is in slot ${slot}, on shard ${owner.name}`,
  }
}

function move(cluster: boolean, key: string): Run {
  if (!cluster) {
    return {
      steps: [
        sentinelIntro(),
        {
          text: 'A Sentinel setup has no slots: one primary holds every key, and the replicas hold full copies. To spread keys over several primaries, you need Redis Cluster.',
          nodes: ['Redis Primary', 'Replica 1', 'Replica 2'],
          data: '> CLUSTER KEYSLOT cart:{user:1001}\n(error) ERR This instance has cluster support disabled',
        },
      ],
      summary: 'no slots without Cluster: every key lives on the one primary',
    }
  }
  const slot = slotOf(key)
  const from = shardOf(slot)
  const to = SHARD[(SHARD.indexOf(from) + 1) % SHARD.length]
  return {
    steps: [
      clusterIntro(),
      {
        text: `Shard ${from.name} is running hot, so an operator moves slot ${slot} (where "${key}" lives) to shard ${to.name}. The slot is marked MIGRATING on the old owner and IMPORTING on the new one, and its keys are copied across in small batches.`,
        nodes: [from.primary, to.primary, 'Cluster Bus'],
        data: `→ ${to.ip}: CLUSTER SETSLOT ${slot} IMPORTING <shard ${from.name} id>\n→ ${from.ip}: CLUSTER SETSLOT ${slot} MIGRATING <shard ${to.name} id>\n→ ${from.ip}: MIGRATE ${to.ip} 6379 "" 0 5000 KEYS ${key} ...`,
      },
      {
        text: `Mid-move, the client still sends ${key} to ${from.primary}. The key has already moved, so it answers ASK: "try ${to.name} for this one command". The client sends ASKING, then the command, to ${to.primary}. Its Slot Map doesn't change yet.`,
        nodes: ['App Server', from.primary, to.primary],
        data: `→ ${from.ip}: HGETALL ${key}\n← -ASK ${slot} ${to.ip}:6379\n→ ${to.ip}: ASKING\n→ ${to.ip}: HGETALL ${key}\n← 1) "sku-2291"  2) "1"`,
      },
      {
        text: `When every key has moved, the slot is assigned to shard ${to.name} on all nodes. Now ${from.primary} answers MOVED, which means "this slot lives there for good". The client updates its Slot Map and goes straight to ${to.primary} from then on.`,
        nodes: ['App Server', from.primary, 'Slot Map', to.primary],
        data: `→ all nodes: CLUSTER SETSLOT ${slot} NODE <shard ${to.name} id>\n\n→ ${from.ip}: HGETALL ${key}\n← -MOVED ${slot} ${to.ip}:6379\nSlot Map: slot ${slot} → ${to.ip}`,
      },
    ],
    summary: `slot ${slot} moved from shard ${from.name} to shard ${to.name}: ASK during the move, MOVED after it`,
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'setup', label: 'Setup', options: Object.values(SETUP) },
    { id: 'event', label: 'What happens', options: Object.values(EVENT) },
    { id: 'key', label: 'Key', placeholder: 'cart:{user:1001}' },
    { id: 'backlog', label: 'Replication backlog', options: Object.values(BACKLOG) },
    { id: 'guard', label: 'Stop writes without replicas', options: Object.values(GUARD) },
  ],
  defaults: { setup: SETUP.sentinel, event: EVENT.cut, key: 'cart:{user:1001}', backlog: BACKLOG.small, guard: GUARD.off },
  run({ setup, event, key, backlog, guard }) {
    const cluster = setup === SETUP.cluster
    const k = key?.trim() || 'cart:{user:1001}'
    const out =
      event === EVENT.crash
        ? crash(cluster, k)
        : event === EVENT.split
          ? split(cluster, guard === GUARD.on)
          : event === EVENT.read
            ? read(cluster, k)
            : event === EVENT.move
              ? move(cluster, k)
              : replicaCut(cluster, backlog === BACKLOG.big)
    return { input: `${cluster ? 'Cluster' : 'Sentinel'} · ${event.toLowerCase()} → ${out.summary}`, steps: out.steps }
  },
}

export const redisReplication: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'redis-replication',
  title: 'Redis Replication, Sentinel and Cluster',
  blurb: 'How replicas sync, how Sentinel fails over, and how Redis Cluster shards keys into 16,384 slots',
  guides: ['how-redis-architecture-evolve', 'scale-replication', 'scale-sharding', 'scale-scaling-redis-at-twitter', 'scale-redis-fleet-at-heroku', 'how-does-redis-persist-data'],
  takeaways: [
    'A replica copies the whole dataset once, then receives every write as a stream, and tracks how far it has got with a replication offset.',
    'A replica that drops off catches up from the replication backlog if the missed writes still fit; otherwise it needs a full sync, so size the backlog for your longest disconnect.',
    'Replication is asynchronous, so a failover loses the writes the replica hadn\'t received; WAIT and min-replicas-to-write shrink that window but never close it.',
    'Sentinel needs a quorum to mark the primary down and a majority of Sentinels to fail over, so run at least three on different machines.',
    'Redis Cluster splits keys into 16,384 hash slots across primaries, and each shard fails over by itself, without Sentinel.',
    'A command with several keys works in Cluster only when they share a slot; hash tags like {user:1001} make sure they do.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'sentinel', label: 'Replication with Sentinel' },
      { id: 'cluster', label: 'Redis Cluster (16,384 slots)' },
    ],
    nodes: [
      { id: 'app', label: 'App Server', shape: 'rectangle', color: 'blue', group: null },
      { id: 'sentinels', label: 'Sentinels', shape: 'diamond', color: 'violet', group: 'sentinel' },
      { id: 'primary', label: 'Redis Primary', shape: 'rectangle', color: 'red', group: 'sentinel' },
      { id: 'backlog', label: 'Replication Backlog', shape: 'rectangle', color: 'yellow', group: 'sentinel' },
      { id: 'replica1', label: 'Replica 1', shape: 'rectangle', color: 'red', group: 'sentinel' },
      { id: 'replica2', label: 'Replica 2', shape: 'rectangle', color: 'red', group: 'sentinel' },
      { id: 'slotmap', label: 'Slot Map', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'a', label: 'Shard A Primary', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'ar', label: 'Shard A Replica', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'b', label: 'Shard B Primary', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'br', label: 'Shard B Replica', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'c', label: 'Shard C Primary', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'cr', label: 'Shard C Replica', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'bus', label: 'Cluster Bus', shape: 'rectangle', color: 'yellow', group: 'cluster' },
    ],
    edges: [
      { from: 'app', to: 'sentinels', label: 'where is the primary?', dashed: true },
      { from: 'app', to: 'primary', label: 'reads and writes', dashed: false },
      { from: 'primary', to: 'backlog', label: 'every write', dashed: false },
      { from: 'primary', to: 'replica1', label: 'replication stream', dashed: false },
      { from: 'primary', to: 'replica2', label: 'replication stream', dashed: false },
      { from: 'sentinels', to: 'primary', label: 'PING every 1 s', dashed: true },
      { from: 'sentinels', to: 'replica1', label: 'promote', dashed: true },
      { from: 'app', to: 'slotmap', label: 'which shard has this slot?', dashed: false },
      { from: 'slotmap', to: 'a', label: 'slots 0-5460', dashed: false },
      { from: 'slotmap', to: 'b', label: 'slots 5461-10922', dashed: false },
      { from: 'slotmap', to: 'c', label: 'slots 10923-16383', dashed: false },
      { from: 'a', to: 'ar', label: 'replicates', dashed: false },
      { from: 'b', to: 'br', label: 'replicates', dashed: false },
      { from: 'c', to: 'cr', label: 'replicates', dashed: false },
      { from: 'a', to: 'bus', label: 'gossip', dashed: true },
      { from: 'b', to: 'bus', label: 'gossip', dashed: true },
      { from: 'c', to: 'bus', label: 'gossip', dashed: true },
      { from: 'bus', to: 'br', label: 'failover votes', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Redis Replication, Sentinel and Cluster',
    summary:
      'Replication keeps copies of a Redis primary on other machines. Sentinel watches a primary and promotes a replica when it dies. Redis Cluster splits the keys into 16,384 slots across several primaries, each with its own replicas, and fails each shard over by itself. All three copy data asynchronously, so a failover can lose the last few writes.',
    sections: [
      {
        heading: 'Overview',
        body: `Three tools, for three jobs:\n- Replication keeps copies. A replica connects to the primary, copies the whole dataset once, and then receives every write as a stream.\n- Sentinel keeps one primary available. Three or more Sentinel processes watch it. When it stops answering, they agree, pick the best replica and promote it.\n- Redis Cluster spreads the keys. Every key belongs to one of 16,384 hash slots, and each primary owns a range of slots. Each shard has its own replicas and fails over without Sentinel.\n\nThe simulator follows a food-delivery app's carts and sessions: ${DATA_GB} GB of data and ${n(WRITES)} writes a second, on one primary with Sentinel or on a 3-shard cluster.`,
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Every write reaches the replicas, in order.\n- A replica that drops off catches up without copying everything again, when it can.\n- When a primary dies, a replica takes over without a person.\n- In Cluster mode, every client can find the shard that holds a key.\n\nNon-functional:\n- Fail over in seconds.\n- Keep write latency under a millisecond: the primary must not wait for replicas.\n- Lose as few acknowledged writes as possible, and know how many can be lost.',
      },
      {
        heading: 'Capacity estimates',
        body: `- Replication stream: ${n(WRITES)} writes/s × ${BYTES} bytes = ${n(STREAM_KB)} KB/s.\n- Backlog: the default repl-backlog-size of 1 MB holds 1 MB ÷ ${n(STREAM_KB)} KB/s ≈ 1.7 s of writes. A replica cut off for ${CUT} s missed ${CUT} × ${n(STREAM_KB)} KB = ${n((CUT * STREAM_KB) / 1000)} MB, so set 64 MB (about 107 s).\n- Full sync: ${DATA_GB} GB of data makes a ${mb(RDB_GB)} GB snapshot. Sending it at ${NET_MB_S} MB/s (1 Gbit/s) takes ${secs((RDB_GB * 1000) / NET_MB_S)}, and loading it at ${LOAD_MB_S} MB/s takes ${secs((RDB_GB * 1000) / LOAD_MB_S)}: ${secs((RDB_GB * 1000) / NET_MB_S + (RDB_GB * 1000) / LOAD_MB_S)}. Meanwhile the primary buffers about ${n((((RDB_GB * 1000) / NET_MB_S + (RDB_GB * 1000) / LOAD_MB_S) * STREAM_KB) / 1000)} MB of new writes for the replica.\n- Failover: Sentinel waits ${DOWN_AFTER} s, then agrees, elects a leader and promotes: about ${SENTINEL_FAILOVER} s of failed writes. A crash loses ${LAG_MS} ms of lag × ${n(WRITES)} writes/s = ${n((WRITES * LAG_MS) / 1000)} writes.\n- Cluster: ${n(SLOTS)} slots ÷ 3 shards ≈ 5,461 slots, ${DATA_GB / SHARDS} GB and ${n(WRITES / SHARDS)} writes/s per shard. A full sync of one shard takes ${secs((((RDB_GB / SHARDS) * 1000) / NET_MB_S + ((RDB_GB / SHARDS) * 1000) / LOAD_MB_S))} instead of ${secs((RDB_GB * 1000) / NET_MB_S + (RDB_GB * 1000) / LOAD_MB_S)}.`,
      },
      {
        heading: 'Step by step',
        body: '1. The App Server asks the Sentinels for the address of the Redis Primary, then sends it reads and writes.\n2. The Redis Primary applies each write and replies. Then it copies the write into the Replication Backlog and streams it to Replica 1 and Replica 2.\n3. Each replica tells the Redis Primary how far it has got, its offset, every second.\n4. A replica that drops off reconnects with PSYNC and its offset. If the missed writes are still in the Replication Backlog, it gets only those; if not, it gets a full copy.\n5. The Sentinels PING the Redis Primary every second. If it stays silent for 5 s and 2 of the 3 agree, they promote Replica 1 and tell the App Server.\n6. In Redis Cluster, the App Server hashes the key to a slot, finds the slot\'s owner in its Slot Map, and sends the command to Shard A Primary, Shard B Primary or Shard C Primary.\n7. The nodes talk over the Cluster Bus. If Shard B Primary dies, Shard B Replica asks the other primaries for votes and takes over its slots.',
      },
      {
        heading: 'Components',
        body: '- App Server: runs the Redis client. It finds the primary through the Sentinels, or keeps the Slot Map in Cluster mode.\n- Sentinels: three small processes that watch the Redis Primary, agree it is down, elect a leader among themselves and promote a replica.\n- Redis Primary: the one node that accepts writes in the Sentinel setup. It replies first and replicates after, so replication is asynchronous.\n- Replication Backlog: the Redis Primary\'s ring buffer of the latest writes (repl-backlog-size, 1 MB by default), so a replica that drops off briefly can catch up with a partial resync.\n- Replica 1: a read-only copy that receives the replication stream. Sentinel promotes it first because it is furthest ahead.\n- Replica 2: a second copy. After a failover it follows the new primary without a full sync.\n- Slot Map: the cluster client\'s copy of which primary owns each of the 16,384 slots. A MOVED reply makes it refresh.\n- Shard A Primary: owns slots 0 to 5460.\n- Shard A Replica: a copy of shard A, promoted if Shard A Primary fails.\n- Shard B Primary: owns slots 5461 to 10922.\n- Shard B Replica: a copy of shard B, promoted if Shard B Primary fails.\n- Shard C Primary: owns slots 10923 to 16383.\n- Shard C Replica: a copy of shard C, promoted if Shard C Primary fails.\n- Cluster Bus: a second port on every node (6379 + 10000 = 16379) where the nodes gossip, spot failures and vote in failovers.',
      },
      {
        heading: 'Key decisions',
        body: '- One primary with Sentinel when the data fits in one machine\'s memory and one primary can take the writes. It is simpler: every command works, and there are no slots.\n- Redis Cluster when the data or the writes outgrow one primary. You pay with a rule: a command with several keys works only if they are in the same slot.\n- Hash tags keep related keys together: cart:{user:1001} and profile:{user:1001} hash only "user:1001", so both land in slot 5712.\n- Size repl-backlog-size for your longest normal disconnect: write rate × seconds. 64 MB covers about 107 s here.\n- Read from replicas only for data that can be a little stale. A user who just wrote must read from the primary.\n- min-replicas-to-write 1 with min-replicas-max-lag 10 stops a cut-off primary from accepting writes for long.\n- WAIT 1 100 after an important write waits up to 100 ms until a replica has it. It narrows the loss window; it is not a transaction.\n- Run at least three Sentinels on different machines, so a majority survives one failure.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Replication is asynchronous: any failover can lose the writes the replica had not received yet (here 20 ms, about 120 writes).\n- A replica that misses more than the backlog needs a full sync. That forks the primary and copies the whole dataset, and many replicas doing it at once can overload the primary.\n- If a full sync takes too long, the replica\'s output buffer on the primary fills up (client-output-buffer-limit replica 256mb 64mb 60), the primary drops the replica, and the sync starts again in a loop.\n- Split brain: a primary cut off from the majority keeps taking writes until min-replicas-to-write (Sentinel) or cluster-node-timeout (Cluster) stops it. Those writes are lost when it rejoins.\n- In Cluster, a shard that loses its primary and has no replica leaves its slots without an owner. By default (cluster-require-full-coverage yes) the whole cluster then stops serving; set it to no to keep the other shards working.\n- Resharding moves one slot at a time. Clients follow ASK during a move and MOVED after it.\n- A hot key stays on one shard: Cluster spreads keys, not the load of a single key.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the difference between a full sync and a partial resync, and what decides which one happens?\n- Why can Redis lose acknowledged writes during a failover? How do WAIT and min-replicas-to-write help?\n- How does Sentinel decide a primary is down? What are the quorum and the majority each used for?\n- How does a cluster client find the right node for a key? What do MOVED and ASK mean?\n- Why does MGET fail with CROSSSLOT, and how do hash tags fix it?\n- Sentinel or Cluster: which would you choose for 10 GB of sessions? For 500 GB?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Replicas and Sentinel, configured',
        language: 'bash',
        source: `# On the primary (redis.conf)
repl-backlog-size 64mb          # ~107 s of writes at 600 KB/s, so short drops resume with PSYNC
min-replicas-to-write 1         # refuse writes if no replica has acknowledged...
min-replicas-max-lag 10         # ...in the last 10 s (bounds split-brain loss)

# On each replica (redis.conf)
replicaof 10.0.1.11 6379
replica-read-only yes
replica-priority 100            # lower = promoted first; 0 = never promote this one

# On three different machines (sentinel.conf): 2 must agree the primary is down
sentinel monitor carts 10.0.1.11 6379 2
sentinel down-after-milliseconds carts 5000
sentinel failover-timeout carts 60000
sentinel parallel-syncs carts 1  # replicas re-sync to a new primary one at a time

# How far behind is each replica?
redis-cli -h 10.0.1.11 INFO replication | grep -E 'slave|master_repl_offset'`,
      },
      {
        title: 'Create a 3-shard cluster and follow a redirect',
        language: 'bash',
        source: `# Six nodes with "cluster-enabled yes" in redis.conf. redis-cli gives every
# primary a replica on a different machine and splits the 16,384 slots three ways.
redis-cli --cluster create \\
  10.0.1.21:6379 10.0.1.22:6379 10.0.1.23:6379 \\
  10.0.2.21:6379 10.0.2.22:6379 10.0.2.23:6379 \\
  --cluster-replicas 1

redis-cli -h 10.0.1.21 CLUSTER KEYSLOT "cart:{user:1001}"   # (integer) 5712
redis-cli -h 10.0.1.21 GET "cart:{user:1001}"
# (error) MOVED 5712 10.0.1.22:6379    slot 5712 lives on shard B
redis-cli -c -h 10.0.1.21 GET "cart:{user:1001}"            # -c follows MOVED for you

redis-cli -h 10.0.1.21 CLUSTER SHARDS     # every shard: its slots, primary and replicas
redis-cli --cluster check 10.0.1.21:6379  # are all 16,384 slots covered?`,
      },
      {
        title: 'Which slot is this key in? (hash tags)',
        language: 'javascript',
        source: `// CRC16/XMODEM, the checksum Redis Cluster hashes keys with.
function crc16(text) {
  let crc = 0
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

// If the key has a non-empty {...}, only that part is hashed: a "hash tag".
export function hashSlot(key) {
  const open = key.indexOf('{')
  if (open >= 0) {
    const close = key.indexOf('}', open + 1)
    if (close > open + 1) key = key.slice(open + 1, close)
  }
  return crc16(key) % 16384
}

console.log(hashSlot('cart:{user:1001}'), hashSlot('profile:{user:1001}')) // 5712 5712: one slot
console.log(hashSlot('cart:user:1001'), hashSlot('profile:user:1001')) // 3725 12854: two shards`,
        versions: [
          {
            language: 'java',
            source: `import java.nio.charset.StandardCharsets;

public class HashSlot {
  // CRC16/XMODEM, the checksum Redis Cluster hashes keys with.
  static int crc16(byte[] data) {
    int crc = 0;
    for (byte b : data) {
      crc ^= (b & 0xff) << 8;
      for (int i = 0; i < 8; i++) crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  // If the key has a non-empty {...}, only that part is hashed: a "hash tag".
  static int hashSlot(String key) {
    int open = key.indexOf('{');
    if (open >= 0) {
      int close = key.indexOf('}', open + 1);
      if (close > open + 1) key = key.substring(open + 1, close);
    }
    return crc16(key.getBytes(StandardCharsets.UTF_8)) % 16384;
  }

  public static void main(String[] args) {
    System.out.println(hashSlot("cart:{user:1001}") + " " + hashSlot("profile:{user:1001}")); // 5712 5712: one slot
    System.out.println(hashSlot("cart:user:1001") + " " + hashSlot("profile:user:1001")); // 3725 12854: two shards
  }
}`,
          },
        ],
      },
      {
        title: 'A cluster client: one user\'s keys in one slot',
        language: 'javascript',
        source: `import { createCluster } from 'redis'

// Give it a few nodes: it loads the slot map from them and follows MOVED and ASK by itself.
const cluster = createCluster({
  rootNodes: [{ url: 'redis://10.0.1.21:6379' }, { url: 'redis://10.0.1.22:6379' }],
})
await cluster.connect()

// One script touching two keys runs as one atomic step, allowed because both are in one slot.
const ADD = \`
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
return redis.call('INCR', KEYS[2])\`

export async function addToCart(userId, sku) {
  const tag = \`{user:\${userId}}\` // every key of one user hashes just "user:<id>"
  return cluster.eval(ADD, { keys: [\`cart:\${tag}\`, \`cart-version:\${tag}\`], arguments: [sku] })
}

// Without the braces these keys hash to slots 3725 and 12854, and MGET fails with CROSSSLOT.
export const cartAndProfile = (userId) => cluster.mGet([\`cart:{user:\${userId}}\`, \`profile:{user:\${userId}}\`])`,
        versions: [
          {
            language: 'java',
            source: `import java.util.List;
import java.util.Set;
import redis.clients.jedis.HostAndPort;
import redis.clients.jedis.RedisClusterClient;

public class Carts {
  // Give it a few nodes: it loads the slot map from them and follows MOVED and ASK by itself.
  private static final RedisClusterClient cluster = RedisClusterClient.create(Set.of(
      new HostAndPort("10.0.1.21", 6379), new HostAndPort("10.0.1.22", 6379)));

  // One script touching two keys runs as one atomic step, allowed because both are in one slot.
  private static final String ADD = """
      redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
      return redis.call('INCR', KEYS[2])""";

  public static long addToCart(long userId, String sku) {
    String tag = "{user:" + userId + "}"; // every key of one user hashes just "user:<id>"
    return (Long) cluster.eval(ADD, List.of("cart:" + tag, "cart-version:" + tag), List.of(sku));
  }

  // Without the braces these keys hash to slots 3725 and 12854, and MGET fails with CROSSSLOT.
  public static List<String> cartAndProfile(long userId) {
    return cluster.mget("cart:{user:" + userId + "}", "profile:{user:" + userId + "}");
  }
}`,
          },
        ],
      },
    ],
    related: ['Redis Persistence', 'Distributed cache', 'Consistent hashing', 'Leader election', 'Database sharding'],
  },
  simulator,
}
