import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator works out what a failure costs a Redis setup: how many acknowledged
// writes are lost and how long writes fail, from the persistence settings, the
// replication setup and the kind of failure. The numbers come from the model below.

const RATE = 2000 // writes a second, from four App Servers
const KEYS = 12_000_000
const MEMORY_GB = 4
const RDB_GB = 1.6 // the snapshot file, compressed
const LOAD_MB_S = 100 // reading and decoding an RDB file
const SINCE_SNAPSHOT = 250 // seconds between the last finished snapshot and the failure
const AOF_TAIL = 2_400_000 // commands appended since the last AOF rewrite (20 minutes at 2,000/s)
const REPLAY_PER_S = 400_000 // AOF commands replayed a second on start-up
const REPL_LAG_WRITES = 40 // async replication: the replica is about 20 ms behind
const BYTES_PER_WRITE = 120 // a write command in the replication stream, on average
const DOWN_AFTER = 5 // sentinel down-after-milliseconds 5000
const FAILOVER = 7 // down-after, then agreement, leader election and promotion
const REBOOT = 180
const SPLIT = 30
const RACK_A = RATE / 4 // App Server A shares the old primary's rack
const MAX_LAG = 10 // min-replicas-max-lag
const BACKLOG_MB = 1 // repl-backlog-size 1mb (the default)

type Persistence = 'none' | 'rdb' | 'everysec' | 'always'
type Replication = 'single' | 'replica' | 'sentinel' | 'minreplicas'
type Failure = 'process' | 'power' | 'split'

const PERSISTENCE: Record<string, Persistence> = {
  'No persistence': 'none',
  'RDB snapshot every 5 min': 'rdb',
  'AOF, fsync every second': 'everysec',
  'AOF, fsync always': 'always',
}
const REPLICATION: Record<string, Replication> = {
  'Single node': 'single',
  'Primary + replica': 'replica',
  'Primary + replica + Sentinel': 'sentinel',
  'Sentinel + min-replicas-to-write': 'minreplicas',
}
const FAILURE: Record<string, Failure> = {
  'Process crash (restarts in 1 s)': 'process',
  'Power cut (reboots in 3 min)': 'power',
  '30 s network split': 'split',
}

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const dur = (s: number) => (s < 60 ? `${n(s)} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${n(s % 60)} s` : ''}`)

/** Seconds to load the dataset back into memory on start-up. */
function loadTime(p: Persistence): number {
  const rdb = (RDB_GB * 1000) / LOAD_MB_S
  if (p === 'none') return 0
  if (p === 'rdb') return rdb
  return rdb + AOF_TAIL / REPLAY_PER_S // the AOF base is an RDB, then the commands since
}

/** Acknowledged writes the restarted node no longer has. 'all' means every key. */
function diskLoss(p: Persistence, f: 'process' | 'power'): { lost: number | 'all'; why: string } {
  if (p === 'none') return { lost: 'all', why: 'nothing was ever written to the disk, so all 12 million keys are gone' }
  if (p === 'rdb') return { lost: SINCE_SNAPSHOT * RATE, why: `the last snapshot finished ${dur(SINCE_SNAPSHOT)} earlier: ${dur(SINCE_SNAPSHOT)} × ${n(RATE)} writes/s = ${n(SINCE_SNAPSHOT * RATE)} writes exist only in the memory that was lost` }
  if (p === 'always') return { lost: 0, why: 'every write was fsynced before Redis replied, so every acknowledged write is on the disk' }
  return f === 'process'
    ? { lost: 0, why: 'each write had already been handed to the OS with write(); the process died but the OS kept its page cache and flushed it to the disk' }
    : { lost: RATE, why: `the last second of writes was still in the OS page cache, waiting for the once-a-second fsync: about ${n(RATE)} writes` }
}

const lostText = (lost: number | 'all') => (lost === 'all' ? `all ${n(KEYS)} keys` : lost === 0 ? 'no acknowledged writes' : `${n(lost)} acknowledged writes`)

const PERSIST_CONFIG: Record<Persistence, string> = {
  none: 'save ""\nappendonly no',
  rdb: 'save 300 1\nappendonly no',
  everysec: 'appendonly yes\nappendfsync everysec',
  always: 'appendonly yes\nappendfsync always',
}

function persistStep(p: Persistence): Trace['steps'][number] {
  switch (p) {
    case 'none':
      return { text: 'Persistence is off: nothing is written to the disk. Redis is as fast as it gets, and if the process stops, the data stops with it.', nodes: ['Primary', 'Dataset in Memory'], data: `${PERSIST_CONFIG.none}\nfiles on disk: none` }
    case 'rdb':
      return {
        text: `Every 5 minutes Redis forks a child process that writes the whole dataset to dump.rdb (${RDB_GB} GB compressed). The parent keeps serving; any page it changes meanwhile is copied for the child (copy-on-write).`,
        nodes: ['Dataset in Memory', 'RDB Snapshot', 'OS Page Cache', 'Disk'],
        data: `${PERSIST_CONFIG.rdb}\nfork of ${MEMORY_GB} GB: about 50 ms pause (≈13 ms per GB)\ndump.rdb: ${RDB_GB} GB, written by the child\nlast snapshot finished: ${dur(SINCE_SNAPSHOT)} before the failure`,
      }
    default:
      return {
        text:
          p === 'everysec'
            ? 'Each write command is appended to the AOF (append-only file) log with write(), which only reaches the OS page cache. A background thread calls fsync once a second to push it onto the disk.'
            : 'Each write command is appended to the AOF (append-only file) and fsynced before Redis replies. Redis groups the writes of one event-loop pass into one fsync, but every reply now waits for the disk.',
        nodes: ['Primary', 'AOF Log', 'OS Page Cache', 'Disk'],
        data: `${PERSIST_CONFIG[p]}\nappendonly.aof, one command in RESP:\n*4\\r\\n$7\\r\\nHINCRBY\\r\\n$9\\r\\ncart:4107\\r\\n$8\\r\\nsku-2291\\r\\n$1\\r\\n1\\r\\n\n${p === 'everysec' ? 'cost: one write() per pass; fsync off the main thread' : 'cost: each pass waits for fsync, often a millisecond or more'}`,
      }
  }
}

function replicationStep(r: Replication): Trace['steps'][number] {
  const behind = REPL_LAG_WRITES * BYTES_PER_WRITE
  const sentinel = r === 'sentinel' || r === 'minreplicas'
  return {
    text: `The Primary streams every write to the Replica asynchronously: it replies to the App Server first and sends the command on, so the Replica runs about 20 ms (${REPL_LAG_WRITES} writes) behind.${sentinel ? ` Three Sentinels PING the Primary every second; if it stops answering for ${DOWN_AFTER} s and 2 of them agree, they fail over.` : ' Nothing watches the Primary: promoting the Replica is a manual job.'}${r === 'minreplicas' ? ` The Primary also refuses writes if no replica has acknowledged for ${MAX_LAG} s.` : ''}`,
    nodes: sentinel ? ['Primary', 'Replica', 'Sentinels'] : ['Primary', 'Replica'],
    data: [
      '> INFO replication',
      'role:master',
      'connected_slaves:1',
      `slave0:ip=10.0.2.14,port=6379,state=online,offset=918273645,lag=0`,
      `master_repl_offset:${918273645 + behind}   (${n(behind)} bytes ≈ ${REPL_LAG_WRITES} writes not yet on the replica)`,
      ...(sentinel ? ['', 'sentinel monitor mymaster 10.0.1.11 6379 2', `sentinel down-after-milliseconds mymaster ${DOWN_AFTER * 1000}`] : []),
      ...(r === 'minreplicas' ? ['', 'min-replicas-to-write 1', `min-replicas-max-lag ${MAX_LAG}`] : []),
    ].join('\n'),
  }
}

/** The replica reconnects to a primary that restarted from its own disk. */
function resyncStep(p: Persistence): Trace['steps'][number] {
  const log = (what: string) => `replica log:\nTrying a partial resynchronization (request 3f1c…:${918273645 + REPL_LAG_WRITES * BYTES_PER_WRITE + 1})\nFull resync from master: 9a07…:0\nMASTER <-> REPLICA sync: Flushing old data\nMASTER <-> REPLICA sync: Loading DB in memory\n→ ${what}`
  if (p === 'none')
    return {
      text: 'The Replica reconnects. The restarted Primary is a new instance with an empty dataset, so the Replica does a full resync: it deletes its own copy and loads the Primary\'s. It had all 12 million keys a second ago; now it has none.',
      nodes: ['Primary', 'Replica'],
      data: log('replica now holds 0 keys (it had 12,000,000)'),
    }
  if (p === 'rdb')
    return {
      text: 'The Replica reconnects. It is ahead of the restarted Primary, which only knows the old snapshot, so it does a full resync: it deletes its newer copy and loads the Primary\'s. The writes it held are thrown away too.',
      nodes: ['Primary', 'Replica', 'RDB Snapshot'],
      data: log(`replica rolled back ${dur(SINCE_SNAPSHOT)}, to the snapshot`),
    }
  return {
    text: 'The Replica reconnects and syncs from the restarted Primary. The AOF brought back every acknowledged write, so both hold the same data and nothing is lost.',
    nodes: ['Primary', 'Replica', 'AOF Log'],
    data: 'replica log:\nMASTER <-> REPLICA sync started\n→ primary and replica hold the same writes',
  }
}

function loadStep(p: Persistence, after: number, why: string): Trace['steps'][number] {
  const load = loadTime(p)
  const detail =
    p === 'none'
      ? 'There is nothing to load: it starts empty.'
      : p === 'rdb'
        ? `It loads dump.rdb: ${RDB_GB} GB at about ${LOAD_MB_S} MB/s takes ${dur(load)}.`
        : `It loads the AOF's base snapshot (${dur((RDB_GB * 1000) / LOAD_MB_S)}) and replays the ${n(AOF_TAIL)} commands appended since (${dur(AOF_TAIL / REPLAY_PER_S)}): ${dur(load)}.`
  return {
    text: `${why} ${detail}${load ? ' Meanwhile every command gets a LOADING error.' : ''}`,
    nodes: ['Supervisor', 'Disk', 'Dataset in Memory', 'Primary'],
    data:
      p === 'none'
        ? `t+${dur(after)}: redis-server started\nkeys: 0`
        : `t+${dur(after)}: redis-server started\n${p === 'rdb' ? 'Loading RDB produced by version 7.2' : 'Loading the AOF base, then the incremental file'}\nDB loaded from disk: ${load.toFixed(1)} seconds\n\n> HGETALL cart:4107   (while loading)\n(error) LOADING Redis is loading the dataset in memory`,
  }
}

function sentinelFailover(): Trace['steps'] {
  return [
    {
      text: `The Sentinels get no PING replies. After ${DOWN_AFTER} s each marks the Primary subjectively down; 2 agree, which makes it objectively down, and they elect a leader to run the failover.`,
      nodes: ['Sentinels', 'Primary'],
      data: `+sdown master mymaster 10.0.1.11 6379\n+odown master mymaster 10.0.1.11 6379 #quorum 2/2\n+new-epoch 7\n+try-failover master mymaster 10.0.1.11 6379\n+elected-leader master mymaster 10.0.1.11 6379`,
    },
    {
      text: `The leader sends the Replica REPLICAOF NO ONE, and at about ${FAILOVER} s it is the new Primary. The App Servers ask the Sentinels for the new address and carry on.`,
      nodes: ['Sentinels', 'Replica', 'App Servers'],
      data: `+selected-slave slave 10.0.2.14:6379 10.0.2.14 6379 @ mymaster 10.0.1.11 6379\n+promoted-slave slave 10.0.2.14:6379 10.0.2.14 6379 @ mymaster 10.0.1.11 6379\n+switch-master mymaster 10.0.1.11 6379 10.0.2.14 6379\n\n> SENTINEL get-master-addr-by-name mymaster\n1) "10.0.2.14"\n2) "6379"`,
    },
  ]
}

interface Outcome {
  steps: Trace['steps']
  lost: number | 'all'
  down: number
  downWho: string
  lesson: string
}

function processCrash(p: Persistence, r: Replication): Outcome {
  const { lost, why } = diskLoss(p, 'process')
  const steps: Trace['steps'] = [
    {
      text: 'The Linux OOM killer stops the Redis process. The machine and its OS keep running, so whatever Redis had already handed to the OS survives; its memory does not.',
      nodes: ['Primary', 'Dataset in Memory', 'OS Page Cache'],
      data: `kernel: Out of memory: Killed process 2211 (redis-server)\nmemory: gone · OS page cache: kept · disk: kept\n→ ${why}`,
    },
    loadStep(p, 1, 'The Supervisor (systemd) restarts Redis after 1 s.'),
  ]
  if (r === 'sentinel' || r === 'minreplicas')
    steps.push({
      text:
        p === 'none'
          ? `The Sentinels saw no reply for only 1 s, less than the ${DOWN_AFTER} s they wait. By then the Primary is back, empty, and answering PING, so there is no failover.`
          : `The Sentinels saw no reply for only 1 s, less than the ${DOWN_AFTER} s they wait, and a loading Redis answers PING with LOADING, which Sentinel counts as alive. No failover: everyone waits for the restart.`,
      nodes: ['Sentinels', 'Primary', 'Replica'],
      data:
        p === 'none'
          ? `no reply for 1.0 s of the ${DOWN_AFTER}.0 s needed for +sdown\n> PING   (to the restarted, empty primary)\nPONG`
          : `no reply for 1.0 s of the ${DOWN_AFTER}.0 s needed for +sdown\n> PING   (to the loading primary)\n(error) LOADING Redis is loading the dataset in memory   → counted as available`,
    })
  if (r !== 'single') steps.push(resyncStep(p))
  const replicaWiped = r !== 'single' && p !== 'everysec' && p !== 'always'
  return {
    steps,
    lost,
    down: 1 + loadTime(p),
    downWho: 'every App Server',
    lesson:
      p === 'none' && r !== 'single'
        ? 'With persistence off, a primary that restarts automatically comes back empty, and its replicas copy it. Turn persistence on, or stop the supervisor from restarting the primary so Sentinel can fail over.'
        : replicaWiped
          ? 'A replica copies whatever the restarted primary has, so it can\'t save writes the primary forgot. Persistence decides what a restart keeps.'
          : p === 'none'
            ? 'In-memory only means a crash loses everything. That is fine for a pure cache that can be refilled from the database, not for data you can\'t rebuild.'
            : lost === 0
              ? `Nothing lost: the AOF had every acknowledged write. The cost is the ${dur(1 + loadTime(p))} restart, which grows with the dataset.`
              : 'Snapshots bound the loss to the time since the last one. Shorten the interval, or add the AOF.',
  }
}

function powerCut(p: Persistence, r: Replication): Outcome {
  const { lost, why } = diskLoss(p, 'power')
  const steps: Trace['steps'] = [
    {
      text: 'The Primary\'s machine loses power. Its memory and the OS page cache vanish at once; only what reached the disk survives.',
      nodes: ['Primary', 'Dataset in Memory', 'OS Page Cache', 'Disk'],
      data: `memory: gone · OS page cache: gone · disk: kept\n→ ${why}`,
    },
  ]
  if (r === 'sentinel' || r === 'minreplicas') {
    steps.push(...sentinelFailover())
    steps.push({
      text: `Writes the old Primary acknowledged but hadn't sent yet are lost, because replication is asynchronous: about ${REPL_LAG_WRITES}. The persistence setting doesn't matter here; the new Primary already had the data.`,
      nodes: ['Primary', 'Replica'],
      data: `old master_repl_offset: ${918273645 + REPL_LAG_WRITES * BYTES_PER_WRITE}\nreplica offset at promotion: 918273645\nlost: ${n(REPL_LAG_WRITES * BYTES_PER_WRITE)} bytes ≈ ${REPL_LAG_WRITES} writes`,
    })
    steps.push({
      text: `The old machine boots ${dur(REBOOT)} later. The Sentinels make it a replica of the new Primary; it deletes whatever it loaded and copies the new Primary's data.`,
      nodes: ['Sentinels', 'Primary', 'Replica'],
      data: '+convert-to-slave slave 10.0.1.11:6379 10.0.1.11 6379 @ mymaster 10.0.2.14 6379\n→ back to two copies',
    })
    return {
      steps,
      lost: REPL_LAG_WRITES,
      down: FAILOVER,
      downWho: 'every App Server',
      lesson: 'Sentinel turned a reboot-length outage into seconds. The writes still lost are the replication lag; WAIT 1 100 after an important write narrows that further.',
    }
  }
  if (r === 'replica')
    steps.push({
      text: `The Replica still has everything but the last ${REPL_LAG_WRITES} writes, but nothing promotes it, and at 3 a.m. nobody does it by hand. The App Servers can read from it; writes fail until the Primary is back.`,
      nodes: ['Replica', 'App Servers'],
      data: `role:slave\nmaster_link_status:down\n\n> HINCRBY cart:4107 sku-2291 1   (sent to the replica)\n(error) READONLY You can't write against a read only replica.`,
    })
  steps.push(loadStep(p, REBOOT, `The machine boots after ${dur(REBOOT)} and the Supervisor starts Redis.`))
  if (r === 'replica') steps.push(resyncStep(p))
  return {
    steps,
    lost,
    down: REBOOT + loadTime(p),
    downWho: 'every App Server',
    lesson:
      r === 'replica'
        ? 'A replica without failover keeps reads going but not writes, and it ends up copying the primary\'s losses. Add Sentinel to promote it automatically.'
        : lost === 0
          ? 'fsync on every write lost nothing, at the price of slower writes; a single node still means minutes of downtime.'
          : 'One machine means its reboot is your outage, and its disk is your only copy. Add a replica and Sentinel.',
  }
}

function split(r: Replication): Outcome {
  const sentinel = r === 'sentinel' || r === 'minreplicas'
  const steps: Trace['steps'] = [
    {
      text: `A switch fails. For ${SPLIT} s the Primary's rack, with App Server A${sentinel ? ' and one Sentinel' : ''}, can't reach the rest: ${[r === 'single' ? '' : 'the Replica', sentinel ? 'two Sentinels' : '', 'App Servers B, C and D'].filter(Boolean).join(', ').replace(/, (App Servers B)/, ' and $1')}.`,
      nodes: ['Primary', ...(r === 'single' ? [] : ['Replica']), ...(sentinel ? ['Sentinels'] : []), 'App Servers'],
      data: `rack 1: Primary 10.0.1.11, App Server A (${n(RACK_A)} writes/s)${sentinel ? ', Sentinel 1' : ''}\nrack 2: ${r === 'single' ? '' : 'Replica 10.0.2.14, '}${sentinel ? 'Sentinels 2 and 3, ' : ''}App Servers B, C, D (${n(RATE - RACK_A)} writes/s)\nsplit lasts ${SPLIT} s`,
    },
  ]
  if (r === 'single' || r === 'replica') {
    const behindMb = (SPLIT * RACK_A * BYTES_PER_WRITE) / 1e6
    steps.push({
      text: `App Servers B, C and D can't reach the Primary, so their writes fail for ${SPLIT} s. App Server A keeps writing.${r === 'replica' ? ' The Replica serves reads that grow stale.' : ''}`,
      nodes: r === 'replica' ? ['App Servers', 'Primary', 'Replica'] : ['App Servers', 'Primary'],
      data: `App Server B> HINCRBY cart:5120 sku-1180 1\n(error) connection timed out\n\nApp Server A> HINCRBY cart:4107 sku-2291 1\n(integer) 2`,
    })
    if (r === 'replica')
      steps.push({
        text: `The network heals. The Replica missed ${dur(SPLIT)} of App Server A's writes, about ${behindMb.toFixed(1)} MB, more than the ${BACKLOG_MB} MB replication backlog, so it needs a full resync: the Primary sends the whole ${RDB_GB} GB snapshot.`,
        nodes: ['Primary', 'Replica', 'RDB Snapshot'],
        data: `missed: ${SPLIT} s × ${n(RACK_A)} writes/s × ${BYTES_PER_WRITE} bytes = ${behindMb.toFixed(1)} MB\nrepl-backlog-size ${BACKLOG_MB}mb → partial resync impossible\nFull resync: ${RDB_GB} GB snapshot sent to the replica`,
      })
    return {
      steps,
      lost: 0,
      down: SPLIT,
      downWho: 'App Servers B, C and D',
      lesson: 'With one primary and no failover, a split costs availability but never data: there is only ever one place to write.',
    }
  }
  steps.push(...sentinelFailover())
  const keepsWriting = r === 'minreplicas' ? MAX_LAG : SPLIT
  const lost = keepsWriting * RACK_A
  steps.push({
    text:
      r === 'minreplicas'
        ? `Now there are two Primaries. App Server A still writes to the old one, until it notices no replica has acknowledged for ${MAX_LAG} s and starts refusing writes.`
        : `Now there are two Primaries. App Server A still writes to the old one for the whole ${SPLIT} s, and it accepts every write: this is split brain.`,
    nodes: ['App Servers', 'Primary', 'Replica'],
    data:
      r === 'minreplicas'
        ? `old primary: accepts App Server A's writes for ${MAX_LAG} s, then\nApp Server A> HINCRBY cart:4107 sku-2291 1\n(error) NOREPLICAS Not enough good replicas to write.\nnew primary: B, C and D, ${n(RATE - RACK_A)} writes/s`
        : `old primary: App Server A, ${n(RACK_A)} writes/s for ${SPLIT} s\nnew primary: B, C and D, ${n(RATE - RACK_A)} writes/s`,
  })
  steps.push({
    text: `The network heals. The Sentinels turn the old Primary into a replica of the new one, so it deletes its data and copies the new Primary's. Every write App Server A made to it after the split disappears.`,
    nodes: ['Sentinels', 'Primary', 'Replica'],
    data: `+convert-to-slave slave 10.0.1.11:6379 10.0.1.11 6379 @ mymaster 10.0.2.14 6379\nlost: ${keepsWriting} s × ${n(RACK_A)} writes/s = ${n(lost)} acknowledged writes`,
  })
  return {
    steps,
    lost,
    down: FAILOVER,
    downWho: r === 'minreplicas' ? `App Servers B, C and D (App Server A gets errors for the last ${SPLIT - MAX_LAG} s)` : 'App Servers B, C and D',
    lesson:
      r === 'minreplicas'
        ? `min-replicas-to-write cut the loss from ${n(SPLIT * RACK_A)} to ${n(lost)} writes, not to zero: Redis replication is asynchronous, so a split can always lose some acknowledged writes.`
        : `Failover traded downtime for data: ${n(lost)} acknowledged writes went to a primary that was about to be overwritten. min-replicas-to-write bounds that window.`,
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'persistence', label: 'Persistence', options: Object.keys(PERSISTENCE) },
    { id: 'replication', label: 'Replication', options: Object.keys(REPLICATION) },
    { id: 'failure', label: 'Failure', options: Object.keys(FAILURE) },
  ],
  defaults: { persistence: 'RDB snapshot every 5 min', replication: 'Single node', failure: 'Power cut (reboots in 3 min)' },
  run({ persistence, replication, failure }) {
    const p = PERSISTENCE[persistence] ?? 'rdb'
    const r = REPLICATION[replication] ?? 'single'
    const f = FAILURE[failure] ?? 'power'
    const out = f === 'process' ? processCrash(p, r) : f === 'power' ? powerCut(p, r) : split(r)
    const steps: Trace['steps'] = [
      {
        text: `Four App Servers send about ${n(RATE)} writes a second to the Primary, which holds the whole dataset, ${n(KEYS)} shopping carts and sessions in ${MEMORY_GB} GB, in memory.`,
        nodes: ['App Servers', 'Primary', 'Dataset in Memory'],
        data: `writes: ${n(RATE)}/s\nkeys: ${n(KEYS)} · used_memory: ${MEMORY_GB}.0 GB\n${PERSIST_CONFIG[p]}`,
      },
      persistStep(p),
      ...(r === 'single' ? [] : [replicationStep(r)]),
      ...out.steps,
      {
        text: `Result: ${lostText(out.lost)} lost, and writes failed for ${dur(out.down)} for ${out.downWho}. ${out.lesson}`,
        nodes: ['App Servers', 'Primary', ...(r === 'single' ? [] : ['Replica'])],
        data: `acknowledged writes lost: ${out.lost === 'all' ? `everything (${n(KEYS)} keys)` : n(out.lost)}\nwrites failing for: ${dur(out.down)}${f === 'split' && p !== 'none' ? '\npersistence: no effect on a split, which loses data through replication, not the disk' : ''}`,
      },
    ]
    return { input: `${persistence} · ${replication} · ${failure.toLowerCase()} → ${lostText(out.lost)} lost, ${dur(out.down)} of failed writes`, steps }
  },
}

const run = (persistence: string, replication: string, failure: string) => ({ persistence, replication, failure })

export const redisPersistence: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'redis-persistence',
  title: 'Redis Persistence and Replication',
  blurb: 'RDB snapshots, the AOF, replicas, Sentinel failover and split brain: what each failure really loses',
  guides: ['how-does-redis-persist-data', 'how-do-big-keys-impact-redis-persistence', 'how-redis-architecture-evolve', 'scale-replication', 'scale-moving-persistent-data-out-of-redis-at-github', 'scale-redis-fleet-at-heroku'],
  story: {
    title: 'The cart store that kept forgetting',
    dek: 'An online shop keeps 12 million carts and sessions in one Redis. Over a year it loses data five different ways, and each fix teaches what the last one couldn\'t.',
    chapters: [
      {
        heading: 'Fast, and gone',
        body: `Tomás ran the shop's cart service. Redis held every cart, with persistence off: "it's only carts", and writes were as fast as memory.

One evening the Linux **OOM killer** (the kernel's out-of-memory killer) stopped the Redis process. systemd restarted it a second later, empty. Twelve million carts were gone, and support spent a week apologising.

Redis keeps data in memory. Unless you ask it to write to the disk, a stopped process is a lost dataset.`,
        replay: { label: 'Replay the crash', values: run('No persistence', 'Single node', 'Process crash (restarts in 1 s)') },
      },
      {
        heading: 'The replica that copied an empty primary',
        body: `The fix seemed simple: add a **replica**, a second Redis that receives every write. Persistence stayed off.

Two months later the primary crashed again and systemd restarted it again, empty, within a second. The replica reconnected, saw a new primary, and did what replicas do: a **full resync**. It deleted its own perfect copy and loaded the primary's, which had nothing in it.

> A replica copies its primary, mistakes included. Replication isn't a backup.`,
        replay: { label: 'Replay the wipe', values: run('No persistence', 'Primary + replica', 'Process crash (restarts in 1 s)') },
      },
      {
        heading: 'Snapshots, and the five minutes they miss',
        body: `Tomás turned on **RDB** snapshots: every 5 minutes Redis forks a child that writes the whole dataset to \`dump.rdb\`. Restarts brought the carts back.

Then the data centre lost power. The machine came back after 3 minutes, Redis loaded the snapshot, and everything since it, \`4 min 10 s × 2,000 writes/s = 500,000\` changes, was gone. Snapshots bound the loss to the time since the last one; they can't make it zero.`,
        replay: { label: 'Replay the power cut', values: run('RDB snapshot every 5 min', 'Single node', 'Power cut (reboots in 3 min)') },
      },
      {
        heading: 'A log of every write',
        body: `Next came the **AOF** (append-only file): every write command is appended to a log, and on start-up Redis replays it. The question is when the log reaches the disk. \`appendfsync everysec\` calls **fsync**, which forces the OS to write its cache to the disk, once a second.

A process crash now lost nothing: the OS still held the log in its page cache and flushed it. A power cut loses up to about a second. \`appendfsync always\` loses nothing even then, but every write waits for the disk, and the shop didn't need it.`,
        replay: { label: 'Replay with the AOF', values: run('AOF, fsync every second', 'Single node', 'Power cut (reboots in 3 min)') },
      },
      {
        heading: 'Seven seconds instead of three minutes',
        body: `Persistence kept the data, but a reboot was still 3 minutes of failed checkouts. **Sentinel** fixed that: three small processes that watch the primary. If it doesn't answer for 5 seconds and two of them agree, they elect a leader, which promotes the replica and tells clients the new address.

The next power cut cost about 7 seconds of errors and the ~40 writes the replica hadn't received yet, because replication is **asynchronous**: the primary replies before the replica has the write.`,
        replay: { label: 'Replay the failover', values: run('AOF, fsync every second', 'Primary + replica + Sentinel', 'Power cut (reboots in 3 min)') },
      },
      {
        heading: 'Two primaries for thirty seconds',
        body: `The last lesson came from a failed switch. For 30 seconds the primary and one app server were cut off from everything else. The Sentinels on the other side promoted the replica, so there were **two primaries**, and the stranded app server kept writing to the old one. When the network healed, the old primary became a replica and threw those 15,000 writes away. That's **split brain**.

\`min-replicas-to-write 1\` with \`min-replicas-max-lag 10\` makes a primary refuse writes once no replica has acknowledged for 10 seconds. It cut the loss to 5,000, not to zero. Redis replication is asynchronous, so a failover can always lose some acknowledged writes; data that must never be lost belongs in a database built for it.`,
        replay: { label: 'Replay the split', values: run('AOF, fsync every second', 'Sentinel + min-replicas-to-write', '30 s network split') },
      },
    ],
  },
  takeaways: [
    'Without persistence a Redis restart is an empty Redis, and a replica of it becomes empty too.',
    'RDB snapshots lose everything since the last snapshot; the AOF with fsync every second loses at most about a second, and nothing on a process crash.',
    'Persistence decides what a restart keeps; replication with Sentinel decides how long writes fail.',
    'Replication is asynchronous, so a failover loses the writes the replica hadn\'t received yet.',
    'A network split can create two primaries; min-replicas-to-write limits the writes lost to the stranded one but can\'t make it zero.',
    'Replication isn\'t a backup: copy RDB files off the machine, and keep data you can\'t lose in a database.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'm1', label: 'Primary machine (rack 1)' },
      { id: 'm2', label: 'Replica machine (rack 2)' },
    ],
    nodes: [
      { id: 'app', label: 'App Servers', shape: 'rectangle', color: 'blue', group: null },
      { id: 'sentinels', label: 'Sentinels', shape: 'diamond', color: 'violet', group: null },
      { id: 'primary', label: 'Primary', shape: 'rectangle', color: 'red', group: 'm1' },
      { id: 'memory', label: 'Dataset in Memory', shape: 'rectangle', color: 'red', group: 'm1' },
      { id: 'aof', label: 'AOF Log', shape: 'rectangle', color: 'green', group: 'm1' },
      { id: 'rdb', label: 'RDB Snapshot', shape: 'rectangle', color: 'green', group: 'm1' },
      { id: 'cache', label: 'OS Page Cache', shape: 'rectangle', color: 'orange', group: 'm1' },
      { id: 'disk', label: 'Disk', shape: 'rectangle', color: 'green', group: 'm1' },
      { id: 'supervisor', label: 'Supervisor', shape: 'rectangle', color: 'orange', group: 'm1' },
      { id: 'replica', label: 'Replica', shape: 'rectangle', color: 'red', group: 'm2' },
    ],
    edges: [
      { from: 'app', to: 'primary', label: 'writes', dashed: false },
      { from: 'app', to: 'sentinels', label: 'where is the primary?', dashed: true },
      { from: 'primary', to: 'memory', label: 'apply', dashed: false },
      { from: 'primary', to: 'aof', label: 'append each write', dashed: false },
      { from: 'memory', to: 'rdb', label: 'fork + snapshot', dashed: false },
      { from: 'aof', to: 'cache', label: 'write()', dashed: false },
      { from: 'rdb', to: 'cache', label: 'write()', dashed: false },
      { from: 'cache', to: 'disk', label: 'fsync', dashed: false },
      { from: 'disk', to: 'memory', label: 'load on start-up', dashed: true },
      { from: 'supervisor', to: 'primary', label: 'restart', dashed: true },
      { from: 'primary', to: 'replica', label: 'async replication', dashed: false },
      { from: 'sentinels', to: 'primary', label: 'PING every 1 s', dashed: true },
      { from: 'sentinels', to: 'replica', label: 'promote', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Redis Persistence and Replication',
    summary:
      'Redis keeps data in memory, so what survives a failure depends on two separate choices: persistence (RDB snapshots and the append-only file) decides what a restarted node still has, and replication with Sentinel decides whether another node takes over, and how fast. Replication is asynchronous, so failovers and network splits can lose acknowledged writes.',
    sections: [
      {
        heading: 'Overview',
        body: 'Two kinds of protection, for two kinds of failure:\n- Persistence writes the dataset to the disk so a restarted Redis can load it back. RDB writes a point-in-time snapshot every so often; the AOF (append-only file) logs every write command and replays them on start-up.\n- Replication keeps a second copy on another machine, and Sentinel promotes it automatically when the primary stops answering.\n\nThe simulator models a 4 GB, 12-million-key cart store taking 2,000 writes a second, and works out the acknowledged writes lost and the seconds of failed writes for each combination of persistence, replication and failure.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Carts and sessions survive a Redis restart.\n- Writes keep working when the primary\'s machine dies.\n\nNon-functional:\n- Lose at most about a second of writes in a crash.\n- Fail over in seconds, without a person.\n- Keep write latency well under a millisecond.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Dataset: 12 million keys in 4 GB of memory; the RDB file compresses to about 1.6 GB.\n- RDB loss: a crash 4 min 10 s after a snapshot loses 250 s × 2,000 writes/s = 500,000 writes.\n- Restart time: 1.6 GB at about 100 MB/s ≈ 16 s to load the RDB; the AOF adds replaying 2.4 million commands at about 400,000/s ≈ 6 s, so 22 s.\n- Fork: about 13 ms per GB of memory on a typical VM, so ≈ 50 ms pause per snapshot or AOF rewrite.\n- Replication lag: about 20 ms, which is 40 writes at 2,000/s.\n- Split brain: 30 s × 500 writes/s from the stranded app server = 15,000 writes; capped at 10 s × 500 = 5,000 with min-replicas-max-lag 10.',
      },
      {
        heading: 'Step by step',
        body: '1. App Servers send writes to the Primary, which applies them to the Dataset in Memory.\n2. With the AOF on, the Primary appends each command to the AOF Log; write() puts it in the OS Page Cache and fsync moves it to the Disk.\n3. With RDB on, the Primary forks and the child writes an RDB Snapshot of the Dataset in Memory to the Disk.\n4. The Primary streams each write to the Replica, after replying to the App Servers.\n5. The Sentinels PING the Primary every second; if it stays silent for 5 s and two agree, they promote the Replica and tell the App Servers.\n6. If the Primary process dies, the Supervisor restarts it, and it loads the Disk back into the Dataset in Memory.',
      },
      {
        heading: 'Components',
        body: '- App Servers: the clients; they find the primary through the Sentinels.\n- Sentinels: three watcher processes that detect a dead primary, agree, and promote a replica.\n- Primary: the Redis node that accepts writes.\n- Dataset in Memory: every key, held in RAM; lost when the process or machine stops.\n- AOF Log: the append-only file of every write command, replayed on start-up.\n- RDB Snapshot: a compact point-in-time copy written by a forked child process.\n- OS Page Cache: the kernel\'s memory buffer for files; survives a process crash, not a power cut.\n- Disk: where the AOF and RDB files survive a restart.\n- Supervisor: systemd or a container runtime that restarts the process when it dies.\n- Replica: a second copy on another machine, kept up to date asynchronously; read-only until promoted.',
      },
      {
        heading: 'Key decisions',
        body: '- Pure cache (data can be rebuilt from the database): persistence off is fine, but then don\'t let a restarted empty primary feed replicas.\n- Most uses: AOF with appendfsync everysec, plus RDB snapshots for fast restarts and backups.\n- appendfsync always only when losing a second is unacceptable and slower writes are not.\n- Add a replica and Sentinel (or a managed service with automatic failover) when minutes of downtime are unacceptable.\n- min-replicas-to-write 1 with min-replicas-max-lag 10 to bound split-brain loss, accepting that writes stop if every replica is down.\n- WAIT numreplicas timeout after a critical write to wait until a replica has it; it narrows the window but isn\'t a transaction.\n- Backups: copy RDB files off the machine (to object storage) on a schedule; a replica copies deletions and bugs too.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Big datasets mean slow restarts: loading time grows with memory, and a loading Redis answers LOADING, which Sentinel treats as alive.\n- Forking a large instance pauses it and can double memory under heavy writes (copy-on-write); leave headroom below maxmemory.\n- The AOF grows forever until rewritten: BGREWRITEAOF (or auto-aof-rewrite-percentage) compacts it into a new base.\n- A replica that falls further behind than the replication backlog needs a full resync, which copies the whole dataset; size repl-backlog-size for your longest expected disconnect.\n- Redis Cluster shards keys across primaries, each with its own replicas; the same persistence and failover rules apply per shard.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- RDB or AOF: what does each lose in a power cut, and why use both?\n- Why can a replica end up empty after its primary crashes?\n- How does Sentinel decide a primary is down, and why does it need a quorum?\n- What is split brain, and what does min-replicas-to-write actually guarantee?\n- Why isn\'t replication a backup?\n- When would you not use Redis as the source of truth?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A durable redis.conf (bash)',
        language: 'bash',
        source: `cat > /etc/redis/redis.conf <<'EOF'
# Log every write; fsync once a second (a power cut loses about a second).
appendonly yes
appendfsync everysec
# Snapshots too: faster restarts, and a file to back up.
save 300 1
# Refuse writes once no replica has acked for 10 s (bounds split brain).
min-replicas-to-write 1
min-replicas-max-lag 10
# A bigger backlog lets a replica catch up after a longer disconnect.
repl-backlog-size 64mb
maxmemory 6gb
EOF

# Back up the latest snapshot off the machine every hour.
aws s3 cp /var/lib/redis/dump.rdb "s3://shop-redis-backups/$(date -u +%Y-%m-%dT%H).rdb"`,
      },
      {
        title: 'Three Sentinels watching the primary (bash)',
        language: 'bash',
        source: `# sentinel.conf, the same on all three Sentinel machines
cat > /etc/redis/sentinel.conf <<'EOF'
sentinel monitor mymaster 10.0.1.11 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
sentinel parallel-syncs mymaster 1
EOF
redis-sentinel /etc/redis/sentinel.conf

# Which node is the primary right now?
redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
# 1) "10.0.1.11"
# 2) "6379"`,
      },
      {
        title: 'Connecting through Sentinel (TypeScript)',
        language: 'typescript',
        source: `import Redis from 'ioredis'

// The client asks the Sentinels where the primary is, and asks again after a failover.
const redis = new Redis({
  sentinels: [
    { host: '10.0.3.21', port: 26379 },
    { host: '10.0.3.22', port: 26379 },
    { host: '10.0.3.23', port: 26379 },
  ],
  name: 'mymaster',
})

export async function addToCart(cartId: string, sku: string) {
  return redis.hincrby(\`cart:\${cartId}\`, sku, 1)
}`,
      },
      {
        title: 'WAIT for a replica on key writes (Python)',
        language: 'python',
        source: `import redis

r = redis.Redis(host="10.0.1.11", port=6379)

def place_order_hold(order_id: str, cart_id: str) -> bool:
    r.hset(f"hold:{order_id}", mapping={"cart": cart_id, "status": "held"})
    # Block up to 100 ms until at least one replica has the write.
    # It narrows the async window; it isn't a guarantee.
    acked = r.wait(1, 100)
    return acked >= 1`,
      },
    ],
    related: ['Redis Basics', 'Distributed cache', 'Replication', 'Leader election', 'Write-ahead log'],
  },
  simulator,
}
