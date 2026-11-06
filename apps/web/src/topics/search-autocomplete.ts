import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator builds a real trie from the query log below and walks it, so
// the suggestions, scores and shard it shows are computed, not canned.

/** [query, searches this week, surge]. surge = how much busier the last hour was than an average hour. */
const LOG: [string, number, number][] = [
  ['weather today', 9_400_000, 1],
  ['weather tomorrow', 3_100_000, 1],
  ['weather radar', 1_800_000, 1],
  ['world cup schedule', 2_100_000, 14],
  ['world population', 1_300_000, 1],
  ['world map', 900_000, 1],
  ['word counter', 1_150_000, 1],
  ['wordle hint', 2_600_000, 1.5],
  ['how to screenshot on mac', 2_300_000, 1],
  ['how to lose weight fast', 2_700_000, 1],
  ['how to tie a tie', 1_900_000, 1],
  ['how to center a div', 1_700_000, 1],
  ['how to write a resume', 1_600_000, 1],
  ['how to cook rice', 1_400_000, 1],
  ['how to make pancakes', 1_250_000, 1],
  ['how to buy bitcoin', 1_050_000, 3],
  ['how to change a tire', 980_000, 1],
  ['pizza near me', 5_200_000, 1],
  ['pizza dough recipe', 1_700_000, 1],
  ['pizza hut menu', 1_350_000, 1],
  ['python tutorial', 2_900_000, 1],
  ['python list comprehension', 800_000, 1],
  ['pandas read csv', 700_000, 1],
  ['youtube', 14_000_000, 1],
  ['youtube downloader', 1_200_000, 1],
  ['yoga for beginners', 1_100_000, 1],
  ['facebook login', 8_300_000, 1],
  ['flights to london', 2_000_000, 1],
  ['flights to tokyo', 1_450_000, 1],
  ['netflix new releases', 2_200_000, 1],
  ['news today', 4_800_000, 1],
  ['nba scores', 3_900_000, 6],
  ['buy fake id online', 450_000, 1], // on the blocklist: never suggested
]
const BLOCKED = new Set(['buy fake id online'])
const TREND_WEIGHT = 100 // trending layer: score = weekly + 100 × searches in the last hour
const SHARDS = ['a–f', 'g–m', 'n–s', 't–z']
const SPARE = 2 // each node stores k + 2, so the filter can drop some and still fill the list

interface Entry {
  query: string
  weekly: number
  hourly: number
}
const ENTRIES: Entry[] = LOG.map(([query, weekly, surge]) => ({ query, weekly, hourly: Math.round((weekly / 168) * surge) }))

interface Node {
  kids: Map<string, Node>
  /** Indexes into ENTRIES that sit under this prefix. */
  all: number[]
}

function buildTrie(): Node {
  const root: Node = { kids: new Map(), all: [] }
  ENTRIES.forEach((e, i) => {
    let n = root
    n.all.push(i)
    for (const ch of e.query) {
      let next = n.kids.get(ch)
      if (!next) n.kids.set(ch, (next = { kids: new Map(), all: [] }))
      n = next
      n.all.push(i)
    }
  })
  return root
}
const TRIE = buildTrie()

function walk(prefix: string): Node | null {
  let n = TRIE
  for (const ch of prefix) {
    const next = n.kids.get(ch)
    if (!next) return null
    n = next
  }
  return n
}

const shardOf = (prefix: string) => {
  const c = prefix[0] ?? 'a'
  return c <= 'f' ? 0 : c <= 'm' ? 1 : c <= 's' ? 2 : 3
}
const fmt = (n: number) => n.toLocaleString('en-US')

const PIPELINE = ['Weekly trie only', 'Weekly trie + trending layer']
const CACHE = ['Cold: every cache misses', 'Warm: edge cache hit']

const simulator: Simulator = {
  fields: [
    { id: 'prefix', label: 'What the user has typed', placeholder: 'e.g. wor, how to, pizza' },
    { id: 'k', label: 'Suggestions shown', options: ['3', '5', '8'] },
    { id: 'ranking', label: 'Ranking', options: PIPELINE },
    { id: 'cache', label: 'Cache state', options: CACHE },
  ],
  defaults: { prefix: 'wor', k: '5', ranking: PIPELINE[1], cache: CACHE[0] },
  run({ prefix, k, ranking, cache }) {
    const typed = (prefix ?? '').toLowerCase().replace(/\s+/g, ' ').trimStart()
    const q = typed.length > 40 ? typed.slice(0, 40) : typed
    const kk = Math.max(1, Number(k) || 5)
    const trending = ranking === PIPELINE[1]
    const warm = cache === CACHE[1]
    const score = (e: Entry) => e.weekly + (trending ? TREND_WEIGHT * e.hourly : 0)
    const key = `sug:v7:${q}`
    const shard = shardOf(q)

    // What the trie holds for this prefix: the best k + 2 of everything below it.
    const node = q ? walk(q) : null
    const stored = node ? [...node.all].sort((a, b) => score(ENTRIES[b]) - score(ENTRIES[a])).slice(0, kk + SPARE) : []
    const kept = stored.filter((i) => !BLOCKED.has(ENTRIES[i].query))
    const shown = kept.slice(0, kk).map((i) => ENTRIES[i])
    const dropped = stored.filter((i) => BLOCKED.has(ENTRIES[i].query)).map((i) => ENTRIES[i].query)
    const total = node ? node.all.length : 0
    const response = json({ prefix: q, suggestions: shown.map((e) => e.query) })
    const list = shown.length ? shown.map((e, i) => `${i + 1}. ${e.query}`).join('\n') : '(no suggestions)'

    const steps = [
      {
        text: q
          ? `The user has typed "${q}". The search box waits about 150 ms after the last keystroke (a debounce), so it does not send a request for every single letter. Then it asks for suggestions.`
          : 'The search box is empty, so there is no prefix. Real products show recent or trending searches here; this model has nothing to look up.',
        nodes: ['Search box'],
        data: `GET /suggest?q=${encodeURIComponent(q)}&limit=${kk}\ndebounce: 150 ms after the last keystroke`,
      },
    ]

    if (warm) {
      steps.push({
        text: `Popular prefixes are cached in the browser and at the edge for a minute or two. This one is there, so the answer comes straight back and nothing behind the edge is touched.`,
        nodes: ['Edge Cache', 'Search box'],
        data: `Cache-Control: public, max-age=120\nHIT  ${key}\n${response}`,
      })
      return { input: `"${q}", ${kk} suggestions, edge cache hit`, steps }
    }

    steps.push(
      {
        text: 'Nothing in the browser or edge cache has this prefix yet, so the request goes on to the Suggestion API.',
        nodes: ['Edge Cache', 'Suggestion API'],
        data: `MISS  ${key}\nforwarded to the Suggestion API`,
      },
      {
        text: 'The Suggestion API asks Redis first. Prefixes repeat a lot, so Redis answers most requests without touching a trie.',
        nodes: ['Suggestion API', 'Prefix Cache (Redis)'],
        data: `GET ${key}\n→ (nil)   cache miss, ask a trie shard`,
      },
      {
        text: node
          ? `Trie shards are split by the first letter, so "${q[0]}" goes to shard ${shard + 1} of ${SHARDS.length} (${SHARDS[shard]}). The server walks the trie one letter per level (${q.length} step${q.length > 1 ? 's' : ''}). Under this node sit ${total} stored ${total === 1 ? 'query' : 'queries'}. The best ${kk + SPARE} were ranked ahead of time and stored on the node, so there is no search through the subtree at request time.`
          : q
            ? `Shard ${shard + 1} (${SHARDS[shard]}) walks the trie letter by letter and falls off the tree: no stored query starts with "${q}". The answer is an empty list, and it is cached too, so a typo does not hit the trie again.`
            : 'With no prefix there is nothing to walk.',
        nodes: ['Suggestion API', 'Trie Servers'],
        data: node
          ? `shard ${shard + 1}/${SHARDS.length} (${SHARDS[shard]})\npath: ${[...q].join(' → ')}\nstored top-${kk + SPARE} (${trending ? 'weekly + 100 × last hour' : 'weekly count'}):\n${stored.map((i, n) => `${n + 1}. ${ENTRIES[i].query.padEnd(26)} score ${fmt(score(ENTRIES[i]))}`).join('\n')}`
          : `shard ${shard + 1}/${SHARDS.length} (${SHARDS[shard]})\npath: ${[...q].join(' → ')} ✗ no child`,
      },
    )

    if (node) {
      steps.push({
        text: dropped.length
          ? `Before anything is returned, the Blocklist Filter removes banned phrases. "${dropped[0]}" ranked high but is on the list, so it is dropped. This is why the trie stores ${SPARE} spare entries: the list can still be filled.`
          : `The Blocklist Filter checks the ${stored.length} candidates against banned and policy-removed phrases. None of these are on the list, so all pass.`,
        nodes: ['Trie Servers', 'Blocklist Filter'],
        data: dropped.length ? `removed: ${dropped.join(', ')}\nleft: ${kept.length} of ${stored.length}` : `removed: none\nleft: ${kept.length} of ${stored.length}`,
      })
    }

    steps.push({
      text: shown.length
        ? `The top ${shown.length} go back, and Redis stores them for 60 seconds under the prefix, so the next person typing "${q}" skips the trie. The edge keeps a copy too.`
        : `The empty answer goes back and is cached for 60 seconds. The search box simply shows no dropdown.`,
      nodes: ['Suggestion API', 'Prefix Cache (Redis)', 'Edge Cache', 'Search box'],
      data: `SETEX ${key} 60 '${JSON.stringify(shown.map((e) => e.query))}'\n${list}`,
    })

    if (trending && shown.length) {
      const surged = ENTRIES.filter((e) => e.hourly / (e.weekly / 168) >= 5 && e.query.startsWith(q))
      steps.push({
        text: surged.length
          ? `Why "${surged[0].query}" ranks where it does: it was searched ${fmt(surged[0].hourly)} times in the last hour, against an average of ${fmt(Math.round(surged[0].weekly / 168))} an hour. The trending layer is a small counter that updates every minute, while the big trie is rebuilt only once a day, so breaking news can show up in minutes.`
          : 'Nothing under this prefix is spiking right now, so the trending layer changes the order only a little. It is a small counter that updates every minute, while the big trie is rebuilt once a day.',
        nodes: ['Trending Layer'],
        data: surged.length
          ? surged.map((e) => `${e.query}: weekly ${fmt(e.weekly)} + 100 × ${fmt(e.hourly)} = ${fmt(score(e))}`).join('\n')
          : 'no query under this prefix is above 5× its normal hourly rate',
      })
    }

    steps.push({
      text: 'When the user finally presses Enter, the search is logged. The Aggregator adds up counts from the Query Log, the Trie Builder turns the counts into a fresh trie snapshot, and shards load it. Suggestions follow what people search, with a delay of a day (or minutes with the trending layer).',
      nodes: ['Query Log (Kafka)', 'Aggregator', 'Query Counts DB', 'Trie Builder', 'Trie Snapshot Store'],
      data: `{"q":"${shown[0]?.query ?? q}","ts":"2026-11-06T09:14:03Z","lang":"en"}\n→ Kafka → count++ → daily rebuild → snapshot trie-2026-11-07.bin`,
    })

    return { input: `"${q}", ${kk} suggestions, ${trending ? 'with trending layer' : 'weekly trie only'}`, steps }
  },
}

export const searchAutocomplete: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'search-autocomplete',
  title: 'Search Autocomplete (Typeahead)',
  blurb: 'Prefix trie with precomputed top-k, layered caches, and a pipeline that learns from searches',
  guides: ['scale-autocomplete-search-2-parts-at-traveloka', 'primer-cache', 'scale-distributed-caching', 'top-8-cache-eviction-strategies', 'most-popular-cache-eviction'],
  takeaways: [
    'Autocomplete is a prefix lookup that must answer in about 100 ms, on almost every keystroke.',
    'A trie finds a prefix in as many steps as it has letters; storing the top-k on each node means no search through the subtree at request time.',
    'Cache aggressively: most prefixes repeat, so browser, edge and Redis absorb most of the traffic.',
    'Build the trie offline from the query log and swap it in as a snapshot; do not update it on every search.',
    'A small trending layer lets breaking news appear in minutes, while the big trie is rebuilt daily.',
    'Filter banned phrases at serving time, and store a few spare candidates so the list can still be filled.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'serve', label: 'Serving (online)' },
      { id: 'build', label: 'Learning (offline)' },
    ],
    nodes: [
      { id: 'box', label: 'Search box', shape: 'ellipse', color: 'blue', group: null },
      { id: 'edge', label: 'Edge Cache', shape: 'cloud', color: 'red', group: null },
      { id: 'api', label: 'Suggestion API', shape: 'rectangle', color: 'violet', group: 'serve' },
      { id: 'redis', label: 'Prefix Cache (Redis)', shape: 'rectangle', color: 'red', group: 'serve' },
      { id: 'trie', label: 'Trie Servers', shape: 'rectangle', color: 'violet', group: 'serve' },
      { id: 'filter', label: 'Blocklist Filter', shape: 'rectangle', color: 'violet', group: 'serve' },
      { id: 'trend', label: 'Trending Layer', shape: 'rectangle', color: 'orange', group: 'serve' },
      { id: 'log', label: 'Query Log (Kafka)', shape: 'rectangle', color: 'yellow', group: 'build' },
      { id: 'agg', label: 'Aggregator', shape: 'rectangle', color: 'orange', group: 'build' },
      { id: 'counts', label: 'Query Counts DB', shape: 'rectangle', color: 'green', group: 'build' },
      { id: 'builder', label: 'Trie Builder', shape: 'rectangle', color: 'orange', group: 'build' },
      { id: 'snap', label: 'Trie Snapshot Store', shape: 'rectangle', color: 'green', group: 'build' },
    ],
    edges: [
      { from: 'box', to: 'edge', label: 'GET /suggest?q=wor', dashed: false },
      { from: 'edge', to: 'api', label: 'miss', dashed: false },
      { from: 'api', to: 'redis', label: 'lookup prefix', dashed: false },
      { from: 'api', to: 'trie', label: 'on miss', dashed: false },
      { from: 'trie', to: 'filter', label: 'top k + spares', dashed: false },
      { from: 'filter', to: 'api', label: 'clean list', dashed: false },
      { from: 'api', to: 'redis', label: 'store 60 s', dashed: true },
      { from: 'api', to: 'trend', label: 'merge spikes', dashed: true },
      { from: 'api', to: 'edge', label: 'JSON, max-age 120', dashed: true },
      { from: 'edge', to: 'box', label: 'suggestions', dashed: true },
      { from: 'box', to: 'log', label: 'search submitted', dashed: true },
      { from: 'log', to: 'agg', label: 'stream', dashed: false },
      { from: 'log', to: 'trend', label: 'last hour', dashed: true },
      { from: 'agg', to: 'counts', label: 'weekly totals', dashed: false },
      { from: 'counts', to: 'builder', label: 'daily', dashed: false },
      { from: 'builder', to: 'snap', label: 'trie snapshot', dashed: false },
      { from: 'snap', to: 'trie', label: 'load + swap', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'query_counts',
        name: 'query_counts',
        columns: [
          { name: 'query', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'lang', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'week_count', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'last_seen', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(lang, week_count DESC)'],
      },
      {
        id: 'blocked_phrases',
        name: 'blocked_phrases',
        columns: [
          { name: 'phrase', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'reason', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'added_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'trie_snapshots',
        name: 'trie_snapshots',
        columns: [
          { name: 'snapshot_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'shard', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'object_url', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'built_from', type: 'date', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(shard, built_from DESC)'],
      },
    ],
    relations: [{ from: 'trie_snapshots', to: 'query_counts', kind: 'one-to-many', label: 'built from' }],
  },
  explanation: {
    title: 'Search Autocomplete (Typeahead)',
    summary:
      'Autocomplete shows likely searches as the user types. Each keystroke is a prefix lookup that must come back in roughly 100 ms, for billions of searches. The design has two halves: a fast serving path (caches in front of an in-memory trie that already knows the top suggestions for every prefix) and a slow learning path that turns the query log into a fresh trie.',
    sections: [
      {
        heading: 'Overview',
        body: 'A trie (prefix tree) is a tree where each level is one letter, so every prefix is a path from the root. Finding "wor" takes 3 steps, however many queries exist. The catch is what is under the node: thousands of queries. Sorting them on every keystroke is far too slow, so each node stores its best few answers, ranked ahead of time.\n\nSuggestions come from what other people searched, not from an index of documents. The system is read-heavy and can be a little stale; it must never be slow.',
      },
      {
        heading: 'Requirements',
        body: '- Return the top 5 or so suggestions for a prefix, ranked by popularity.\n- Respond in under about 100 ms, or typing feels laggy.\n- Handle very high read volume, with one request per few keystrokes.\n- Learn from new searches within a day, and from breaking news within minutes.\n- Never suggest banned or harmful phrases.\n- Stay available even if the learning pipeline is down; slightly old suggestions are fine.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 10 million daily users, 10 searches each, and (thanks to debounce) about 4 suggestion requests per search.\n- Searches: 10,000,000 × 10 = 100,000,000 a day.\n- Suggestion requests: 100,000,000 × 4 = 400,000,000 a day, which is 400,000,000 / 86,400 = about 4,630 per second on average. Peak is about 3 times that: roughly 13,900 per second.\n- Distinct queries kept: say 50 million after dropping rare ones. At 25 bytes each that is 1.25 GB of raw text.\n- Trie: about 300 million nodes. With 8 bytes for links plus 10 top-k ids of 4 bytes each, a node costs about 48 bytes, so 300,000,000 × 48 B = 14.4 GB. That fits in memory, split over 4 shards of about 3.6 GB each (plus replicas).\n- Query log: 100,000,000 × 100 B = 10 GB a day.',
      },
      {
        heading: 'Step by step',
        body: '1. The Search box waits for a short pause in typing (debounce), then sends the prefix.\n2. The Edge Cache answers at once if this prefix is cached in the browser or at the edge.\n3. On a miss the request goes to the Suggestion API.\n4. The Suggestion API checks the Prefix Cache (Redis).\n5. On another miss it asks the Trie Servers, picking the shard from the first letter.\n6. The trie walks one level per letter and reads the stored top k plus spares from the node.\n7. The Blocklist Filter removes banned phrases.\n8. The Trending Layer adds queries that are spiking right now.\n9. The list goes back through the Suggestion API, is cached in Redis and the Edge Cache, and the Search box shows it.\n10. When the user submits a search, it goes to the Query Log (Kafka).\n11. The Aggregator counts, saves totals in the Query Counts DB, the Trie Builder makes a new trie and puts it in the Trie Snapshot Store, and Trie Servers load it.',
      },
      {
        heading: 'Components',
        body: '- Search box: the client; debounces keystrokes, cancels outdated requests and ignores late answers.\n- Edge Cache: browser and CDN cache; short prefixes are cached for a minute or two.\n- Suggestion API: stateless service that checks caches, calls the trie and merges the trending layer.\n- Prefix Cache (Redis): maps a prefix to its final list for about 60 seconds; absorbs most traffic.\n- Trie Servers: in-memory tries, sharded by the first letters of the prefix, each node holding its top-k ids.\n- Blocklist Filter: removes banned phrases at serving time, so a policy change takes effect without rebuilding the trie.\n- Trending Layer: a small counter of the last hour that boosts spiking queries.\n- Query Log (Kafka): a stream of every submitted search.\n- Aggregator: sums log events into counts per query, in batches or as a stream.\n- Query Counts DB: weekly totals per query, with old data decayed or dropped.\n- Trie Builder: reads the counts, builds the trie with top-k on every node, and writes a snapshot.\n- Trie Snapshot Store: object storage holding trie snapshots; servers download and swap them in without downtime.',
      },
      {
        heading: 'Key decisions',
        body: '- Top-k stored on each node versus computed on demand: storing costs memory (the 14.4 GB above) but makes every lookup a few steps. Computing means scanning the subtree, which for "a" is millions of queries.\n- Build offline versus update live: updating counts on every search would lock the hot nodes of the trie and make the top-k jump around. Rebuild daily and swap the snapshot.\n- Ranking: weekly count is simple; recency decay and the trending layer (score = weekly + 100 × last hour in this model) handle news. Personalisation can be added by merging a per-user list.\n- Sharding: by the first letter is easy but uneven (more words start with s than x). Real systems split by measured load and may duplicate shard maps in the API.\n- Debounce on the client: waiting about 150 ms cuts requests by a large share at almost no cost to the user.\n- Typos and languages: a basic trie only matches exact prefixes. Fuzzy matching adds an edit-distance step or a separate index.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Replicate each trie shard; any replica can answer, and a bad snapshot is fixed by loading the previous one.\n- Keep the last good snapshot on disk, so a failed build leaves the old suggestions running.\n- Cache keys include a version (sug:v7:wor) so a new snapshot or a block change can invalidate everything by bumping the version.\n- If the Suggestion API is slow, the client should give up quickly and show no dropdown; autocomplete is never worth blocking a search.\n- Hot prefixes (the first letter, "how to") are served from the edge; the trie sees the long tail only.\n- Reduce load by not suggesting for one-letter prefixes, or by serving them from a static list.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why not just run SELECT ... WHERE query LIKE \'wor%\' ORDER BY count?\n- How much memory does the trie need, and how would you shard it?\n- How do you make a breaking-news query appear within minutes?\n- How do you remove a phrase from suggestions right now?\n- How would you personalise suggestions without a separate trie per user?',
      },
    ],
    trace: { input: '', steps: [] },
    code: [
      {
        title: 'Trie with top-k on every node',
        language: 'typescript',
        source: `type Node = { kids: Map<string, Node>; top: string[] }

// counts: the weekly total per query. Built once, offline.
export function build(counts: Map<string, number>, k = 5): Node {
  const root: Node = { kids: new Map(), top: [] }
  const ranked = [...counts].sort((a, b) => b[1] - a[1])   // most popular first
  for (const [query] of ranked) {
    let n = root
    for (const ch of query) {
      if (!n.kids.has(ch)) n.kids.set(ch, { kids: new Map(), top: [] })
      n = n.kids.get(ch)!
      if (n.top.length < k + 2) n.top.push(query)           // k + 2 spares for the filter
    }
  }
  return root
}

export function suggest(root: Node, prefix: string, k = 5): string[] {
  let n = root
  for (const ch of prefix) {
    const next = n.kids.get(ch)
    if (!next) return []
    n = next
  }
  return n.top.slice(0, k)   // no scan: the answer is already on the node
}`,
      },
      {
        title: 'Client: debounce and drop stale answers',
        language: 'javascript',
        source: `let timer
let latest = 0

input.addEventListener('input', () => {
  clearTimeout(timer)
  const q = input.value.trim().toLowerCase()
  if (!q) return hideDropdown()
  timer = setTimeout(async () => {
    const id = ++latest                       // remember which request this is
    const res = await fetch('/suggest?q=' + encodeURIComponent(q))
    if (id !== latest) return                 // a newer keystroke won; ignore this late answer
    render(await res.json())
  }, 150)                                      // wait for a pause in typing
})`,
      },
      {
        title: 'Aggregate the query log',
        language: 'sql',
        source: `-- Daily job: turn raw search events into the counts the trie is built from.
INSERT INTO query_counts (query, lang, week_count, last_seen)
SELECT lower(trim(q)), lang, count(*), max(ts)
FROM search_events
WHERE ts >= now() - interval '7 days'
GROUP BY lower(trim(q)), lang
HAVING count(*) >= 100            -- drop the rare tail: it would only bloat the trie
ON CONFLICT (query, lang) DO UPDATE
SET week_count = EXCLUDED.week_count, last_seen = EXCLUDED.last_seen;`,
      },
      {
        title: 'Cache a prefix in Redis',
        language: 'python',
        source: `import json, redis
r = redis.Redis()
VERSION = "v7"   # bump to invalidate every cached list at once

def suggestions(prefix: str, k: int, trie) -> list[str]:
    key = f"sug:{VERSION}:{prefix}:{k}"
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)
    result = trie.lookup(prefix, k)           # network call to a trie shard
    r.setex(key, 60, json.dumps(result))      # short TTL: new snapshots show up within a minute
    return result`,
      },
    ],
    related: ['Trie', 'Debounce', 'Top-k', 'Cache invalidation', 'Sharding', 'Kafka'],
  },
  simulator,
}
searchAutocomplete.explanation.trace = simulator.run(simulator.defaults)
