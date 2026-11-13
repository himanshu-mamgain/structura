import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator, stableHash } from './simulator'
import type { StaticTopic } from './types'

// "Find places near me" with a geohash index. A geohash turns a point into a short
// string; points that share a prefix are in the same rectangle of the map. The
// simulator builds 4,000 places around a city, indexes them by geohash and answers
// the search with the same maths the Location Search Service uses.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/** Geohash of a point, `precision` characters long (5 bits per character, longitude first). */
export function geohash(lat: number, lng: number, precision: number): string {
  let la = [-90, 90]
  let lo = [-180, 180]
  let even = true
  let bit = 0
  let ch = 0
  let out = ''
  while (out.length < precision) {
    const range = even ? lo : la
    const mid = (range[0] + range[1]) / 2
    if ((even ? lng : lat) >= mid) {
      ch = ch * 2 + 1
      range[0] = mid
    } else {
      ch = ch * 2
      range[1] = mid
    }
    even = !even
    if (++bit === 5) {
      out += BASE32[ch]
      bit = 0
      ch = 0
    }
  }
  return out
}

/** The rectangle a geohash covers. */
export function geohashBox(hash: string) {
  const la = [-90, 90]
  const lo = [-180, 180]
  let even = true
  for (const c of hash) {
    const v = BASE32.indexOf(c)
    for (let b = 4; b >= 0; b--) {
      const range = even ? lo : la
      const mid = (range[0] + range[1]) / 2
      if ((v >> b) & 1) range[0] = mid
      else range[1] = mid
      even = !even
    }
  }
  return { latMin: la[0], latMax: la[1], lngMin: lo[0], lngMax: lo[1] }
}

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (x: number) => (x * Math.PI) / 180
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h))
}

/** The cell and its 8 neighbours: step one cell width/height in each direction and re-encode. */
function ring(hash: string): string[] {
  const b = geohashBox(hash)
  const dLat = b.latMax - b.latMin
  const dLng = b.lngMax - b.lngMin
  const cLat = (b.latMin + b.latMax) / 2
  const cLng = (b.lngMin + b.lngMax) / 2
  const cells = new Set<string>()
  for (const i of [-1, 0, 1])
    for (const j of [-1, 0, 1]) cells.add(geohash(Math.max(-89.99, Math.min(89.99, cLat + i * dLat)), cLng + j * dLng, hash.length))
  return [...cells]
}

const CITIES = {
  'Connaught Place, Delhi': { lat: 28.6315, lng: 77.2167 },
  'Shibuya, Tokyo': { lat: 35.6595, lng: 139.7005 },
  'Mission District, San Francisco': { lat: 37.7599, lng: -122.4148 },
} as const
type CityName = keyof typeof CITIES

const FIRST = ['Blue', 'Golden', 'Urban', 'Corner', 'Little', 'Royal', 'Fresh', 'Old Town', 'Sunrise', 'Green', 'Lucky', 'Night']
const SECOND = ['Cafe', 'Bakery', 'Ramen', 'Pharmacy', 'Books', 'Kitchen', 'Gym', 'Tea House', 'Pizza', 'Salon']

interface Place {
  id: number
  name: string
  lat: number
  lng: number
  hash: string // precision 7, so any shorter cell is a prefix of it
}

const placeCache = new Map<string, Place[]>()

/** 4,000 repeatable places: half spread over 10 km, half packed within 2 km of the centre (downtown). */
function placesAround(city: CityName): Place[] {
  const hit = placeCache.get(city)
  if (hit) return hit
  const c = CITIES[city]
  let seed = stableHash(city)
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const list: Place[] = []
  for (let i = 0; i < 4000; i++) {
    const reach = i % 2 === 0 ? 10_000 : 2_000
    const r = reach * Math.sqrt(rand())
    const a = rand() * 2 * Math.PI
    const lat = c.lat + (r * Math.sin(a)) / 111_320
    const lng = c.lng + (r * Math.cos(a)) / (111_320 * Math.cos((c.lat * Math.PI) / 180))
    const name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${SECOND[Math.floor(rand() * SECOND.length)]}`
    list.push({ id: 41_000_000 + i, name, lat, lng, hash: geohash(lat, lng, 7) })
  }
  placeCache.set(city, list)
  return list
}

const RADII: Record<string, number> = { '500 m': 500, '1 km': 1000, '2 km': 2000, '5 km': 5000 }

/** Longest geohash whose smallest side is still at least the radius: 3x3 cells then always cover the circle. */
function precisionFor(lat: number, lng: number, radiusM: number): number {
  for (let p = 7; p >= 1; p--) {
    const b = geohashBox(geohash(lat, lng, p))
    const h = distanceM(b.latMin, b.lngMin, b.latMax, b.lngMin)
    const w = distanceM(b.latMin, b.lngMin, b.latMin, b.lngMax)
    if (Math.min(h, w) >= radiusM) return p
  }
  return 1
}

const APP = 'Client (Mobile App)'
const GW = 'API Gateway'
const SEARCH = 'Location Search Service'
const INDEX = 'Geohash Index (Redis)'
const BIZ = 'Business Service'
const CACHE = 'Business Cache (Redis)'
const DB = 'Business DB (primary + replicas)'
const OWNER = 'Business Owner'
const QUEUE = 'Update Queue'
const BUILDER = 'Index Builder'

const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`)

const simulator: Simulator = {
  fields: [
    { id: 'city', label: 'Where the user stands', options: Object.keys(CITIES) },
    { id: 'radius', label: 'Search radius', options: Object.keys(RADII) },
    { id: 'cells', label: 'Cells searched', options: ['Own cell + 8 neighbours', 'Own cell only'] },
  ],
  defaults: { city: 'Connaught Place, Delhi', radius: '1 km', cells: 'Own cell + 8 neighbours' },
  run({ city, radius, cells }) {
    const name = (city in CITIES ? city : 'Connaught Place, Delhi') as CityName
    const here = CITIES[name]
    const radiusM = RADII[radius] ?? 1000
    const neighbours = !cells.includes('only')
    const all = placesAround(name)

    const p = precisionFor(here.lat, here.lng, radiusM)
    const own = geohash(here.lat, here.lng, p)
    const box = geohashBox(own)
    const cellH = distanceM(box.latMin, box.lngMin, box.latMax, box.lngMin)
    const cellW = distanceM(box.latMin, box.lngMin, box.latMin, box.lngMax)
    const searched = neighbours ? ring(own) : [own]

    const candidates = all.filter((x) => searched.some((c) => x.hash.startsWith(c)))
    const withDist = (list: Place[]) => list.map((x) => ({ ...x, m: distanceM(here.lat, here.lng, x.lat, x.lng) }))
    const inside = withDist(candidates)
      .filter((x) => x.m <= radiusM)
      .sort((a, b) => a.m - b.m)
    const truth = withDist(all).filter((x) => x.m <= radiusM)
    const missed = truth.length - inside.length
    const top = inside.slice(0, 3)
    const perCell = searched.map((c) => `${c}: ${all.filter((x) => x.hash.startsWith(c)).length}`)

    const steps: Trace['steps'] = [
      {
        text: `The user opens the app in ${name} and searches for places within ${radius}. The phone sends its GPS position and the radius.`,
        nodes: [APP, GW],
        data: `GET /v1/search/nearby?lat=${here.lat}&lng=${here.lng}&radius=${radiusM}`,
      },
      {
        text: 'The gateway checks the request and sends it to the Location Search Service. This service is read-only and holds no state, so any copy can answer.',
        nodes: [GW, SEARCH],
        data: 'route /v1/search/* → location-search (stateless, 12 pods)',
      },
      {
        text: `The service picks how long the geohash should be. A cell must be at least as wide as the radius, or a 3 × 3 block of cells could not cover the circle. For ${radius}, precision ${p} works: its cells are ${fmtM(cellW)} wide and ${fmtM(cellH)} tall. The user's own cell is "${own}".`,
        nodes: [SEARCH],
        data: `precision ${p} → cell ≈ ${fmtM(cellW)} × ${fmtM(cellH)}\ngeohash(${here.lat}, ${here.lng}, ${p}) = "${own}"\ncell box: lat ${box.latMin.toFixed(4)} … ${box.latMax.toFixed(4)}, lng ${box.lngMin.toFixed(4)} … ${box.lngMax.toFixed(4)}`,
      },
      {
        text: neighbours
          ? `A user near the edge of a cell has places just across the border, in the next cell. So the service also takes the ${searched.length - 1} neighbouring cells and looks up ${searched.length} cells in all.`
          : 'This run looks only at the user’s own cell. Anything just across a cell border is invisible, which is the classic geohash bug; turn on the neighbours to see the difference.',
        nodes: [SEARCH],
        data: neighbours ? `cells = ${json(searched)}` : `cells = ["${own}"]`,
      },
      {
        text: `One Redis set per cell holds the ids of the places inside it, so each cell is a single read with no scan. The ${searched.length} lookups run in parallel and return ${candidates.length} candidate place${candidates.length === 1 ? '' : 's'}.`,
        nodes: [SEARCH, INDEX],
        data: `${searched.map((c) => `SMEMBERS geo:${p}:${c}`).join('\n')}\n→ places per cell, out of ${all.length} in the city:\n${perCell.join('\n')}`,
      },
      {
        text: `A cell is a rectangle, not a circle, so some candidates are too far away. The service computes the real distance to each one with the haversine formula and keeps those within ${radius}: ${inside.length} of ${candidates.length} stay. Then it sorts by distance.${missed > 0 ? ` With ${truth.length} places truly in range, ${missed} were never looked at because their cell was not searched.` : ` All ${truth.length} places truly in range were found.`}`,
        nodes: [SEARCH],
        data: `candidates ${candidates.length} → within ${radiusM} m: ${inside.length}\ntruly within ${radiusM} m (brute force over ${all.length}): ${truth.length}\nmissed: ${missed}${missed > 0 ? '  ← the border bug' : ''}`,
      },
    ]

    if (top.length === 0) {
      steps.push({
        text: 'Nothing was found, so the service returns an empty list. The app can suggest a bigger radius.',
        nodes: [SEARCH, GW, APP],
        data: json({ results: [] }),
      })
    } else {
      steps.push(
        {
          text: `The index only stores ids. The Business Service asks its cache for the details of the top ${top.length}, and falls back to the database for any it does not have. Details change rarely, so the cache hit rate is high.`,
          nodes: [SEARCH, BIZ, CACHE, DB],
          data: `MGET biz:${top.map((x) => x.id).join(' biz:')}\n→ on a miss: SELECT * FROM businesses WHERE id IN (...) -- read replica`,
        },
        {
          text: `The results go back to the phone, nearest first. The nearest is ${top[0].name}, ${fmtM(top[0].m)} away.`,
          nodes: [BIZ, GW, APP],
          data: json({ results: top.map((x) => ({ id: x.id, name: x.name, distance_m: Math.round(x.m) })) }),
        },
      )
    }

    // Writes use a different path, so reads are never slowed by them.
    const fresh = { id: 41_004_000, lat: here.lat + 0.0012, lng: here.lng + 0.0009 }
    const keys = [4, 5, 6].map((q) => `geo:${q}:${geohash(fresh.lat, fresh.lng, q)}`)
    steps.push({
      text: 'Writes take another path. A Business Owner adds a new shop. It is saved in the database first, then an event goes into the Update Queue, and the Index Builder adds the id to its geohash cells at precisions 4, 5 and 6, so every radius needs only one lookup. The shop appears in search a few seconds later, which is fine for this data.',
      nodes: [OWNER, DB, QUEUE, BUILDER, INDEX],
      data: `INSERT INTO businesses (id, name, lat, lng) VALUES (${fresh.id}, 'Chai Stop', ${fresh.lat.toFixed(5)}, ${fresh.lng.toFixed(5)});\npublish business.created {id: ${fresh.id}}\n${keys.map((k) => `SADD ${k} ${fresh.id}`).join('\n')}`,
    })

    return { input: `${name}, ${radius}, ${neighbours ? '9 cells' : '1 cell'}`, steps }
  },
}

export const proximityService: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'proximity-service',
  title: 'Proximity Service (Nearby Places)',
  blurb: 'Find places within a radius of you in milliseconds, using geohash cells instead of scanning every row',
  guides: ['proximity-service', 'quadtree', 'scale-location-caching-with-quadtrees-at-yext', 'scale-geosharded-recommendations-3-parts-at-tinder', 'top-4-data-sharding-algorithms-explained'],
  takeaways: [
    'A plain SQL query on latitude and longitude still scans too much, because a normal index handles only one range well.',
    'A geohash turns a point into a short string, and places that share a prefix are close together, so "nearby" becomes a key lookup.',
    'Pick a cell at least as big as the radius, then search the user’s cell and its 8 neighbours, or places across a border go missing.',
    'A cell is a rectangle, so always filter the candidates by true distance before returning them.',
    'Search is read-heavy and tolerates a few seconds of delay on writes, so build the index asynchronously and scale reads with replicas and caches.',
    'A quadtree is the main alternative: it splits busy areas into smaller cells and leaves empty ones big.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'search', label: 'Read path' }, { id: 'write', label: 'Write path' }],
    nodes: [
      { id: 'app', label: APP, shape: 'ellipse', color: 'blue', group: null },
      { id: 'gw', label: GW, shape: 'rectangle', color: 'violet', group: null },
      { id: 'search', label: SEARCH, shape: 'rectangle', color: 'violet', group: 'search' },
      { id: 'index', label: INDEX, shape: 'rectangle', color: 'red', group: 'search' },
      { id: 'biz', label: BIZ, shape: 'rectangle', color: 'violet', group: 'search' },
      { id: 'cache', label: CACHE, shape: 'rectangle', color: 'red', group: 'search' },
      { id: 'db', label: DB, shape: 'rectangle', color: 'green', group: null },
      { id: 'owner', label: OWNER, shape: 'ellipse', color: 'blue', group: 'write' },
      { id: 'queue', label: QUEUE, shape: 'rectangle', color: 'yellow', group: 'write' },
      { id: 'builder', label: BUILDER, shape: 'rectangle', color: 'orange', group: 'write' },
    ],
    edges: [
      { from: 'app', to: 'gw', label: 'GET /search/nearby', dashed: false },
      { from: 'gw', to: 'search', label: 'route', dashed: false },
      { from: 'search', to: 'index', label: 'SMEMBERS 9 cells', dashed: false },
      { from: 'search', to: 'biz', label: 'ids', dashed: false },
      { from: 'biz', to: 'cache', label: 'MGET', dashed: false },
      { from: 'biz', to: 'db', label: 'on miss', dashed: true },
      { from: 'owner', to: 'db', label: 'add / edit shop', dashed: false },
      { from: 'db', to: 'queue', label: 'business.created', dashed: true },
      { from: 'queue', to: 'builder', label: 'consume', dashed: false },
      { from: 'builder', to: 'index', label: 'SADD cells', dashed: false },
      { from: 'biz', to: 'gw', label: 'details', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'businesses',
        name: 'businesses',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'owner_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'category', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'lat', type: 'double precision', pk: false, fk: null, nullable: false, unique: false },
          { name: 'lng', type: 'double precision', pk: false, fk: null, nullable: false, unique: false },
          { name: 'geohash7', type: 'char(7)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['geohash7 (prefix lookups)'],
      },
      {
        id: 'geo_index',
        name: 'geo_index (Redis sets)',
        columns: [
          { name: 'key', type: 'geo:{precision}:{geohash}', pk: true, fk: null, nullable: false, unique: false },
          { name: 'members', type: 'set of business id', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [],
  },
  explanation: {
    title: 'Proximity Service (Nearby Places)',
    summary:
      'Apps like Yelp and Google Maps must answer "what is near me?" in milliseconds out of hundreds of millions of places. The trick is to cut the map into labelled cells (geohashes) and keep a list of places per cell, so a search reads a few small lists instead of scanning every row.',
    sections: [
      {
        heading: 'Overview',
        body: 'The obvious query is SELECT * FROM businesses WHERE lat BETWEEN a AND b AND lng BETWEEN c AND d. A normal database index sorts by one column, so it can narrow latitude well but then still has to check every row in that band of the planet. With hundreds of millions of rows that is far too slow.\n\nA geohash fixes this. It repeatedly halves the map: longitude first, then latitude, alternating, and writes each choice as a bit (1 = upper half). Every 5 bits become one character from a 32-letter alphabet. For Connaught Place in Delhi (28.6315, 77.2167) the geohash is ttnfvh5; its first 4 letters, ttnf, name a cell about 34 km × 20 km, and each extra letter shrinks the cell by 4 to 8 times. Places that share a prefix are in the same cell, so "nearby" becomes "same prefix".\n\nThe system then keeps one list per cell. A search finds the user\'s cell, reads that list and the 8 around it, throws away places that are too far, and returns the closest ones.',
      },
      {
        heading: 'Requirements',
        body: '- Given a position and a radius (500 m up to 5 km), return the nearest places, closest first.\n- Search is fast: under 100 ms at the 99th percentile.\n- Owners can add, edit and remove places; a change can take a few minutes to show up in search.\n- The service stays up when a machine or a data centre fails.\n- Search reads are far more frequent than writes.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Places: 200 million.\n- Searches: 100 million daily users × 5 searches = 500 million a day, which is 500,000,000 / 86,400 = about 5,800 searches per second. Plan for a peak of twice that, about 11,600 per second.\n- Writes: if 1 million places change each day, that is about 12 writes per second. Reads outnumber writes about 500 to 1.\n- Place details: 200 million × 1 KB = 200 GB, which fits on a single database server and is replicated for reads and safety.\n- Index: each place is stored under 3 precisions (4, 5 and 6) at 8 bytes per id, so 200 million × 3 × 8 B = 4.8 GB of ids. With Redis overhead that is still small enough for one node; we copy it to several nodes for read speed, not because it is big.\n- Cells: precision 6 has 2^30, about 1.07 billion, cells over the whole planet, so on average a cell holds under one place. Cities are the exception: a downtown cell can hold hundreds.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client (Mobile App) sends its position and radius to the API Gateway.\n2. The API Gateway routes the call to the Location Search Service.\n3. The service picks a geohash length so one cell is at least as wide as the radius, and works out the user\'s cell and its 8 neighbours.\n4. It reads those cells from the Geohash Index (Redis), one set of place ids per cell.\n5. It computes the real distance to every candidate and keeps the ones inside the radius, sorted nearest first.\n6. The Business Service loads details for the top results from the Business Cache (Redis).\n7. On a cache miss it reads the Business DB (primary + replicas), then the results go back through the API Gateway to the app.\n8. When a Business Owner adds or edits a place, it is saved in the Business DB (primary + replicas) and an event goes into the Update Queue.\n9. The Index Builder reads the queue and updates the sets in the Geohash Index (Redis), so search picks up the change.',
      },
      {
        heading: 'Components',
        body: '- Client (Mobile App): sends the user\'s GPS position and radius and shows the results.\n- API Gateway: authenticates, rate-limits and routes requests.\n- Location Search Service: stateless; chooses the precision, finds the cells, reads the index and filters by true distance.\n- Geohash Index (Redis): one set of business ids per geohash cell, at precisions 4, 5 and 6.\n- Business Service: returns the details (name, photos, rating) of the ids it is given.\n- Business Cache (Redis): keeps hot place details so most searches never touch the database.\n- Business DB (primary + replicas): the source of truth for places; the primary takes writes and replicas serve reads.\n- Business Owner: the person who adds, edits or removes a place.\n- Update Queue: carries change events, so writes never wait for the index.\n- Index Builder: a worker that reads the events and adds or removes ids in the right cells.',
      },
      {
        heading: 'Key decisions',
        body: '- Geohash vs quadtree: a geohash is just a string, so it works with Redis or any database and is easy to shard. A quadtree adapts to density (it splits a crowded cell into four) but lives in memory on each server and must be rebuilt after a restart. Many systems use geohash for simplicity.\n- Search 9 cells, not 1: two points a metre apart can have different geohashes if they sit on either side of a cell border. Without the neighbours, those places are missed.\n- Precision from the radius: if the cell is much smaller than the radius, you need many cells; if it is much bigger, you filter too many candidates.\n- Several precisions in the index: storing each place under 3 precisions costs 3 times the space (4.8 GB, still small) and makes every search one round of lookups.\n- Filter by true distance: a cell is a rectangle, so places in a corner can be farther than the radius.\n- Async index updates: a short delay between an edit and search is fine and keeps writes cheap.',
      },
      {
        heading: 'Scaling and failure',
        body: '- More reads: add search pods (stateless) and Redis read replicas; cache hot cells.\n- Dense cells: a downtown cell can hold thousands of places. Use a longer geohash there, or fall back to a quadtree split.\n- Sharding the details table: shard by business id, not by location, so a popular city does not overload one shard. Geographic sharding creates hot spots.\n- Redis node dies: a replica takes over; if the whole index is lost, the Index Builder can rebuild it from the database in a few minutes, since it is only 4.8 GB.\n- Queue lag: searches show slightly old data; alert if lag grows past a few minutes.\n- Near the poles and the 180° meridian, cells get thin or wrap around; handle those edge cases explicitly.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why does a plain index on latitude and longitude not solve this?\n- What goes wrong when you search only the user\'s own geohash cell?\n- How would you handle a cell with 50,000 places in it?\n- Geohash or quadtree: when would you choose each?\n- How would the design change if places moved (drivers, delivery riders) instead of staying put?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Encode a geohash (TypeScript)',
        language: 'typescript',
        source: `const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

export function geohash(lat: number, lng: number, precision: number): string {
  let la = [-90, 90], lo = [-180, 180]
  let even = true, bit = 0, ch = 0, out = ''
  while (out.length < precision) {
    const range = even ? lo : la // longitude first, then latitude
    const mid = (range[0] + range[1]) / 2
    if ((even ? lng : lat) >= mid) { ch = ch * 2 + 1; range[0] = mid } // upper half = 1
    else { ch = ch * 2; range[1] = mid }
    even = !even
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0 } // 5 bits per character
  }
  return out
}

geohash(28.6315, 77.2167, 7) // "ttnfvh5"`,
      },
      {
        title: 'Nearby search (Python)',
        language: 'python',
        source: `from math import radians, sin, cos, asin, sqrt

def haversine_m(lat1, lng1, lat2, lng2):
    h = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371008.8 * asin(sqrt(h))

def nearby(redis, lat, lng, radius_m, precision, neighbours):
    ids = set()
    for cell in neighbours:  # the user's cell plus its 8 neighbours
        ids |= redis.smembers(f"geo:{precision}:{cell}")
    found = []
    for biz_id in ids:
        b = get_business(biz_id)  # cache first, database on a miss
        d = haversine_m(lat, lng, b.lat, b.lng)
        if d <= radius_m:  # the cell is a rectangle: drop the far corners
            found.append((d, b))
    return sorted(found, key=lambda x: x[0])[:20]`,
      },
      {
        title: 'Add a place to the index (JavaScript)',
        language: 'javascript',
        source: `// Runs in the Index Builder after a business.created event.
async function indexBusiness(redis, b) {
  const pipe = redis.multi()
  for (const precision of [4, 5, 6]) {
    pipe.sAdd(\`geo:\${precision}:\${geohash(b.lat, b.lng, precision)}\`, String(b.id))
  }
  await pipe.exec() // one round trip; SADD is safe to repeat if the event arrives twice
}`,
      },
      {
        title: 'Why a lat/lng range query is slow (SQL)',
        language: 'sql',
        source: `-- Needs to look at every row in the latitude band, not just the nearby ones.
SELECT id FROM businesses
WHERE lat BETWEEN 28.6225 AND 28.6405
  AND lng BETWEEN 77.2057 AND 77.2277;

-- With a geohash column, nearby is an indexed prefix match.
SELECT id FROM businesses
WHERE geohash7 LIKE 'ttnfvh%';`,
      },
    ],
    related: ['Geohash', 'Quadtree', 'Haversine distance', 'Read replicas', 'Sharding'],
  },
  simulator,
}
