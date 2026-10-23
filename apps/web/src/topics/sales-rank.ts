import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design Amazon's sales ranking by category feature" in the System
// Design Primer by Donne Martin (CC BY 4.0). Requirements, estimates and the
// batch MapReduce design follow the primer; the walkthrough, simulator, code and
// the freshness trade-off are Structura's.

/** Units sold in the past week, per product. Realistic, hand-written example data. */
const CATALOG: Record<string, { category: string; id: string; sold: number }> = {
  'Sony WH-1000XM5': { category: 'Headphones', id: 'B09XS7JWHH', sold: 8420 },
  'Bose QuietComfort Ultra': { category: 'Headphones', id: 'B0CCZ1L489', sold: 7110 },
  'Apple AirPods Max': { category: 'Headphones', id: 'B08PZHYWJS', sold: 5935 },
  'JBL Tune 760NC': { category: 'Headphones', id: 'B08KDLQ8SX', sold: 1980 },
  'Anker Soundcore Q30': { category: 'Headphones', id: 'B07Q9MJKBV', sold: 1655 },
  'Atomic Habits': { category: 'Books', id: '0735211299', sold: 9310 },
  'Project Hail Mary': { category: 'Books', id: '0593135202', sold: 6240 },
  'Designing Data-Intensive Applications': { category: 'Books', id: '1449373321', sold: 2875 },
  'The Pragmatic Programmer': { category: 'Books', id: '0135957052', sold: 2410 },
  'System Design Interview': { category: 'Books', id: 'B08CMF2CQF', sold: 2290 },
}

const REFRESH_HOURS: Record<string, number> = { 'Every hour': 1, 'Every 6 hours': 6, 'Once a day': 24 }

const fmt = (n: number) => n.toLocaleString('en-US')

/** Top of a category by units sold, highest first (ties broken by product id for a stable order). */
function ranking(category: string, extra: Record<string, number> = {}) {
  return Object.entries(CATALOG)
    .filter(([, p]) => p.category === category)
    .map(([name, p]) => ({ name, id: p.id, sold: p.sold + (extra[name] ?? 0) }))
    .sort((a, b) => b.sold - a.sold || a.id.localeCompare(b.id))
}

const table = (rows: ReturnType<typeof ranking>) =>
  rows.map((r, i) => `${String(i + 1).padStart(2)}. ${r.name.padEnd(38)} ${fmt(r.sold).padStart(6)} units`).join('\n')

const simulator: Simulator = {
  fields: [
    { id: 'product', label: 'Product', options: Object.keys(CATALOG) },
    { id: 'units', label: 'Units bought in one big order', options: ['1', '500', '2000', '6000'] },
    { id: 'refresh', label: 'How often the ranking is recomputed', options: Object.keys(REFRESH_HOURS) },
    { id: 'action', label: 'What happens', options: ['Place the order', 'Someone opens the category ranking'] },
  ],
  defaults: { product: 'Apple AirPods Max', units: '2000', refresh: 'Every hour', action: 'Place the order' },
  run({ product, units, refresh, action }) {
    const name = CATALOG[product] ? product : 'Apple AirPods Max'
    const p = CATALOG[name]
    const n = Math.max(1, Number.parseInt(units, 10) || 1)
    const hours = REFRESH_HOURS[refresh] ?? 1
    const before = ranking(p.category)
    const after = ranking(p.category, { [name]: n })
    const rankBefore = before.findIndex((r) => r.name === name) + 1
    const rankAfter = after.findIndex((r) => r.name === name) + 1
    const moved = rankBefore - rankAfter
    const orderId = 'ord_7f3a91'
    const steps: Trace['steps'] = []

    if (action === 'Place the order') {
      steps.push(
        { text: `A shopper buys ${fmt(n)} × ${name}. The Client sends the purchase to the Web Server, which forwards it to the Purchase API.`, nodes: ['Client', 'Web Server', 'Purchase API'], data: `POST /api/v1/orders\n${json({ product_id: p.id, quantity: n, buyer_id: 48213 })}` },
        { text: 'The Purchase API saves the order in the Orders Database. That row is the source of truth for money and stock; the ranking is only a report built from it.', nodes: ['Purchase API', 'Orders Database'], data: `INSERT INTO orders (order_id, product_id, category_id, quantity, total_price)\nVALUES ('${orderId}', '${p.id}', '${p.category.toLowerCase()}', ${n}, …);` },
        { text: 'The Purchase API also appends one line to the Transaction Log Files. Appending is cheap, and a batch job can read these files later without touching the live database.', nodes: ['Purchase API', 'Transaction Log Files'], data: `s3://sales-logs/2026-10-23/14/part-0042.tsv\n${p.id}\t${p.category.toLowerCase()}\t${n}\t2026-10-23T14:07:31Z` },
        { text: `The ranking does not change yet. The Batch Scheduler starts the Sales Rank Service ${refresh.toLowerCase()}, so on average this order takes ${hours / 2} hour${hours / 2 === 1 ? '' : 's'} to show up, and in the worst case ${hours}.`, nodes: ['Batch Scheduler', 'Sales Rank Service'], data: `refresh = ${refresh.toLowerCase()}\nexpected delay ≈ ${hours / 2} h, worst case ${hours} h` },
        { text: `At the next run, map reads the log files and emits ((${p.category.toLowerCase()}, ${name}), quantity). Reduce adds them up: ${name} goes from ${fmt(p.sold)} to ${fmt(p.sold + n)} units this week.`, nodes: ['Sales Rank Service', 'Transaction Log Files'], data: `map    → (("${p.category.toLowerCase()}", "${name}"), ${n})\nreduce → (("${p.category.toLowerCase()}", "${name}"), ${fmt(p.sold + n)})` },
        { text: moved > 0 ? `Sorting the ${p.category} totals moves ${name} from rank ${rankBefore} to rank ${rankAfter}, up ${moved} place${moved === 1 ? '' : 's'}.` : `Sorting the ${p.category} totals leaves ${name} at rank ${rankAfter}: ${rankAfter === 1 ? 'it is already first' : 'the order was not big enough to pass the product above'}.`, nodes: ['Sales Rank Service'], data: table(after) },
        { text: 'The service writes the finished table to the Analytics Database, replacing the old rows for that category. Only now is the order visible to readers.', nodes: ['Sales Rank Service', 'Analytics Database'], data: `UPDATE sales_rank SET total_sold = ${fmt(p.sold + n).replace(/,/g, '')}, rank = ${rankAfter}\nWHERE category_id = '${p.category.toLowerCase()}' AND product_id = '${p.id}';` },
      )
      return { input: `${fmt(n)} × ${name} ordered, ranking recomputed ${refresh.toLowerCase()}`, steps }
    }

    steps.push(
      { text: `A shopper opens the ${p.category} bestsellers. The Client asks the Web Server, which forwards it to the Read API.`, nodes: ['Client', 'Web Server', 'Read API'], data: `GET /api/v1/categories/${p.category.toLowerCase()}/bestsellers?window=7d` },
      { text: 'The Read API looks in the Memory Cache first. About 100 reads happen for every purchase, so almost every request ends here.', nodes: ['Read API', 'Memory Cache (Redis)'], data: `GET rank:${p.category.toLowerCase()}:7d\n→ hit (written by the last batch run)` },
      { text: 'On a miss, for example just after the cache restarts, the Read API reads the sorted rows from the Analytics Database and puts them back in the cache.', nodes: ['Read API', 'Analytics Database'], data: `SELECT product_id, total_sold FROM sales_rank\nWHERE category_id = '${p.category.toLowerCase()}'\nORDER BY total_sold DESC LIMIT 5;` },
      { text: `The list the shopper sees comes from the last batch run, not from this second. Orders from the past ${hours === 1 ? 'hour' : hours + ' hours'} are not in it yet, which is the price of recomputing ${refresh.toLowerCase()}.`, nodes: ['Read API', 'Client'], data: table(before) },
    )
    return { input: `Someone opens the ${p.category} ranking (recomputed ${refresh.toLowerCase()})`, steps }
  },
}

export const salesRank: StaticTopic = {
  difficulty: 'Intermediate',
  kind: 'static',
  id: 'sales-rank',
  title: "Amazon's Sales Rank by Category",
  blurb: 'Batch MapReduce over transaction logs, a ranked table, and a cache in front',
  adaptedFrom: {
    title: "Design Amazon's sales ranking by category feature",
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/sales_rank/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: [
    'primer-design-amazons-sales-ranking-by-category-feature',
    'primer-cache',
    'primer-asynchronism',
    'primer-database',
    'top-5-caching-strategies',
  ],
  takeaways: [
    'A ranking is a report, not a transaction: build it from a log of sales, away from the live order path.',
    'MapReduce fits: map each sale to a (category, product) key, reduce by summing, then sort per category.',
    'Reads outnumber purchases about 100 to 1, so serve the finished table from a cache.',
    'How often you recompute is a freshness trade-off: hourly is fresh but costly, daily is cheap but stale.',
    'Append-only log files keep the batch job from touching the orders database.',
    'Hot categories and viral products skew the reduce step; split the heavy keys across reducers.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'api', label: 'API servers' },
      { id: 'batch', label: 'Ranking batch' },
      { id: 'data', label: 'Storage' },
    ],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'web', label: 'Web Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'purchase', label: 'Purchase API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'read', label: 'Read API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'scheduler', label: 'Batch Scheduler', shape: 'rectangle', color: 'orange', group: 'batch' },
      { id: 'rank', label: 'Sales Rank Service', shape: 'rectangle', color: 'orange', group: 'batch' },
      { id: 'logs', label: 'Transaction Log Files', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'orders', label: 'Orders Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'analytics', label: 'Analytics Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'cache', label: 'Memory Cache (Redis)', shape: 'rectangle', color: 'red', group: 'data' },
    ],
    edges: [
      { from: 'client', to: 'web', label: 'HTTPS', dashed: false },
      { from: 'web', to: 'purchase', label: 'POST /orders', dashed: false },
      { from: 'web', to: 'read', label: 'GET /bestsellers', dashed: false },
      { from: 'purchase', to: 'orders', label: 'order row', dashed: false },
      { from: 'purchase', to: 'logs', label: 'append sale', dashed: false },
      { from: 'scheduler', to: 'rank', label: 'start run', dashed: true },
      { from: 'rank', to: 'logs', label: 'map + reduce', dashed: false },
      { from: 'rank', to: 'analytics', label: 'write ranked table', dashed: false },
      { from: 'read', to: 'cache', label: 'lookup', dashed: false },
      { from: 'read', to: 'analytics', label: 'on a miss', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'orders',
        name: 'orders',
        columns: [
          { name: 'order_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'product_id', type: 'text', pk: false, fk: 'products.product_id', nullable: false, unique: false },
          { name: 'category_id', type: 'text', pk: false, fk: 'categories.category_id', nullable: false, unique: false },
          { name: 'seller_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'buyer_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'quantity', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'total_price', type: 'numeric(10,2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(buyer_id, created_at DESC) — order history'],
      },
      {
        id: 'products',
        name: 'products',
        columns: [
          { name: 'product_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'category_id', type: 'text', pk: false, fk: 'categories.category_id', nullable: false, unique: false },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'categories',
        name: 'categories',
        columns: [
          { name: 'category_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: [],
      },
      {
        id: 'sales_rank',
        name: 'sales_rank',
        columns: [
          { name: 'category_id', type: 'text', pk: true, fk: 'categories.category_id', nullable: false, unique: false },
          { name: 'product_id', type: 'text', pk: true, fk: 'products.product_id', nullable: false, unique: false },
          { name: 'total_sold', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'rank', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'computed_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(category_id, total_sold DESC) — top N for a category'],
      },
    ],
    relations: [
      { from: 'orders', to: 'products', kind: 'one-to-many', label: 'of product' },
      { from: 'products', to: 'categories', kind: 'one-to-many', label: 'in category' },
      { from: 'sales_rank', to: 'products', kind: 'one-to-many', label: 'ranks' },
    ],
  },
  explanation: {
    title: "Amazon's Sales Rank by Category",
    summary:
      'Each category shows its bestsellers for the past week. Purchases are appended to log files, a batch MapReduce job adds them up per category and product on a schedule, and the sorted result is stored in an analytics table and cached. Shoppers read the finished table, so reading is fast and the order path is untouched.',
    sections: [
      {
        heading: 'Overview',
        body: 'A sales rank answers "what sells best in Headphones this week?". It is not part of buying something, and a rank that is a little out of date harms nobody. That frees the design from the live order path:\n- Writes: a purchase goes to the orders database and is appended to a log file.\n- Computing: a scheduled batch job turns the logs into one ranked list per category.\n- Reads: shoppers get that list from a cache, almost always without touching a database.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- The service computes the past week\'s most popular products by category.\n- A user views the ranked products of a category.\n- Purchases must not slow down.\n- High availability.\n\nOut of scope: overall rankings across all products, personalized ranking, and showing real-time results.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions from the System Design Primer:\n- 10 million products in 1,000 categories.\n- 1 billion transactions a month and 100 billion read requests a month: 100 reads per purchase.\n\nWhich works out to:\n- About 40 bytes per transaction (product id 8, category id 4, seller id 8, buyer id 8, quantity 4, price 5, time 5 = 42 bytes). That is 42 GB of new data a month, 1.5 TB in three years.\n- About 400 purchases per second and 40,000 reads per second.\n- 10,000 products per category on average, so one category ranking is small.\n\nHandy rule: 2.5 million seconds in a month, so 1 billion a month ≈ 400 a second.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client sends an order to the Web Server, which forwards it to the Purchase API.\n2. The Purchase API saves the order in the Orders Database.\n3. It also appends the sale to the Transaction Log Files.\n4. The Batch Scheduler starts the Sales Rank Service on a schedule.\n5. The Sales Rank Service maps and reduces the Transaction Log Files into totals per category and product, then sorts each category.\n6. It writes the ranked table to the Analytics Database.\n7. To read a ranking, the Client asks the Web Server, which forwards the request to the Read API.\n8. The Read API answers from the Memory Cache (Redis) and falls back to the Analytics Database on a miss.',
      },
      {
        heading: 'Components',
        body: '- Web Server: a reverse proxy in front of the API servers (TLS, routing).\n- Purchase API: records an order and appends the sale to the log.\n- Read API: serves category rankings, cache first.\n- Batch Scheduler: starts the ranking run every hour, six hours or day.\n- Sales Rank Service: the MapReduce job: map to (category, product), reduce by summing, then sort.\n- Transaction Log Files: append-only sale records in cheap object storage, partitioned by hour.\n- Orders Database: the source of truth for orders, used by checkout and not by the ranking.\n- Analytics Database: the sales_rank table, indexed on (category, total sold).\n- Memory Cache (Redis): the top of each category\'s ranking, rewritten after every run.',
      },
      {
        heading: 'Key decisions',
        body: '- Batch, not real time. Counting every sale as it happens needs a stream processor and very hot counters. A batch job over logs is simple and cheap, and a rank that is minutes old is fine.\n- Logs, not the orders table. Scanning a week of orders would compete with checkout. Log files can be read in parallel with no effect on it.\n- How often to recompute. Hourly gives a worst-case delay of 1 hour; daily costs 24 times fewer runs but can show a bestseller list up to a day old. Pick by how much the business cares.\n- Replace rows, don\'t update in place: write the new table beside the old one and swap, so readers never see a half-sorted list.\n- Cache the top of each category, not every product.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Skew. One viral product or one huge category sends most records to a single reducer. Split a hot key across reducers (add a random suffix), then merge the partial sums.\n- A failed run is harmless: the old table keeps serving, and the next run reads the same logs.\n- Make the job idempotent: the same logs always give the same table.\n- The Analytics Database serves a few misses, so one replica is enough at first. Add read replicas, then a NoSQL store or sharding by category if needed.\n- Old log files move to cold storage after the window passes.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you show "sales in the last hour" instead of the last week?\n- How do you keep a rolling 7-day window when the job runs every hour?\n- A product is in several categories. What changes in the map step?\n- How would you stop a seller from gaming the rank with fake orders?\n- When does a stream processor beat the batch job?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'MapReduce job (Python)',
        language: 'python',
        source: `from collections import defaultdict

def map_sale(line):
    # one log line: product_id, category, quantity, timestamp
    product_id, category, quantity, _ = line.rstrip("\\n").split("\\t")
    yield (category, product_id), int(quantity)

def reduce_totals(pairs):
    totals = defaultdict(int)
    for key, quantity in pairs:  # in a real cluster, the shuffle groups equal keys
        totals[key] += quantity
    return totals

def rank(totals):
    by_category = defaultdict(list)
    for (category, product_id), sold in totals.items():
        by_category[category].append((sold, product_id))
    # highest sales first; product id breaks ties so runs are repeatable
    return {c: sorted(rows, key=lambda r: (-r[0], r[1])) for c, rows in by_category.items()}`,
      },
      {
        title: 'Read path with cache',
        language: 'typescript',
        source: `import Redis from 'ioredis'
import { db } from './db'

const redis = new Redis()

/** Top N for a category: cache first, table on a miss. */
export async function bestsellers(category: string, n = 20) {
  const key = \`rank:\${category}:7d\`
  const hit = await redis.get(key)
  if (hit) return JSON.parse(hit).slice(0, n)

  const { rows } = await db.query(
    'SELECT product_id, total_sold FROM sales_rank WHERE category_id = $1 ORDER BY total_sold DESC LIMIT 100',
    [category],
  )
  await redis.set(key, JSON.stringify(rows), 'EX', 3600) // the next batch run overwrites it anyway
  return rows.slice(0, n)
}`,
      },
      {
        title: 'The ranked table',
        language: 'sql',
        source: `-- Written by the batch job; readers only ever SELECT.
CREATE TABLE sales_rank (
  category_id text   NOT NULL,
  product_id  text   NOT NULL,
  total_sold  bigint NOT NULL,
  rank        int    NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (category_id, product_id)
);
CREATE INDEX ON sales_rank (category_id, total_sold DESC);

-- Top 5 for a category.
SELECT product_id, total_sold FROM sales_rank
WHERE category_id = 'headphones'
ORDER BY total_sold DESC LIMIT 5;`,
      },
    ],
    related: ['MapReduce', 'Batch processing', 'Redis', 'Data skew', 'Read replicas', 'Idempotency'],
  },
  simulator,
}
