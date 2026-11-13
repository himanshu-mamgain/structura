import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator really searches: it builds a flat index, an IVF-PQ index and an
// HNSW graph over 2,000 sample vectors in the browser, runs 40 queries against
// each, and measures recall against an exact scan. Costs at 1 million and 100
// million real 768-dimension vectors are then worked out from formulas.

// ---------- the sample ----------

const D = 32 // sample dimensions (real embeddings here have 768)
const N = 2000
const K = 10
const QUERIES = 40
const MATCH_SHARE = 0.02 // the filter "size M, under ₹1,000" matches 2% of listings

type Vec = Float32Array

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function unit(v: Vec): Vec {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** Squared Euclidean distance. On unit vectors it ranks exactly like cosine similarity. */
function dist(a: Vec, b: Vec, from = 0, to = a.length): number {
  let s = 0
  for (let i = from; i < to; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return s
}

interface Sample {
  vecs: Vec[]
  queries: Vec[]
  match: boolean[]
  matching: number[]
}

let sampleCache: Sample | null = null
function sample(): Sample {
  if (sampleCache) return sampleCache
  const rand = rng(20261112)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
  // Embeddings bunch around topics (dresses, sneakers, kurtas…) with plenty of spread.
  const topics = Array.from({ length: 24 }, () => unit(Float32Array.from({ length: D }, gauss)))
  const point = () => {
    const t = topics[Math.floor(rand() * topics.length)]
    return unit(Float32Array.from(t, (x) => x + 0.22 * gauss()))
  }
  const vecs = Array.from({ length: N }, point)
  const queries = Array.from({ length: QUERIES }, point)
  const match = vecs.map(() => rand() < MATCH_SHARE)
  sampleCache = { vecs, queries, match, matching: match.flatMap((m, i) => (m ? [i] : [])) }
  return sampleCache
}

interface Stats {
  distances: number
}

/** Exact top k: compare the query with every allowed vector, keeping only the best k as it goes. */
function exact(q: Vec, ids: number[] | null, stats?: Stats): number[] {
  const { vecs } = sample()
  const pool = ids ?? vecs.map((_, i) => i)
  if (stats) stats.distances += pool.length
  const best: { i: number; d: number }[] = []
  for (const i of pool) {
    const d = dist(q, vecs[i])
    if (best.length === K && d >= best[K - 1].d) continue
    let at = best.length
    while (at > 0 && best[at - 1].d > d) at--
    best.splice(at, 0, { i, d })
    if (best.length > K) best.pop()
  }
  return best.map((x) => x.i)
}

function nearest(p: Vec, cents: Vec[]): number {
  let best = 0
  let bestD = Infinity
  for (let c = 0; c < cents.length; c++) {
    const d = dist(p, cents[c])
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

function kmeans(points: Vec[], k: number, iters: number, rand: () => number): Vec[] {
  const dim = points[0].length
  const cents = [...points]
    .map((p) => ({ p, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, k)
    .map((x) => Float32Array.from(x.p))
  for (let it = 0; it < iters; it++) {
    const sums = cents.map(() => new Float64Array(dim))
    const counts = new Array(k).fill(0)
    for (const p of points) {
      const best = nearest(p, cents)
      counts[best]++
      for (let j = 0; j < dim; j++) sums[best][j] += p[j]
    }
    cents.forEach((c, i) => {
      if (counts[i]) for (let j = 0; j < dim; j++) c[j] = sums[i][j] / counts[i]
    })
  }
  return cents
}


// ---------- IVF-PQ: clusters, then compressed codes ----------

const NLIST = 64 // sample clusters (about 1.4 × √2,000)
const SUBS = 8 // sub-vectors per code
const SUB_D = D / SUBS
const CODEBOOK = 16 // codewords per sub-vector: 4 bits each, so a code is 8 × 4 bits = 4 bytes (32× smaller than 128 bytes)

interface IvfPq {
  cents: Vec[]
  lists: number[][]
  books: Vec[][]
  codes: Uint8Array[]
  home: number[]
}

let ivfCache: IvfPq | null = null
function ivfpq(): IvfPq {
  if (ivfCache) return ivfCache
  const { vecs } = sample()
  const rand = rng(99)
  const cents = kmeans(vecs, NLIST, 8, rand)
  const home = vecs.map((v) => nearest(v, cents))
  const lists: number[][] = cents.map(() => [])
  home.forEach((c, i) => lists[c].push(i))
  // Product quantisation encodes what's left after subtracting the cluster centre.
  const residuals = vecs.map((v, i) => Float32Array.from(v, (x, j) => x - cents[home[i]][j]))
  const books = Array.from({ length: SUBS }, (_, s) =>
    kmeans(
      residuals.map((r) => r.slice(s * SUB_D, (s + 1) * SUB_D)),
      CODEBOOK,
      8,
      rand,
    ),
  )
  const codes = residuals.map((r) => Uint8Array.from({ length: SUBS }, (_, s) => nearest(r.slice(s * SUB_D, (s + 1) * SUB_D), books[s])))
  ivfCache = { cents, lists, books, codes, home }
  return ivfCache
}

/** Approximate distance from a query to one stored code, through per-cluster lookup tables. */
function lookupTables(index: IvfPq, q: Vec, list: number): Float64Array[] {
  const qr = Float32Array.from(q, (x, j) => x - index.cents[list][j])
  return index.books.map((book, s) => Float64Array.from(book, (cw) => dist(qr.slice(s * SUB_D, (s + 1) * SUB_D), cw)))
}

interface IvfStats extends Stats {
  centroids: number
  codes: number
  reranked: number
}

function searchIvf(q: Vec, nprobe: number, rerank: number, allowed: number[] | null, stats: IvfStats): number[] {
  const index = ivfpq()
  const { vecs } = sample()
  const scored: { i: number; d: number }[] = []
  if (allowed) {
    // A selective filter: score just the matching codes, whatever cluster they're in.
    const tables = new Map<number, Float64Array[]>()
    for (const i of allowed) {
      const c = index.home[i]
      if (!tables.has(c)) tables.set(c, lookupTables(index, q, c))
      const t = tables.get(c)!
      scored.push({ i, d: index.codes[i].reduce((s, code, sub) => s + t[sub][code], 0) })
    }
    stats.codes += allowed.length
  } else {
    stats.centroids += NLIST
    const probes = index.cents
      .map((c, i) => ({ i, d: dist(q, c) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, nprobe)
    for (const { i: list } of probes) {
      const t = lookupTables(index, q, list)
      for (const i of index.lists[list]) scored.push({ i, d: index.codes[i].reduce((s, code, sub) => s + t[sub][code], 0) })
      stats.codes += index.lists[list].length
    }
  }
  scored.sort((a, b) => a.d - b.d)
  if (!rerank) return scored.slice(0, K).map((x) => x.i)
  // Re-rank the best candidates with their full vectors (kept on SSD at scale).
  const pool = scored.slice(0, rerank)
  stats.reranked += pool.length
  stats.distances += pool.length
  return pool
    .map((x) => ({ i: x.i, d: dist(q, vecs[x.i]) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, K)
    .map((x) => x.i)
}

// ---------- HNSW: a layered graph of near neighbours ----------

const M = 8 // links per node on upper layers (M0 = 2M on the bottom layer)
const EF_CONSTRUCTION = 40

interface Hnsw {
  links: number[][][] // links[node][layer]
  entry: number
  top: number
}

let stamp = 0
let seenAt = new Uint32Array(0)

function searchLayer(q: Vec, entry: number, ef: number, layer: number, g: Hnsw, stats: Stats): { i: number; d: number }[] {
  const { vecs } = sample()
  if (seenAt.length < vecs.length) seenAt = new Uint32Array(vecs.length)
  stamp++
  seenAt[entry] = stamp
  const first = { i: entry, d: dist(q, vecs[entry]) }
  stats.distances++
  const found = [first] // closest first, at most ef long
  const frontier = [first]
  while (frontier.length) {
    let m = 0
    for (let j = 1; j < frontier.length; j++) if (frontier[j].d < frontier[m].d) m = j
    const c = frontier[m]
    frontier[m] = frontier[frontier.length - 1]
    frontier.pop()
    if (found.length >= ef && c.d > found[found.length - 1].d) break
    for (const n of g.links[c.i][layer] ?? []) {
      if (seenAt[n] === stamp) continue
      seenAt[n] = stamp
      const d = dist(q, vecs[n])
      stats.distances++
      if (found.length < ef || d < found[found.length - 1].d) {
        let at = found.length
        while (at > 0 && found[at - 1].d > d) at--
        found.splice(at, 0, { i: n, d })
        if (found.length > ef) found.pop()
        frontier.push({ i: n, d })
      }
    }
  }
  return found
}

let hnswCache: Hnsw | null = null
function hnsw(): Hnsw {
  if (hnswCache) return hnswCache
  const { vecs } = sample()
  const rand = rng(7)
  const g: Hnsw = { links: [], entry: 0, top: 0 }
  const build: Stats = { distances: 0 }
  vecs.forEach((v, i) => {
    // Each node's top layer is random, falling off exponentially: few nodes reach the upper "highways".
    const level = Math.floor(-Math.log(1 - rand()) / Math.log(M))
    g.links[i] = Array.from({ length: level + 1 }, () => [])
    if (i === 0) {
      g.top = level
      return
    }
    let ep = g.entry
    for (let l = g.top; l > level; l--) ep = searchLayer(v, ep, 1, l, g, build)[0].i
    for (let l = Math.min(level, g.top); l >= 0; l--) {
      const near = searchLayer(v, ep, EF_CONSTRUCTION, l, g, build)
      const max = l === 0 ? 2 * M : M
      g.links[i][l] = near.slice(0, max).map((x) => x.i)
      for (const n of g.links[i][l]) {
        const ln = g.links[n][l]
        ln.push(i)
        if (ln.length > max) {
          // Too many links: keep the closest ones.
          const kept = ln.map((x) => ({ x, d: dist(vecs[n], vecs[x]) })).sort((a, b) => a.d - b.d)
          g.links[n][l] = kept.slice(0, max).map((k) => k.x)
        }
      }
      ep = near[0].i
    }
    if (level > g.top) {
      g.top = level
      g.entry = i
    }
  })
  hnswCache = g
  return g
}

function searchHnsw(q: Vec, ef: number, stats: Stats): number[] {
  const g = hnsw()
  let ep = g.entry
  for (let l = g.top; l > 0; l--) ep = searchLayer(q, ep, 1, l, g, stats)[0].i
  return searchLayer(q, ep, Math.max(ef, K), 0, g, stats)
    .slice(0, K)
    .map((x) => x.i)
}

// ---------- measuring ----------

type Index = 'flat' | 'ivfpq' | 'hnsw'
type Filter = 'none' | 'after' | 'during'

const EFFORT = {
  ivfpq: { low: { nprobe: 2, rerank: 0 }, high: { nprobe: 8, rerank: 50 } },
  hnsw: { low: { ef: 10 }, high: { ef: 64 } },
}

interface Measured {
  recall: number
  returned: number
  distances: number
  centroids: number
  codes: number
  reranked: number
}

const measured = new Map<string, Measured>()
export function measure(index: Index, high: boolean, filter: Filter): Measured {
  const key = `${index}/${high}/${filter}`
  const hit = measured.get(key)
  if (hit) return hit
  const s = sample()
  const stats: IvfStats = { distances: 0, centroids: 0, codes: 0, reranked: 0 }
  let recall = 0
  let returned = 0
  for (const q of s.queries) {
    const truth = exact(q, filter === 'none' ? null : s.matching)
    const allowed = filter === 'during' ? s.matching : null
    let got: number[]
    if (filter === 'during' && index !== 'ivfpq') got = exact(q, s.matching, stats) // the planner scans the few matches exactly
    else if (index === 'flat') got = exact(q, null, stats)
    else if (index === 'hnsw') got = searchHnsw(q, high ? EFFORT.hnsw.high.ef : EFFORT.hnsw.low.ef, stats)
    else {
      const e = high ? EFFORT.ivfpq.high : EFFORT.ivfpq.low
      got = searchIvf(q, e.nprobe, e.rerank, allowed, stats)
    }
    if (filter === 'after') got = got.filter((i) => s.match[i])
    returned += got.length
    recall += got.filter((i) => truth.includes(i)).length / K
  }
  const per = (n: number) => n / QUERIES
  const m: Measured = {
    recall: recall / QUERIES,
    returned: per(returned),
    distances: per(stats.distances),
    centroids: per(stats.centroids),
    codes: per(stats.codes),
    reranked: per(stats.reranked),
  }
  measured.set(key, m)
  return m
}

// ---------- costs at real scale ----------

const REAL_D = 768
const FULL = REAL_D * 4 // float32: 3,072 bytes a vector
const PQ_CODE = 96 // 96 sub-vectors of 8 dimensions, one byte each
const ID = 8
const LINKS = 2 * 16 * 4 // HNSW bottom layer: 2M = 32 neighbour ids of 4 bytes (M = 16)
const RAM_BW = 40e9 // bytes a second a server streams from memory, all cores together
const RANDOM_BW = 10e9 // scattered reads (graph hops, filtered ids) are slower
const USABLE = 48e9 // a 64 GB server, leaving room for the OS and queries
const SSD_IOPS = 500_000 // random 4 KB reads a second from an NVMe drive

const int = (n: number) => Math.round(n).toLocaleString('en-US')
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : bytes >= 1e10 ? 1 : 2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}
function ms(seconds: number): string {
  const v = seconds * 1000
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${v.toFixed(0)} ms` : v >= 1 ? `${v.toFixed(1)} ms` : `${v.toFixed(2)} ms`
}

interface Plan {
  ram: number
  servers: number
  memoryLines: string[]
}

function plan(index: Index, n: number): Plan {
  if (index === 'flat') {
    const ram = n * FULL
    const servers = Math.max(1, Math.ceil(ram / USABLE))
    return { ram, servers, memoryLines: [`768 dimensions × 4 bytes = ${int(FULL)} bytes a vector`, `× ${int(n)} vectors = ${size(ram)} in RAM`] }
  }
  if (index === 'hnsw') {
    const per = FULL + LINKS
    const ram = n * per
    const servers = Math.max(1, Math.ceil(ram / USABLE))
    return { ram, servers, memoryLines: [`${int(FULL)} bytes of vector + ${LINKS} bytes of links (32 neighbours × 4 bytes) = ${int(per)} bytes`, `× ${int(n)} vectors = ${size(ram)} in RAM`] }
  }
  const nlist = 4 * Math.round(Math.sqrt(n))
  const codes = n * (PQ_CODE + ID)
  const ram = codes + nlist * FULL
  return {
    ram,
    servers: Math.max(1, Math.ceil(ram / USABLE)),
    memoryLines: [
      `code: 96 sub-vectors × 1 byte = 96 bytes (32× smaller than ${int(FULL)}) + ${ID}-byte id`,
      `× ${int(n)} vectors = ${size(codes)}, + ${int(nlist)} cluster centres × ${int(FULL)} bytes = ${size(nlist * FULL)}`,
      `= ${size(ram)} in RAM; the full vectors (${size(n * FULL)}) stay on SSD for re-ranking`,
    ],
  }
}

const INDEX_NODE: Record<Index, string> = { flat: 'Raw Vectors', ivfpq: 'IVF-PQ Index', hnsw: 'HNSW Graph' }

const simulator: Simulator = {
  fields: [
    { id: 'vectors', label: 'Vectors stored', options: ['1 million', '100 million'] },
    { id: 'index', label: 'Index', options: ['Flat (exact scan)', 'IVF-PQ (clusters + compression)', 'HNSW (graph)'] },
    { id: 'effort', label: 'Search effort', options: ['Low (fast)', 'High (accurate)'] },
    { id: 'filter', label: 'Filter: size M, under ₹1,000', options: ['None', 'After search (2% match)', 'During search (2% match)'] },
  ],
  defaults: { vectors: '1 million', index: 'Flat (exact scan)', effort: 'Low (fast)', filter: 'None' },
  run({ vectors, index: indexText, effort, filter: filterText }) {
    const n = vectors.startsWith('100') ? 100_000_000 : 1_000_000
    const index: Index = indexText.startsWith('IVF') ? 'ivfpq' : indexText.startsWith('HNSW') ? 'hnsw' : 'flat'
    const high = effort.startsWith('High')
    const filter: Filter = filterText.startsWith('After') ? 'after' : filterText.startsWith('During') ? 'during' : 'none'
    const m = measure(index, high, filter)
    const p = plan(index, n)
    const shardN = n / p.servers
    const steps: Trace['steps'] = []

    const built =
      index === 'flat'
        ? 'stores each vector as a plain row of numbers: no index at all'
        : index === 'hnsw'
          ? 'links each vector to its nearest neighbours in a graph, so a search can hop towards any query'
          : 'assigns each vector to the nearest of a few thousand clusters and compresses it to a 96-byte code'
    steps.push({
      text: `${vectors[0].toUpperCase() + vectors.slice(1)} listing photos are stored as embeddings: 768 numbers each, from the same model that embeds queries. Every write lands in the Write-Ahead Log first, so nothing is lost in a crash. The Index Builder then ${built}.`,
      nodes: ['Vector DB API', 'Write-Ahead Log', 'Index Builder', INDEX_NODE[index]],
      data: [...p.memoryLines, `servers needed at 48 GB of usable RAM each: ${p.servers}`].join('\n'),
    })

    const params = index === 'hnsw' ? { ef: high ? 64 : 10 } : index === 'ivfpq' ? { nprobe: `${high ? 12.5 : 3.1}% of clusters`, rerank: high ? 50 : 0 } : {}
    steps.push({
      text: 'A shopper taps "Similar items" on a photo of a dress. The Search App gets the photo\'s embedding from the Embedding Model and asks the Vector DB API for the 10 nearest listings.',
      nodes: ['Search App', 'Embedding Model', 'Vector DB API'],
      data: JSON.stringify(
        {
          vector: '[0.021, -0.113, 0.087, … 768 numbers]',
          k: K,
          filter: filter === 'none' ? null : { size: 'M', price_lte: 1000 },
          ...(Object.keys(params).length ? { params } : {}),
        },
        null,
        2,
      ),
    })

    if (p.servers > 1)
      steps.push({
        text: `${size(p.ram)} doesn't fit on one server, so the collection is split into ${p.servers} shards of about ${int(shardN)} vectors. The Shard Router sends every query to all ${p.servers}; they search in parallel, so each query costs ${p.servers} servers' work.`,
        nodes: ['Vector DB API', 'Shard Router'],
        data: `${int(n)} vectors ÷ ${p.servers} shards = ~${int(shardN)} a shard, ${size(p.ram / p.servers)} of RAM each\nquery → shard 1 … shard ${p.servers} in parallel → merge the ${p.servers} × 10 candidates`,
      })

    let seconds = 0
    const router = p.servers > 1 ? ['Shard Router'] : []
    const sampleRatio = Math.log(shardN) / Math.log(N)
    if (filter === 'during') {
      const matches = n * MATCH_SHARE
      const per = index === 'ivfpq' ? PQ_CODE : FULL
      seconds = (matches / p.servers) * per / RANDOM_BW + (index === 'ivfpq' && high ? EFFORT.ivfpq.high.rerank / SSD_IOPS : 0)
      steps.push({
        text: `The query planner checks the filter first. The Metadata Index says "size M, under ₹1,000" matches only 2% of listings (${int(matches)}). That's few enough to score every match directly instead of walking the index and hoping matches turn up${index === 'ivfpq' ? `, using their compressed codes${high ? ' and re-ranking the best 50 with full vectors' : ''}` : ', exactly'}.`,
        nodes: ['Filter Selective?', 'Metadata Index', INDEX_NODE[index === 'hnsw' ? 'flat' : index]],
        data: [
          `matching listings: 2% of ${int(n)} = ${int(matches)}${p.servers > 1 ? ` (${int(matches / p.servers)} a shard)` : ''}`,
          `read: ${int(matches / p.servers)} × ${per} bytes = ${size((matches / p.servers) * per)} at ~10 GB/s ≈ ${ms(seconds)}`,
          `measured on the sample: ${int(m.distances || m.codes)} of 2,000 vectors scored, recall@10 = ${m.recall.toFixed(2)}`,
        ].join('\n'),
      })
    } else if (index === 'flat') {
      seconds = (shardN * FULL) / RAM_BW
      steps.push({
        text: `No index: the query is compared with every stored vector. The answer is exact, but every query reads all ${size(shardN * FULL)}${p.servers > 1 ? ' on each shard' : ''}, so the cost grows with the data.`,
        nodes: [INDEX_NODE.flat, ...router],
        data: [
          `read: ${int(shardN)} × ${int(FULL)} bytes = ${size(shardN * FULL)} at ~40 GB/s ≈ ${ms(seconds)} a query`,
          `one server manages ~${int(1 / seconds) || '<1'} queries a second at full memory bandwidth`,
          `measured on the sample: 2,000 of 2,000 vectors compared, recall@10 = 1.00`,
        ].join('\n'),
      })
    } else if (index === 'hnsw') {
      const hops = m.distances * 2 * sampleRatio
      seconds = (hops * FULL) / RANDOM_BW
      steps.push({
        text: `The search enters the graph at the top layer, where a few long links cross the whole space, and greedily hops to the neighbour closest to the query. On the bottom layer it keeps the best ${high ? 64 : 10} candidates (ef) as it explores, and stops when no neighbour is closer. ${high ? 'A wider search checks more neighbours: slower, but it misses less.' : 'A narrow search is fast, but it can stop at a local best and miss true neighbours.'}`,
        nodes: [INDEX_NODE.hnsw, ...router],
        data: [
          `measured on the sample: ${int(m.distances)} of 2,000 vectors compared (ef = ${high ? 64 : 10}), recall@10 = ${m.recall.toFixed(2)}`,
          `at ${int(shardN)} a shard: ~${int(hops)} comparisons (×2 for twice the links, ×${sampleRatio.toFixed(2)} for a deeper graph)`,
          `read: ${int(hops)} × ${int(FULL)} bytes ≈ ${size(hops * FULL)}, scattered, at ~10 GB/s ≈ ${ms(seconds)}`,
        ].join('\n'),
      })
    } else {
      const share = (high ? EFFORT.ivfpq.high : EFFORT.ivfpq.low).nprobe / NLIST
      const nlist = 4 * Math.round(Math.sqrt(shardN))
      const codes = shardN * share
      const rerank = high ? EFFORT.ivfpq.high.rerank : 0
      seconds = (nlist * FULL + codes * PQ_CODE) / RAM_BW + rerank / SSD_IOPS
      steps.push({
        text: `The query is compared with the ${int(nlist)} cluster centres, and only the nearest ${(share * 100).toFixed(1)}% of clusters are searched. Their vectors are scored from their 96-byte codes with lookup tables, which is fast but approximate. ${high ? 'The best 50 are then re-ranked with their full vectors, read from SSD.' : 'Without re-ranking, compression errors decide the final order.'}`,
        nodes: high ? ['IVF-PQ Index', 'Raw Vectors', ...router] : ['IVF-PQ Index', ...router],
        data: [
          `measured on the sample: ${int(m.centroids)} centres + ${int(m.codes)} codes scored${rerank ? ` + ${rerank} re-ranked` : ''}, recall@10 = ${m.recall.toFixed(2)}`,
          `at ${int(shardN)}: ${int(nlist)} centres × ${int(FULL)} bytes (${size(nlist * FULL)}) + ${int(codes)} codes × 96 bytes (${size(codes * PQ_CODE)})`,
          `at ~40 GB/s${rerank ? `, plus ${rerank} SSD reads` : ''} ≈ ${ms(seconds)}`,
        ].join('\n'),
      })
    }

    const s = sample()
    const q = s.queries[0]
    const truth = exact(q, filter === 'none' ? null : s.matching)
    const ignore: IvfStats = { distances: 0, centroids: 0, codes: 0, reranked: 0 }
    let got: number[]
    if (filter === 'during' && index !== 'ivfpq') got = exact(q, s.matching)
    else if (index === 'flat') got = exact(q, null)
    else if (index === 'hnsw') got = searchHnsw(q, high ? 64 : 10, ignore)
    else got = searchIvf(q, (high ? EFFORT.ivfpq.high : EFFORT.ivfpq.low).nprobe, high ? EFFORT.ivfpq.high.rerank : 0, filter === 'during' ? s.matching : null, ignore)
    const before = got.length
    if (filter === 'after') got = got.filter((i) => s.match[i])
    const similarity = (i: number) => (1 - dist(q, s.vecs[i]) / 2).toFixed(3) // unit vectors: |a − b|² = 2 − 2·cos
    const missed = truth.filter((i) => !got.includes(i)).length
    const found = got.filter((i) => truth.includes(i)).length

    steps.push({
      text:
        filter === 'after'
          ? `${p.servers > 1 ? 'Each shard' : 'The index'} returned its 10 nearest listings, and only then was the filter applied. With 2% of listings matching, about 0.2 of every 10 survive: on the sample, ${m.returned.toFixed(2)} results a query on average. The shopper sees an almost empty page, though plenty of matching dresses exist.`
          : `The Top-k Merge combines the candidates${p.servers > 1 ? ` from all ${p.servers} shards` : ''}, keeps the best 10 and returns them with their similarity scores. ${m.recall >= 0.995 ? 'All 10 are the true nearest neighbours.' : `On average ${(m.recall * 10).toFixed(1)} of the 10 are true nearest neighbours; the rest are close, but not the closest.`}`,
      nodes: ['Top-k Merge', 'Vector DB API', 'Search App'],
      data: [
        `sample query 1: ${filter === 'after' ? `${before} nearest found, ${got.length} pass the filter` : `${found} of the true top 10 found${missed ? `, ${missed} missed` : ''}`}`,
        ...got.slice(0, 5).map((i, r) => `${r + 1}. listing #${1000 + i}  similarity ${similarity(i)}${truth.includes(i) ? '' : '  (not in the true top 10)'}`),
        got.length > 5 ? `… ${got.length - 5} more` : got.length === 0 ? '(no results)' : '',
        `over 40 queries: recall@10 = ${m.recall.toFixed(2)}, ${m.returned.toFixed(m.returned === 10 ? 0 : 2)} results each`,
      ]
        .filter(Boolean)
        .join('\n'),
    })

    const label = index === 'flat' ? 'flat' : index === 'hnsw' ? 'HNSW' : 'IVF-PQ'
    return {
      input: `${vectors} · ${label}${index === 'flat' ? '' : high ? ' · high effort' : ' · low effort'}${filter === 'none' ? '' : filter === 'after' ? ' · filter after' : ' · filter during'} → recall ${m.recall.toFixed(2)}${filter === 'after' ? `, ${m.returned.toFixed(2)} results` : ''} · ~${ms(seconds)}${p.servers > 1 ? ` on ${p.servers} servers` : ''}`,
      steps,
    }
  },
}

const run = (vectors: string, index: string, effort: string, filter: string) => ({ vectors, index, effort, filter })

export const vectorDatabase: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'vector-database',
  title: 'Vector Database',
  blurb: 'Finding the nearest of 100 million embeddings in milliseconds: flat scans, HNSW, IVF-PQ, recall and filters',
  guides: [
    'scale-similarity-search-at-flickr',
    'scale-similarity-engine-at-ebay',
    'scale-pintext-multitask-text-embedding-system-at-pinterest',
    'scale-modeling-user-journeys-via-semantic-embeddings-at-etsy',
    'scale-similarity-clustering-to-catch-fraud-rings-at-stripe',
    'the-open-source-ai-stack',
  ],
  story: {
    title: 'Three gigabytes per question',
    dek: 'A "Similar items" button, a server that read every vector it owned, and a filter that returned nothing. How a vector database finds the nearest neighbours fast.',
    chapters: [
      {
        heading: 'Every search reads everything',
        body: `In June, Meera's team at a second-hand fashion marketplace in Pune shipped "Similar items": tap any listing photo and see ten that look like it.

An image model turns each photo into an **embedding**: 768 numbers that place it in a space where similar-looking things sit close together. Two red cotton kurtas land near each other; a red kurta and a black sneaker don't. "Similar" just means "nearest", measured by **cosine similarity**, the angle between two vectors.

The first version was the obvious one. Keep all one million vectors in memory and compare the query with every one of them. That's a **flat**, or brute-force, search. It's exact and it's ten lines of code.

The arithmetic caught up with them at the first Sunday sale:
- each vector is 768 × 4 bytes = 3,072 bytes, so a million of them take 3.07 GB
- every search reads all 3.07 GB; at about 40 GB a second of memory bandwidth, that's 77 ms with every core busy
- so one server tops out near 13 searches a second, and the sale brought 40

> The search wasn't slow because the code was bad. It was slow because it was exact.`,
        replay: { label: 'Replay the flat scan', values: run('1 million', 'Flat (exact scan)', 'Low (fast)', 'None') },
      },
      {
        heading: 'Close enough, two hundred times faster',
        body: `Nobody needs the exact ten nearest dresses. Ten that are very close are fine, and a shopper can't tell the difference. That trade is called **approximate nearest neighbour** (ANN) search, and a vector database is built around it.

The team picked **HNSW** (hierarchical navigable small world), which is a graph. Every vector is linked to a few dozen of its nearest neighbours. A search starts at an entry point, looks at the current vector's neighbours, moves to whichever is closest to the query, and repeats until nothing is closer.

The "hierarchical" part makes it fast. Upper layers hold only a few vectors with long links, like highways; the bottom layer holds every vector with short local links, like streets. A search takes the highways to the right neighbourhood, then walks the streets.

A search now compared the query with about 1,200 vectors instead of a million: roughly 0.36 ms instead of 77. One setting controls the trade, **ef**: how many candidates the search keeps while it explores. They measured it with **recall@10**, the share of the true ten nearest that the index finds. With ef = 10, about 86% came back; with ef = 64, 98%. They chose 64.`,
        replay: { label: 'Replay with HNSW, ef = 64', values: run('1 million', 'HNSW (graph)', 'High (accurate)', 'None') },
      },
      {
        heading: 'A hundred million photos',
        body: `A year later the app sold home goods too, and kept sold listings to suggest prices: 100 million vectors.

HNSW keeps every full vector and its links in RAM, 3,072 + 128 = 3,200 bytes each, so 320 GB. At 48 GB of usable RAM a server, that's 7 servers, and every search has to visit all of them.

The alternative was **IVF-PQ**, two ideas together:
- **IVF** (inverted file) groups the vectors into clusters, about 40,000 of them, and a search only looks inside the clusters nearest the query.
- **PQ** (product quantisation) compresses each vector. Cut the 768 numbers into 96 pieces of 8, and replace each piece with the number of the closest of 256 typical pieces: one byte. 3,072 bytes become 96, 32 times smaller.

The whole index fit in 10.5 GB, on one server. But compression costs accuracy. With a quick search, a few clusters scored only by their codes, barely half of the true top 10 came back. The fix is to **re-rank**: take the best 50 by code, read their full vectors from SSD, and order them exactly. Searching more clusters and re-ranking brought recall back to 0.94, in about 33 ms.`,
        replay: { label: 'Replay IVF-PQ with re-ranking at 100 million', values: run('100 million', 'IVF-PQ (clusters + compression)', 'High (accurate)', 'None') },
      },
      {
        heading: 'Size M, under ₹1,000',
        body: `Then came filters: "Similar items, in my size, under ₹1,000." The first version searched as before and filtered the ten results afterwards. It shipped on a Friday. By Saturday the support inbox was full of screenshots of empty pages.

The maths had been waiting for them. That filter matched 2% of listings. The search found the 10 nearest listings of any size and price, and on average 2% of 10, a fifth of one listing, survived the filter. Matching dresses existed. They just weren't in the top 10 of everything.

Fetching more (the top 1,000, then filtering) helps until a filter is rarer still. The real fix is to filter **during** the search:
- The database keeps a **metadata index** on fields like size and price, and its query planner first asks how many listings match.
- 2% of a million is 20,000. Scoring all 20,000 directly reads 61 MB, takes about 6 ms and is exact.
- When a filter matches most listings, the planner walks the graph as usual and skips the ones that don't match.`,
        replay: { label: 'Replay the empty results', values: run('1 million', 'HNSW (graph)', 'Low (fast)', 'After search (2% match)') },
      },
      {
        heading: 'Keeping it honest',
        body: `An approximate index fails quietly. Nothing errors; results just get a little less similar. So the team wrote down what they had learned:
- **New listings** go to the write-ahead log and a small fresh segment that's searched by brute force, then merged into the big index in the background. A listing is searchable within seconds.
- **Deletes** don't remove nodes from the graph; they mark them as deleted and skip them. When enough pile up, the index is rebuilt.
- **A new embedding model** makes every stored vector incomparable with new queries. Upgrading means re-embedding all 100 million photos into a new collection, then switching searches over.
- **Recall drifts** as data changes. Every night a job runs 1,000 queries through the index and through an exact scan and records recall@10. Below 0.95, someone gets paged.

> Nobody notices a row of similar items that's 2% less similar. Everybody notices an empty one. Measure the first, and test for the second.`,
        replay: { label: 'Run the filtered search properly', values: run('1 million', 'HNSW (graph)', 'High (accurate)', 'During search (2% match)') },
      },
    ],
  },
  takeaways: [
    'A vector database answers "which stored items are nearest to this one?" over embeddings, the numbers a model produces to capture meaning.',
    'A flat search compares the query with every vector: exact, but 1 million 768-dimension vectors means reading 3 GB per query.',
    'Approximate indexes trade a little recall for a huge speed-up: HNSW walks a graph of neighbours, IVF-PQ searches a few clusters of compressed codes.',
    'Memory shapes the design: HNSW needs full vectors in RAM, PQ shrinks them 32 times, and re-ranking with full vectors recovers accuracy.',
    'Filtering after an approximate search returns almost nothing when the filter is selective; filter during the search or score the matches directly.',
    'Measure recall@k against an exact scan continuously, because data, settings and models all drift.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'writes', label: 'Write path' },
      { id: 'query', label: 'Query path' },
      { id: 'shard', label: 'Each shard' },
    ],
    nodes: [
      { id: 'app', label: 'Search App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'embed', label: 'Embedding Model', shape: 'rectangle', color: 'violet', group: null },
      { id: 'api', label: 'Vector DB API', shape: 'rectangle', color: 'violet', group: 'query' },
      { id: 'wal', label: 'Write-Ahead Log', shape: 'rectangle', color: 'yellow', group: 'writes' },
      { id: 'builder', label: 'Index Builder', shape: 'rectangle', color: 'orange', group: 'writes' },
      { id: 'router', label: 'Shard Router', shape: 'rectangle', color: 'violet', group: 'query' },
      { id: 'planner', label: 'Filter Selective?', shape: 'diamond', color: 'violet', group: 'shard' },
      { id: 'meta', label: 'Metadata Index', shape: 'rectangle', color: 'green', group: 'shard' },
      { id: 'raw', label: 'Raw Vectors', shape: 'rectangle', color: 'green', group: 'shard' },
      { id: 'ivf', label: 'IVF-PQ Index', shape: 'rectangle', color: 'green', group: 'shard' },
      { id: 'hnsw', label: 'HNSW Graph', shape: 'rectangle', color: 'green', group: 'shard' },
      { id: 'merge', label: 'Top-k Merge', shape: 'rectangle', color: 'violet', group: null },
    ],
    edges: [
      { from: 'app', to: 'embed', label: 'photo', dashed: false },
      { from: 'app', to: 'api', label: 'vector, k, filter', dashed: false },
      { from: 'api', to: 'wal', label: 'upsert', dashed: false },
      { from: 'wal', to: 'builder', label: 'new vectors', dashed: false },
      { from: 'builder', to: 'raw', label: 'store', dashed: false },
      { from: 'builder', to: 'hnsw', label: 'link neighbours', dashed: false },
      { from: 'builder', to: 'ivf', label: 'cluster + encode', dashed: false },
      { from: 'builder', to: 'meta', label: 'fields', dashed: false },
      { from: 'api', to: 'router', label: 'search', dashed: false },
      { from: 'router', to: 'planner', label: 'every shard', dashed: false },
      { from: 'planner', to: 'meta', label: 'how many match?', dashed: true },
      { from: 'planner', to: 'raw', label: 'few: score them', dashed: false },
      { from: 'planner', to: 'hnsw', label: 'many: walk graph', dashed: false },
      { from: 'planner', to: 'ivf', label: 'many: probe clusters', dashed: false },
      { from: 'ivf', to: 'raw', label: 're-rank', dashed: true },
      { from: 'hnsw', to: 'merge', label: 'candidates', dashed: false },
      { from: 'ivf', to: 'merge', label: 'candidates', dashed: false },
      { from: 'raw', to: 'merge', label: 'exact scores', dashed: false },
      { from: 'merge', to: 'api', label: 'top 10', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'listings',
        name: 'listings',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'category', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'size', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'price_inr', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'photo_url', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(category, size, price_inr)', '(status)'],
      },
      {
        id: 'listing_embeddings',
        name: 'listing_embeddings',
        columns: [
          { name: 'listing_id', type: 'bigint', pk: true, fk: 'listings.id', nullable: false, unique: false },
          { name: 'model_version', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'embedding', type: 'vector(768)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['HNSW (embedding vector_cosine_ops) WITH (m = 16)'],
      },
      {
        id: 'recall_checks',
        name: 'recall_checks',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'run_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'index_params', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
          { name: 'queries', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'recall_at_10', type: 'numeric(4,3)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'p99_ms', type: 'numeric', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(run_at)'],
      },
    ],
    relations: [{ from: 'listings', to: 'listing_embeddings', kind: 'one-to-one', label: 'embedded as' }],
  },
  explanation: {
    title: 'Vector Database',
    summary:
      'An embedding model turns a photo or a sentence into a list of numbers that captures what it means. A vector database stores millions of these and finds the ones nearest to a query in milliseconds, by searching an approximate index instead of comparing with every vector.',
    sections: [
      {
        heading: 'Overview',
        body: 'An embedding is a vector: a list of numbers, here 768 of them, produced by a model so that similar things get similar vectors. "Find similar items", "find passages that answer this question" and "find accounts that behave like this fraud ring" all become one question: which stored vectors are nearest to this one? That is nearest neighbour search, usually measured by cosine similarity (the angle between two vectors).\n\nComparing with every vector is exact but reads all of them on every query. A vector database builds an approximate index instead, such as an HNSW graph or IVF-PQ clusters, and adds what a database needs around it: durable writes, deletes, metadata filters, sharding and replication.\n\nThe simulator really searches. It builds a flat index, IVF-PQ and an HNSW graph over 2,000 sample vectors in your browser, runs 40 queries against each and measures recall against an exact scan. Memory and latency at 1 million and 100 million real 768-dimension vectors are worked out from the formulas shown.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Upsert and delete vectors with an id and metadata (size, price, category).\n- Return the k nearest vectors to a query by cosine similarity, optionally filtered by metadata.\n- New items searchable within seconds.\n\nNon-functional:\n- 100 million vectors of 768 dimensions.\n- 500 searches a second at peak, p99 under 50 ms.\n- Recall@10 of at least 0.95: the index finds 95% of the true ten nearest.',
      },
      {
        heading: 'Capacity estimates',
        body: '- One float32 vector: 768 × 4 bytes = 3,072 bytes. 1 million = 3.07 GB; 100 million = 307 GB.\n- HNSW with M = 16 adds 32 neighbour ids × 4 bytes = 128 bytes on the bottom layer: 3,200 bytes a vector, 320 GB for 100 million, or 7 servers at 48 GB of usable RAM each.\n- IVF-PQ with 96-byte codes and 8-byte ids: 100 million × 104 bytes = 10.4 GB, plus 40,000 cluster centres × 3,072 bytes = 123 MB. One server.\n- A flat scan of 1 million reads 3.07 GB per query; at 40 GB/s that is 77 ms, about 13 queries a second per server. 500 a second would need 39 servers.\n- Writes: 200,000 new listings a day ÷ 86,400 seconds ≈ 2.3 a second. Running the embedding model is the expensive part, not indexing.\n- Storing vectors as float16 halves everything: 1,536 bytes a vector, 154 GB for 100 million.',
      },
      {
        heading: 'Step by step',
        body: 'Writing:\n1. The Vector DB API receives an upsert (id, vector, metadata) and appends it to the Write-Ahead Log.\n2. The Index Builder stores the vector in Raw Vectors, adds it to the HNSW Graph or the IVF-PQ Index, and records its fields in the Metadata Index.\n\nSearching:\n3. The Search App embeds the photo with the Embedding Model and sends the vector, k and any filter to the Vector DB API.\n4. The Shard Router sends the search to every shard.\n5. On each shard, Filter Selective? asks the Metadata Index how many items match. If few do, it scores them directly from Raw Vectors.\n6. Otherwise it searches the HNSW Graph or the IVF-PQ Index, skipping items that fail the filter; IVF-PQ candidates are re-ranked with their full vectors from Raw Vectors.\n7. The Top-k Merge combines the shards\' candidates and returns the best k to the Vector DB API, which answers the Search App.',
      },
      {
        heading: 'Components',
        body: '- Search App: the shopping app\'s backend; turns a tap on "Similar items" into a vector search and shows the results.\n- Embedding Model: turns a photo or text into 768 numbers; stored items and queries must use the same model.\n- Vector DB API: accepts upserts, deletes and searches, and checks dimensions and collections.\n- Write-Ahead Log: makes each write durable before it is indexed, so a crash loses nothing; replayed on restart.\n- Index Builder: builds and merges index segments in the background, trains clusters and PQ codebooks, and purges deleted items.\n- Shard Router: knows which servers hold which shards; sends each write to one shard and each search to all of them.\n- Filter Selective?: the query planner\'s choice between scoring the few matching items directly and searching the index while skipping non-matches.\n- Metadata Index: ordinary indexes on fields like size, price and category, used to count and list matching ids.\n- Raw Vectors: the full float32 vectors; scanned for exact search and read to re-rank approximate results.\n- IVF-PQ Index: cluster centres plus a 96-byte compressed code per vector; 100 million fit on one server.\n- HNSW Graph: every vector linked to its nearest neighbours, in layers; fast and accurate, but needs the full vectors in RAM.\n- Top-k Merge: merges the shards\' candidates by score and keeps the best k.',
      },
      {
        heading: 'Key decisions',
        body: '- Exact or approximate: a flat scan is exact and fine up to about 100,000 vectors, or when a filter leaves few candidates. Beyond that, use an approximate index and measure its recall.\n- HNSW or IVF-PQ: HNSW gives the best recall for the time, but keeps full vectors and links in RAM, builds slowly and handles deletes poorly. IVF-PQ is 30 times smaller and builds fast, but needs training on a sample and re-ranking to be accurate. Graph indexes that live on SSD (DiskANN) sit in between.\n- Knobs: HNSW\'s M (links per node) and ef_construction set build quality, ef sets search width. IVF\'s cluster count (around 4 × √N) and nprobe (clusters searched) trade recall for time; PQ\'s code size trades memory for accuracy.\n- Distance: use the one the embedding model was trained for, usually cosine. Normalise vectors once, and cosine becomes a plain dot product.\n- Filters: score the matches directly when a filter is selective, filter inside the graph walk when it isn\'t, and never filter only after a top-10 search.\n- Extension or dedicated engine: pgvector keeps vectors next to the rows, in the same transactions and backups, and handles tens of millions. Dedicated engines (Milvus, Qdrant, Weaviate) add sharding, quantisation and filter-aware planning.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Shards: split by id hash so shards are equal. Every search visits every shard, so latency is set by the slowest one; replicate shards and send a backup request when one is slow.\n- Throughput: adding shards doesn\'t raise searches a second, because each search still costs every shard. Add replicas instead.\n- Fresh data: new vectors go into a small segment searched by brute force, merged into the main index in the background.\n- Deletes: mark and skip, then rebuild or compact when deleted items pile up, or the graph fills with dead ends.\n- Model upgrades: vectors from two models aren\'t comparable. Re-embed into a new collection, write to both, switch searches over, and keep the old one for rollback.\n- Rebuilds: building HNSW over 100 million vectors takes hours. Snapshot indexes to object storage so a new replica loads one instead of rebuilding.\n- Silent decay: run a sample of queries through an exact scan every night and alert when recall@10 drops.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why can\'t a B-tree index answer "which vector is nearest to this one"?\n- 1 billion vectors: HNSW, IVF-PQ or something on disk? Show the memory maths.\n- A filter matches 0.1% of items. What does each filtering strategy return?\n- How do you measure recall in production without an exact scan on every query?\n- The embedding model changes. What happens to the 100 million stored vectors?\n- Why doesn\'t adding shards increase queries per second?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Exact top k by cosine similarity (TypeScript)',
        language: 'typescript',
        source: `// Brute force: exact, simple, and fine up to about 100,000 vectors.
export function normalise(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n)
  return v.map((x) => x / n)
}

// On unit vectors, cosine similarity is just the dot product.
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// Items are stored normalised, so each comparison is one dot product.
export function topK(query: Float32Array, items: { id: string; vector: Float32Array }[], k = 10) {
  const q = normalise(query)
  return items
    .map((it) => ({ id: it.id, score: dot(q, it.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}`,
      },
      {
        title: 'Filtered HNSW search with pgvector (SQL)',
        language: 'sql',
        source: `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE listing_embeddings (
  listing_id bigint PRIMARY KEY REFERENCES listings (id),
  embedding  vector(768) NOT NULL
);

-- m = links per node, ef_construction = search width while building.
CREATE INDEX ON listing_embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Search width per query; keep scanning if the filter removes results (pgvector 0.8+).
SET hnsw.ef_search = 64;
SET hnsw.iterative_scan = relaxed_order;

-- $1 = the photo's embedding. <=> is cosine distance.
SELECT l.id, l.title, 1 - (e.embedding <=> $1) AS similarity
FROM listing_embeddings e
JOIN listings l ON l.id = e.listing_id
WHERE l.size = 'M' AND l.price_inr <= 1000
ORDER BY e.embedding <=> $1
LIMIT 10;`,
      },
      {
        title: 'IVF-PQ with re-ranking in FAISS (Python)',
        language: 'python',
        source: `import faiss
import numpy as np

d = 768
xb = np.load("listing_vectors.npy").astype("float32")  # (1_000_000, 768)
faiss.normalize_L2(xb)                                   # cosine = inner product on unit vectors

nlist = 4 * int(np.sqrt(len(xb)))                        # 4,000 clusters for a million
quantizer = faiss.IndexFlatIP(d)
ivfpq = faiss.IndexIVFPQ(quantizer, d, nlist, 96, 8, faiss.METRIC_INNER_PRODUCT)  # 96 bytes a vector

index = faiss.IndexRefineFlat(ivfpq)  # also keeps full vectors, to re-rank the best candidates
index.train(xb[np.random.choice(len(xb), 200_000, replace=False)])
index.add(xb)

ivfpq.nprobe = 64    # clusters searched per query
index.k_factor = 5   # re-rank the best 50 to return 10

xq = np.load("query_vectors.npy").astype("float32")
faiss.normalize_L2(xq)
scores, ids = index.search(xq, 10)`,
      },
      {
        title: 'Measuring recall@10 of an HNSW index (Python)',
        language: 'python',
        source: `import hnswlib
import numpy as np

vectors = np.load("listing_vectors.npy").astype("float32")
unit = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)

index = hnswlib.Index(space="cosine", dim=768)
index.init_index(max_elements=len(vectors), M=16, ef_construction=200)
index.add_items(vectors, np.arange(len(vectors)))

queries = unit[np.random.choice(len(unit), 100, replace=False)]
exact = np.argsort(-(queries @ unit.T), axis=1)[:, :10]  # ground truth: a full scan

for ef in (10, 64, 200):
    index.set_ef(ef)  # search width: higher finds more, slower
    approx, _ = index.knn_query(queries, k=10)
    recall = np.mean([len(set(a) & set(e)) / 10 for a, e in zip(approx, exact)])
    print(f"ef={ef}: recall@10 = {recall:.3f}")`,
      },
    ],
    related: ['RAG pipeline', 'Embeddings', 'Database sharding', 'Distributed cache', 'Consistent hashing', 'Full-text search'],
  },
  simulator,
}
