import type { Trace } from '@structura/shared'
import type { Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator really runs three eviction policies on a seeded stream of reads,
// and really computes Redis-style hash slots (CRC16 mod 16384), so every number
// the walkthrough shows is computed, not canned.

const CATALOG = 1000 // products in the database
const CAPACITY = 100 // entries one cache can hold (10% of the catalog)
const READS = 3000
const HOT_KEYS = 50
const SLOTS = 16384
const DB_MS = 40 // one database read
const DB_POOL = 50 // connections the database will serve at once
const CACHE_MS = 1

/** CRC16/XMODEM, the checksum Redis Cluster uses to pick a hash slot. */
function crc16(text: string): number {
  let crc = 0
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}
const slotOf = (key: string) => crc16(key) % SLOTS
/** Three shards, each owning a third of the slots: 0-5460, 5461-10922, 10923-16383. */
const shardOf = (slot: number) => (slot <= 5460 ? 1 : slot <= 10922 ? 2 : 3)

/** A small seeded random generator, so the same input always gives the same reads. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PATTERNS: Record<string, () => number[]> = {
  'Popular products (80% of reads on 50 products)': () => {
    const rnd = mulberry32(7)
    return Array.from({ length: READS }, () => (rnd() < 0.8 ? Math.floor(rnd() * HOT_KEYS) : Math.floor(rnd() * CATALOG)))
  },
  'Popular products plus a catalogue crawler': () => {
    // Every other read is a bot walking the whole catalogue in order.
    const rnd = mulberry32(11)
    let next = 0
    return Array.from({ length: READS }, (_, i) => (i % 2 === 0 ? Math.floor(rnd() * HOT_KEYS) : next++ % CATALOG))
  },
  'Uniform random (no popular products)': () => {
    const rnd = mulberry32(3)
    return Array.from({ length: READS }, () => Math.floor(rnd() * CATALOG))
  },
}

const POLICIES = ['LRU (evict least recently used)', 'LFU (evict least frequently used)', 'FIFO (evict oldest entry)']

interface Result {
  hits: number
  misses: number
  evictions: number
  /** Hit rate over the second half, once the cache has warmed up. */
  warmRate: number
}

function simulate(policy: string, reads: number[]): Result {
  const cache = new Map<number, number>() // key -> frequency; Map order = recency (LRU) or age (FIFO)
  let hits = 0
  let evictions = 0
  let warmHits = 0
  reads.forEach((key, i) => {
    const freq = cache.get(key)
    if (freq !== undefined) {
      hits++
      if (i >= reads.length / 2) warmHits++
      if (policy === POLICIES[0]) {
        cache.delete(key) // re-insert at the end: most recently used
        cache.set(key, freq + 1)
      } else if (policy === POLICIES[1]) {
        cache.set(key, freq + 1)
      }
      return
    }
    if (cache.size >= CAPACITY) {
      let victim = -1
      if (policy === POLICIES[1]) {
        // Lowest count; Map order breaks ties in favour of the older entry.
        let best = Infinity
        for (const [k, f] of cache) if (f < best) ((best = f), (victim = k))
      } else {
        victim = cache.keys().next().value as number // first = least recent (LRU) or oldest (FIFO)
      }
      cache.delete(victim)
      evictions++
    }
    cache.set(key, 1)
  })
  return { hits, misses: reads.length - hits, evictions, warmRate: warmHits / (reads.length / 2) }
}

const EXPIRY = ['No protection', 'Single-flight lock', 'Lock + serve stale value']
const CROWD = [200, 800, 3000]

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

const simulator: Simulator = {
  fields: [
    { id: 'policy', label: 'Eviction policy', options: POLICIES },
    { id: 'pattern', label: 'Read pattern', options: Object.keys(PATTERNS) },
    { id: 'expiry', label: 'When a hot key expires', options: EXPIRY },
    { id: 'crowd', label: 'Requests waiting at that moment', options: CROWD.map(String) },
  ],
  defaults: { policy: POLICIES[0], pattern: 'Popular products plus a catalogue crawler', expiry: EXPIRY[0], crowd: '800' },
  run({ policy, pattern, expiry, crowd }) {
    const reads = (PATTERNS[pattern] ?? PATTERNS[Object.keys(PATTERNS)[0]])()
    const pol = POLICIES.includes(policy) ? policy : POLICIES[0]
    const res = simulate(pol, reads)
    const policyName = pol.split(' ')[0]
    const waiting = Number(crowd) || 800

    const key = 'product:42'
    const slot = slotOf(key)
    const shard = shardOf(slot)
    const hitRate = res.hits / READS
    const dbWithCache = res.misses
    const dbPerSecondAt = (rps: number) => Math.round(rps * (1 - hitRate))

    // The stampede: `waiting` requests all miss at the same instant.
    const stale = expiry === EXPIRY[2]
    const locked = expiry !== EXPIRY[0]
    const dbQueries = locked ? 1 : waiting
    const waves = Math.ceil(dbQueries / DB_POOL)
    const lastDone = waves * DB_MS // the last query finishes after this many waves
    const waitMs = locked ? (stale ? CACHE_MS : DB_MS) : lastDone

    const steps: Trace['steps'] = [
      {
        text: 'A shopper opens a product page. The app asks for product 42. Reading it from the database every time would cost a query per page view, so the app tries a cache first.',
        nodes: ['Client app', 'App Servers'],
        data: `GET /products/42\nreads in this run: ${READS} across ${CATALOG} products\ncache holds ${CAPACITY} entries (${pct(CAPACITY / CATALOG)} of the catalogue)`,
      },
      {
        text: 'The App Servers look in their own memory first, the Local Cache (L1). It is tiny and lives 5 seconds, but it costs no network hop. A hit here never reaches the shared cache.',
        nodes: ['App Servers', 'Local Cache (L1)'],
        data: `L1.get("${key}") → miss\nL1 holds at most 1,000 keys, TTL 5 s`,
      },
      {
        text: `On a miss, the cache client hashes the key to find which shard owns it: CRC16 of the key, modulo ${SLOTS} slots. The same key always lands on the same shard, so any app server can find it. Each of the 3 shards owns a third of the slots.`,
        nodes: ['Local Cache (L1)', 'Hash Slot Router'],
        data: `CRC16("${key}") mod ${SLOTS} = ${slot}\nslot ${slot} → shard ${shard}\nslots: shard 1 = 0-5460, shard 2 = 5461-10922, shard 3 = 10923-16383`,
      },
      {
        text: `The router sends GET to Cache Shard ${shard}. Each shard is a primary that keeps its keys in memory, and a Cache Replica copies it, so a dead primary can be replaced without losing the cache.`,
        nodes: ['Hash Slot Router', `Cache Shard ${shard}`, ...(shard === 1 ? ['Cache Replica'] : [])],
        data: `→ shard ${shard}: GET ${key}\n${[1, 2, 3].map((s) => ['product:42', 'product:1001', 'product:7'].filter((k) => shardOf(slotOf(k)) === s).map((k) => `${k} (slot ${slotOf(k)})`).join(', ') || '-').map((l, i) => `shard ${i + 1}: ${l}`).join('\n')}`,
      },
      {
        text: `Now the real question: how often does the cache answer? We replayed ${READS} reads (${pattern.toLowerCase()}) through a ${CAPACITY}-entry cache using ${policyName}. ${res.hits} were hits, ${res.misses} were misses, and ${res.evictions} entries had to be thrown out to make room.`,
        nodes: ['Cache hit?'],
        data: `policy: ${pol}\nhits ${res.hits} · misses ${res.misses} · evictions ${res.evictions}\nhit rate overall ${pct(hitRate)} · after warm-up ${pct(res.warmRate)}`,
      },
      {
        text:
          pattern === Object.keys(PATTERNS)[1]
            ? `The crawler reads every product once, in order. Under LRU each of those one-time reads pushes out something useful, so popular products keep getting evicted. LFU protects entries that were used many times; FIFO ignores use entirely. Try the three policies and compare.`
            : pattern === Object.keys(PATTERNS)[2]
              ? `With no popular products, a cache of ${CAPACITY} entries can only ever hold about ${pct(CAPACITY / CATALOG)} of what is asked, so the hit rate stays near that. No eviction policy can fix this; only a bigger cache or a better key choice does.`
              : `A few popular products make most of the reads, so even a small cache catches most of them. LRU and LFU keep the popular ones; FIFO may throw one out just because it is old.`,
        nodes: ['Cache hit?', 'App Servers'],
        data: `hit → return the cached value in ~${CACHE_MS} ms, no database work\nmiss → go to the database (~${DB_MS} ms)`,
      },
      {
        text: `Now a hot key expires. Its 5-minute TTL runs out at the instant ${waiting} requests are waiting for it. ${
          expiry === EXPIRY[0]
            ? 'Every one of them sees a miss and runs the same query. This is a cache stampede.'
            : expiry === EXPIRY[1]
              ? 'The first request takes a lock and the rest wait for it.'
              : 'The first request takes a lock to refresh the value; the rest get the old value straight away.'
        }`,
        nodes: ['Cache hit?', 'Single-flight Lock'],
        data: `${key} expired\nconcurrent misses: ${waiting}\n${locked ? `SET lock:${key} NX PX 5000 → 1 winner, ${waiting - 1} ${stale ? 'serve stale' : 'wait'}` : 'no lock: every request goes on to the database'}`,
      },
      {
        text: `The database sees ${dbQueries} ${dbQueries === 1 ? 'query' : 'queries'} for the same row. It serves ${DB_POOL} at a time and each takes ${DB_MS} ms, so ${dbQueries > DB_POOL ? `${dbQueries} queries need ${waves} rounds and the last one finishes after ${lastDone} ms` : 'it answers in a single round'}.${dbQueries > 1000 ? ' Most databases would be overloaded by this.' : ''}`,
        nodes: ['Single-flight Lock', 'Primary Database'],
        data: `SELECT * FROM products WHERE product_id = 42;  × ${dbQueries}\nconnections ${DB_POOL}, rounds ${waves}\nslowest waiter: ${waitMs} ms${stale ? ' (stale waiters: 1 ms)' : ''}`,
      },
      {
        text: `The winner writes the fresh row back with SET and a TTL, with a few random seconds added so a whole group of keys never expires together. Later reads hit the cache again.`,
        nodes: ['Primary Database', 'Hash Slot Router', `Cache Shard ${shard}`],
        data: `SET ${key} {"id":42,"price_cents":4999,…} EX ${300 + (slot % 30)}\n(300 s + jitter of ${slot % 30} s, taken from the key's slot)`,
      },
      {
        text: `Without a cache, ${READS} reads would be ${READS} database queries. With it, only ${dbWithCache} reach the database. At 50,000 reads per second, that is about ${dbPerSecondAt(50000).toLocaleString('en-US')} queries per second instead of 50,000.`,
        nodes: ['Primary Database'],
        data: `database reads: ${READS} → ${dbWithCache} (${pct(1 - dbWithCache / READS)} fewer)\nat 50,000 reads/s: ${dbPerSecondAt(50000).toLocaleString('en-US')}/s reach the database\nstampede on one key: ${dbQueries} ${dbQueries === 1 ? 'query' : 'queries'}`,
      },
    ]

    return { input: `${policyName}, ${pattern.toLowerCase()}, ${expiry.toLowerCase()} with ${waiting} waiting`, steps }
  },
}

export const distributedCache: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'distributed-cache',
  title: 'Distributed Cache',
  blurb: 'Cache-aside on a sharded Redis cluster: hash slots, eviction policies and cache stampedes',
  guides: ['primer-cache', 'top-8-cache-eviction-strategies', 'most-popular-cache-eviction', 'cache-miss-attack', 'how-can-cache-systems-go-wrong', 'memcached-vs-redis'],
  takeaways: [
    'A cache trades memory for speed: the hit rate decides how much load the database really sees.',
    'Cache-aside is the usual pattern: look in the cache, on a miss read the database and fill the cache.',
    'Hashing the key to a slot, and slots to shards, lets any app server find a key and lets the cluster grow.',
    'LRU suits most workloads, but a one-time crawl can flush it; LFU resists that, FIFO ignores use altogether.',
    'When a hot key expires, a lock (single-flight) turns hundreds of identical queries into one.',
    'Add random jitter to TTLs, and expect the cache to disappear: the database must survive a cold start.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'cluster', label: 'Cache cluster (3 shards)' }],
    nodes: [
      { id: 'client', label: 'Client app', shape: 'ellipse', color: 'blue', group: null },
      { id: 'app', label: 'App Servers', shape: 'rectangle', color: 'violet', group: null },
      { id: 'l1', label: 'Local Cache (L1)', shape: 'rectangle', color: 'red', group: null },
      { id: 'router', label: 'Hash Slot Router', shape: 'rectangle', color: 'violet', group: null },
      { id: 's1', label: 'Cache Shard 1', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 's2', label: 'Cache Shard 2', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 's3', label: 'Cache Shard 3', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'replica', label: 'Cache Replica', shape: 'rectangle', color: 'red', group: 'cluster' },
      { id: 'hit', label: 'Cache hit?', shape: 'diamond', color: 'violet', group: null },
      { id: 'lock', label: 'Single-flight Lock', shape: 'rectangle', color: 'orange', group: null },
      { id: 'db', label: 'Primary Database', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'client', to: 'app', label: 'GET /products/42', dashed: false },
      { from: 'app', to: 'l1', label: 'check L1 (5 s TTL)', dashed: false },
      { from: 'l1', to: 'router', label: 'L1 miss', dashed: false },
      { from: 'router', to: 's1', label: 'slots 0-5460', dashed: false },
      { from: 'router', to: 's2', label: 'slots 5461-10922', dashed: false },
      { from: 'router', to: 's3', label: 'slots 10923-16383', dashed: false },
      { from: 's1', to: 'replica', label: 'replicate', dashed: true },
      { from: 's1', to: 'hit', label: 'GET result', dashed: false },
      { from: 's2', to: 'hit', label: 'GET result', dashed: false },
      { from: 's3', to: 'hit', label: 'GET result', dashed: false },
      { from: 'hit', to: 'app', label: 'hit: value', dashed: false },
      { from: 'hit', to: 'lock', label: 'miss', dashed: false },
      { from: 'lock', to: 'db', label: 'one query', dashed: false },
      { from: 'db', to: 'router', label: 'refill: SET + TTL', dashed: true },
      { from: 'db', to: 'app', label: 'row', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'categories',
        name: 'categories',
        columns: [
          { name: 'category_id', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: [],
      },
      {
        id: 'products',
        name: 'products',
        columns: [
          { name: 'product_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'category_id', type: 'int', pk: false, fk: 'categories.category_id', nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'price_cents', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'stock', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(category_id)'],
      },
      {
        id: 'cache_rules',
        name: 'cache_rules',
        columns: [
          { name: 'key_prefix', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'ttl_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'jitter_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'serve_stale', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [{ from: 'products', to: 'categories', kind: 'one-to-many', label: 'belongs to' }],
  },
  explanation: {
    title: 'Distributed Cache',
    summary:
      'A distributed cache keeps hot data in the memory of several servers, so most reads never touch the database. The hard parts are splitting keys across servers, choosing what to throw out when memory is full, keeping the cache from going stale, and not letting a burst of misses crush the database.',
    sections: [
      {
        heading: 'Overview',
        body: 'Reading from memory takes about a millisecond; a database query takes tens of milliseconds and costs real capacity. A cache sits between the app and the database and remembers recent answers. Most systems use cache-aside: the app asks the cache; on a miss it reads the database, then stores the result in the cache with a time to live (TTL), the number of seconds after which the entry is dropped.\n\nOne server can only hold so much and only answer so many requests, so the cache is split into shards. Each key lives on exactly one shard, chosen by hashing the key.',
      },
      {
        heading: 'Requirements',
        body: '- Serve most reads from memory, in about a millisecond.\n- Hold a dataset bigger than one machine\'s memory.\n- Add or lose a server without emptying the whole cache.\n- Keep values reasonably fresh; a stale price for a few minutes is fine, for ever is not.\n- Protect the database when the cache is cold, expired or down.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: an online shop with 20 million products and 50,000 reads per second at peak.\n- Memory: each entry is about 1 KB of value plus 100 B of key and bookkeeping, so 20,000,000 × 1,100 B = 22 GB for everything. The popular 20% is 4.4 GB, but we size for the whole set so cold products do not cause misses.\n- Shards: a 16 GB server gives about 12 GB for data (the rest is for replication buffers and fragmentation), so 22 / 12 = 1.8, rounded up to 2. We use 3 for headroom and for traffic.\n- Traffic: 50,000 / 3 = about 16,700 reads per second per shard. One Redis node handles roughly 100,000 simple operations per second, so each shard is far from its limit.\n- Database: at a 95% hit rate, only 50,000 × 0.05 = 2,500 queries per second reach it, 20 times fewer than without the cache.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client app asks the App Servers for GET /products/42.\n2. The App Servers look in their Local Cache (L1), a small in-process cache with a 5-second TTL.\n3. On a miss, the Hash Slot Router computes CRC16 of the key modulo 16,384 to get a slot, and maps the slot to a shard.\n4. The request goes to the right shard: Cache Shard 1, Cache Shard 2 or Cache Shard 3. Cache Shard 1 here is copied to the Cache Replica.\n5. The answer reaches Cache hit?. On a hit, the value goes straight back to the App Servers.\n6. On a miss, the Single-flight Lock lets only one request per key continue; the others wait or use the old value.\n7. The winner reads the Primary Database once.\n8. The row is written back through the Hash Slot Router into its shard with a TTL, and returned to the App Servers.',
      },
      {
        heading: 'Components',
        body: '- Client app: the shopper\'s browser or phone.\n- App Servers: run the cache-aside logic: check the cache, fall back to the database, refill.\n- Local Cache (L1): a tiny in-process cache per app server; it absorbs the hottest keys with no network hop.\n- Hash Slot Router: the cache client\'s routing table; maps key to slot to shard.\n- Cache Shard 1: a primary node that owns hash slots 0 to 5460.\n- Cache Shard 2: a primary node that owns hash slots 5461 to 10922.\n- Cache Shard 3: a primary node that owns hash slots 10923 to 16383.\n- Cache Replica: a live copy of a primary; it takes over if that primary fails.\n- Cache hit?: the decision: was the key in the cache and not expired?\n- Single-flight Lock: makes sure one request per key rebuilds a missing value; the rest wait for it.\n- Primary Database: the source of truth; the cache never holds the only copy of anything.',
      },
      {
        heading: 'Key decisions',
        body: '- Cache-aside vs write-through: cache-aside only caches what is read and is easy to reason about; write-through updates the cache on every write, which is fresher but caches data nobody reads.\n- Invalidation: the safest rule is to delete the key when the row changes (not update it), so the next read refills it. Always keep a TTL as a safety net.\n- Eviction when memory is full: LRU drops the entry unused for longest and fits most workloads; LFU drops the least used, which resists one-time scans; FIFO drops the oldest and ignores use.\n- Sharding: Redis Cluster uses 16,384 fixed slots rather than hashing straight to servers, so moving a slot moves only its keys. Consistent hashing is the other common choice.\n- Stampede protection: a single-flight lock, serving a stale value while one request refreshes, and TTL jitter so keys do not all expire together.\n- Cache penetration: requests for keys that do not exist miss every time; cache the "not found" answer briefly, or use a Bloom filter in front.\n- L1 plus L2: a local cache removes network hops but can be stale across servers; keep its TTL very short.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Add a shard and move some slots to it; only the keys in those slots are remapped and refilled.\n- A hot key (one viral product) can overload its single shard; the L1 cache absorbs most of it, or copy the key under several names (product:42#1 to #8) and read a random one.\n- If a primary dies, its replica is promoted. Replication is asynchronous, so the last few writes may be lost; that is acceptable for a cache.\n- If the whole cache is lost, every read misses and the database sees full traffic. Warm the cache before sending traffic, limit database connections, and shed load rather than fall over.\n- Put a short timeout (a few milliseconds) on cache calls and treat a timeout as a miss, so a slow cache never makes the site slower than having no cache.\n- Watch the hit rate, evictions per second and memory use. A falling hit rate usually means the working set outgrew the cache.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- A product page is cached for 5 minutes but the price just changed. What do you do?\n- A key expires and 5,000 requests arrive at once. What happens to the database, and how do you stop it?\n- LRU or LFU for a site that is sometimes crawled by bots? Why?\n- How would you add a fourth shard without emptying the cache?\n- What is the difference between cache penetration, breakdown and avalanche?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Cache-aside with a TTL and jitter',
        language: 'typescript',
        source: `import Redis from 'ioredis'
const cache = new Redis.Cluster([{ host: 'cache-1', port: 6379 }])

export async function getProduct(id: number) {
  const key = \`product:\${id}\`
  const hit = await cache.get(key)
  if (hit) return JSON.parse(hit)

  const row = await db.query('SELECT * FROM products WHERE product_id = $1', [id])
  // 5 minutes plus up to 30 s of jitter, so keys cached together don't expire together
  const ttl = 300 + Math.floor(Math.random() * 30)
  await cache.set(key, JSON.stringify(row), 'EX', ttl)
  return row
}`,
      },
      {
        title: 'Single-flight: one rebuild per key',
        language: 'typescript',
        source: `const inFlight = new Map<string, Promise<unknown>>()

// In one app server, all callers for the same key share one database query.
export function singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running) return running as Promise<T>
  const p = load().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}
// Across servers, also take a Redis lock: SET lock:product:42 1 NX PX 5000`,
      },
      {
        title: 'Which shard owns a key (Redis hash slot)',
        language: 'python',
        source: `def crc16(data: bytes) -> int:           # CRC16/XMODEM, as Redis Cluster uses
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc

slot = crc16(b"product:42") % 16384        # 12456
shard = 1 if slot <= 5460 else 2 if slot <= 10922 else 3
print(slot, shard)                         # 12456 3`,
      },
      {
        title: 'Delete on write, not update',
        language: 'bash',
        source: `# After the database row changes, drop the cached copy.
# The next read refills it with fresh data, so a failed update can't leave a wrong value.
redis-cli -c DEL product:42

# Check what is left and how long it has to live
redis-cli -c TTL product:42     # -2 means the key is gone
redis-cli INFO stats | grep -E "keyspace_(hits|misses)|evicted_keys"`,
      },
    ],
    related: ['Cache-aside', 'LRU', 'LFU', 'TTL', 'Cache stampede', 'Hash slot', 'Replication', 'Bloom filter'],
  },
  simulator,
}
