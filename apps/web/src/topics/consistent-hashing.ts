import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A cache cluster that decides which node owns a key. The simulator runs the real
// algorithms: a 32-bit hash (FNV-1a plus murmur3's finaliser) places keys and
// nodes on a ring of 2^32 positions, and a key belongs to the first node token
// clockwise from it. The "keys that move" figures count 10,000 sample keys
// (user:0 to user:9999), so they are measured, not quoted from theory.

const RING = 2 ** 32
const SAMPLE = 10_000
const READS_PER_SEC = 20_000

/** FNV-1a, then murmur3's 32-bit finaliser so short, similar strings spread out. */
export function hash32(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

type Token = { pos: number; node: string }

/** Every node gets `vnodes` tokens on the ring, at hash("<node>#<i>"). */
export function buildRing(nodes: string[], vnodes: number): Token[] {
  const tokens: Token[] = []
  for (const node of nodes) for (let i = 0; i < vnodes; i++) tokens.push({ pos: hash32(`${node}#${i}`), node })
  return tokens.sort((a, b) => a.pos - b.pos)
}

/** The first token at or after the key's position, wrapping past the top of the ring. */
export function ownerOnRing(ring: Token[], h: number): Token {
  let lo = 0
  let hi = ring.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ring[mid].pos < h) lo = mid + 1
    else hi = mid
  }
  return ring[lo % ring.length]
}

const NODES = ['Cache Node A', 'Cache Node B', 'Cache Node C', 'Cache Node D']
const NEW_NODE = 'Cache Node E'
const letter = (node: string) => node.slice(-1)
const degrees = (h: number) => ((h / RING) * 360).toFixed(1)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const sampleKeys = Array.from({ length: SAMPLE }, (_, i) => `user:${i}`)

type Placement = (h: number) => string
const placement = (nodes: string[], mode: string): Placement => {
  if (mode.startsWith('Hash mod N')) return (h) => nodes[h % nodes.length]
  const ring = buildRing(nodes, mode.startsWith('Ring with 1 token') ? 1 : 100)
  return (h) => ownerOnRing(ring, h).node
}

const MODES = ['Ring with 100 tokens per node', 'Ring with 1 token per node', 'Hash mod N (no ring)']

const simulator: Simulator = {
  fields: [
    { id: 'key', label: 'Cache key', placeholder: 'user:1001', options: ['user:1001', 'user:4242', 'user:77', 'user:9000'] },
    { id: 'mode', label: 'How keys find a node', options: MODES },
    { id: 'event', label: 'What happens', options: ['A normal day (4 nodes)', 'Add Cache Node E', 'Cache Node crashes'] },
  ],
  defaults: { key: 'user:1001', mode: MODES[0], event: 'A normal day (4 nodes)' },
  run({ key, mode, event }) {
    const k = key.trim() || 'user:1001'
    const h = hash32(k)
    const isMod = mode.startsWith('Hash mod N')
    const vnodes = mode.startsWith('Ring with 1 token') ? 1 : 100
    const before = placement(NODES, mode)
    const owner = before(h)
    const add = event.startsWith('Add')
    const crash = event.startsWith('Cache Node crashes')

    // Share of the sample each node holds today.
    const counts = new Map(NODES.map((n) => [n, 0]))
    for (const s of sampleKeys) counts.set(before(hash32(s)), (counts.get(before(hash32(s))) ?? 0) + 1)
    const shares = NODES.map((n) => `${letter(n)}: ${pct((counts.get(n) ?? 0) / SAMPLE)}`).join('  ')

    const steps: Trace['steps'] = [
      {
        text: `The app reads ${k}. The Cache Router (a client library, so there is no extra network hop) has to decide which of the ${NODES.length} cache nodes may hold it.`,
        nodes: ['User Request', 'Cache Router (client library)'],
        data: `GET ${k}\nnodes: ${NODES.map(letter).join(', ')}`,
      },
    ]

    if (isMod) {
      steps.push({
        text: `With plain modulo the router hashes the key and takes the remainder by the node count: ${h} mod ${NODES.length} = ${h % NODES.length}, so ${owner}. Simple, and perfectly even, until the node count changes.`,
        nodes: ['Cache Router (client library)', owner],
        data: `hash32("${k}") = ${h}\n${h} % ${NODES.length} = ${h % NODES.length} → ${owner}`,
      })
    } else {
      const ring = buildRing(NODES, vnodes)
      const tok = ownerOnRing(ring, h)
      steps.push(
        {
          text: `The key is hashed onto a ring of 2^32 positions (think of a clock face). ${k} lands at ${h}, which is ${degrees(h)}° round the ring.`,
          nodes: ['Cache Router (client library)', 'Hash Ring (key → node)'],
          data: `hash32("${k}") = ${h}\nposition = ${h} / 2^32 × 360° = ${degrees(h)}°\nring: ${ring.length} tokens (${NODES.length} nodes × ${vnodes})`,
        },
        {
          text: `Walk clockwise to the first node token. Here it is ${tok.node}'s token at ${tok.pos} (${degrees(tok.pos)}°), so ${tok.node} owns the key. With ${vnodes} token${vnodes === 1 ? '' : 's'} per node, each node owns ${vnodes === 1 ? 'one big arc, whose size is luck' : 'many small arcs spread round the ring, so the shares even out'}.`,
          nodes: ['Hash Ring (key → node)', tok.node],
          data: `first token ≥ ${h} → ${tok.pos} ("${tok.node}#…")\nowner = ${tok.node}`,
        },
      )
    }

    steps.push({
      text: `${owner} does not have ${k} yet (a miss), so the router reads the Database and stores the row in ${owner}. Every later read of this key goes straight to ${owner}.`,
      nodes: [owner, 'Database'],
      data: `${owner}: GET ${k} → miss\nDatabase: SELECT * FROM users WHERE id = ${k.split(':')[1] ?? '…'}\n${owner}: SET ${k} (ttl 3600s)`,
    })

    if (!add && !crash) {
      steps.push({
        text: `Across ${SAMPLE.toLocaleString('en-US')} sample keys (user:0 to user:${SAMPLE - 1}) the load is ${isMod ? 'even' : vnodes === 1 ? 'uneven, because each node owns just one arc of random size' : 'close to even, thanks to the 100 tokens per node'}.`,
        nodes: ['Hash Ring (key → node)', ...NODES],
        data: `share of ${SAMPLE.toLocaleString('en-US')} keys\n${shares}`,
      })
      return { input: `${k}, ${mode}`, steps }
    }

    const after = add ? [...NODES, NEW_NODE] : NODES.filter((n) => n !== owner)
    const afterPlace = placement(after, mode)
    const gone = owner
    const newOwner = afterPlace(h)
    let moved = 0
    for (const s of sampleKeys) {
      const x = hash32(s)
      if (before(x) !== afterPlace(x)) moved++
    }
    const movedFrac = moved / SAMPLE
    const dbExtra = Math.round(movedFrac * READS_PER_SEC)

    steps.push({
      text: add
        ? `The Membership Service adds ${NEW_NODE} (traffic is growing). Every router is told the new node list: ${after.map(letter).join(', ')}.`
        : `${gone} stops answering. The Membership Service marks it dead after missed heartbeats and tells every router the new list: ${after.map(letter).join(', ')}.`,
      nodes: ['Membership Service', add ? NEW_NODE : gone],
      data: json({ event: add ? 'node_joined' : 'node_dead', node: add ? NEW_NODE : gone, members: after }),
    })

    steps.push({
      text: isMod
        ? `Now the divisor is ${after.length}: ${h} mod ${after.length} = ${h % after.length}, so ${newOwner}. ${newOwner === owner ? 'This key happens to stay put' : `${k} moved from ${owner} to ${newOwner}`}, and so did ${pct(movedFrac)} of all keys: the whole cache is shuffled.`
        : `The ring is rebuilt. ${k} is still at ${degrees(h)}°; walking clockwise now ends at ${newOwner}. ${newOwner === owner ? 'This key stays where it was' : `${k} moved from ${owner} to ${newOwner}`}. Only keys in the arcs the ${add ? 'new' : 'dead'} node ${add ? 'took over' : 'owned'} move: ${pct(movedFrac)} of the sample.`,
      nodes: ['Hash Ring (key → node)', newOwner],
      data: isMod
        ? `${h} % ${after.length} = ${h % after.length} → ${newOwner}\nkeys that changed node: ${moved.toLocaleString('en-US')} of ${SAMPLE.toLocaleString('en-US')} (${pct(movedFrac)})`
        : `owner before: ${owner}\nowner after:  ${newOwner}\nkeys that changed node: ${moved.toLocaleString('en-US')} of ${SAMPLE.toLocaleString('en-US')} (${pct(movedFrac)})\nideal for one node of ${add ? after.length : NODES.length}: ${pct(1 / (add ? after.length : NODES.length))}`,
    })

    steps.push({
      text: `Every moved key is a cache miss on its new node, so those reads fall through to the Database. At ${READS_PER_SEC.toLocaleString('en-US')} reads a second, that is about ${dbExtra.toLocaleString('en-US')} extra database reads a second until the cache warms up.${isMod ? ' This is how a one-node change becomes an outage.' : ''}`,
      nodes: [newOwner, 'Database'],
      data: `${READS_PER_SEC.toLocaleString('en-US')} reads/s × ${pct(movedFrac)} moved = ${dbExtra.toLocaleString('en-US')} reads/s hitting the Database\n(the database was sized for the misses of a warm cache)`,
    })
    return { input: `${k}, ${mode}, ${add ? 'add node' : 'node crash'}`, steps }
  },
}

export const consistentHashing: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'consistent-hashing',
  title: 'Consistent Hashing',
  blurb: 'How a cache or database cluster adds and loses nodes without reshuffling every key',
  guides: ['consistent-hashing', 'scale-consistent-hashing', 'scale-consistent-hashing-algorithmic-tradeoffs', 'scale-uniform-consistent-hashing-at-netflix', 'top-4-data-sharding-algorithms-explained', 'primer-load-balancer'],
  takeaways: [
    'Hash mod N reshuffles almost every key when N changes; going from 4 to 5 nodes moves about 80% of them.',
    'A hash ring places nodes and keys on the same circle; a key belongs to the first node clockwise from it.',
    'Adding or removing one node moves only about 1/N of the keys, and only to or from its neighbours.',
    'One token per node gives uneven arcs; many virtual nodes per node even out the load.',
    'Virtual nodes also let you give bigger machines more tokens, and spread a dead node\'s keys over many survivors.',
    'Moved keys are cache misses, so even a good ring needs a database that can absorb the warm-up.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'cache', label: 'Cache cluster' }],
    nodes: [
      { id: 'user', label: 'User Request', shape: 'ellipse', color: 'blue', group: null },
      { id: 'router', label: 'Cache Router (client library)', shape: 'rectangle', color: 'violet', group: null },
      { id: 'ring', label: 'Hash Ring (key → node)', shape: 'diamond', color: 'violet', group: null },
      { id: 'members', label: 'Membership Service', shape: 'rectangle', color: 'orange', group: null },
      { id: 'a', label: 'Cache Node A', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'b', label: 'Cache Node B', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'c', label: 'Cache Node C', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'd', label: 'Cache Node D', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'e', label: 'Cache Node E', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'db', label: 'Database', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'user', to: 'router', label: 'get(key)', dashed: false },
      { from: 'router', to: 'ring', label: 'hash(key)', dashed: false },
      { from: 'ring', to: 'a', label: 'owner', dashed: false },
      { from: 'ring', to: 'b', label: 'owner', dashed: false },
      { from: 'ring', to: 'c', label: 'owner', dashed: false },
      { from: 'ring', to: 'd', label: 'owner', dashed: false },
      { from: 'ring', to: 'e', label: 'new node', dashed: true },
      { from: 'members', to: 'ring', label: 'node list', dashed: true },
      { from: 'a', to: 'db', label: 'miss', dashed: true },
      { from: 'b', to: 'db', label: 'miss', dashed: true },
      { from: 'c', to: 'db', label: 'miss', dashed: true },
      { from: 'd', to: 'db', label: 'miss', dashed: true },
      { from: 'e', to: 'db', label: 'miss', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'cache_nodes',
        name: 'cache_nodes',
        columns: [
          { name: 'node', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'address', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'weight', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'ring_tokens',
        name: 'ring_tokens',
        columns: [
          { name: 'node', type: 'text', pk: true, fk: 'cache_nodes.node', nullable: false, unique: false },
          { name: 'token_index', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'position', type: 'bigint', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: ['(position) unique — find the first token at or after a key'],
      },
    ],
    relations: [
      { from: 'cache_nodes', to: 'ring_tokens', kind: 'one-to-many', label: 'owns tokens' },
    ],
  },
  explanation: {
    title: 'Consistent Hashing',
    summary:
      'Consistent hashing is a way to spread keys over a changing set of servers so that adding or removing a server moves only a small share of the keys. Servers and keys are hashed onto the same ring; a key belongs to the first server clockwise from it. It is used by caches, sharded databases, CDNs and load balancers.',
    sections: [
      {
        heading: 'Overview',
        body: 'You have four cache nodes and millions of keys. Each key must always go to the same node, or the cache is useless. The obvious rule is node = hash(key) mod 4. It spreads keys evenly, but it breaks the moment the node count changes: with 5 nodes, hash(key) mod 5 gives a different answer for most keys. Nearly the whole cache becomes misses at once, and the database takes the full load.\n\nConsistent hashing fixes this. Hash both nodes and keys onto the same circle of positions (the ring). A key belongs to the first node you meet walking clockwise. When a node joins or leaves, only the keys on the arc next to it change owner.',
      },
      {
        heading: 'Requirements',
        body: '- The same key always maps to the same node while the cluster is stable.\n- Load is spread evenly across nodes.\n- Adding or removing a node moves as few keys as possible.\n- Every router computes the same answer without asking a central server on each read.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 20,000 cache reads per second, 95% hit rate, so the Database serves about 1,000 reads a second.\n- With hash mod N, going from 4 to 5 nodes leaves a key in place only if hash mod 4 equals hash mod 5, about 1 in 5. In the 10,000-key sample here about 80% move, so misses jump from 5% to roughly 80% and the Database sees about 16,000 reads a second: 16 times its normal load.\n- With a ring, adding the fifth node takes about 1/5 of the keys (18% in the 10,000-key sample here), so about 3,600 to 4,000 extra reads a second at first, and they come from only that node\'s arcs.\n- Ring size: 4 nodes × 100 tokens = 400 tokens, about 6 KB of memory for the router to hold. Lookup is a binary search over a sorted array: about 9 comparisons.',
      },
      {
        heading: 'Step by step',
        body: '1. A User Request asks for a key, for example user:1001.\n2. The Cache Router (client library) hashes the key to a 32-bit position.\n3. It looks that position up on the Hash Ring (key → node): the first node token clockwise is the owner.\n4. The owner, one of Cache Node A, Cache Node B, Cache Node C or Cache Node D, answers from memory on a hit.\n5. On a miss the owner reads the Database and stores the result for next time.\n6. The Membership Service watches node health and sends the current node list to every router.\n7. When Cache Node E joins, the ring is rebuilt; only the arcs it takes over change owner, and those keys miss once.\n8. When a node dies, its arcs pass to the next tokens clockwise, spread over the survivors.',
      },
      {
        heading: 'Components',
        body: '- User Request: a read for a key such as a user profile.\n- Cache Router (client library): hashes the key and sends it to the right node; it lives inside the app, so there is no extra hop.\n- Hash Ring (key → node): the sorted list of node tokens; a binary search finds the first token at or after the key\'s position.\n- Membership Service: tracks which nodes are alive (heartbeats, or a store like etcd) and publishes the node list.\n- Cache Node A: holds the keys on its arcs of the ring.\n- Cache Node B: another node with its own tokens; it also takes over part of a dead neighbour\'s arcs.\n- Cache Node C: same role; with virtual nodes its arcs are spread round the ring.\n- Cache Node D: same role; losing it moves only its keys, roughly a quarter of the total.\n- Cache Node E: a node added later; it takes about a fifth of the keys, a little from each existing node.\n- Database: the source of truth; it serves every cache miss, so it must cope with a node change.',
      },
      {
        heading: 'Key decisions',
        body: '- Virtual nodes: give each server many tokens (100 to 256 is common) instead of one. With one token per node the arcs are random sizes and one node can hold twice the average; with many, the shares converge.\n- Weights: give a bigger machine more tokens, so it takes a proportionally bigger share.\n- Hash function: it must be fast, well mixed and the same in every client (all routers must agree). It does not need to be cryptographic.\n- Replication: for a database, store each key on the next R distinct nodes clockwise, so a node loss does not lose data (Dynamo and Cassandra do this).\n- Alternatives: rendezvous hashing and jump consistent hash need no ring but have their own limits; fixed hash slots (Redis Cluster uses 16,384) move whole slots between nodes.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Adding a node moves about 1/(N+1) of the keys, and only onto the new node. Warm it up gradually so the Database is not hit all at once.\n- A crashed node\'s keys move to the next tokens clockwise. With virtual nodes those are spread over many survivors; with one token per node the single next node gets double load and may fall over too.\n- Routers must agree on the node list. If two routers disagree for a moment, a key may be cached on two nodes or looked up in the wrong one; both are only misses for a cache, but serious for a database, which needs a versioned membership view.\n- A hot key (one celebrity profile) still lands on one node, whatever the hash does. Copy it to several nodes or add a small local cache in front.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why does hash mod N fail when you add a server?\n- How many keys move when you add the 11th node to a ring of 10?\n- Why do virtual nodes help, and how many would you use?\n- How would you store three replicas of each key on a ring?\n- How do clients learn about a node change, and what if they learn at different times?\n- A single key is far hotter than the rest. What do you do?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'A hash ring with virtual nodes (TypeScript)',
        language: 'typescript',
        source: `import { createHash } from 'node:crypto'

// First 4 bytes of MD5 as a position on a ring of 2^32. Any well-mixed hash works,
// but every client must use the same one.
const pos = (s: string) => createHash('md5').update(s).digest().readUInt32BE(0)

export class Ring {
  private tokens: { pos: number; node: string }[] = []

  constructor(nodes: string[], private vnodes = 100) {
    for (const n of nodes) this.add(n)
  }

  add(node: string) {
    for (let i = 0; i < this.vnodes; i++) this.tokens.push({ pos: pos(\`\${node}#\${i}\`), node })
    this.tokens.sort((a, b) => a.pos - b.pos)
  }

  remove(node: string) {
    this.tokens = this.tokens.filter((t) => t.node !== node)
  }

  /** First token clockwise from the key, found by binary search. */
  get(key: string): string {
    const p = pos(key)
    let lo = 0
    let hi = this.tokens.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.tokens[mid].pos < p) lo = mid + 1
      else hi = mid
    }
    return this.tokens[lo % this.tokens.length].node // wrap past the top
  }
}`,
      },
      {
        title: 'Count how many keys move (Python)',
        language: 'python',
        source: `import hashlib

def h(s: str) -> int:
    return int.from_bytes(hashlib.md5(s.encode()).digest()[:4], "big")

keys = [f"user:{i}" for i in range(10_000)]

# Hash mod N: 4 nodes -> 5 nodes
moved = sum(h(k) % 4 != h(k) % 5 for k in keys)
print(f"mod N: {moved / len(keys):.0%} of keys moved")  # about 80%

def ring(nodes, vnodes=100):
    return sorted((h(f"{n}#{i}"), n) for n in nodes for i in range(vnodes))

def owner(tokens, key):
    p = h(key)
    for pos, node in tokens:  # fine for a demo; use bisect in real code
        if pos >= p:
            return node
    return tokens[0][1]

before = ring(["A", "B", "C", "D"])
after = ring(["A", "B", "C", "D", "E"])
moved = sum(owner(before, k) != owner(after, k) for k in keys)
print(f"ring: {moved / len(keys):.0%} of keys moved")  # about 20%`,
      },
      {
        title: 'Replicas: the next distinct nodes clockwise (TypeScript)',
        language: 'typescript',
        source: `// Store each key on R different nodes. Walk the ring and skip tokens
// that belong to a node we already picked (virtual nodes repeat).
export function replicas(tokens: { pos: number; node: string }[], start: number, r = 3): string[] {
  const picked = new Set<string>()
  for (let i = 0; picked.size < r && i < tokens.length; i++) {
    picked.add(tokens[(start + i) % tokens.length].node)
  }
  return [...picked]
}`,
      },
    ],
    related: ['Sharding', 'Rendezvous hashing', 'Distributed cache', 'Consistent hashing with bounded loads', 'Dynamo-style replication'],
  },
  simulator,
}
