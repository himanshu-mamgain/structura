import type { Trace } from '@structura/shared'
import { json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design a key-value cache to save the results of the most recent
// web server queries" in the System Design Primer by Donne Martin (CC BY 4.0).
// The requirements and the hash map + linked list core follow the primer. The
// capacity maths (computed with a Zipf model), cache router, invalidation path,
// walkthrough, simulator and code are Structura's.

/** How many entries one cache shard holds in the simulator, so eviction is easy to see. */
const SHARD_CAPACITY = 3
/** Cached results expire after this long, so edits to the index show up eventually. */
const TTL_SECONDS = 300

/** Lower-case, drop punctuation and collapse spaces, so near-identical queries share one cache key. */
const normalize = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Entries are ordered most recently used first, like the linked list in the primer. */
class Lru {
  private entries = new Map<string, string>()
  constructor(readonly capacity: number) {}
  get keys() {
    return [...this.entries.keys()].reverse()
  }
  get(key: string) {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value) // move to the front
    return value
  }
  /** Returns the key that was evicted, if the cache was full. */
  set(key: string, value: string) {
    this.entries.delete(key)
    let evicted: string | undefined
    if (this.entries.size >= this.capacity) {
      evicted = this.entries.keys().next().value
      this.entries.delete(evicted as string)
    }
    this.entries.set(key, value)
    return evicted
  }
}

const OTHERS = ['cheap flights', 'python tutorial', 'weather today']
const keyOf = (q: string) => `q:${stableHash(q).toString(16).padStart(8, '0')}`

const STATES = ['Cache is empty', 'This query is already cached', 'Shard is full of other queries']

const simulator: Simulator = {
  fields: [
    { id: 'query', label: 'Search query', placeholder: 'e.g. weather in London' },
    { id: 'state', label: 'Cache state', options: STATES },
    { id: 'shards', label: 'Cache shards', options: ['4', '8', '16'] },
  ],
  defaults: { query: 'Weather in  London!', state: STATES[0], shards: '8' },
  run({ query, state, shards }) {
    const raw = (query ?? '').trim() || 'weather in london'
    const norm = normalize(raw) || 'weather in london'
    const n = Math.max(1, Number(shards) || 8)
    const h = stableHash(norm)
    const key = keyOf(norm)
    const shard = h % n

    // The shard's LRU: preload it the way the chosen state describes.
    const lru = new Lru(SHARD_CAPACITY)
    const results = json([1, 2, 3].map((i) => ({ doc: 10000 + ((h >>> (i * 4)) % 89999), rank: i })))
    // For a hit the query is the oldest entry, so the move to the front is visible.
    if (state === STATES[1]) lru.set(key, results)
    const others = state === STATES[0] ? [] : OTHERS.slice(0, state === STATES[1] ? SHARD_CAPACITY - 1 : SHARD_CAPACITY)
    for (const other of others) lru.set(keyOf(other), '…')
    const label = (k: string) => (k === key ? `${k} (this query)` : `${k} (${OTHERS.find((o) => keyOf(o) === k)})`)
    const before = lru.keys.length ? lru.keys.map(label).join(' → ') : '(empty)'
    const hit = lru.get(key) !== undefined

    const steps: Trace['steps'] = [
      { text: 'The Client sends the search to the Web Server, which forwards it to the Query API.', nodes: ['Client', 'Web Server', 'Query API'], data: `GET /search?q=${encodeURIComponent(raw)}` },
      { text: `The Query API cleans the query: lower case, punctuation removed, spaces collapsed. "${raw}" becomes "${norm}". Queries that mean the same thing now share one cache key.`, nodes: ['Query API'], data: `normalize(${JSON.stringify(raw)})\n→ ${JSON.stringify(norm)}\nkey = "q:" + hex(fnv1a(query)) = ${key}` },
      { text: `The Cache Router picks the shard that owns this key: hash % ${n}. The same key always lands on the same shard, so each shard keeps its own slice of the popular queries.`, nodes: ['Query API', 'Cache Router'], data: `fnv1a("${norm}") = ${h}\nshard = ${h} % ${n} = ${shard}` },
    ]

    if (hit) {
      const after = lru.keys.map(label).join(' → ')
      steps.push(
        { text: `Cache hit. The shard finds the key and moves it to the front of its LRU list, so it is the last to be evicted. No index lookup is needed at all.`, nodes: ['Cache Router', 'Memory Cache (Redis)'], data: `GET ${key}  → hit (shard ${shard})\nLRU before (newest first): ${before}\nLRU after:                 ${after}` },
        { text: 'The Query API returns the stored results straight away: one in-memory lookup instead of an index search plus a document fetch.', nodes: ['Memory Cache (Redis)', 'Query API', 'Client'], data: `HTTP/1.1 200 OK\nX-Cache: HIT\n${results}` },
      )
      return { input: `Search "${raw}" (cached, ${n} shards)`, steps }
    }

    steps.push(
      { text: `Cache miss. Shard ${shard} does not have ${key}. The Query API will have to compute the answer.`, nodes: ['Cache Router', 'Memory Cache (Redis)'], data: `GET ${key}  → nil (shard ${shard})\nLRU (newest first): ${before}` },
      { text: `The Query API asks the Reverse Index Service, which looks up each word's posting list in the Inverted Index Store and intersects them: the documents that contain every word.`, nodes: ['Query API', 'Reverse Index Service', 'Inverted Index Store'], data: `${norm.split(' ').map((w) => `postings("${w}")`).join(' ∩ ')}\n→ ${json([1, 2, 3].map((i) => 10000 + ((h >>> (i * 4)) % 89999)))}` },
      { text: 'The Document Service fetches titles and snippets for the top ten hits from the Document Store. This is the slow part the cache exists to avoid.', nodes: ['Query API', 'Document Service', 'Document Store'], data: `SELECT doc_id, title, snippet FROM documents\nWHERE doc_id IN (…top 10 ids…);` },
    )
    const evicted = lru.set(key, results)
    const after = lru.keys.map(label).join(' → ')
    steps.push(
      {
        text: evicted
          ? `The result is written back with a ${TTL_SECONDS}-second TTL. The shard is full (${SHARD_CAPACITY} entries), so it evicts the least recently used entry, ${label(evicted)}, to make room.`
          : `The result is written back with a ${TTL_SECONDS}-second TTL. The shard has room (${SHARD_CAPACITY} entries), so nothing is evicted. The next identical search will hit.`,
        nodes: ['Query API', 'Cache Router', 'Memory Cache (Redis)'],
        data: `SET ${key} <results> EX ${TTL_SECONDS}\n${evicted ? `evicted (least recently used): ${label(evicted)}\n` : ''}LRU after (newest first): ${after}`,
      },
      { text: 'The Query API returns the results to the Client.', nodes: ['Query API', 'Client'], data: `HTTP/1.1 200 OK\nX-Cache: MISS\n${results}` },
    )
    return { input: `Search "${raw}" (${state.toLowerCase()}, ${n} shards)`, steps }
  },
}

export const queryCache: StaticTopic = {
  difficulty: 'Intermediate',
  kind: 'static',
  id: 'query-cache',
  title: 'Query Cache for a Search Engine',
  blurb: 'LRU caching, sharded memory, TTLs and invalidation for hot searches',
  adaptedFrom: {
    title: 'Design a key-value cache to save the results of the most recent web server queries',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/query_cache/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: [
    'primer-design-a-key-value-store-for-a-search-engine',
    'primer-cache',
    'most-popular-cache-eviction',
    'top-8-cache-eviction-strategies',
    'consistent-hashing',
    'how-can-cache-systems-go-wrong',
  ],
  takeaways: [
    'A few queries make most of the traffic, so a small cache in front of the index absorbs most of the load.',
    'An LRU cache is a hash map for O(1) lookup plus a linked list for O(1) "most recently used" bookkeeping.',
    'Clean the query first (case, punctuation, spaces) so equivalent searches share one cache key.',
    'Shard the cache by key hash: one machine cannot hold hundreds of gigabytes, and each shard can fail alone.',
    'A TTL bounds how stale a result can be; invalidating keys when the index changes makes it fresher.',
    'Plain hash % N reshuffles almost every key when N changes: use consistent hashing to resize the cache.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'services', label: 'Services' },
      { id: 'cache', label: 'Cache layer' },
      { id: 'data', label: 'Storage' },
    ],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'web', label: 'Web Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'api', label: 'Query API', shape: 'rectangle', color: 'violet', group: 'services' },
      { id: 'router', label: 'Cache Router', shape: 'rectangle', color: 'light-violet', group: 'cache' },
      { id: 'cache', label: 'Memory Cache (Redis)', shape: 'rectangle', color: 'red', group: 'cache' },
      { id: 'rindex', label: 'Reverse Index Service', shape: 'rectangle', color: 'light-violet', group: 'services' },
      { id: 'docs', label: 'Document Service', shape: 'rectangle', color: 'light-violet', group: 'services' },
      { id: 'idxstore', label: 'Inverted Index Store', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'docstore', label: 'Document Store', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'queue', label: 'Index Update Queue', shape: 'rectangle', color: 'yellow', group: 'data' },
      { id: 'invalid', label: 'Invalidation Worker', shape: 'rectangle', color: 'orange', group: 'services' },
    ],
    edges: [
      { from: 'client', to: 'web', label: 'HTTPS', dashed: false },
      { from: 'web', to: 'api', label: 'GET /search', dashed: false },
      { from: 'api', to: 'router', label: 'get / set by key', dashed: false },
      { from: 'router', to: 'cache', label: 'hash(key) % shards', dashed: false },
      { from: 'api', to: 'rindex', label: 'on a miss', dashed: false },
      { from: 'api', to: 'docs', label: 'titles + snippets', dashed: false },
      { from: 'rindex', to: 'idxstore', label: 'posting lists', dashed: false },
      { from: 'docs', to: 'docstore', label: 'fetch top 10', dashed: false },
      { from: 'rindex', to: 'queue', label: 'index changed', dashed: true },
      { from: 'queue', to: 'invalid', label: 'changed terms', dashed: true },
      { from: 'invalid', to: 'cache', label: 'delete stale keys', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'documents',
        name: 'documents',
        columns: [
          { name: 'doc_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'url', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'snippet', type: 'varchar(160)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'postings',
        name: 'postings',
        columns: [
          { name: 'term', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'doc_id', type: 'bigint', pk: true, fk: 'documents.doc_id', nullable: false, unique: false },
          { name: 'term_frequency', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(term, doc_id) — one posting list per term, sorted by doc_id'],
      },
      {
        id: 'query_log',
        name: 'query_log',
        columns: [
          { name: 'day', type: 'date', pk: true, fk: null, nullable: false, unique: false },
          { name: 'normalized_query', type: 'varchar(50)', pk: true, fk: null, nullable: false, unique: false },
          { name: 'searches', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(day, searches DESC) — most popular queries, to warm a cold cache'],
      },
    ],
    relations: [{ from: 'postings', to: 'documents', kind: 'many-to-many', label: 'term appears in' }],
  },
  explanation: {
    title: 'Query Cache for a Search Engine',
    summary:
      'A search engine answers the same popular queries again and again. Computing each answer means reading posting lists and fetching documents, which is slow. So the Query API keeps the results of recent queries in a sharded in-memory cache with LRU eviction, and only searches the index on a miss.',
    sections: [
      {
        heading: 'Overview',
        body: 'Query traffic is skewed: a small set of queries (weather, news, a trending name) makes most of the searches. Caching their results turns an expensive index search into one memory lookup.\n\nThe core data structure is an LRU cache (least recently used). It is a hash map from query to its entry, plus a doubly linked list that orders entries from most to least recently used. A hit moves the entry to the front of the list; when the cache is full, the entry at the back is evicted. Both operations are O(1).\n\nA single machine cannot hold the whole cache, so it is split into shards by key hash.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A user searches and gets results; popular queries come back fast.\n- Results of recent queries are cached; the cache expires entries after a time limit (TTL) and evicts the least recently used when full.\n- High availability: a cache failure must slow things down, not take search offline.\n\nOut of scope: ranking and the index itself (see the Web Crawler topic), personalised results, spelling correction.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions:\n- 10 billion searches a month; about 1 billion different queries among them.\n- Query popularity follows a Zipf curve (the nth most popular query is searched 1/n as often).\n- A cache entry is a 50-byte key, ten results of about 250 bytes each, and about 100 bytes of overhead: 2,650 bytes.\n\nWhich works out to:\n- About 3,900 searches per second (10 billion / 2.6 million seconds in a month).\n- Caching the 50 million most popular queries (5%) needs about 133 GB: roughly 8 GB per shard across 16 shards.\n- Under the Zipf model that cache answers about 86% of searches: about 3,300 per second from memory, and only about 540 per second reach the index.\n- A smaller cache of 1 million entries (2.6 GB) would still answer about 68%. Returns diminish quickly, so size the cache from real hit-rate numbers.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client sends a search to the Web Server, which forwards it to the Query API.\n2. The Query API normalizes the query and builds the cache key.\n3. The Cache Router hashes the key and picks the shard that owns it.\n4. It reads the key from the Memory Cache (Redis). On a hit, that is the whole job: the results go back to the Client.\n5. On a miss, the Query API asks the Reverse Index Service, which reads posting lists from the Inverted Index Store and intersects them.\n6. The Document Service fetches titles and snippets for the top hits from the Document Store.\n7. The Query API writes the results to the Memory Cache (Redis) with a TTL; the shard evicts its least recently used entry if it is full.\n8. When the index changes, the Index Update Queue tells the Invalidation Worker, which deletes the affected keys from the cache.',
      },
      {
        heading: 'Components',
        body: '- Web Server: a reverse proxy in front of the Query API (TLS, routing, rate limits).\n- Query API: normalizes the query, checks the cache, and falls back to the index on a miss.\n- Cache Router: maps a key to its shard with hash(key) % shards (or a consistent hash ring).\n- Memory Cache (Redis): the shards. Each keeps entries in memory and evicts by LRU when full.\n- Reverse Index Service: finds the documents that contain every query word, using posting lists.\n- Document Service: loads titles and snippets for the chosen documents.\n- Inverted Index Store: maps each word to the sorted list of documents that contain it.\n- Document Store: the documents themselves, keyed by id.\n- Index Update Queue: carries "this index changed" events so invalidation never slows indexing.\n- Invalidation Worker: deletes cached results whose answer may now be out of date.',
      },
      {
        heading: 'Key decisions',
        body: '- LRU vs LFU vs TTL only. LRU is simple and adapts to trends: a query that stops being searched drifts to the back and leaves. LFU keeps long-time favourites but is slow to forget; a TTL alone does not bound memory.\n- Normalizing the key. Without it, "Weather in London" and "weather  in london!" are two entries. With it they share one, which raises the hit rate for free. Do not over-normalize: queries that differ in meaning must keep different keys.\n- Shard by key hash, not by user. Any server can handle any query, and the load spreads evenly because popular queries hash to different shards.\n- Freshness. A TTL (here 300 seconds) is the safety net: nothing is stale for longer. Invalidation on index change is optional polish for the queries where freshness matters, such as news.\n- Cache-aside. The Query API owns the read-through logic, so the cache stays a dumb key-value store that is easy to replace.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Resizing. With hash % N, going from 8 to 9 shards moves about 8 of every 9 keys, which empties the cache at once and sends the full load to the index. A consistent hash ring moves only about 1 in 9.\n- Thundering herd. When a popular key expires, thousands of requests miss together. Let one request recompute it (a lock or request coalescing) and serve the rest the old value, or add random jitter to TTLs.\n- Hot keys. One viral query can overload its shard. Replicate that key to several shards, or keep a tiny local cache inside each Query API server.\n- Shard failure. Treat it as a miss for that shard\'s keys and keep serving from the index; run a replica per shard if the extra index load is too high.\n- Cold start. A new cache has a hit rate of zero. Warm it by replaying the most popular entries from the query log.\n- Negative caching. Cache empty results briefly too, so a popular query with no answer does not hit the index every time.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Implement an LRU cache with O(1) get and put. Why a doubly linked list rather than a singly linked one?\n- How would you choose the cache size and the TTL from real traffic?\n- How do you keep the cache fresh when the index updates every few seconds?\n- What changes if every user sees personalised results?\n- Redis only approximates LRU by sampling a few keys. When does that matter?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'LRU cache with a Map',
        language: 'typescript',
        source: `// A JavaScript Map remembers insertion order, so it is the
// hash map and the "linked list" in one: first key = least recently used.
export class LruCache<V> {
  private map = new Map<string, V>()
  constructor(private capacity: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key) // re-insert to mark as most recently used
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V) {
    this.map.delete(key)
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value as string
      this.map.delete(oldest) // evict the least recently used
    }
    this.map.set(key, value)
  }
}`,
      },
      {
        title: 'LRU with a linked list (the primer design)',
        language: 'python',
        source: `class Node:
    def __init__(self, key, value):
        self.key, self.value = key, value
        self.prev = self.next = None

class LruCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.table = {}                          # key -> node, O(1) lookup
        self.head, self.tail = Node(None, None), Node(None, None)
        self.head.next, self.tail.prev = self.tail, self.head  # sentinels

    def _unlink(self, node):
        node.prev.next, node.next.prev = node.next, node.prev

    def _push_front(self, node):
        node.next, node.prev = self.head.next, self.head
        self.head.next.prev = node
        self.head.next = node

    def get(self, key):
        node = self.table.get(key)
        if node is None:
            return None
        self._unlink(node)                       # O(1) because the list is doubly linked
        self._push_front(node)
        return node.value

    def set(self, key, value):
        if key in self.table:
            self._unlink(self.table[key])
        elif len(self.table) >= self.capacity:
            lru = self.tail.prev                 # least recently used
            self._unlink(lru)
            del self.table[lru.key]
        node = self.table[key] = Node(key, value)
        self._push_front(node)`,
      },
      {
        title: 'Cache-aside lookup and shard router',
        language: 'typescript',
        source: `import Redis from 'ioredis'

const shards = ['cache-0:6379', 'cache-1:6379', 'cache-2:6379', 'cache-3:6379'].map(
  (addr) => new Redis(\`redis://\${addr}\`),
)
const TTL_SECONDS = 300

const normalize = (q: string) =>
  q.toLowerCase().replace(/[^\\p{L}\\p{N}\\s]/gu, ' ').replace(/\\s+/g, ' ').trim()

/** FNV-1a: a small, fast, stable hash. */
function fnv1a(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

export async function search(raw: string, searchIndex: (q: string) => Promise<string>) {
  const query = normalize(raw)
  const redis = shards[fnv1a(query) % shards.length] // which shard owns this key
  const key = \`q:\${fnv1a(query).toString(16).padStart(8, '0')}\`

  const cached = await redis.get(key).catch(() => null) // a dead shard is just a miss
  if (cached) return cached

  const results = await searchIndex(query) // slow path
  await redis.set(key, results, 'EX', TTL_SECONDS).catch(() => {})
  return results
}`,
      },
      {
        title: 'Redis as an LRU cache',
        language: 'bash',
        source: `# redis.conf for one cache shard
maxmemory 8gb                  # hard cap on the data held in memory
maxmemory-policy allkeys-lru   # when full, evict the least recently used key
maxmemory-samples 10           # Redis approximates LRU by sampling; more = closer to exact

# Check how well the cache is working
redis-cli INFO stats | grep -E "keyspace_(hits|misses)|evicted_keys"`,
      },
    ],
    related: ['LRU cache', 'Cache-aside', 'Cache eviction', 'TTL', 'Consistent hashing', 'Thundering herd', 'Redis', 'Inverted index'],
  },
  simulator,
}
