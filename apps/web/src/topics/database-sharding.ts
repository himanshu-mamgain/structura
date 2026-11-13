import type { Trace } from '@structura/shared'
import { hash32 } from './consistent-hashing'
import { defaultTrace, json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// An orders table split over 4 database shards. The simulator uses a fixed,
// pseudo-random data set of 20,000 orders (2,000 users, 8 countries, 12 months,
// with the skews real data has: a few heavy users, one dominant country, growth
// over the year) and measures where each strategy puts them, so every "share of
// rows" and "rows that move" figure is computed, not quoted.

const USERS = 2000
const ORDERS = 20_000
const SHARDS = 4
const BUCKETS = 64
const COUNTRIES = ['BR', 'DE', 'FR', 'GB', 'IN', 'JP', 'NG', 'US'] // alphabetical, so ranges are meaningful
const COUNTRY_WEIGHT = [6, 8, 5, 9, 22, 7, 3, 40]
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`)
const NOW_MONTH = 10 // "today" is in 2026-11, so new orders always carry that month

// Small deterministic generator (mulberry32), so every visitor sees the same data.
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = rng(2026)
const pickCountry = () => {
  let r = rand() * 100
  for (let i = 0; i < COUNTRIES.length; i++) {
    r -= COUNTRY_WEIGHT[i]
    if (r < 0) return i
  }
  return COUNTRIES.length - 1
}
const userCountry = Array.from({ length: USERS }, pickCountry)
type Order = { user: number; country: number; month: number }
const orders: Order[] = Array.from({ length: ORDERS }, () => {
  const user = 1 + Math.floor(USERS * rand() ** 2) // low ids (old accounts) order the most
  return { user, country: userCountry[user - 1], month: Math.floor(12 * Math.sqrt(rand())) } // later months are busier
})

type ShardKey = 'user_id' | 'country' | 'created_at (month)'
const SHARD_KEYS: ShardKey[] = ['user_id', 'country', 'created_at (month)']
const STRATEGIES = ['Hash mod N', 'Hash into 64 buckets', 'Range', 'Directory (lookup table)']

const domain = (k: ShardKey) => (k === 'user_id' ? USERS : k === 'country' ? COUNTRIES.length : 12)
const labelOf = (k: ShardKey, idx: number) => (k === 'user_id' ? String(idx + 1) : k === 'country' ? COUNTRIES[idx] : MONTHS[idx])
const idxOf = (k: ShardKey, o: Order) => (k === 'user_id' ? o.user - 1 : k === 'country' ? o.country : o.month)

/** Orders per key value (index into the key's domain). */
const countsCache = new Map<ShardKey, number[]>()
function counts(k: ShardKey): number[] {
  let c = countsCache.get(k)
  if (!c) {
    c = new Array(domain(k)).fill(0)
    for (const o of orders) c[idxOf(k, o)]++
    countsCache.set(k, c)
  }
  return c
}

/** key index → shard number (0-based). */
type Layout = number[]
const hashOf = (k: ShardKey, idx: number) => hash32(`${k}:${labelOf(k, idx)}`)
const indexes = (k: ShardKey) => Array.from({ length: domain(k) }, (_, i) => i)

/** Biggest keys first, each to the shard with the fewest rows so far (how a directory is filled). */
function directoryLayout(k: ShardKey, n: number): Layout {
  const c = counts(k)
  const load = new Array(n).fill(0)
  const out: Layout = new Array(c.length).fill(0)
  for (const i of indexes(k).sort((a, b) => c[b] - c[a] || a - b)) {
    const s = load.indexOf(Math.min(...load))
    out[i] = s
    load[s] += c[i]
  }
  return out
}

const bucketTable = (n: number) => Array.from({ length: BUCKETS }, (_, b) => b % n)

function layout(k: ShardKey, strategy: string, n: number): Layout {
  const D = domain(k)
  if (strategy.startsWith('Hash mod')) return indexes(k).map((i) => hashOf(k, i) % n)
  if (strategy.startsWith('Hash into')) {
    const t = bucketTable(n)
    return indexes(k).map((i) => t[hashOf(k, i) % BUCKETS])
  }
  if (strategy === 'Range') return indexes(k).map((i) => Math.floor((i * n) / D))
  return directoryLayout(k, n)
}

/** The layout after adding Shard 5, moving as little as the strategy allows. */
function grow(k: ShardKey, strategy: string): { after: Layout; note: string } {
  const n = SHARDS + 1
  const c = counts(k)
  if (strategy.startsWith('Hash mod')) return { after: layout(k, strategy, n), note: `the divisor changes from ${SHARDS} to ${n}, so the remainder changes for most keys` }
  if (strategy === 'Range') return { after: layout(k, strategy, n), note: `the ${n} ranges are cut again, so every boundary slides` }
  if (strategy.startsWith('Hash into')) {
    const t = bucketTable(SHARDS)
    const goal = Math.floor(BUCKETS / n)
    let moved = 0
    while (moved < goal) {
      const sizes = Array.from({ length: SHARDS }, (_, s) => t.filter((x) => x === s).length)
      const from = sizes.indexOf(Math.max(...sizes))
      const b = t.lastIndexOf(from)
      t[b] = SHARDS
      moved++
    }
    return { after: indexes(k).map((i) => t[hashOf(k, i) % BUCKETS]), note: `only ${goal} of the ${BUCKETS} buckets are handed to Shard 5; the hash of a key never changes` }
  }
  // Directory: copy whole keys to Shard 5 until it holds a fifth of the rows.
  const after = directoryLayout(k, SHARDS)
  const target = Math.floor(ORDERS / n)
  let held = 0
  for (;;) {
    const load = new Array(n).fill(0)
    indexes(k).forEach((i) => (load[after[i]] += c[i]))
    const donor = load.indexOf(Math.max(...load.slice(0, SHARDS)))
    const fit = indexes(k)
      .filter((i) => after[i] === donor && c[i] > 0 && c[i] <= target - held)
      .sort((a, b) => c[b] - c[a])[0]
    if (fit === undefined) break
    after[fit] = SHARDS
    held += c[fit]
  }
  return { after, note: 'whole keys are re-pointed in the lookup table, so only the ones you choose move' }
}

const loads = (k: ShardKey, lay: Layout, n: number) => {
  const c = counts(k)
  const out = new Array(n).fill(0)
  lay.forEach((s, i) => (out[s] += c[i]))
  return out
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const fmt = (x: number) => x.toLocaleString('en-US')
const shardName = (s: number) => `Shard ${s + 1}`
const R = 'Shard Router (key → shard)'
const MAP = 'Shard Map (config store)'

/** "Shard 2 holds 4,480 rows (22.4%)" lines plus how lopsided the cluster is. */
function balance(k: ShardKey, lay: Layout, n: number) {
  const l = loads(k, lay, n)
  const avg = ORDERS / n
  const worst = Math.max(...l)
  const lines = l.map((v, s) => `${shardName(s)}: ${fmt(v)} rows (${pct(v / ORDERS)})`).join('\n')
  return { l, worst, ratio: worst / avg, text: `${lines}\nbusiest shard = ${(worst / avg).toFixed(2)}× the average (${fmt(avg)})` }
}

/** Why a key lands where it does, in the strategy's own terms. */
function route(k: ShardKey, strategy: string, idx: number, lay: Layout) {
  const label = labelOf(k, idx)
  const s = lay[idx]
  if (strategy.startsWith('Hash mod')) {
    const h = hashOf(k, idx)
    return { s, text: `Hash mod N: hash32("${k}:${label}") = ${h}; ${h} mod ${SHARDS} = ${h % SHARDS}, so ${shardName(s)}. No lookup is needed, but N is baked into every answer.`, data: `hash32("${k}:${label}") = ${h}\n${h} % ${SHARDS} = ${h % SHARDS} → ${shardName(s)}` }
  }
  if (strategy.startsWith('Hash into')) {
    const h = hashOf(k, idx)
    const b = h % BUCKETS
    return { s, text: `Hash into buckets: the key hashes to bucket ${b} of ${BUCKETS}, and the Shard Map says bucket ${b} lives on ${shardName(s)}. Buckets, not keys, are what move later.`, data: `hash32("${k}:${label}") % ${BUCKETS} = bucket ${b}\nbucket_map[${b}] = ${shardName(s)}` }
  }
  if (strategy === 'Range') {
    const mine = indexes(k).filter((i) => lay[i] === s)
    const lo = labelOf(k, mine[0])
    const hi = labelOf(k, mine[mine.length - 1])
    return { s, text: `Range: the Shard Map holds sorted ranges, and ${label} falls in ${lo} to ${hi}, which belongs to ${shardName(s)}. Neighbouring keys sit together, so range scans stay on one shard.`, data: `ranges (${k}):\n${Array.from({ length: SHARDS }, (_, x) => { const m = indexes(k).filter((i) => lay[i] === x); return `${shardName(x)}: ${labelOf(k, m[0])} … ${labelOf(k, m[m.length - 1])}` }).join('\n')}\n"${label}" → ${shardName(s)}` }
  }
  return { s, text: `Directory: the Shard Map is a lookup table with one row per key, so it simply says ${label} → ${shardName(s)}. It can place any key anywhere, at the price of one more read (usually cached) and a table that can grow as large as the data.`, data: `SELECT shard FROM shard_map WHERE ${k.split(' ')[0]} = '${label}'\n→ ${shardName(s)}` }
}

const SHARD_LABELS = Array.from({ length: SHARDS }, (_, s) => shardName(s))

const simulator: Simulator = {
  fields: [
    { id: 'user', label: 'User placing the order (id 1 to 2000)', placeholder: '1042', options: ['17', '1042', '1999'] },
    { id: 'shardKey', label: 'Shard key', options: SHARD_KEYS },
    { id: 'strategy', label: 'Strategy', options: STRATEGIES },
    { id: 'event', label: 'What happens', options: ['Place an order', "Read that user's orders", 'Search orders by status', 'Add a fifth shard'] },
  ],
  defaults: { user: '1042', shardKey: 'user_id', strategy: 'Hash mod N', event: 'Place an order' },
  run({ user, shardKey, strategy, event }) {
    const u = Math.min(USERS, Math.max(1, Math.round(Number(user)) || 1042))
    const k = (SHARD_KEYS.includes(shardKey as ShardKey) ? shardKey : 'user_id') as ShardKey
    const country = COUNTRIES[userCountry[u - 1]]
    const lay = layout(k, strategy, SHARDS)
    const inputText = `user ${u}, ${k}, ${strategy}`
    const orderId = `ord_${100000 + (hash32(`order:${u}`) % 900000)}`
    const row = { order_id: orderId, user_id: u, country, created_at: '2026-11-12', status: 'new', total_cents: 1000 + (hash32(`total:${u}`) % 19000) }
    // The shard key value for this user's new order.
    const keyIdx = k === 'user_id' ? u - 1 : k === 'country' ? userCountry[u - 1] : NOW_MONTH
    const keyValue = labelOf(k, keyIdx)
    const bal = balance(k, lay, SHARDS)

    const steps: Trace['steps'] = []

    if (event.startsWith('Place')) {
      const r = route(k, strategy, keyIdx, lay)
      steps.push(
        { text: `User ${u} (from ${country}) places an order. The app sends it to the API Server.`, nodes: ['App Client', 'API Server'], data: `POST /orders\n${json({ user_id: u, items: 2 })}` },
        { text: `The API Server hands the row to the Shard Router. The table is sharded by ${k}, so the router needs one value from the row: ${k} = ${keyValue}.`, nodes: ['API Server', R], data: json(row) + `\nshard key: ${k} = ${keyValue}` },
        { text: r.text, nodes: [R, MAP], data: r.data },
        { text: `The router writes the row to ${shardName(r.s)} only. The other shards never see it. One shard, one transaction, no cross-shard coordination.`, nodes: [R, shardName(r.s)], data: `${shardName(r.s)}: INSERT INTO orders (order_id, user_id, country, created_at, status, total_cents)\nVALUES ('${orderId}', ${u}, '${country}', '2026-11-12', 'new', ${row.total_cents});` },
      )
      const tail =
        k === 'created_at (month)'
          ? ` Every new order carries the current month, so with a time-based key all of today's writes hit ${shardName(r.s)} while the others sit idle: a hot shard, whichever strategy places the months.`
          : k === 'country'
            ? ' A country key has only 8 values and one of them (US) is 40% of the orders, so no strategy can spread it beyond what its biggest value weighs.'
            : ''
      steps.push({
        text: `Across the ${fmt(ORDERS)} sample orders, the busiest shard holds ${bal.ratio.toFixed(2)}× the average.${tail}`,
        nodes: [MAP, ...SHARD_LABELS],
        data: `rows per shard (${k}, ${strategy})\n${bal.text}`,
      })
      return { input: inputText, steps }
    }

    if (event.startsWith('Read')) {
      const single = k === 'user_id'
      steps.push({
        text: `The app opens "my orders" for user ${u}.`,
        nodes: ['App Client', 'API Server'],
        data: `GET /users/${u}/orders`,
      })
      if (single) {
        const r = route(k, strategy, u - 1, lay)
        steps.push(
          { text: `The query names user_id, which is the shard key, so the router can go straight to one shard. ${r.text}`, nodes: ['API Server', R, MAP], data: r.data },
          { text: `Only ${shardName(r.s)} is asked. The other ${SHARDS - 1} shards do no work for this request.`, nodes: [R, shardName(r.s)], data: `${shardName(r.s)}: SELECT * FROM orders WHERE user_id = ${u} ORDER BY created_at DESC LIMIT 20;\nshards touched: 1 of ${SHARDS}` },
        )
      } else {
        const lost = 1 - 0.99 ** SHARDS
        steps.push(
          { text: `The query filters on user_id, but the table is sharded by ${k}. The router cannot tell which shard holds user ${u}'s orders, because ${k === 'country' ? 'orders from one user are not grouped by anything the query knows' : 'a user\'s orders were written in different months and so live on different shards'}.`, nodes: ['API Server', R], data: `shard key: ${k}\nquery filter: user_id = ${u}\n→ not the shard key: scatter to all ${SHARDS} shards` },
          { text: `So the router sends the query to every shard and the Result Merger waits for all ${SHARDS} answers. If each shard is slow 1% of the time, then 1 - 0.99^${SHARDS} = ${pct(lost)} of requests wait on at least one slow shard. At 16 shards that is ${pct(1 - 0.99 ** 16)}.`, nodes: [R, ...SHARD_LABELS], data: `SELECT * FROM orders WHERE user_id = ${u} ORDER BY created_at DESC LIMIT 20;  (× ${SHARDS} shards, in parallel)\nshards touched: ${SHARDS} of ${SHARDS}` },
          { text: `The Result Merger combines up to ${SHARDS} × 20 = ${SHARDS * 20} rows, sorts them and keeps the newest 20. The database does ${SHARDS}× the work for a request that needed one shard's data.`, nodes: [...SHARD_LABELS, 'Result Merger'], data: `rows received: ${SHARDS * 20} (max)\nrows returned: 20` },
        )
      }
      steps.push({ text: `The API Server returns the page to the app.`, nodes: single ? [shardName(route(k, strategy, u - 1, lay).s), 'API Server'] : ['Result Merger', 'API Server'], data: `200 OK\n20 orders for user ${u}` })
      return { input: inputText, steps }
    }

    if (event.startsWith('Search')) {
      steps.push(
        { text: 'A support agent searches the newest shipped orders. Status is not a good shard key (it has a handful of values and every row changes it), so it is only an ordinary column.', nodes: ['App Client', 'API Server'], data: 'GET /orders?status=shipped&limit=20' },
        { text: `The filter has no shard key in it, so whatever the strategy (${strategy}) the router must ask every shard.`, nodes: ['API Server', R], data: `shard key: ${k}\nquery filter: status = 'shipped'\n→ scatter to all ${SHARDS} shards` },
        { text: `Each shard returns its own newest 20 shipped orders. The Result Merger then picks the global newest 20 out of ${SHARDS * 20}. Page 2 is harder: every shard must now return 40 rows, and page 50 means ${SHARDS} × 1,000 rows merged, which is why deep paging across shards is avoided.`, nodes: [R, ...SHARD_LABELS, 'Result Merger'], data: `each shard: SELECT * FROM orders WHERE status = 'shipped' ORDER BY created_at DESC LIMIT 20;\nrows merged: ${SHARDS * 20} → 20 returned\npage 50 (offset 980): each shard returns 1,000 rows → ${fmt(SHARDS * 1000)} merged` },
        { text: 'The usual cure is a second copy of the data built for the question (a search index or a read model fed from the shards), instead of making every shard answer.', nodes: ['Result Merger', 'API Server'], data: '200 OK\n20 orders' },
      )
      return { input: inputText, steps }
    }

    // Add a fifth shard.
    const { after, note } = grow(k, strategy)
    const c = counts(k)
    let moved = 0
    let movedKeys = 0
    indexes(k).forEach((i) => {
      if (after[i] !== lay[i]) {
        moved += c[i]
        movedKeys++
      }
    })
    const frac = moved / ORDERS
    const tb = frac * 12.5 // the sample stands in for a 12.5 TB table
    const hours = (tb * 1_000_000) / 100 / 3600 // copied at 100 MB/s
    const after5 = balance(k, after, SHARDS + 1)
    const myBefore = lay[keyIdx]
    const myAfter = after[keyIdx]
    steps.push(
      { text: `The four shards are filling up, so operations adds Shard 5 and starts the Rebalancer, the job that copies rows to their new home while the app keeps running.`, nodes: ['Rebalancer', 'Shard 5'], data: `new shard: Shard 5 (empty)\nstrategy: ${strategy}\nshard key: ${k}` },
      { text: `Which rows must move? Under "${strategy}", ${note}. Measured on the sample: ${fmt(moved)} of ${fmt(ORDERS)} rows (${pct(frac)}) change shard, covering ${movedKeys} of ${domain(k)} key values.`, nodes: ['Rebalancer', ...SHARD_LABELS], data: `rows that move: ${fmt(moved)} / ${fmt(ORDERS)} = ${pct(frac)}\nideal (one fifth): ${pct(1 / (SHARDS + 1))}\n${k} = ${keyValue}: ${shardName(myBefore)} → ${shardName(myAfter)}${myBefore === myAfter ? ' (stays)' : ''}` },
      { text: `Scaled up to a 12.5 TB table, that is ${tb.toFixed(1)} TB to copy. At 100 MB/s that is about ${hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours.toFixed(1)} hours`}, during which writes go to both the old and new location (double-write) and reads stay on the old one.`, nodes: ['Rebalancer', 'Shard 5'], data: `${frac.toFixed(4)} × 12.5 TB = ${tb.toFixed(2)} TB\n${tb.toFixed(2)} TB ÷ 100 MB/s = ${hours.toFixed(1)} h` },
      { text: 'When the copy has caught up and been verified, the Rebalancer flips the entry in the Shard Map. Every router sees the new map, and the old rows are deleted later. The change is a config edit, not an application deploy.', nodes: ['Rebalancer', MAP], data: `shard_map version ${strategy.startsWith('Hash mod') ? 'n/a (formula, must ship to every client)' : '42 → 43'}\ncutover: reads now go to the new shard` },
      { text: `After the move the busiest shard holds ${after5.ratio.toFixed(2)}× the average of ${fmt(ORDERS / (SHARDS + 1))} rows.${moved === 0 ? ' Nothing moved, so Shard 5 is empty: this key has too few values to give a fifth shard any rows.' : ''}`, nodes: [MAP, ...SHARD_LABELS, 'Shard 5'], data: after5.text },
    )
    return { input: `${inputText}, add shard`, steps }
  },
}

export const databaseSharding: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'database-sharding',
  title: 'Database Sharding',
  blurb: 'How to split one table over many databases, and why the choice of shard key decides everything',
  guides: ['a-crash-course-in-database-sharding', 'key-concepts-to-understand-database-sharding', 'top-4-data-sharding-algorithms-explained', 'scale-how-sharding-works', 'consistent-hashing', 'vertical-partitioning-vs-horizontal-partitioning'],
  takeaways: [
    'Sharding splits one big table across several databases, each holding a slice of the rows, so storage and writes scale past one machine.',
    'The shard key decides which shard owns a row; a good key has many values, spreads load evenly and appears in your common queries.',
    'A query that includes the shard key touches one shard; one that does not must scatter to every shard and wait for the slowest.',
    'Hash placement spreads load but loses order; range placement keeps order but makes hot shards (a time key sends every new write to the newest one).',
    'Hash mod N moves most rows when N changes; fixed buckets or a lookup table move only what you choose.',
    'Shard last: replicas, caches and indexes are cheaper, and cross-shard joins and transactions are hard to get back once lost.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'shards', label: 'Database shards' }],
    nodes: [
      { id: 'client', label: 'App Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'api', label: 'API Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'router', label: 'Shard Router (key → shard)', shape: 'diamond', color: 'violet', group: null },
      { id: 'map', label: 'Shard Map (config store)', shape: 'rectangle', color: 'yellow', group: null },
      { id: 's1', label: 'Shard 1', shape: 'rectangle', color: 'green', group: 'shards' },
      { id: 's2', label: 'Shard 2', shape: 'rectangle', color: 'green', group: 'shards' },
      { id: 's3', label: 'Shard 3', shape: 'rectangle', color: 'green', group: 'shards' },
      { id: 's4', label: 'Shard 4', shape: 'rectangle', color: 'green', group: 'shards' },
      { id: 's5', label: 'Shard 5', shape: 'rectangle', color: 'green', group: 'shards' },
      { id: 'merger', label: 'Result Merger', shape: 'rectangle', color: 'violet', group: null },
      { id: 'rebalancer', label: 'Rebalancer', shape: 'rectangle', color: 'orange', group: null },
    ],
    edges: [
      { from: 'client', to: 'api', label: 'request', dashed: false },
      { from: 'api', to: 'router', label: 'query + shard key', dashed: false },
      { from: 'router', to: 'map', label: 'where is the key?', dashed: true },
      { from: 'router', to: 's1', label: 'single-shard query', dashed: false },
      { from: 'router', to: 's2', label: 'single-shard query', dashed: false },
      { from: 'router', to: 's3', label: 'single-shard query', dashed: false },
      { from: 'router', to: 's4', label: 'single-shard query', dashed: false },
      { from: 'router', to: 's5', label: 'after rebalance', dashed: true },
      { from: 'router', to: 'merger', label: 'no shard key: scatter', dashed: true },
      { from: 's1', to: 'merger', label: 'partial rows', dashed: true },
      { from: 's2', to: 'merger', label: 'partial rows', dashed: true },
      { from: 's3', to: 'merger', label: 'partial rows', dashed: true },
      { from: 's4', to: 'merger', label: 'partial rows', dashed: true },
      { from: 'merger', to: 'api', label: 'merged page', dashed: false },
      { from: 'rebalancer', to: 's5', label: 'copy rows', dashed: false },
      { from: 'rebalancer', to: 'map', label: 'flip ownership', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'country', type: 'char(2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'orders',
        name: 'orders (on every shard)',
        columns: [
          { name: 'order_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'country', type: 'char(2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'total_cents', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id, created_at DESC) — the shard key first, so "my orders" reads one shard'],
      },
      {
        id: 'shard_map',
        name: 'shard_map',
        columns: [
          { name: 'bucket', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'shard_id', type: 'int', pk: false, fk: 'shards.shard_id', nullable: false, unique: false },
          { name: 'version', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'shards',
        name: 'shards',
        columns: [
          { name: 'shard_id', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'dsn', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'state', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'shards', to: 'shard_map', kind: 'one-to-many', label: 'owns buckets' },
      { from: 'users', to: 'orders', kind: 'one-to-many', label: 'places' },
    ],
  },
  explanation: {
    title: 'Database Sharding',
    summary:
      'Sharding splits one large table into pieces (shards) and puts each piece on its own database server. A shard key decides which shard owns a row, and a router sends each query to the right shard. It lets storage and write traffic grow beyond one machine, at the price of harder queries, joins and transactions.',
    sections: [
      {
        heading: 'Overview',
        body: 'One database server can only hold so much data and take so many writes. You can buy a bigger server (vertical scaling), add read replicas (which help reads, not writes or storage), or split the data (horizontal partitioning, which is sharding).\n\nEach shard is a full database with the same schema holding a different slice of the rows. For an orders table, the slice might be "all orders of users whose id hashes to 2". Which column picks the slice is the shard key. Everything else follows from that choice: if a query contains the shard key it goes to one shard; if not, it has to ask them all.',
      },
      {
        heading: 'Requirements',
        body: '- Data and write load spread evenly, so no shard is the bottleneck.\n- The most common queries (for example, "this user\'s orders") touch a single shard.\n- A shard can be added or retired without downtime and without moving most of the data.\n- Every router agrees on which shard owns a key, even during a move.\n- A failure takes out one slice of users, not all of them.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 5 billion orders a year at about 500 bytes a row.\n- Storage: 5,000,000,000 × 500 B = 2.5 TB a year, so 12.5 TB over 5 years.\n- Write rate: 5,000,000,000 ÷ 31,536,000 s ≈ 159 orders a second on average. Assume peaks of 10×, about 1,600 a second.\n- Shard count: a shard kept under 2 TB (so backups and restores stay quick) needs at least 12.5 ÷ 2 = 6.25, so 7 shards; running at half full for headroom needs 13, so 16 (a power of two, which keeps bucket maths easy).\n- Each of 16 shards then holds about 0.8 TB and takes about 100 writes a second at peak.\n- Scatter queries: if each shard is slow 1% of the time, a query over 4 shards waits on a slow one in 1 - 0.99^4 = 3.9% of requests; over 16 shards, 14.9%.',
      },
      {
        heading: 'Step by step',
        body: '1. The App Client sends a request, for example "place an order" or "list my orders".\n2. The API Server passes the query and its shard key value to the Shard Router (key → shard).\n3. The Shard Router (key → shard) asks the Shard Map (config store) which shard owns that key (or computes it from a formula).\n4. If the query has the shard key, the router sends it to one shard: Shard 1, Shard 2, Shard 3 or Shard 4.\n5. If it does not, the router sends it to every shard, and the Result Merger combines the partial rows into one page.\n6. The Result Merger returns the merged page to the API Server.\n7. When space runs low, the Rebalancer copies a slice of rows to Shard 5 while writes continue.\n8. The Rebalancer flips ownership in the Shard Map (config store); routers pick up the new map and the old rows are deleted.',
      },
      {
        heading: 'Components',
        body: '- App Client: the phone or browser that places and reads orders.\n- API Server: stateless service that holds the business logic and passes the shard key to the router.\n- Shard Router (key → shard): a library or proxy that turns a shard key into a shard and runs the query there.\n- Shard Map (config store): the source of truth for who owns what: a table or a strongly consistent store such as etcd, with a version number.\n- Shard 1: a database holding one slice of the orders (with its own replicas for failover).\n- Shard 2: same schema, a different slice of the rows.\n- Shard 3: same schema, a different slice; it fails and recovers on its own.\n- Shard 4: same schema, a different slice; if it is much busier than the others, the shard key is a poor one.\n- Shard 5: the shard added later, which starts empty and receives a share of the rows.\n- Result Merger: collects partial results from scatter queries, sorts, limits and returns one page.\n- Rebalancer: background job that copies rows to a new shard, verifies them and flips the Shard Map.',
      },
      {
        heading: 'Key decisions',
        body: '- Shard key: pick a column with many distinct values, even load and presence in the main queries. For orders, user_id is usually right: "my orders" is one shard. A country key has 8 values and one is 40% of orders; a time key sends every new write to the newest shard.\n- Placement strategy: hash (even, but no ordering), range (ordered scans, but hot spots), or a directory (any placement, but a lookup table to run). See the simulator.\n- Hash mod N or buckets: mod N is a one-line formula but moves about 80% of rows going from 4 to 5 shards. Hashing into many fixed buckets (64, or 1,024) and mapping buckets to shards moves only the buckets you hand over. Consistent hashing is the same idea on a ring.\n- Joins and transactions: keep rows that are queried together on the same shard (shard orders by user_id, not order_id). A transaction across shards needs two-phase commit or a saga, both costly.\n- Global ids: with no single auto-increment, use ids that are unique across shards (Snowflake-style) and, ideally, carry the shard in them.\n- Resharding in advance: start with many more buckets than shards (for example 1,024 buckets on 4 servers) so growth is moving buckets, never re-cutting data.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Hot shard: one shard that gets much more load than the rest. Fix with a better key, splitting that shard, or putting a cache in front. A single very heavy user (a celebrity account) stays on one shard whatever the hash.\n- Shard failure: replicate each shard (a primary and replicas) so a failure is a failover, and only that slice of users is affected meanwhile.\n- Cross-shard queries: reports and searches that ignore the shard key hit all shards. Send them to a read replica, a warehouse or a search index instead of production shards.\n- Moving data safely: copy, then double-write, verify, then flip the Shard Map and delete later. Never move rows and change the map in one step.\n- Stale maps: a router with an old map writes to the wrong shard. Version the map and have shards reject requests for slices they no longer own.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you choose a shard key for a chat app, for a social network, for a multi-tenant SaaS?\n- Why is hash mod N a bad way to place keys when you add a shard?\n- What is a hot shard and how do you find and fix one?\n- How do you run a join or a transaction across two shards?\n- How do you add shards with no downtime?\n- When would you not shard at all?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Route a key with fixed buckets (TypeScript)',
        language: 'typescript',
        source: `import { createHash } from 'node:crypto'

const BUCKETS = 1024 // far more buckets than shards, fixed for the life of the system

// bucket → shard id, loaded from the shard map and refreshed when its version changes.
let bucketToShard: number[] = Array.from({ length: BUCKETS }, (_, b) => b % 4)

export function bucketOf(userId: number): number {
  const h = createHash('md5').update(String(userId)).digest().readUInt32BE(0)
  return h % BUCKETS
}

export function shardFor(userId: number): number {
  return bucketToShard[bucketOf(userId)]
}

// Adding a shard only changes entries in bucketToShard; no key is ever re-hashed.`,
      },
      {
        title: 'Scatter-gather when there is no shard key (Python)',
        language: 'python',
        source: `import asyncio, heapq

async def newest_shipped(shards, limit=20):
    # Ask every shard for its own newest rows, in parallel.
    parts = await asyncio.gather(*[
        s.fetch("SELECT * FROM orders WHERE status = 'shipped' "
                "ORDER BY created_at DESC LIMIT $1", limit)
        for s in shards
    ])
    # Merge the already-sorted lists and keep the global newest 'limit'.
    merged = heapq.merge(*parts, key=lambda r: r["created_at"], reverse=True)
    return list(merged)[:limit]`,
      },
      {
        title: 'Per-shard table and the index that matters (SQL)',
        language: 'sql',
        source: `-- Same DDL on every shard.
CREATE TABLE orders (
  order_id    text PRIMARY KEY,           -- unique across shards (e.g. Snowflake-style)
  user_id     bigint NOT NULL,            -- the shard key
  country     char(2) NOT NULL,
  created_at  timestamptz NOT NULL,
  status      text NOT NULL,
  total_cents int NOT NULL
);

-- Shard key first: "my orders, newest first" is one index range scan on one shard.
CREATE INDEX orders_user_created ON orders (user_id, created_at DESC);`,
      },
      {
        title: 'Shard map as a table (SQL)',
        language: 'sql',
        source: `-- Owned by a small, strongly consistent database or etcd.
CREATE TABLE shard_map (
  bucket   int PRIMARY KEY,
  shard_id int NOT NULL,
  version  int NOT NULL
);

-- Cutover for one bucket after the Rebalancer has copied and verified its rows:
UPDATE shard_map SET shard_id = 5, version = version + 1 WHERE bucket = 12;`,
      },
    ],
    related: ['Consistent hashing', 'Read replicas', 'Replication', 'Two-phase commit', 'Unique ID generator', 'Vertical partitioning'],
  },
  simulator,
}
