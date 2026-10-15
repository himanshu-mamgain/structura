import type { Trace } from '@structura/shared'
import { json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Encodes a number in base62: the short code is just the row's ID, written compactly. */
export function toBase62(id: number): string {
  let code = ''
  do {
    code = ALPHABET[id % 62] + code
    id = Math.floor(id / 62)
  } while (id > 0)
  return code
}

const simulator: Simulator = {
  fields: [{ id: 'url', label: 'Long URL to shorten', placeholder: 'https://…' }],
  defaults: { url: 'https://www.example.com/blog/2026/how-we-scaled-our-database-to-a-billion-rows' },
  run({ url }) {
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      // handled below
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      return {
        input: url,
        steps: [
          { text: 'User / Browser sends the URL through the Load Balancer to the Shorten API.', nodes: ['User / Browser', 'Load Balancer', 'Shorten API'], data: `POST /shorten\n${json({ url })}` },
          { text: 'The Shorten API validates it first. This is not an http(s) URL, so nothing is stored and the request is rejected.', nodes: ['Shorten API'], data: `HTTP/1.1 400 Bad Request\n${json({ error: 'url must be an http or https URL' })}` },
        ],
      }
    }

    // A real counter would just increment; a hash keeps this example stable per URL.
    const id = 125_000_000_000 + (stableHash(url) % 900_000_000)
    const code = toBase62(id)
    const short = `https://sho.rt/${code}`
    const now = '2026-10-11T09:30:00Z'
    const steps: Trace['steps'] = [
      { text: 'User / Browser asks to shorten the URL. The Load Balancer forwards it to one of the Shorten API servers.', nodes: ['User / Browser', 'Load Balancer', 'Shorten API'], data: `POST /shorten\nContent-Type: application/json\n\n${json({ url })}` },
      { text: `Shorten API validates it: scheme ${parsed.protocol.replace(':', '')}, host ${parsed.hostname}, ${url.length} characters. It would also check the host against a malware blocklist.`, nodes: ['Shorten API'], data: null },
      { text: `Key Generator hands out the next unique ID, and base62 turns it into a ${code.length}-character code.`, nodes: ['Key Generator (base62)'], data: `next id   = ${id.toLocaleString('en-US')}\nbase62    = "${code}"\n(62^${code.length} = ${(62 ** code.length).toExponential(1)} possible codes)` },
      { text: 'The mapping is stored. short_code is UNIQUE, so a duplicate could never be inserted.', nodes: ['URL Database'], data: `INSERT INTO urls (id, short_code, long_url, created_at)\nVALUES (${id}, '${code}', '${url}', '${now}');` },
      { text: 'The short link goes back to the user.', nodes: ['Shorten API', 'User / Browser'], data: `HTTP/1.1 201 Created\n${json({ short_url: short })}` },
      { text: `Later, someone opens ${short}. The Load Balancer sends it to a Redirect API server.`, nodes: ['User / Browser', 'Load Balancer', 'Redirect API'], data: `GET /${code}\nHost: sho.rt` },
      { text: 'In cache? First the Redis Cache is checked. This link is new, so it is a miss.', nodes: ['In cache?', 'Redis Cache'], data: `GET url:${code}\n→ (nil)` },
      { text: 'On a miss, the URL Database is read using the unique index on short_code (a few milliseconds).', nodes: ['URL Database'], data: `SELECT long_url FROM urls\nWHERE short_code = '${code}'\n  AND (expires_at IS NULL OR expires_at > now());\n→ '${url}'` },
      { text: 'The answer is put in Redis Cache with a TTL, so the next visits skip the database.', nodes: ['Redis Cache'], data: `SET url:${code} "${url}" EX 86400` },
      { text: 'Redirect API answers with 302 and the browser follows the Location header to the original page.', nodes: ['Redirect API', 'User / Browser'], data: `HTTP/1.1 302 Found\nLocation: ${url}\nCache-Control: private, max-age=0` },
      { text: 'Without slowing the redirect, a click event goes to the Click Event Queue; the Analytics Worker adds it to the daily count.', nodes: ['Click Event Queue', 'Analytics Worker', 'Stats Store'], data: `${json({ code, at: now, referrer: 'https://news.example.org/' })}\n\nINSERT INTO url_daily_stats (url_id, day, clicks)\nVALUES (${id}, '2026-10-11', 1)\nON CONFLICT (url_id, day) DO UPDATE\n  SET clicks = url_daily_stats.clicks + 1;` },
      { text: 'The next visitor gets a cache hit: Redis answers in under a millisecond and the database is not touched.', nodes: ['In cache?', 'Redis Cache', 'Redirect API'], data: `GET url:${code}\n→ "${url}"\n\nHTTP/1.1 302 Found\nLocation: ${url}` },
    ]
    return { input: url, steps }
  },
}

export const urlShortener: StaticTopic = {
  kind: 'static',
  id: 'url-shortener',
  title: 'URL Shortener',
  blurb: 'Read-heavy service: ID generation, caching, redirects, analytics',
  video: '/videos/url-shortener.mp4',
  chapters: [
    [0, "Introduction"],
    [4, "Making a short link"],
    [25, "Base62 encoding"],
    [41, "Redirect and caching"],
    [68, "Scaling for reads"],
    [83, "Recap"],
  ],
  guides: [
    "explaining-5-unique-id-generators-in-distributed-systems",
    "unique-id-generator",
    "top-5-caching-strategies",
    "what-happens-when-you-type-a-url-into-your-browser",
    "url-uri-urn-do-you-know-the-differences",
  ],
  takeaways: [
    "Give each link a unique ID from a counter and write it in base62: 7 characters cover 3.5 trillion links.",
    "Reads outnumber writes about 100 to 1, so optimise the redirect path.",
    "Cache hot codes in Redis; the database only sees cache misses.",
    "Keep API servers stateless so you can add more behind the load balancer.",
    "Count clicks through a queue, never inside the redirect.",
    "Hand each server a block of IDs so the counter is not a bottleneck.",
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'api', label: 'Application tier' },
      { id: 'data', label: 'Data tier' },
      { id: 'analytics', label: 'Analytics (async)' },
    ],
    nodes: [
      { id: 'user', label: 'User / Browser', shape: 'ellipse', color: 'blue', group: null },
      { id: 'lb', label: 'Load Balancer', shape: 'rectangle', color: 'violet', group: null },
      { id: 'shorten', label: 'Shorten API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'keygen', label: 'Key Generator (base62)', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'redirect', label: 'Redirect API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'hit', label: 'In cache?', shape: 'diamond', color: 'violet', group: 'api' },
      { id: 'cache', label: 'Redis Cache', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'db', label: 'URL Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'queue', label: 'Click Event Queue', shape: 'rectangle', color: 'orange', group: 'analytics' },
      { id: 'worker', label: 'Analytics Worker', shape: 'rectangle', color: 'violet', group: 'analytics' },
      { id: 'stats', label: 'Stats Store', shape: 'rectangle', color: 'green', group: 'analytics' },
    ],
    edges: [
      { from: 'user', to: 'lb', label: 'POST /shorten, GET /:code', dashed: false },
      { from: 'lb', to: 'shorten', label: 'create', dashed: false },
      { from: 'shorten', to: 'keygen', label: 'next ID', dashed: false },
      { from: 'shorten', to: 'db', label: 'insert code → URL', dashed: false },
      { from: 'lb', to: 'redirect', label: 'redirect', dashed: false },
      { from: 'redirect', to: 'hit', label: 'look up code', dashed: false },
      { from: 'hit', to: 'cache', label: 'yes', dashed: false },
      { from: 'hit', to: 'db', label: 'no (miss)', dashed: false },
      { from: 'db', to: 'cache', label: 'fill with TTL', dashed: true },
      { from: 'redirect', to: 'user', label: '302 Location', dashed: true },
      { from: 'redirect', to: 'queue', label: 'click event', dashed: true },
      { from: 'queue', to: 'worker', label: 'consume', dashed: false },
      { from: 'worker', to: 'stats', label: 'daily counts', dashed: false },
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
          { name: 'email', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'urls',
        name: 'urls',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'short_code', type: 'varchar(10)', pk: false, fk: null, nullable: false, unique: true },
          { name: 'long_url', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.id', nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'expires_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(user_id, created_at)', '(expires_at) for cleanup'],
      },
      {
        id: 'url_daily_stats',
        name: 'url_daily_stats',
        columns: [
          { name: 'url_id', type: 'bigint', pk: true, fk: 'urls.id', nullable: false, unique: false },
          { name: 'day', type: 'date', pk: true, fk: null, nullable: false, unique: false },
          { name: 'clicks', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'urls', to: 'users', kind: 'one-to-many', label: 'creates' },
      { from: 'url_daily_stats', to: 'urls', kind: 'one-to-many', label: 'counts' },
    ],
  },
  explanation: {
    title: 'URL Shortener',
    summary:
      'Turns a long URL into a short code and redirects anyone who opens the code. It is a classic read-heavy system: one link is created once and opened many times, so the design is mostly about fast lookups.',
    sections: [
      {
        heading: 'Overview',
        body: 'Users submit a long URL and get back a short link like sho.rt/aZ3k9Qx. Opening that link sends them to the original URL. Optional extras: custom aliases, expiry dates and click analytics.\n\nThe defining property is the read/write ratio. A link is written once and read many times, often 100 reads per write, so the redirect path is what you optimize.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Create a short code for a long URL (optionally a custom alias and an expiry).\n- Redirect a short code to its URL.\n- Count clicks per link.\n\nNon-functional:\n- Redirects must be fast: a few milliseconds inside the service.\n- Highly available: a broken redirect is a broken link on someone else\'s page.\n- Codes must be unique and hard to guess if links are private.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Illustrative numbers, typical for an interview:\n- 100 million new links a month is about 40 writes per second on average.\n- At 100 reads per write, that is about 4,000 redirects per second, with peaks of maybe 10 times that.\n- At roughly 500 bytes per row, five years of links (6 billion rows) is about 3 TB, which suits a sharded relational store or a key-value store.\n- Code length: 62^7 is about 3.5 trillion codes, so 7 base62 characters (a–z, A–Z, 0–9) last a very long time.',
      },
      {
        heading: 'Step by step',
        body: 'Creating a link:\n1. User / Browser sends POST /shorten through the Load Balancer to the Shorten API.\n2. The Shorten API asks the Key Generator for the next unique ID and encodes it in base62.\n3. It inserts the code and long URL into the URL Database and returns the short link.\n\nOpening a link:\n4. User / Browser requests GET /:code; the Load Balancer routes it to the Redirect API.\n5. In cache? Redis Cache answers most lookups in well under a millisecond.\n6. On a miss, the Redirect API reads the URL Database and fills the cache with a TTL.\n7. It returns 302 with a Location header, and the browser follows it.\n8. In the background it sends a click event to the Click Event Queue; the Analytics Worker turns events into daily counts in the Stats Store.',
      },
      {
        heading: 'Components',
        body: '- Load Balancer: spreads traffic across stateless API servers, so you scale by adding servers.\n- Shorten API: validates the URL (format, blocklist), gets an ID, stores the mapping.\n- Key Generator (base62): hands out unique IDs; base62 encoding turns a number into a short, URL-safe code.\n- Redirect API: the hot path. Look up, redirect, emit an event, nothing else.\n- Redis Cache: holds popular codes. Link traffic is very skewed, so a small hot set serves most redirects.\n- URL Database: the source of truth, keyed by short code.\n- Click Event Queue and Analytics Worker: keep analytics off the redirect path so slow counting never delays a redirect.\n- Stats Store: aggregated counts for dashboards.',
      },
      {
        heading: 'Data model',
        body: '- urls: one row per short link. short_code is UNIQUE, which also creates the index every redirect uses. user_id is nullable so anonymous links work.\n- users: the people who create links.\n- url_daily_stats: one row per link per day, primary key (url_id, day). Counting per day keeps the table small; raw click events stay in the queue or a log store, not in the OLTP database.',
      },
      {
        heading: 'Key decisions',
        body: '- How to generate codes. A counter encoded in base62 never collides, but is guessable and needs coordination. Hashing the URL (and truncating) needs collision checks. Random codes need a uniqueness check on insert. A common answer: each server reserves a block of IDs (say 1,000 at a time) from a central counter, so there is no per-request coordination.\n- 301 or 302. A 301 (permanent) is cached by browsers, which saves traffic but means later clicks never reach you: no analytics, and you cannot change the target. A 302 (temporary) sends every click through the service.\n- Cache-aside with a TTL: read the cache, fall back to the database, then populate the cache. Links rarely change, so stale entries are rarely a problem.\n- Async analytics: never count clicks synchronously on the redirect path.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Reads: add Redirect API servers and cache capacity first, then database read replicas.\n- Storage: shard the URL Database by short code (hash-based) once a single node is not enough.\n- Hot links: a viral link can overload one cache node. Replicate hot keys or add a small in-process cache on each server.\n- Cache stampede: when a popular entry expires, many requests hit the database at once. Use request coalescing or refresh entries early.\n- Key Generator as a single point of failure: block reservation means servers keep working through short outages.\n- Abuse: rate-limit link creation, and scan target URLs for phishing and malware.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you support custom aliases without collisions?\n- How do you make codes unguessable for private links?\n- What changes if each link must redirect differently by country or device?\n- How do you delete expired links without slowing down the database?\n- How would you guarantee a link keeps working if a whole region goes down?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Base62 encode and decode',
        language: 'typescript',
        source: `const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

// The short code is just the row's numeric ID, written in base 62.
export function encode(id: bigint): string {
  if (id === 0n) return ALPHABET[0]
  let code = ''
  while (id > 0n) {
    code = ALPHABET[Number(id % 62n)] + code
    id /= 62n
  }
  return code
}

export function decode(code: string): bigint {
  let id = 0n
  for (const ch of code) {
    const digit = ALPHABET.indexOf(ch)
    if (digit < 0) throw new Error(\`invalid character: \${ch}\`)
    id = id * 62n + BigInt(digit)
  }
  return id
}

// encode(125_000_000_000n) === '2crtgcg', and decode('2crtgcg') === 125_000_000_000n`,
      },
      {
        title: 'Redirect with cache-aside',
        language: 'typescript',
        source: `import express from 'express'
import { createClient } from 'redis'
import pg from 'pg'

declare function publishClick(event: object): Promise<void> // e.g. a Kafka producer

const app = express()
const db = new pg.Pool()
const redis = createClient()
await redis.connect()

app.get('/:code', async (req, res) => {
  const { code } = req.params
  // 1. Cache first: most redirects end here.
  let url = await redis.get(\`url:\${code}\`)
  if (!url) {
    // 2. Miss: read the source of truth (uses the UNIQUE index on short_code).
    const { rows } = await db.query(
      \`SELECT long_url FROM urls
       WHERE short_code = $1 AND (expires_at IS NULL OR expires_at > now())\`,
      [code],
    )
    if (rows.length === 0) return res.status(404).send('Link not found')
    url = rows[0].long_url as string
    // 3. Fill the cache for the next visitor.
    await redis.set(\`url:\${code}\`, url, { EX: 86_400 })
  }
  // 4. Count the click without delaying the redirect.
  void publishClick({ code, at: new Date().toISOString(), referrer: req.get('referer') ?? null })
  res.redirect(302, url)
})`,
      },
      {
        title: 'IDs in blocks, no per-request coordination',
        language: 'typescript',
        source: `import type pg from 'pg'

// Each server reserves 1,000 IDs at a time from a shared Postgres sequence,
// so most links get their ID from memory with no network call.
const BLOCK = 1000n
let next = 0n
let end = 0n
let refill: Promise<void> | null = null

export async function nextId(db: pg.Pool): Promise<bigint> {
  while (next === end) {
    // Concurrent callers share one refill instead of each reserving a block.
    refill ??= db
      .query(\`SELECT nextval('url_id_blocks') AS block\`)
      .then(({ rows }) => {
        next = BigInt(rows[0].block) * BLOCK
        end = next + BLOCK
      })
      .finally(() => {
        refill = null
      })
    await refill
  }
  return next++
}`,
      },
    ],
    related: ['Consistent hashing', 'Cache-aside pattern', 'Rate limiter', 'Base62 encoding', 'Database sharding'],
  },
  simulator,
}
