import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator, stableHash } from './simulator'
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
  difficulty: 'Beginner',
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
    "primer-design-pastebincom-or-bitly",
    "primer-cache",
    "explaining-5-unique-id-generators-in-distributed-systems",
    "unique-id-generator",
    "top-5-caching-strategies",
    "what-happens-when-you-type-a-url-into-your-browser",
    "url-uri-urn-do-you-know-the-differences",
  ],
  story: {
    title: 'The link that had to survive a cricket final',
    dek: 'A college project, a seven-character code and one link on TV during the last over. Why a URL shortener is really a lesson in reading fast.',
    chapters: [
      {
        heading: 'Seven characters',
        body: 'Meera built sho.rt in her final year of college, mostly so the fest posters could fit a link. The idea is tiny: store a long URL, hand back a short code, and when someone opens the code, send them on to the long URL.\n\nThe interesting part is the code. Meera used a counter: every new link gets the next number, and the number is written in **base62**, using the digits 0–9, a–z and A–Z, 62 symbols in all. Base62 squeezes big numbers into very few characters. Link number 125 billion becomes `2crtgcg`. Seven characters give 62⁷ codes, about 3.5 trillion (3.5 lakh crore), far more than the service will ever need.\n\nA counter never collides, so there is no "is this code taken?" check. To avoid asking a central counter on every request, each server reserves a block of 1k numbers at a time and hands them out on its own.',
        replay: { label: 'Shorten a link and follow it', values: { url: 'https://www.example.com/fest/2026/schedule-and-passes' } },
      },
      {
        heading: 'The final over',
        body: 'Two years later, sho.rt was a small company creating about 100 million links a month. That sounds like a lot, but it\'s only about 40 new links a second (100 million ÷ 30 days ÷ 86,400 seconds ≈ 38.6). The real load runs the other way. A link is created once and opened about 100 times, so the servers handled about 4k redirects a second. A URL shortener is read-heavy.\n\nThen a sports channel put a sho.rt link on screen during the last over of a cricket final. Redirects for that one code jumped from nothing to tens of thousands a second. Every redirect was a database read, and almost all of them were for the same row. The database\'s CPU hit 100%, and every link on the service slowed down, not just the famous one.\n\nThe fix was a **cache**: a small, fast, in-memory copy of the answers asked for most. Before touching the database, the redirect server now asks Redis, "do you have `2crtgcg`?" On a miss it reads the database once and stores the answer in Redis for a day (a TTL, time to live). This pattern is called **cache-aside**. Link traffic is very lopsided, with a few hot links getting most of the clicks, so a small cache answers almost every redirect in under a millisecond.\n\n> The database stopped seeing the final. Redis saw all of it.\n\nThere was one more scare. When the hot entry finally expired, thousands of requests missed at the same instant and all ran to the database together: a **cache stampede**. Now requests for the same missing key are coalesced: one request refills the entry and the others wait briefly for that result.',
        replay: { label: 'Watch a cache miss, then a hit', values: { url: 'https://www.example.com/sports/final-over-highlights' } },
      },
      {
        heading: 'Where did the clicks go?',
        body: 'A week later, the marketing team asked why their click counts had halved while their sales went up.\n\nThe redirect was answering with **301 Moved Permanently**. A 301 tells the browser "this will never change, so remember it", and the browser did: the next time anyone tapped the link, it skipped sho.rt entirely. That\'s great for speed and terrible for counting, and the link\'s target could never be changed again.\n\nMeera switched to **302 Found**, a temporary redirect, and configured caching so browsers would generally request the short link through the service again. A 302 alone is not a guarantee that every click will be counted. To keep counting from slowing redirects down, each redirect drops a small "click" event onto a queue and moves on. A separate worker reads the queue and adds up clicks per link per day.',
      },
      {
        heading: 'Guessable by design',
        body: 'The last lesson arrived in a security email. Someone had noticed that sho.rt codes were sequential: `2crtgcg`, then `2crtgch`, then `2crtgci`. They wrote a script that walked through the codes and found links people thought were private, like shared documents and invoices.\n\nA counter is perfect for uniqueness and terrible for secrecy. Private links now get random seven-character codes, and the `UNIQUE` index on the code column rejects the rare duplicate, so the server just tries again. Public links keep the fast counter. Link creation also got a rate limit, so nobody can mint millions of links to probe with.\n\nHere is what sho.rt looks like today:\n- Creating a link: Shorten API, then the Key Generator for an ID, then the URL Database.\n- Opening a link: Redirect API, then the Redis Cache, and the database only on a miss.\n- A 302 for every redirect, with the click counted later, off a queue.\n- Random codes for anything private.\n\nOpen the diagram and follow one link from its creation to its first redirect.',
      },
    ],
  },
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
      { heading: "Start with the idea", body: "A URL shortener does two jobs:\n\n1. **Create:** take a long web address and give it a short code.\n2. **Redirect:** when someone opens that code, find the saved address and send the browser there.\n\nExample: `https://example.com/articles/how-to-build-a-database` becomes `https://sho.rt/aZ3k9Qx`. The service stores the pair `aZ3k9Qx → https://example.com/articles/how-to-build-a-database`.\n\nThe important design challenge is that people usually open a link many more times than they create it. That makes the redirect path the busiest part of the system." },
      { heading: "A quick note on URL and URI", body: "A **URI** is a general identifier. A **URL** is a URI that tells a client where something is and how to access it. In everyday development, people often say URL when they mean a web address.\n\n- URL: `https://sho.rt/aZ3k9Qx` — a web address the browser can request.\n- URN: `urn:isbn:9780134685991` — identifies a book by its ISBN; it does not tell you which server hosts it.\n- `mailto:support@sho.rt` — a URI that identifies an email destination.\n\nFor `https://api.sho.rt:443/v1/links/aZ3k9Qx?ref=whatsapp#stats`:\n- Scheme: `https` — how to communicate.\n- Host: `api.sho.rt` — which server name to contact.\n- Port: `443` — the network port (the default for HTTPS).\n- Path: `/v1/links/aZ3k9Qx` — which resource is requested.\n- Query: `?ref=whatsapp` — extra parameters sent with the request.\n- Fragment: `#stats` — a position within the page; browsers do not send it to the server in the HTTP request." },
      { heading: "Requirements: what must the system do?", body: "**Functional requirements (features):**\n- Accept a long HTTP or HTTPS URL and create a short code.\n- Redirect a request for that code to the saved destination.\n- Optionally support custom aliases, expiry dates, and click statistics.\n\n**Non-functional requirements (quality):**\n- Redirects should be fast and reliable.\n- Every active code must map to the correct destination.\n- Codes must be unique.\n- Private links should not be easy to guess.\n- The service should handle sudden traffic spikes, such as a link shared during a live match.\n\nRequirements describe what the product needs; the architecture describes how we meet those needs." },
      { heading: "Capacity estimates: do the maths", body: "These are **interview assumptions**, not universal facts. The goal is to estimate the order of magnitude before choosing infrastructure.\n\nAssume 100 million new links each month:\n- Average writes/second = `100,000,000 ÷ 30 ÷ 86,400` ≈ **39 writes/second**.\n- If each link is opened 100 times on average, reads are about **3,900 redirects/second**.\n- Real traffic is uneven: a live-event link can create a much higher short-lived peak.\n\nFor storage, assume 6 billion rows over five years and roughly 500 bytes per row:\n- `6 billion × 500 bytes` ≈ **3 TB** of raw row data (before indexes, replicas, and database overhead).\n\nFor seven-character Base62 codes:\n- There are `62⁷` possible combinations ≈ **3.52 trillion**.\n- This is the size of the code space, not a promise that every code is available or that seven characters are always enough.\n\n**Interview habit:** state your assumptions, show the arithmetic, then explain what the estimate means for the design." },
      { heading: "Flow 1: create a short link", body: "Follow one request from start to finish:\n\n1. The browser sends `POST /shorten` with the long URL.\n2. The Load Balancer sends the request to a Shorten API server.\n3. The API validates the URL (for example, allow only HTTP/HTTPS and check abuse rules).\n4. A Key Generator provides a unique ID. The service converts that number into a short Base62 code.\n5. The URL Database stores the code and destination. A unique constraint protects against duplicate codes.\n6. The API returns `201 Created` and the short URL.\n\nExample response: `{ \"short_url\": \"https://sho.rt/aZ3k9Qx\" }`.\n\nSave the mapping before returning the link so it cannot be used before its destination is stored successfully." },
      { heading: "Base62: how a number becomes a short code", body: "Base62 is a numbering system with 62 symbols: `0–9`, `a–z`, and `A–Z`. Decimal uses ten symbols; hexadecimal uses sixteen. Base62 can represent the same number with fewer characters.\n\nThe Key Generator gives us a number, such as `125000000000`. Base62 writes that number using 62 possible characters per position, producing a shorter string. The code is not encryption: anyone who can see sequential codes may be able to guess nearby codes.\n\nA counter is easy to make unique, but it needs coordination between servers. One common approach is to reserve blocks of IDs: a server gets (for example) 1,000 IDs at once and uses them locally. Random codes are harder to guess, but the database must reject a rare collision and the service must generate another code." },
      { heading: "Flow 2: open a short link", body: "Now a visitor requests `GET /aZ3k9Qx`:\n\n1. The Load Balancer routes the request to a Redirect API server.\n2. The Redirect API checks Redis for `url:aZ3k9Qx`.\n3. **Cache hit:** Redis has the destination, so the service can skip the database lookup.\n4. **Cache miss:** the service reads the URL Database using the unique index on `short_code`, then places the result in Redis with an expiry time (TTL).\n5. The API responds with a redirect and a `Location` header containing the destination. The browser makes a request to that destination.\n6. The service sends a click event to a queue so analytics can be processed separately.\n\nA cache is an accelerator, not the source of truth. If Redis loses an entry, the database can provide it again." },
      { heading: "Components: what each one is responsible for", body: "- **Load Balancer:** spreads incoming requests across API servers.\n- **Shorten API:** validates new URLs and coordinates code creation and storage.\n- **Key Generator:** supplies unique IDs; Base62 turns an ID into a compact code.\n- **Redirect API:** looks up a code and returns the redirect response. Keep this path small and fast.\n- **Redis:** stores frequently requested code-to-URL mappings in memory.\n- **URL Database:** the durable source of truth for every link.\n- **Click Event Queue:** accepts click events without making the visitor wait for analytics.\n- **Analytics Worker:** consumes events and calculates counts.\n- **Stats Store:** stores aggregated statistics for dashboards.\n\nSeparating these responsibilities makes it easier to scale the busy redirect path without scaling every part of the product." },
      { heading: "Data model: what do we store?", body: "A simple relational design can start with three tables:\n\n- `users`: one row per account.\n- `urls`: one row per short link, including `short_code`, `long_url`, owner, creation time, and optional expiry.\n- `url_daily_stats`: one row per link per day, with the click count.\n\nPut a **UNIQUE constraint** on `urls.short_code`. The database enforces uniqueness and creates an index that helps find a row by code. For daily statistics, a composite primary key such as `(url_id, day)` prevents duplicate daily rows for the same link.\n\nThe exact schema depends on product needs. For example, anonymous links can have a nullable `user_id`." },
      { heading: "Key decisions: explain the trade-offs", body: "**How should we generate codes?**\n- Counter + Base62: simple and unique when IDs are allocated safely, but sequential codes are guessable.\n- Hash of the URL: the same URL may produce the same hash, but truncation can cause collisions and identical URLs may need different links.\n- Random code: harder to guess; enforce a unique constraint and retry if a collision occurs.\n\n**301 or 302?**\n- `301 Moved Permanently` tells clients the destination is permanent. Browsers and intermediaries may cache it, which can reduce repeat visits to your service. That can affect click counting and make destination changes difficult.\n- `302 Found` indicates a temporary redirect and is commonly chosen when the service wants requests to keep passing through it. Caching behavior still depends on HTTP cache headers and client behavior; 302 does not guarantee every click is counted.\n\n**Why cache-aside?** Read Redis first; on a miss, read the database and populate Redis. A TTL limits how long an entry stays cached.\n\n**Why asynchronous analytics?** Publishing an event lets the redirect response proceed without waiting for a database aggregation. The queue and worker need retries and monitoring so events are not silently lost." },
      { heading: "Scaling and failure: what can go wrong?", body: "- **More normal traffic:** add stateless Redirect API instances behind the Load Balancer and increase cache capacity.\n- **Database pressure:** add read replicas where appropriate; shard only when one database can no longer meet storage or throughput needs.\n- **One viral link:** many requests may ask for the same cache key. Replication or a small local cache can help distribute that hot key.\n- **Cache stampede:** if a popular key expires, many requests may miss together and hit the database. Use request coalescing (one refill per key), early refresh, or a short lock.\n- **Key Generator outage:** servers with reserved ID blocks can continue until their local blocks run out. Monitor block usage and have a recovery plan.\n- **Abuse and phishing:** rate-limit link creation, validate destinations, and use abuse or malware checks.\n- **Queue backlog:** monitor queue lag and worker health; the redirect should not depend on a slow analytics consumer.\n\nDo not add sharding, replicas, or complex coordination before the traffic and storage estimates justify them." },
      { heading: "Interview follow-ups", body: "Use these questions to test whether you understand the trade-offs:\n\n- How would you support a user-chosen alias such as `/summer-sale` without allowing duplicates?\n- How would you make private links difficult to enumerate?\n- What changes if the destination depends on country, device, or language?\n- How would you expire and delete old links safely?\n- What happens if Redis is unavailable?\n- How would you keep redirects working during a database or region outage?\n- How would you make click analytics resilient to retries and duplicate events?\n\nA strong interview answer explains the simplest design first, then introduces complexity only when a requirement demands it." }
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Base62 encode and decode',
        language: 'javascript',
        source: `const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

// The short code is just the row's numeric ID, written in base 62.
export function encode(id) {
  if (id === 0n) return ALPHABET[0]
  let code = ''
  while (id > 0n) {
    code = ALPHABET[Number(id % 62n)] + code
    id /= 62n
  }
  return code
}

export function decode(code) {
  let id = 0n
  for (const ch of code) {
    const digit = ALPHABET.indexOf(ch)
    if (digit < 0) throw new Error(\`invalid character: \${ch}\`)
    id = id * 62n + BigInt(digit)
  }
  return id
}

// encode(125_000_000_000n) === '2crtgcg', and decode('2crtgcg') === 125_000_000_000n`,
        versions: [
          {
            language: 'java',
            source: `public class Base62 {
  static final String ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  // The short code is just the row's numeric ID, written in base 62.
  static String encode(long id) {
    if (id == 0) return "0";
    StringBuilder code = new StringBuilder();
    for (; id > 0; id /= 62) code.append(ALPHABET.charAt((int) (id % 62)));
    return code.reverse().toString();
  }

  static long decode(String code) {
    long id = 0;
    for (char ch : code.toCharArray()) {
      int digit = ALPHABET.indexOf(ch);
      if (digit < 0) throw new IllegalArgumentException("invalid character: " + ch);
      id = Math.addExact(Math.multiplyExact(id, 62), digit); // throws instead of wrapping on overflow
    }
    return id;
  }

  public static void main(String[] args) {
    System.out.println(encode(125_000_000_000L) + " " + decode("2crtgcg")); // 2crtgcg 125000000000
  }
}`,
          },
          {
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
        ],
      },
      {
        title: 'Redirect with cache-aside',
        language: 'javascript',
        source: `import express from 'express'
import { createClient } from 'redis'
import pg from 'pg'

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
    url = rows[0].long_url
    // 3. Fill the cache for the next visitor.
    await redis.set(\`url:\${code}\`, url, { EX: 86_400 })
  }
  // 4. Count the click without delaying the redirect.
  void publishClick({ code, at: new Date().toISOString(), referrer: req.get('referer') ?? null })
  res.redirect(302, url)
})`,
        versions: [
          {
            language: 'java',
            source: `import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RedirectController {
  private final StringRedisTemplate redis;
  private final JdbcTemplate db;
  private final ClickPublisher clicks;

  public RedirectController(StringRedisTemplate redis, JdbcTemplate db, ClickPublisher clicks) {
    this.redis = redis;
    this.db = db;
    this.clicks = clicks;
  }

  @GetMapping("/{code}")
  public ResponseEntity<String> redirect(@PathVariable String code,
      @RequestHeader(value = "Referer", required = false) String referrer) {
    // 1. Cache first: most redirects end here.
    String url = redis.opsForValue().get("url:" + code);
    if (url == null) {
      // 2. Miss: read the source of truth (uses the UNIQUE index on short_code).
      List<String> rows = db.queryForList("SELECT long_url FROM urls "
          + "WHERE short_code = ? AND (expires_at IS NULL OR expires_at > now())", String.class, code);
      if (rows.isEmpty()) return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Link not found");
      url = rows.get(0);
      // 3. Fill the cache for the next visitor.
      redis.opsForValue().set("url:" + code, url, Duration.ofDays(1));
    }
    // 4. Count the click without delaying the redirect.
    clicks.publishAsync(code, Instant.now(), referrer);
    return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(url)).build();
  }
}`,
          },
          {
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
        ],
      },
      {
        title: 'IDs in blocks, no per-request coordination',
        language: 'javascript',
        source: `// Each server reserves 1,000 IDs at a time from a shared Postgres sequence,
// so most links get their ID from memory with no network call.
const BLOCK = 1000n
let next = 0n
let end = 0n
let refill = null

export async function nextId(db) {
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
        versions: [
          {
            language: 'java',
            source: `import java.util.function.LongSupplier;

// Each server reserves 1,000 IDs at a time from a shared Postgres sequence,
// so most links get their ID from memory with no network call.
public class IdBlocks {
  private static final long BLOCK = 1000;
  private final LongSupplier nextBlock; // runs SELECT nextval('url_id_blocks')
  private long next = 0;
  private long end = 0;

  public IdBlocks(LongSupplier nextBlock) {
    this.nextBlock = nextBlock;
  }

  // synchronized: concurrent callers wait for one refill instead of each reserving a block.
  public synchronized long nextId() {
    if (next == end) {
      next = nextBlock.getAsLong() * BLOCK;
      end = next + BLOCK;
    }
    return next++;
  }

  public static void main(String[] args) {
    long[] sequence = {7};
    IdBlocks ids = new IdBlocks(() -> sequence[0]++);
    System.out.println(ids.nextId() + " " + ids.nextId()); // 7000 7001: block 7 covers 7000-7999
  }
}`,
          },
          {
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
      },
    ],
    related: ['Consistent hashing', 'Cache-aside pattern', 'Rate limiter', 'Base62 encoding', 'Database sharding'],
  },
  simulator,
}
