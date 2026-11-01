import type { Trace } from '@structura/shared'
import { json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A Dynamo-style key-value store: four nodes on a hash ring, every key stored on
// three of them (N=3). The simulator places the nodes and the key on the ring
// with a real hash, picks the real "preference list", and applies the quorum
// arithmetic (a write needs W acks, a read needs R replies) to show when a read
// returns stale data.

const N = 3
const NODES = ['Node A', 'Node B', 'Node C', 'Node D']
const RING = 2 ** 32

/** Position on the ring. FNV alone clusters names that differ in one letter, so finish with murmur3's mixer. */
function hashPos(text: string): number {
  let h = stableHash(text)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Where each node sits on the ring (its token), sorted clockwise from 0. */
const ring = NODES.map((name) => ({ name, token: hashPos(name) })).sort((a, b) => a.token - b.token)

/** The first N distinct nodes clockwise from the key's position, then the spare that holds hints. */
export function preferenceList(key: string) {
  const pos = hashPos(key)
  let start = ring.findIndex((n) => n.token >= pos)
  if (start < 0) start = 0 // wrapped past the last token
  const order = Array.from({ length: ring.length }, (_, i) => ring[(start + i) % ring.length])
  return { pos, replicas: order.slice(0, N), spare: order[N] }
}

const pct = (n: number) => `${((n / RING) * 100).toFixed(1)}%`

const QUORUMS: Record<string, { w: number; r: number }> = {
  'W=1, R=1 (fast)': { w: 1, r: 1 },
  'W=2, R=2 (quorum)': { w: 2, r: 2 },
  'W=3, R=1 (write to all)': { w: 3, r: 1 },
}
const FAILURES = ['All nodes healthy', 'One replica missed the write', 'Two replicas missed the write']

const simulator: Simulator = {
  fields: [
    { id: 'key', label: 'Key', options: ['cart:alice', 'cart:bob', 'session:9f3a'] },
    { id: 'quorum', label: 'Quorum setting', options: Object.keys(QUORUMS) },
    { id: 'failure', label: 'What goes wrong', options: FAILURES },
  ],
  defaults: { key: 'cart:alice', quorum: 'W=2, R=2 (quorum)', failure: 'One replica missed the write' },
  run({ key, quorum, failure }) {
    const { w, r } = QUORUMS[quorum] ?? QUORUMS['W=2, R=2 (quorum)']
    const { pos, replicas, spare } = preferenceList(key)
    const missed = failure === FAILURES[1] ? 1 : failure === FAILURES[2] ? 2 : 0
    // The replicas at the end of the list are the ones that were down.
    const alive = replicas.slice(0, N - missed)
    const down = replicas.slice(N - missed)
    const acked = alive.length
    const ok = acked >= w
    const names = (l: { name: string }[]) => l.map((n) => n.name).join(', ')
    const oldV = { items: ['milk'], ts: 1_700_000_000_100 }
    const newV = { items: ['milk', 'eggs'], ts: 1_700_000_005_200 }
    const ringText = ring.map((n) => `${n.name} @ ${pct(n.token)}`).join('  →  ')

    const steps: Trace['steps'] = [
      {
        text: `The client sends put(${key}) to the Coordinator (any node can coordinate, and the client just picked one). It hashes the key onto the ring.`,
        nodes: ['Client App', 'Coordinator (any node)'],
        data: `PUT ${key}\n${json(newV)}\nW=${w}, R=${r}, N=${N}`,
      },
      {
        text: `The key hashes to ${pct(pos)} of the ring. Walking clockwise, the next ${N} distinct nodes are its replicas: ${names(replicas)}. That "preference list" is the same on every node, so nobody has to ask a central server.`,
        nodes: ['Hash Ring (token map)', ...replicas.map((n) => n.name)],
        data: `hash("${key}") = ${pos} (${pct(pos)} of the ring)\nring: ${ringText}\npreference list: [${names(replicas)}]\nnext spare for hints: ${spare.name}`,
      },
      {
        text: `The Coordinator sends the write to all ${N} replicas at once. ${
          missed
            ? `${names(down)} ${down.length > 1 ? 'are' : 'is'} down, so only ${acked} of ${N} can answer.`
            : `All ${N} answer.`
        } Each replica appends to its Commit Log first, so a crash cannot lose the write, then updates its Memtable.`,
        nodes: ['Coordinator (any node)', 'Commit Log (WAL)', 'Memtable (in memory)', ...alive.map((n) => n.name)],
        data: `${alive.map((n) => `${n.name}: WAL append ✓, memtable set ✓`).join('\n')}${down.map((n) => `\n${n.name}: no answer ✗`).join('')}`,
      },
    ]

    if (missed) {
      steps.push({
        text: `The Coordinator hands the missed write to ${spare.name} as a hint ("give this to ${names(down)} when it is back"). Gossip tells everyone when the node returns, and the hint is replayed then. Until that happens the node is stale.`,
        nodes: ['Gossip (membership)', 'Hinted Handoff Store', spare.name],
        data: `hint on ${spare.name}: { for: [${names(down)}], key: "${key}", value: v2 (ts ${newV.ts}) }`,
      })
    }

    steps.push({
      text: ok
        ? `${acked} acks arrived and W=${w}, so the Coordinator tells the client "written". The write is durable on ${acked} of ${N} machines.`
        : `Only ${acked} ack${acked === 1 ? '' : 's'} arrived but W=${w}. The Coordinator answers the client with an error. Nothing is rolled back: the ${acked} node${acked === 1 ? '' : 's'} that took the write keep it, so a later read may still see it.`,
      nodes: ['Coordinator (any node)', 'Client App'],
      data: ok ? `HTTP 200  acks=${acked}/${N} (needed ${w})` : `HTTP 503  acks=${acked}/${N} (needed ${w})\n✗ write not confirmed, yet ${names(alive)} still hold v2`,
    })

    // Worst case for the reader: the R replicas that answer first are the last in the list.
    const readSet = replicas.slice(N - r)
    const fresh = readSet.filter((n) => alive.includes(n))
    const stale = readSet.filter((n) => !alive.includes(n))
    const gotNew = fresh.length > 0
    steps.push({
      text: `Later, the client reads ${key}. The Coordinator asks the replicas and waits for R=${r} replies. To show the worst case, the first ${r} to answer are ${names(readSet)}.`,
      nodes: ['Client App', 'Coordinator (any node)', ...readSet.map((n) => n.name)],
      data: `GET ${key}\n${fresh.map((n) => `${n.name} → v2 (ts ${newV.ts})`).concat(stale.map((n) => `${n.name} → v1 (ts ${oldV.ts})`)).join('\n')}`,
    })

    if (gotNew) {
      steps.push({
        text: `The read set and the write set overlap (${names(fresh)} saw both), so the Coordinator can see the newest version by timestamp and returns v2.${
          stale.length ? ` It also notices ${names(stale)} returned an old version and sends it v2 (read repair).` : ''
        }`,
        nodes: stale.length ? ['Coordinator (any node)', 'Read Repair', ...stale.map((n) => n.name)] : ['Coordinator (any node)', 'Client App'],
        data: `newest wins: v2 (ts ${newV.ts})${stale.length ? `\nrepair → ${names(stale)}: set(${key}, v2)` : ''}\n${w} + ${r} ${w + r > N ? '>' : '≤'} ${N}`,
      })
    } else {
      steps.push({
        text: `Every node that answered had missed the write, so the Coordinator returns the old cart. W + R = ${w + r}, which is not more than N = ${N}, so the sets were not forced to overlap. This is eventual consistency: v2 appears once the hint is replayed or read repair runs.`,
        nodes: ['Coordinator (any node)', 'Client App'],
        data: `${names(readSet)} → v1 (ts ${oldV.ts})\nreturned to client: ${json(oldV)}\n${w} + ${r} ${w + r > N ? '>' : '≤'} ${N}  → stale read`,
      })
    }

    steps.push({
      text: `Inside one replica, a write lands in the Memtable; when it is full it is flushed as an immutable SSTable file, and reads check the Memtable first, then SSTables, newest first. Old SSTables are merged (compacted) in the background.`,
      nodes: ['Memtable (in memory)', 'SSTables (on disk)'],
      data: `memtable ${key} → v2\nsstable-0042.db (flushed 14:02) has ${key} → v1\nread order: memtable, then sstables newest → oldest`,
    })

    return {
      input: `${key}, ${quorum}, ${failure.toLowerCase()}`,
      steps,
    }
  },
}

export const keyValueStore: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'key-value-store',
  title: 'Key-Value Store (Dynamo-style)',
  blurb: 'Hash ring, replication, quorum reads and writes, hinted handoff and LSM storage',
  guides: [
    'primer-design-a-key-value-store-for-a-search-engine',
    'consistent-hashing',
    'primer-availability-vs-consistency',
    'primer-consistency-patterns',
    'cap-theorem-one-of-the-most-misunderstood-terms',
    'b-tree-vs',
    '8-data-structures-that-power-your-databases',
    'a-crash-course-in-database-sharding',
  ],
  takeaways: [
    'A hash ring spreads keys over nodes, and every node can compute where a key lives, so there is no master to fail.',
    'Each key is copied to N nodes; W acks make a write safe and R replies make a read fresh.',
    'If W + R is greater than N, a read must touch at least one node that saw the latest successful write.',
    'Hinted handoff and read repair heal the replicas that missed writes, so the store converges (eventual consistency).',
    'Writes go to a commit log, then a memtable, then immutable SSTables: sequential disk writes make them fast.',
    'Pick W and R per workload: W=1, R=1 is fastest and can be stale; W=2, R=2 trades latency for fresher reads.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'cluster', label: 'Storage cluster (N = 3 replicas per key)' },
      { id: 'local', label: 'Inside one node' },
    ],
    nodes: [
      { id: 'client', label: 'Client App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'coord', label: 'Coordinator (any node)', shape: 'rectangle', color: 'violet', group: null },
      { id: 'ring', label: 'Hash Ring (token map)', shape: 'diamond', color: 'violet', group: null },
      { id: 'a', label: 'Node A', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'b', label: 'Node B', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'c', label: 'Node C', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'd', label: 'Node D', shape: 'rectangle', color: 'green', group: 'cluster' },
      { id: 'gossip', label: 'Gossip (membership)', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'hints', label: 'Hinted Handoff Store', shape: 'rectangle', color: 'yellow', group: 'cluster' },
      { id: 'repair', label: 'Read Repair', shape: 'rectangle', color: 'orange', group: null },
      { id: 'wal', label: 'Commit Log (WAL)', shape: 'rectangle', color: 'yellow', group: 'local' },
      { id: 'mem', label: 'Memtable (in memory)', shape: 'rectangle', color: 'red', group: 'local' },
      { id: 'sst', label: 'SSTables (on disk)', shape: 'rectangle', color: 'green', group: 'local' },
    ],
    edges: [
      { from: 'client', to: 'coord', label: 'get / put', dashed: false },
      { from: 'coord', to: 'ring', label: 'who owns this key?', dashed: false },
      { from: 'ring', to: 'a', label: 'replica 1', dashed: false },
      { from: 'ring', to: 'b', label: 'replica 2', dashed: false },
      { from: 'ring', to: 'c', label: 'replica 3', dashed: false },
      { from: 'coord', to: 'hints', label: 'replica down', dashed: true },
      { from: 'hints', to: 'd', label: 'holds hint', dashed: true },
      { from: 'gossip', to: 'coord', label: 'node up / down', dashed: true },
      { from: 'coord', to: 'repair', label: 'stale reply seen', dashed: true },
      { from: 'repair', to: 'c', label: 'send newest', dashed: true },
      { from: 'a', to: 'wal', label: '1. append', dashed: false },
      { from: 'wal', to: 'mem', label: '2. update', dashed: false },
      { from: 'mem', to: 'sst', label: '3. flush when full', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'kv_entries',
        name: 'kv_entries',
        columns: [
          { name: 'key', type: 'bytes', pk: true, fk: null, nullable: false, unique: false },
          { name: 'value', type: 'bytes', pk: false, fk: null, nullable: true, unique: false },
          { name: 'timestamp_ms', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'tombstone', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'hints',
        name: 'hints',
        columns: [
          { name: 'target_node', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'key', type: 'bytes', pk: true, fk: 'kv_entries.key', nullable: false, unique: false },
          { name: 'value', type: 'bytes', pk: false, fk: null, nullable: true, unique: false },
          { name: 'timestamp_ms', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [{ from: 'hints', to: 'kv_entries', kind: 'one-to-many', label: 'replays' }],
  },
  explanation: {
    title: 'Key-Value Store (Dynamo-style)',
    summary:
      'A key-value store only offers get(key) and put(key, value), which lets it spread over many machines and keep working when some fail. Keys are placed on a hash ring, each key is copied to N nodes, and quorum rules (W acks to write, R replies to read) let you choose between speed and fresh reads.',
    sections: [
      {
        heading: 'Overview',
        body: "A relational database makes you pay for joins and transactions even when you only ever look things up by id. A key-value store drops them. You give up rich queries and get the ability to add machines and survive failures with no single master.\n\nThis design follows Amazon's Dynamo paper and systems like Cassandra and Riak: every node is equal, data is copied to several nodes, and the system favours staying available over always being perfectly consistent (in CAP terms, it is AP by default, with tunable consistency).",
      },
      {
        heading: 'Requirements',
        body: '- get(key) and put(key, value), with values up to a few KB.\n- Low latency (single-digit milliseconds at the 99th percentile).\n- Highly available: keep accepting writes when a node or a whole rack is down.\n- Scales out by adding nodes, with little data moved.\n- Tunable consistency per request. Not needed: joins, secondary indexes, multi-key transactions.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 2 billion keys of 1 KB each, 100,000 reads/s and 20,000 writes/s at peak.\n- Raw data: 2 × 10⁹ × 1 KB = 2 TB; with N = 3 copies, 6 TB.\n- At 1 TB of usable disk per node, run them half full for compaction and growth: 6 TB ÷ 0.5 TB = 12 nodes by disk.\n- Replica operations: writes touch 3 replicas (20,000 × 3 = 60,000/s); reads at R = 2 touch 2 (100,000 × 2 = 200,000/s). Total 260,000/s. At about 20,000 operations/s per node, that is 13 nodes, so around 16 with headroom.\n- A Bloom filter (a compact "definitely not here" check) at a 1% false-positive rate needs about 9.6 bits per key. With 2 × 10⁹ × 3 ÷ 16 = 375 million keys per node, that is about 450 MB of RAM per node, which saves most disk reads for missing keys.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client App sends put(key, value) or get(key) to any node, which becomes the Coordinator (any node) for this request.\n2. The Coordinator hashes the key and looks it up on the Hash Ring (token map) to find the N = 3 replicas, for example Node A, Node B and Node C.\n3. For a write, it sends the value to all replicas. Each appends to its Commit Log (WAL), then updates its Memtable (in memory).\n4. When the Memtable is full it is flushed to SSTables (on disk), immutable sorted files.\n5. Once W replicas acknowledge, the Coordinator answers the Client App.\n6. If a replica is down, Gossip (membership) has marked it, and the write for it is kept in the Hinted Handoff Store on a spare node such as Node D.\n7. For a read, the Coordinator waits for R replies and returns the newest version by timestamp.\n8. If some replicas returned old data, Read Repair sends them the newest version.',
      },
      {
        heading: 'Components',
        body: '- Client App: calls get and put through a client library that knows a few nodes.\n- Coordinator (any node): the node that received the request; it routes to replicas and counts acks and replies.\n- Hash Ring (token map): maps hash(key) to the next N distinct nodes clockwise; every node holds a copy.\n- Node A: a storage node; owns a slice of the ring and is a replica for the two slices before it.\n- Node B: an equal peer; there is no leader.\n- Node C: an equal peer; adding a node only moves data from its neighbours.\n- Node D: also a peer, and here the spare that keeps hints for a down replica.\n- Gossip (membership): nodes exchange who is up and who is down every second, so failures are noticed without a central monitor.\n- Hinted Handoff Store: holds writes meant for a down node and replays them when it returns.\n- Read Repair: fixes replicas found stale during a read.\n- Commit Log (WAL): an append-only file written first, so a crash can replay the memtable.\n- Memtable (in memory): a sorted in-memory table that absorbs recent writes.\n- SSTables (on disk): immutable sorted files; background compaction merges them and drops overwritten values and deleted keys.',
      },
      {
        heading: 'Key decisions',
        body: '- Consistent hashing with virtual nodes: each machine owns many small slices of the ring, so load evens out and a new node takes a little from everyone.\n- N, W, R: N = 3 survives losing one node. W + R > N (for example 2 + 2) forces reads to overlap the latest successful write; W = 1, R = 1 is faster but can return stale data.\n- Conflict resolution: last-write-wins by timestamp is simple but can drop a concurrent update; Dynamo used vector clocks to detect conflicts and let the client merge them (like merging two shopping carts).\n- Sloppy quorum and hinted handoff keep writes available when replicas are down, at the cost of weaker guarantees until hints replay.\n- LSM storage (log, memtable, SSTables) turns random writes into sequential ones; deletes are written as tombstones and removed later by compaction.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Add a node: it takes over tokens from its neighbours and streams only those keys, while the rest of the cluster keeps serving.\n- A node dies: gossip marks it down within seconds; writes continue on the other replicas with hints saved; reads still reach R replicas.\n- A node is down for a long time: hints expire, so a repair job compares Merkle trees (hash trees over key ranges) to find and copy only the differing ranges (anti-entropy).\n- A whole data centre is lost: place replicas in different racks or zones, so the preference list never has all copies in one failure domain.\n- Hot keys: one very popular key lives on 3 nodes only; cache it in front or split it into several keys.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- With N = 3, what do W = 2 and R = 2 guarantee, and what do they not?\n- How does the store behave during a network partition? Which side accepts writes?\n- Last-write-wins loses data when two clients update at once. How do vector clocks help?\n- Why does adding a node with a plain hash(key) mod nodes scheme move almost every key, and how does the ring avoid that?\n- How would you add secondary indexes or range scans on top?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Find the replicas on a hash ring',
        language: 'typescript',
        source: `import { createHash } from 'node:crypto'

// 64-bit position on the ring from the first 8 bytes of MD5.
const pos = (s: string) => createHash('md5').update(s).digest().readBigUInt64BE(0)

// Each node owns several tokens (virtual nodes) so load evens out.
const ring = ['A', 'B', 'C', 'D']
  .flatMap((n) => Array.from({ length: 64 }, (_, i) => ({ node: n, token: pos(\`\${n}#\${i}\`) })))
  .sort((x, y) => (x.token < y.token ? -1 : 1))

export function replicas(key: string, n = 3): string[] {
  const p = pos(key)
  let i = ring.findIndex((t) => t.token >= p)
  if (i < 0) i = 0 // wrap around
  const out = new Set<string>()
  // Walk clockwise, skipping tokens of nodes we already chose.
  for (let k = 0; out.size < n; k++) out.add(ring[(i + k) % ring.length].node)
  return [...out]
}`,
      },
      {
        title: 'Coordinator: quorum write',
        language: 'typescript',
        source: `type Replica = { put(key: string, value: string, ts: number): Promise<void> }

export async function quorumPut(replicas: Replica[], key: string, value: string, w: number) {
  const ts = Date.now()
  let acks = 0
  let failures = 0
  await new Promise<void>((resolve, reject) => {
    for (const r of replicas) {
      r.put(key, value, ts).then(
        () => ++acks >= w && resolve(),
        // Fail fast once W acks are impossible. Slower replicas still finish in the background.
        () => ++failures > replicas.length - w && reject(new Error(\`only \${acks} acks, needed \${w}\`)),
      )
    }
  })
}`,
      },
      {
        title: 'Newest version wins, then repair the stale replicas',
        language: 'python',
        source: `def quorum_get(replies, put):
    """replies: list of (replica, value, timestamp_ms) from the first R replicas."""
    newest = max(replies, key=lambda r: r[2])
    for replica, _value, ts in replies:
        if ts < newest[2]:
            put(replica, newest[1], newest[2])  # read repair: bring the stale one up to date
    return newest[1]`,
      },
      {
        title: 'Tiny LSM write path',
        language: 'python',
        source: `class Store:
    def __init__(self, wal, limit=4096):
        self.wal, self.mem, self.sstables, self.limit = wal, {}, [], limit

    def put(self, key, value):
        self.wal.write(f"{key}\\t{value}\\n"); self.wal.flush()   # durable first
        self.mem[key] = value                                       # then memory
        if len(self.mem) >= self.limit:                             # flush as a sorted, immutable file
            self.sstables.insert(0, dict(sorted(self.mem.items())))
            self.mem = {}

    def get(self, key):
        if key in self.mem:
            return self.mem[key]
        for table in self.sstables:                                 # newest first
            if key in table:
                return table[key]`,
      },
    ],
    related: ['Consistent hashing', 'Quorum', 'CAP theorem', 'LSM trees', 'Vector clocks', 'Merkle trees', 'Gossip protocol'],
  },
  simulator,
}
