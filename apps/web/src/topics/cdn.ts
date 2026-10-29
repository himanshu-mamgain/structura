import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A CDN in front of an e-commerce site whose origin is in Virginia (us-east-1).
// Round-trip times come from great-circle distances between the cities, at
// 200 km per millisecond in fibre (two thirds of the speed of light) and a 1.4x
// detour for real cable routes: rtt = 2 x km x 1.4 / 200. The simulator uses
// them, so "why is the CDN faster?" is answered with the geography.

const HOST = 'cdn.shop.example'
const EDGE = 'Edge Cache (nearest PoP)'
const LOOKUP = 'Cache Lookup: hit or miss?'
const SHIELD = 'Regional Shield Cache'
const ORIGIN = 'Origin Server'

/** Round trip in ms for a great-circle distance in km. */
const rtt = (km: number) => Math.round((2 * km * 1.4) / 200)

const LAST_MILE_MS = 12
const EDGE_WORK_MS = 2
const ORIGIN_WORK_MS = 40
/** A typical 4G/Wi-Fi download speed: 50 Mbit/s = 6.25 MB/s. */
const MB_PER_S = 6.25

const USERS: Record<string, { pop: string; shield: string; popToShield: number; shieldToOrigin: number; direct: number }> = {
  'Mumbai': { pop: 'Mumbai', shield: 'Singapore', popToShield: rtt(3904), shieldToOrigin: rtt(15522), direct: rtt(12855) },
  'Frankfurt': { pop: 'Frankfurt', shield: 'London', popToShield: rtt(638), shieldToOrigin: rtt(5917), direct: rtt(6549) },
  'Sydney': { pop: 'Sydney', shield: 'Singapore', popToShield: rtt(6306), shieldToOrigin: rtt(15522), direct: rtt(15674) },
}

interface Asset {
  path: string
  kb: number
  control: string
  /** Seconds the edge may serve it without asking again; 0 means never stored. */
  ttl: number
  swr: number
  note: string
}

const ASSETS: Record<string, Asset> = {
  'Logo, fingerprinted (1 year)': {
    path: '/assets/logo.4f3a9c.png', kb: 18, ttl: 31_536_000, swr: 0,
    control: 'public, max-age=31536000, immutable',
    note: 'The file name contains a hash of its bytes, so it never changes: a new logo gets a new name. That is what makes a one-year lifetime safe.',
  },
  'Price list JSON (60 s)': {
    path: '/api/prices.json', kb: 4, ttl: 60, swr: 30,
    control: 'public, max-age=60, stale-while-revalidate=30',
    note: 'Prices change, so it lives for one minute. stale-while-revalidate lets the edge answer instantly with a slightly old copy while it refreshes in the background.',
  },
  'Video segment (1 day)': {
    path: '/video/hls/seg-0412.ts', kb: 1800, ttl: 86_400, swr: 0,
    control: 'public, max-age=86400',
    note: 'A 6-second HLS segment at about 2.4 Mbit/s is 1.8 MB. Segments never change once written, so they cache well, and they are the bulk of a streaming service\'s traffic.',
  },
  'Account page (private)': {
    path: '/account', kb: 12, ttl: 0, swr: 0,
    control: 'private, no-store',
    note: 'It shows one person\'s data. A shared cache must never keep it, or the next visitor could be shown it.',
  },
}

const STATES = [
  'Cold: nobody asked yet',
  'Edge hit: fresh copy at the edge',
  'Edge copy expired',
  'Only the shield has it',
]

const ms = (n: number) => `${Math.round(n)} ms`

const simulator: Simulator = {
  fields: [
    { id: 'asset', label: 'What is requested', options: Object.keys(ASSETS) },
    { id: 'user', label: 'Where the visitor is', options: Object.keys(USERS) },
    { id: 'state', label: 'What the cache holds', options: STATES },
  ],
  defaults: { asset: 'Video segment (1 day)', user: 'Mumbai', state: STATES[0] },
  run({ asset, user, state }) {
    const a = ASSETS[asset] ?? ASSETS['Video segment (1 day)']
    const u = USERS[user] ?? USERS.Mumbai
    const s = STATES.includes(state) ? state : STATES[0]
    const bypass = a.ttl === 0
    const longLived = a.ttl >= 31_536_000
    // An immutable file is never "expired"; the only way it is missing is LRU eviction.
    const evicted = s === STATES[2] && longLived
    const expired = s === STATES[2] && !longLived && !bypass
    const edgeFresh = s === STATES[1] && !bypass
    const shieldOnly = (s === STATES[3] || evicted) && !bypass

    const transfer = (a.kb / 1024 / MB_PER_S) * 1000
    const handshake = 3 * LAST_MILE_MS
    const toShield = u.popToShield + EDGE_WORK_MS
    const toOrigin = u.shieldToOrigin + ORIGIN_WORK_MS
    const directTtfb = 3 * (LAST_MILE_MS + u.direct) + ORIGIN_WORK_MS
    const key = `GET ${HOST}${a.path} | Accept-Encoding: br`
    const sizeLabel = a.kb >= 1024 ? `${(a.kb / 1024).toFixed(1)} MB` : `${a.kb} KB`

    const steps: Trace['steps'] = [
      {
        text: `A visitor in ${user} opens a page that links to ${a.path}. The browser asks DNS for ${HOST}. GeoDNS (or anycast routing) answers with the address of the closest point of presence (PoP), not the origin's address.`,
        nodes: ['Browser', 'GeoDNS / Anycast'],
        data: `dig ${HOST}\n${HOST}. 30 IN A 203.0.113.${user === 'Mumbai' ? 17 : user === 'Frankfurt' ? 42 : 88}   ← ${u.pop} PoP\n(a visitor in Virginia would get a different address for the same name)`,
      },
      {
        text: `The browser opens HTTPS to the ${u.pop} PoP: TCP, TLS 1.3 and the request take 3 round trips of about ${LAST_MILE_MS} ms each, because the server is a few kilometres away. That alone is ${handshake} ms. Direct to Virginia the same handshake would cost ${3 * (LAST_MILE_MS + u.direct)} ms.`,
        nodes: ['Browser', EDGE],
        data: `GET ${a.path} HTTP/2\nHost: ${HOST}\nAccept-Encoding: br\n\nconnection setup: 3 × ${LAST_MILE_MS} ms = ${handshake} ms (vs 3 × ${LAST_MILE_MS + u.direct} ms to the origin)`,
      },
    ]

    if (bypass) {
      steps.push(
        {
          text: `The response is marked "${a.control}", so the edge never stores it. Every request is passed straight through to the origin. ${a.note}`,
          nodes: [EDGE, LOOKUP],
          data: `cache key: ${key}\nrule: Cache-Control has no-store → BYPASS (nothing is read or written)`,
        },
        {
          text: `The request travels PoP → shield → origin over connections the CDN keeps open (no new handshakes), so it costs one round trip per hop: ${u.popToShield} ms then ${u.shieldToOrigin} ms, plus ${ORIGIN_WORK_MS} ms for the origin to build the page.`,
          nodes: [SHIELD, ORIGIN],
          data: `${u.pop} → ${u.shield}: ${u.popToShield} ms\n${u.shield} → Virginia: ${u.shieldToOrigin} ms\norigin work: ${ORIGIN_WORK_MS} ms\nX-Cache: BYPASS`,
        },
      )
      const ttfb = handshake + toShield + toOrigin
      steps.push({
        text: `A CDN does not speed up what it cannot cache, and it can even add a hop (${ms(ttfb)} to first byte versus ${ms(directTtfb)} direct). What it still gives: faster TLS at the edge, one warm connection to the origin, and protection from attacks. Dynamic pages are why teams split "static assets on the CDN" from "personal pages".`,
        nodes: [EDGE, 'Edge Metrics & Logs'],
        data: `TTFB via CDN: ${ms(ttfb)}\nTTFB direct:  ${ms(directTtfb)}\nlog: { path: "${a.path}", cache: "BYPASS", status: 200 }`,
      })
      return { input: `${a.path} from ${user}, ${asset}`, steps }
    }

    steps.push({
      text: `The edge builds a cache key from the method, host, path and the headers the response varies on (here Accept-Encoding, so Brotli and gzip copies are stored separately). Then it checks its own memory and disk. ${a.note}`,
      nodes: [EDGE, LOOKUP],
      data: `cache key: ${key}\norigin said: Cache-Control: ${a.control}\nmax-age = ${a.ttl.toLocaleString('en-US')} s`,
    })

    let ttfb: number
    let outcome: string
    if (edgeFresh) {
      const age = Math.min(Math.round(a.ttl * 0.4), 3_600)
      ttfb = handshake + EDGE_WORK_MS
      outcome = 'HIT'
      steps.push({
        text: `HIT. The copy is ${age.toLocaleString('en-US')} s old and its lifetime is ${a.ttl.toLocaleString('en-US')} s, so it is fresh. The edge answers from its own disk. The origin never hears about this request.`,
        nodes: [LOOKUP, 'Browser'],
        data: `HTTP/2 200\nAge: ${age}\nX-Cache: HIT from ${u.pop}\nContent-Length: ${a.kb * 1024}`,
      })
    } else if (expired && a.swr > 0) {
      ttfb = handshake + EDGE_WORK_MS
      outcome = 'STALE (refreshing)'
      steps.push(
        {
          text: `The copy is ${a.ttl + 12} s old, 12 s past its ${a.ttl} s lifetime, but inside the ${a.swr} s stale-while-revalidate window. The edge answers the visitor right now with the stale copy: they never wait for the origin.`,
          nodes: [LOOKUP, 'Browser'],
          data: `HTTP/2 200\nAge: ${a.ttl + 12}\nX-Cache: STALE from ${u.pop}`,
        },
        {
          text: `In the background the edge revalidates through the shield: a conditional request with the ETag it already holds. The origin replies 304 Not Modified with no body (${u.popToShield + u.shieldToOrigin + ORIGIN_WORK_MS} ms, none of it felt by the visitor), and the copy is fresh for another ${a.ttl} s.`,
          nodes: [SHIELD, ORIGIN],
          data: `GET ${a.path}\nIf-None-Match: "8f3c1a"\n→ 304 Not Modified (ETag matches)\nbackground cost: ${u.popToShield} + ${u.shieldToOrigin} + ${ORIGIN_WORK_MS} = ${u.popToShield + u.shieldToOrigin + ORIGIN_WORK_MS} ms`,
        },
      )
    } else if (expired) {
      ttfb = handshake + toShield + toOrigin
      outcome = 'REVALIDATED'
      steps.push(
        {
          text: `EXPIRED. The edge still has the bytes but its ${a.ttl.toLocaleString('en-US')} s lifetime is over, so it must ask before serving. It sends a conditional request with the ETag it holds, through the shield, to the origin.`,
          nodes: [LOOKUP, SHIELD],
          data: `GET ${a.path}\nIf-None-Match: "8f3c1a"\n${u.pop} → ${u.shield}: ${u.popToShield} ms`,
        },
        {
          text: `The shield's copy is expired too, so the request reaches the origin, which answers 304 Not Modified: same ETag, no body. The ${a.kb >= 1024 ? 'big file' : 'file'} is not moved again; only a few hundred bytes cross the ocean (${u.shieldToOrigin} ms + ${ORIGIN_WORK_MS} ms work).`,
          nodes: [SHIELD, ORIGIN],
          data: `HTTP/1.1 304 Not Modified\nETag: "8f3c1a"\nCache-Control: ${a.control}`,
        },
        {
          text: `Both caches renew the copy's lifetime and the edge serves it: ${ms(ttfb)} to first byte. Slower than a HIT, but cheap on the origin and much cheaper than a full MISS.`,
          nodes: [EDGE, 'Browser'],
          data: `HTTP/2 200\nAge: 0\nX-Cache: REVALIDATED from ${u.pop}`,
        },
      )
    } else if (shieldOnly) {
      ttfb = handshake + toShield
      outcome = 'MISS, shield HIT'
      steps.push(
        {
          text: evicted
            ? `MISS at the edge: the one-year copy was pushed out to make room (caches evict the least recently used files when full). The edge asks the Regional Shield Cache in ${u.shield}, ${u.popToShield} ms away.`
            : `MISS at the edge: no PoP in ${u.pop} has asked for this file yet. It asks the Regional Shield Cache in ${u.shield}, ${u.popToShield} ms away. The shield exists so that many PoPs share one trip to the origin.`,
          nodes: [LOOKUP, SHIELD],
          data: `X-Cache: MISS from ${u.pop}\n${u.pop} → ${u.shield}: ${u.popToShield} ms`,
        },
        {
          text: `HIT at the shield: another PoP already pulled the file in. It returns the bytes, and the edge stores a copy of its own for the next visitor. The origin still sees nothing.`,
          nodes: [SHIELD, EDGE],
          data: `X-Cache: HIT from ${u.shield} (shield)\nedge stores ${sizeLabel} for ${a.ttl.toLocaleString('en-US')} s`,
        },
      )
    } else {
      ttfb = handshake + toShield + toOrigin
      outcome = 'MISS'
      steps.push(
        {
          text: `MISS at the edge. It asks the Regional Shield Cache in ${u.shield} (${u.popToShield} ms away), which misses too: this is the first request for the file anywhere in the region.`,
          nodes: [LOOKUP, SHIELD],
          data: `X-Cache: MISS from ${u.pop}\nX-Cache: MISS from ${u.shield} (shield)\n${u.pop} → ${u.shield}: ${u.popToShield} ms`,
        },
        {
          text: `Only the shield contacts the Origin Server, ${u.shieldToOrigin} ms away in Virginia, which takes ${ORIGIN_WORK_MS} ms to answer. Because every PoP in the region goes through the shield, a file that 40 PoPs miss at once still costs the origin one request.`,
          nodes: [SHIELD, ORIGIN],
          data: `GET ${a.path}  (${u.shield} → Virginia: ${u.shieldToOrigin} ms)\norigin work: ${ORIGIN_WORK_MS} ms`,
        },
        {
          text: a.kb >= 1024
            ? `The origin reads the file from Object Storage (it is ${sizeLabel}, far too big to keep on the app servers) and returns it with its caching headers.`
            : `The origin reads the file from Object Storage and returns it with its caching headers.`,
          nodes: [ORIGIN, 'Object Storage'],
          data: `GET s3://shop-assets${a.path}\nHTTP/1.1 200 OK\nCache-Control: ${a.control}\nETag: "8f3c1a"\nContent-Length: ${a.kb * 1024}`,
        },
        {
          text: `The shield and then the edge each store a copy as the bytes stream through, and the visitor gets the file. The next visitor near ${u.pop} gets a HIT.`,
          nodes: [SHIELD, EDGE, 'Browser'],
          data: `shield stores ${sizeLabel}; edge stores ${sizeLabel}; TTL ${a.ttl.toLocaleString('en-US')} s`,
        },
      )
    }

    const total = ttfb + transfer
    const directTotal = directTtfb + transfer
    steps.push({
      text: `Every request is logged at the edge. The hit ratio (HITs ÷ all requests) is the number to watch: ${outcome === 'HIT' ? 'this one was a hit, the best case' : `this one was ${outcome}`}. Time to first byte ${ms(ttfb)} via the CDN versus ${ms(directTtfb)} direct from Virginia; with the download (${sizeLabel} at 50 Mbit/s: ${ms(transfer)}) the file is complete in ${ms(total)} versus ${ms(directTotal)}.`,
      nodes: [EDGE, 'Edge Metrics & Logs'],
      data: json({ path: a.path, pop: u.pop, cache: outcome, ttfb_ms: Math.round(ttfb), ttfb_direct_ms: Math.round(directTtfb), total_ms: Math.round(total), bytes: a.kb * 1024 }),
    })
    return { input: `${a.path} from ${user}, ${outcome}`, steps }
  },
}

export const cdn: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'cdn',
  title: 'CDN: Content Delivery Network',
  blurb: 'Edge caches, cache keys and TTLs, shielding the origin, purging and hit ratio',
  guides: [
    'primer-content-delivery-network',
    'what-is-cdn-content-delivery-network',
    'how-does-cnd-work',
    'why-are-content-delivery-networks-cdn-so-popular',
    'scale-http-caching-and-cdn',
    'primer-cache',
    'top-5-strategies-to-reduce-latency',
    'which-latency-numbers-should-you-know',
  ],
  takeaways: [
    'Distance is latency: the CDN moves copies of files next to the visitor, so the slow trips to the origin become rare.',
    'Cache-Control from the origin decides what is stored and for how long; private, no-store content must never reach a shared cache.',
    'Fingerprinted file names (logo.4f3a9c.png) allow year-long caching, because a change means a new URL instead of a purge.',
    'A shield tier collapses misses from many PoPs into one request to the origin.',
    'Revalidation (ETag and 304) and stale-while-revalidate keep content fresh without making visitors wait.',
    'Watch the hit ratio: at 50,000 requests/s, going from 95% to 99% cuts the origin load from 2,500 to 500 requests/s.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'cdn', label: 'CDN network' },
      { id: 'origin', label: 'Your origin (Virginia)' },
    ],
    nodes: [
      { id: 'browser', label: 'Browser', shape: 'ellipse', color: 'blue', group: null },
      { id: 'dns', label: 'GeoDNS / Anycast', shape: 'diamond', color: 'violet', group: 'cdn' },
      { id: 'edge', label: EDGE, shape: 'rectangle', color: 'red', group: 'cdn' },
      { id: 'lookup', label: LOOKUP, shape: 'diamond', color: 'violet', group: 'cdn' },
      { id: 'shield', label: SHIELD, shape: 'rectangle', color: 'red', group: 'cdn' },
      { id: 'metrics', label: 'Edge Metrics & Logs', shape: 'rectangle', color: 'orange', group: 'cdn' },
      { id: 'purge', label: 'Purge API', shape: 'rectangle', color: 'violet', group: 'cdn' },
      { id: 'origin', label: ORIGIN, shape: 'rectangle', color: 'violet', group: 'origin' },
      { id: 'storage', label: 'Object Storage', shape: 'rectangle', color: 'green', group: 'origin' },
    ],
    edges: [
      { from: 'browser', to: 'dns', label: 'resolve cdn.shop.example', dashed: true },
      { from: 'dns', to: 'edge', label: 'nearest PoP', dashed: true },
      { from: 'browser', to: 'edge', label: 'HTTPS GET', dashed: false },
      { from: 'edge', to: 'lookup', label: 'cache key', dashed: false },
      { from: 'lookup', to: 'browser', label: 'HIT: serve copy', dashed: false },
      { from: 'lookup', to: 'shield', label: 'MISS', dashed: false },
      { from: 'shield', to: 'origin', label: 'MISS / revalidate', dashed: false },
      { from: 'origin', to: 'storage', label: 'read file', dashed: false },
      { from: 'origin', to: 'shield', label: 'Cache-Control, ETag', dashed: true },
      { from: 'shield', to: 'edge', label: 'fill', dashed: true },
      { from: 'purge', to: 'edge', label: 'purge key', dashed: true },
      { from: 'purge', to: 'shield', label: 'purge key', dashed: true },
      { from: 'edge', to: 'metrics', label: 'log hit/miss', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'assets',
        name: 'assets',
        columns: [
          { name: 'path', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'etag', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'cache_control', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'surrogate_key', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'size_bytes', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(surrogate_key)'],
      },
      {
        id: 'purge_requests',
        name: 'purge_requests',
        columns: [
          { name: 'purge_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'surrogate_key', type: 'text', pk: false, fk: 'assets.surrogate_key', nullable: false, unique: false },
          { name: 'requested_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [{ from: 'purge_requests', to: 'assets', kind: 'one-to-many', label: 'invalidates' }],
  },
  explanation: {
    title: 'CDN: Content Delivery Network',
    summary:
      'A CDN is a worldwide network of caches placed close to visitors. The first request for a file travels to your origin; the copy is kept at the edge, so later requests are answered a few kilometres away. It cuts latency, shields the origin from load and absorbs traffic spikes and attacks.',
    sections: [
      {
        heading: 'Overview',
        body: "Light travels through fibre at about 200 km per millisecond, and cables are never straight. A visitor in Mumbai talking to a server in Virginia (12,855 km away) waits about 180 ms for every round trip, and a secure connection plus a request takes three of them. That is over half a second before the first byte, however fast the server is.\n\nA CDN fixes the distance, not the server. Its points of presence (PoPs) sit in hundreds of cities. GeoDNS or anycast routing sends each visitor to the nearest one. If the PoP has a fresh copy it answers at once (a HIT); if not (a MISS) it fetches the file from the origin, keeps a copy and serves it.\n\nThe origin controls the rules with HTTP headers: Cache-Control says whether a file may be stored and for how long, and an ETag lets a cache check cheaply whether its copy is still current.",
      },
      {
        heading: 'Requirements',
        body: '- Serve static files (images, scripts, video segments) from a PoP near the visitor.\n- Keep content reasonably fresh, and allow an urgent purge within seconds.\n- Never cache or leak private pages.\n- Keep the origin\'s load low and steady even when a million people ask for the same file.\n- Stay up when the origin or one PoP is down.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: a shop at peak serves 50,000 requests per second, averaging 300 KB each.\n- Total traffic: 50,000 × 300 KB = 15 GB/s, which is 120 Gbit/s. No single origin can serve that.\n- At a 95% hit ratio the origin sees 5% of requests: 2,500 requests/s and 6 Gbit/s.\n- At 99% it sees 500 requests/s and 1.2 Gbit/s: raising the hit ratio four points cuts origin load by 80%.\n- Latency for a Mumbai visitor: a 3-round-trip handshake costs about 3 × (12 + 180) = 576 ms direct to Virginia, but 3 × 12 = 36 ms to a PoP in Mumbai.\n- Round trip = 2 × distance × 1.4 ÷ 200 km/ms: Mumbai to Singapore (3,904 km) is about 55 ms, Singapore to Virginia (15,522 km) about 217 ms.',
      },
      {
        heading: 'Step by step',
        body: '1. The Browser asks GeoDNS / Anycast for cdn.shop.example and gets the address of the closest PoP.\n2. The Browser opens HTTPS to the Edge Cache (nearest PoP) and sends GET.\n3. The Edge Cache (nearest PoP) builds a cache key and runs the Cache Lookup: hit or miss?\n4. On a HIT the copy is returned straight to the Browser; the origin is never contacted.\n5. On a MISS the request goes to the Regional Shield Cache, which serves it if it has a copy.\n6. If the shield misses too, only it contacts the Origin Server, which reads the file from Object Storage.\n7. The response, with its Cache-Control and ETag, flows back and is stored in the Regional Shield Cache and the Edge Cache (nearest PoP).\n8. Every request is counted in Edge Metrics & Logs; the Purge API removes files that must change now.',
      },
      {
        heading: 'Components',
        body: '- Browser: sends requests and keeps its own private cache too; follows the same Cache-Control rules.\n- GeoDNS / Anycast: answers the name lookup with the nearest healthy PoP, by the visitor\'s resolver location (GeoDNS) or by network routing to one shared address (anycast).\n- Edge Cache (nearest PoP): terminates TLS close to the visitor and stores files in RAM and on SSD, evicting the least recently used when full.\n- Cache Lookup: hit or miss?: compares the cache key (method, host, path, Vary headers) with stored entries and checks the copy is still fresh.\n- Regional Shield Cache: a second cache tier in front of the origin; many PoPs share it, so one miss reaches the origin once.\n- Origin Server: the source of truth; sets Cache-Control and ETag headers and answers conditional requests with 304.\n- Object Storage: holds the original files cheaply and durably (S3 style), so the origin servers stay small.\n- Purge API: removes files before their lifetime ends, by URL, prefix or surrogate key (a tag like product-1842).\n- Edge Metrics & Logs: records hit ratio, bytes served, errors and latency per PoP, to spot bad cache rules.',
      },
      {
        heading: 'Key decisions',
        body: '- Pull or push: a pull CDN fetches on the first miss and needs no upload step; a push CDN stores what you upload, useful for huge files released on a date.\n- TTL: long for files that never change, short for those that do. Versioned names (logo.4f3a9c.png) let you use a one-year TTL and never purge.\n- Cache key: include only what changes the response. Adding a cookie or a tracking query string to the key splits one file into thousands of copies and wrecks the hit ratio.\n- Purging: purge by tag when content changes (a price update), and prefer short TTLs to rely on over purges.\n- Private content: send Cache-Control: private or no-store, or sign URLs and tokens so only the right person can fetch a protected file.\n- Shield tier: add it when you have many PoPs, an expensive origin, or a thundering herd after a purge.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Capacity scales by adding PoPs; the origin only needs to handle misses.\n- A flash crowd for a new file causes many simultaneous misses. Request collapsing makes the edge send one request upstream while the others wait for the answer.\n- If the origin goes down, "stale-if-error" lets caches keep serving expired copies instead of errors.\n- A PoP failure is handled by DNS or anycast routing sending visitors to the next-nearest PoP, at a small cost in latency.\n- A bad purge or a wrongly short TTL can send all traffic to the origin at once: rate limit purges, and keep the origin able to survive a cold cache.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How do you update a file that is cached for a year?\n- Why does a cookie in the cache key hurt, and how do you avoid it?\n- A product page is cached, but the price just changed. What are your options?\n- How do you serve private files (paid videos) through a CDN?\n- What happens when a million people request a new file the instant it is released?\n- How would you measure whether the CDN is paying for itself?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Origin: headers that tell the CDN what to do (Express)',
        language: 'typescript',
        source: `import express from 'express'

const app = express()

// Fingerprinted files: the name changes when the content does, so cache for a year.
app.use('/assets', express.static('dist/assets', {
  immutable: true,
  maxAge: '365d',
  etag: true,
}))

// Data that changes: one minute fresh, then serve stale for 30 s while refreshing.
app.get('/api/prices.json', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30')
  res.set('Surrogate-Key', 'prices') // lets you purge every price file with one call
  res.json(loadPrices())
})

// Personal pages: never store them in a shared cache.
app.get('/account', (_req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.send(renderAccount())
})`,
      },
      {
        title: 'Conditional request: how a cache revalidates (bash)',
        language: 'bash',
        source: `# 1. First fetch: note the ETag and the caching headers.
curl -sI https://cdn.shop.example/api/prices.json | grep -iE 'etag|cache-control|age|x-cache'

# 2. Ask "has it changed?" with the ETag. 304 means no body, only headers.
curl -s -o /dev/null -w '%{http_code}\\n' \\
  -H 'If-None-Match: "8f3c1a"' https://cdn.shop.example/api/prices.json`,
      },
      {
        title: 'Edge cache with TTL and LRU eviction (python)',
        language: 'python',
        source: `import time
from collections import OrderedDict

class EdgeCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.items = OrderedDict()  # key -> (body, expires_at); order = recency

    def get(self, key):
        entry = self.items.get(key)
        if entry is None:
            return None, "MISS"
        body, expires_at = entry
        if time.time() >= expires_at:
            return body, "EXPIRED"  # caller revalidates with If-None-Match
        self.items.move_to_end(key)  # most recently used goes last
        return body, "HIT"

    def put(self, key, body, ttl):
        self.items[key] = (body, time.time() + ttl)
        self.items.move_to_end(key)
        if len(self.items) > self.capacity:
            self.items.popitem(last=False)  # evict the least recently used`,
      },
      {
        title: 'Purge by tag when content changes (bash)',
        language: 'bash',
        source: `# Remove every cached response tagged "product-1842" at all PoPs.
# Most CDNs finish a purge within a few seconds.
curl -X POST https://api.cdn.example/v1/purge \\
  -H "Authorization: Bearer $CDN_TOKEN" \\
  -d '{"surrogate_keys": ["product-1842"]}'`,
      },
    ],
    related: ['HTTP caching', 'Anycast routing', 'Cache invalidation', 'Object storage', 'Edge computing', 'Video streaming'],
  },
  simulator,
}
