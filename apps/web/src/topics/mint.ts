import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design Mint.com" in the System Design Primer by Donne Martin
// (CC BY 4.0). The requirements, the capacity estimates and the shape of the
// design (extraction service, queue, category and budget services) follow the
// primer; the walkthrough, simulator, schema and code are Structura's.

interface Merchant {
  merchant: string
  amount: number
  /** What the seller-to-category lookup answers for this merchant. */
  category: string
}

const MERCHANTS: Record<string, Merchant> = {
  'Starbucks, $12.40': { merchant: 'STARBUCKS #4412', amount: 12.4, category: 'Food & Dining' },
  'Uber, $41.80': { merchant: 'UBER *TRIP', amount: 41.8, category: 'Transportation' },
  'Netflix, $9.99': { merchant: 'NETFLIX.COM', amount: 9.99, category: 'Entertainment' },
}

/** Monthly budgets in dollars, with what is already spent this month. */
const BUDGETS: Record<string, { limit: number; spent: number }> = {
  'Food & Dining': { limit: 200, spent: 164.2 },
  Transportation: { limit: 120, spent: 78.5 },
  Entertainment: { limit: 40, spent: 24.99 },
  'Work expenses': { limit: 300, spent: 120 },
}

/** A budget alert goes out when spending crosses this share of the limit. */
const WARN_AT = 0.8
const OVERRIDE = 'Pin this seller to "Work expenses"'

const usd = (n: number) => `$${n.toFixed(2)}`

const simulator: Simulator = {
  fields: [
    { id: 'transaction', label: 'New purchase', options: Object.keys(MERCHANTS) },
    { id: 'override', label: 'Category rule', options: ['Use the default category', OVERRIDE] },
    { id: 'account', label: 'Linked account', options: ['Active user (logged in this week)', 'Inactive user (no login for 45 days)'] },
  ],
  defaults: { transaction: 'Starbucks, $12.40', override: 'Use the default category', account: 'Active user (logged in this week)' },
  run({ transaction, override, account }) {
    const t = MERCHANTS[transaction] ?? MERCHANTS['Starbucks, $12.40']
    const active = !account.startsWith('Inactive')
    const pinned = override === OVERRIDE
    const category = pinned ? 'Work expenses' : t.category
    const budget = BUDGETS[category]
    const after = Math.round((budget.spent + t.amount) * 100) / 100
    const share = after / budget.limit
    const pct = (share * 100).toFixed(1)
    const steps: Trace['steps'] = []

    steps.push({
      text: active
        ? 'The user opened the app this week, so the Transaction Extraction Service syncs their linked account often (here, a pull right now). It signs in to the bank through the Bank APIs and downloads what is new.'
        : 'The user has not logged in for 45 days. The Transaction Extraction Service still syncs them, but only in the slow nightly batch, so active users are never stuck behind them.',
      nodes: ['Transaction Extraction Service', 'Bank APIs'],
      data: `GET /accounts/chk-8841/transactions?since=2026-10-19T02:00:00Z\n(${active ? 'priority queue: every 15 min' : 'low-priority batch: once a day at 02:00'})`,
    })
    if (!active) {
      steps.push({
        text: 'The new purchase waits for the nightly run. The user is not looking at the app, so a late alert costs nothing, and the bank\'s rate limit is kept for people who are.',
        nodes: ['Transaction Extraction Service', 'Message Queue'],
        data: `enqueue(low) { account: "chk-8841", merchant: "${t.merchant}", amount: ${t.amount} }`,
      })
    } else {
      steps.push({
        text: 'Each new transaction is put on the Message Queue as an event. The queue absorbs bursts (every salary day, every bank at once) and lets the next services work at their own pace.',
        nodes: ['Transaction Extraction Service', 'Message Queue'],
        data: json({ account: 'chk-8841', merchant: t.merchant, amount: t.amount, posted: '2026-10-20' }),
      })
    }
    steps.push({
      text: pinned
        ? `The Category Service looks up the seller. The default for ${t.merchant} is "${t.category}", but this user pinned the seller to "Work expenses", and a user rule always wins over the default.`
        : `The Category Service looks up the seller in its seller-to-category table: ${t.merchant} is "${t.category}". Unknown sellers fall back to "Uncategorized" and can be fixed by the user.`,
      nodes: ['Message Queue', 'Category Service'],
      data: `seller_category["${t.merchant}"] → "${t.category}"\nuser_override(user 7, "${t.merchant}") → ${pinned ? '"Work expenses"' : 'none'}\ncategory = "${category}"`,
    })
    steps.push({
      text: 'The categorized transaction is written to the Transactions Database. Writes arrive at a steady, predictable rate because they come off the queue, not straight from users.',
      nodes: ['Category Service', 'Transactions Database'],
      data: `INSERT INTO transactions (account_id, posted_at, merchant, amount_cents, category)\nVALUES ('chk-8841', '2026-10-20', '${t.merchant}', ${Math.round(t.amount * 100)}, '${category}');`,
    })
    steps.push({
      text: `The Budget Service adds the amount to this month's total for "${category}": ${usd(budget.spent)} + ${usd(t.amount)} = ${usd(after)} of ${usd(budget.limit)}, which is ${pct}%. The running totals live in the Memory Cache (Redis), so the next page load is one read.`,
      nodes: ['Category Service', 'Budget Service', 'Memory Cache (Redis)'],
      data: `HINCRBYFLOAT budget:7:2026-10 "${category}" ${t.amount}\n→ ${after}\nlimit ${budget.limit} → ${pct}% used`,
    })
    const over = share >= 1
    const warn = share >= WARN_AT
    if (!warn) {
      steps.push({
        text: `${pct}% is under the ${WARN_AT * 100}% alert line, so nothing is sent. The Budget Service has finished with this transaction.`,
        nodes: ['Budget Service'],
        data: `${pct}% < ${WARN_AT * 100}% → no notification`,
      })
    } else if (!active) {
      steps.push({
        text: `The budget is at ${pct}%, which would normally trigger an alert. This user is inactive, so the Notification Service batches it into the weekly digest instead of pushing a message.`,
        nodes: ['Budget Service', 'Notification Service'],
        data: `${pct}% ≥ ${WARN_AT * 100}% but user inactive → add to weekly digest`,
      })
    } else {
      steps.push({
        text: over
          ? `The budget is blown: ${usd(after)} against a ${usd(budget.limit)} limit (${pct}%). The Budget Service asks the Notification Service for an "over budget" alert, sent by push and email.`
          : `The budget crossed the ${WARN_AT * 100}% line (${pct}%). The Budget Service asks the Notification Service for a "close to your limit" alert.`,
        nodes: ['Budget Service', 'Notification Service'],
        data: json({ to: 'user 7', channel: ['push', 'email'], title: over ? `Over budget: ${category}` : `Nearly there: ${category}`, body: `${usd(after)} of ${usd(budget.limit)} spent (${pct}%)` }),
      })
    }
    steps.push({
      text: 'Later the user opens the app. The Read API serves the dashboard from the Memory Cache (Redis) totals and a short query on the Transactions Database, so reading never waits on a bank.',
      nodes: ['Client', 'Web Server', 'Read API', 'Memory Cache (Redis)'],
      data: `GET /api/v1/budgets?month=2026-10\n→ ${json({ [category]: { spent: after, limit: budget.limit, percent: Number(pct) } })}`,
    })
    return { input: `${transaction}${pinned ? ', pinned to Work expenses' : ''}, ${active ? 'active' : 'inactive'} user`, steps }
  },
}

export const mint: StaticTopic = {
  difficulty: 'Intermediate',
  kind: 'static',
  id: 'mint',
  title: 'Mint: Personal Finance Aggregator',
  blurb: 'Pulling bank transactions through a queue, then categorizing and budgeting them',
  adaptedFrom: {
    title: 'Design Mint.com',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/mint/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: ['primer-design-mintcom', 'primer-asynchronism', 'primer-cache'],
  takeaways: [
    'Pull data from banks in a separate extraction service, never inside the user\'s request.',
    'Put each new transaction on a queue, so bursts are absorbed and every stage works at its own pace.',
    'Sync active users often and inactive users in a slow nightly batch, so the bank rate limits go where they matter.',
    'Categorize with a seller-to-category table, and let the user\'s own rule win over the default.',
    'Keep running budget totals in memory, so the dashboard is one cache read instead of a month of sums.',
    'Writes outnumber reads 10 to 1 here, so the write path (about 2,000 a second) is the one to design around.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'api', label: 'API servers' },
      { id: 'pipeline', label: 'Transaction pipeline' },
      { id: 'data', label: 'Storage' },
    ],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'web', label: 'Web Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'accountsapi', label: 'Accounts API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'readapi', label: 'Read API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'banks', label: 'Bank APIs', shape: 'cloud', color: 'grey', group: null },
      { id: 'extract', label: 'Transaction Extraction Service', shape: 'rectangle', color: 'orange', group: 'pipeline' },
      { id: 'queue', label: 'Message Queue', shape: 'rectangle', color: 'yellow', group: 'pipeline' },
      { id: 'category', label: 'Category Service', shape: 'rectangle', color: 'light-violet', group: 'pipeline' },
      { id: 'budget', label: 'Budget Service', shape: 'rectangle', color: 'light-violet', group: 'pipeline' },
      { id: 'notify', label: 'Notification Service', shape: 'rectangle', color: 'yellow', group: 'pipeline' },
      { id: 'accountsdb', label: 'Accounts Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'txdb', label: 'Transactions Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'cache', label: 'Memory Cache (Redis)', shape: 'rectangle', color: 'red', group: 'data' },
    ],
    edges: [
      { from: 'client', to: 'web', label: 'HTTPS', dashed: false },
      { from: 'web', to: 'accountsapi', label: 'link account', dashed: false },
      { from: 'web', to: 'readapi', label: 'GET /budgets', dashed: false },
      { from: 'accountsapi', to: 'accountsdb', label: 'credentials, tokens', dashed: false },
      { from: 'accountsapi', to: 'extract', label: 'first sync', dashed: true },
      { from: 'extract', to: 'accountsdb', label: 'who to sync', dashed: true },
      { from: 'extract', to: 'banks', label: 'pull transactions', dashed: false },
      { from: 'extract', to: 'queue', label: 'new transactions', dashed: false },
      { from: 'queue', to: 'category', label: 'consume', dashed: false },
      { from: 'category', to: 'txdb', label: 'save categorized', dashed: false },
      { from: 'category', to: 'budget', label: 'update totals', dashed: false },
      { from: 'budget', to: 'cache', label: 'running totals', dashed: false },
      { from: 'budget', to: 'notify', label: 'over budget', dashed: true },
      { from: 'readapi', to: 'cache', label: 'budget totals', dashed: false },
      { from: 'readapi', to: 'txdb', label: 'recent transactions', dashed: false },
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
          { name: 'email', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'last_login_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'accounts',
        name: 'accounts',
        columns: [
          { name: 'account_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'bank', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'access_token', type: 'bytea', pk: false, fk: null, nullable: false, unique: false },
          { name: 'last_synced_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(user_id) — a user\'s accounts', '(last_synced_at) — pick who to sync next'],
      },
      {
        id: 'transactions',
        name: 'transactions',
        columns: [
          { name: 'transaction_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'account_id', type: 'bigint', pk: false, fk: 'accounts.account_id', nullable: false, unique: false },
          { name: 'bank_ref', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'posted_at', type: 'date', pk: false, fk: null, nullable: false, unique: false },
          { name: 'merchant', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'amount_cents', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'category', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['UNIQUE (account_id, bank_ref) — ignore repeats', '(account_id, posted_at DESC) — recent transactions'],
      },
      {
        id: 'budgets',
        name: 'budgets',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'category', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'monthly_limit_cents', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'seller_categories',
        name: 'seller_categories',
        columns: [
          { name: 'seller', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'category', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'accounts', to: 'users', kind: 'one-to-many', label: 'owns' },
      { from: 'transactions', to: 'accounts', kind: 'one-to-many', label: 'posted to' },
      { from: 'budgets', to: 'users', kind: 'one-to-many', label: 'sets' },
    ],
  },
  explanation: {
    title: 'Mint: Personal Finance Aggregator',
    summary:
      'Mint connects to a user\'s bank accounts, pulls their transactions, sorts each one into a category, and warns them when a monthly budget is close to its limit. The hard part is the pipeline: many slow, unreliable bank connections feeding a steady flow of writes. An extraction service, a queue, and small services for categories and budgets keep the user-facing side fast.',
    sections: [
      {
        heading: 'Overview',
        body: 'The user does three things: link a bank account, see where their money goes, and set budgets. Only the last two are fast reads. Everything that touches a bank is slow and can fail, so it never happens inside a user request.\n\nInstead a background pipeline does the work:\n- Pull new transactions from each bank.\n- Queue them.\n- Categorize them and save them.\n- Add them to the running budget totals and send an alert if needed.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A user connects a financial account.\n- The service extracts transactions from the account, on a schedule.\n- It categorizes transactions; the user can recategorize them.\n- It analyzes monthly spending by category.\n- It lets the user set a budget per category and sends a notification when they are about to go over.\n- High availability.\n\nOut of scope: investments, bill pay and credit scores.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions from the System Design Primer:\n- 10 million users with 30 million financial accounts, so 3 accounts each.\n- 5 billion transactions a month, about 167 per account.\n- 500 million read requests a month: a 10 to 1 write-to-read ratio, because most users open the app rarely.\n\nWhich works out to:\n- About 2,000 transactions written per second (5 billion over 2.5 million seconds in a month).\n- About 200 reads per second.\n- About 50 bytes per transaction: 250 GB of new data a month and 9 TB over three years.\n\nHandy rule: 400 requests per second is about 1 billion requests per month.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client links an account through the Web Server and the Accounts API, which stores the bank credentials in the Accounts Database.\n2. The Transaction Extraction Service pulls new transactions from the Bank APIs, and syncs active users more often than inactive ones.\n3. It puts each new transaction on the Message Queue.\n4. The Category Service takes transactions off the queue and picks a category from the seller, unless the user has a rule.\n5. It saves the result in the Transactions Database.\n6. The Budget Service adds the amount to the month\'s totals in the Memory Cache (Redis).\n7. If a budget is near or over its limit, the Budget Service asks the Notification Service to alert the user.\n8. To read, the Read API serves totals from the Memory Cache (Redis) and recent transactions from the Transactions Database.',
      },
      {
        heading: 'Components',
        body: '- Web Server: a reverse proxy in front of the API servers (TLS, routing).\n- Accounts API: links and unlinks accounts; stores bank tokens, encrypted.\n- Read API: serves the dashboard, budgets and transaction lists.\n- Bank APIs: the outside world. Slow, rate limited, sometimes down.\n- Transaction Extraction Service: logs in to banks and downloads new transactions, with a schedule per user activity.\n- Message Queue: holds new transactions between stages and absorbs bursts.\n- Category Service: maps a seller to a category, with the user\'s own rules first.\n- Budget Service: keeps the monthly totals and decides when to alert.\n- Notification Service: sends push and email, off its own queue.\n- Accounts Database: users, accounts, tokens and budgets (SQL).\n- Transactions Database: the ledger of categorized transactions (SQL).\n- Memory Cache (Redis): monthly totals per user and category.',
      },
      {
        heading: 'Key decisions',
        body: '- Pull, queue, process. Extraction talks to banks; everything after the queue only talks to our own systems. A slow bank delays only its own users.\n- Sync by activity. Active users are synced every few minutes; users who have not logged in for 30 days only in a nightly batch. That spends the bank rate limit where it is noticed.\n- Idempotent saves. Banks resend old transactions, so each row has a unique (account_id, bank_ref) and repeats are ignored. Totals are only updated for rows that were actually inserted.\n- Seller to category table. A simple lookup covers most sellers; the primer suggests a priority queue of sellers sorted by volume so the common ones are reviewed first. User rules override it.\n- Totals in memory. A month of sums per category is cheap to keep up to date at write time, and expensive to rebuild at read time.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The Transactions Database takes about 2,000 writes per second. Add read replicas for the dashboard, then shard by account_id.\n- Totals can be rebuilt from the Transactions Database at any time, so losing the Memory Cache (Redis) costs time, not data.\n- If a bank is down, only its accounts lag. Retry with growing delays and show a "last synced" time rather than an error.\n- Bank credentials are the most sensitive data in the system: encrypt them, keep them out of logs, and prefer revocable access tokens over passwords.\n- A poisoned or malformed transaction should move to a dead-letter queue, not block the queue behind it.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How do you avoid counting a transaction twice if the bank sends it again?\n- A user recategorizes a purchase from last month. What has to be recomputed?\n- How would you decide how often to sync each account?\n- How do you alert once at 80%, and not on every later purchase?\n- How would you shard the Transactions Database, and what does a cross-account query cost?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Idempotent save and budget update',
        language: 'sql',
        source: `-- A bank may resend a transaction: the unique key makes the repeat a no-op.
INSERT INTO transactions (account_id, bank_ref, posted_at, merchant, amount_cents, category)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (account_id, bank_ref) DO NOTHING
RETURNING transaction_id; -- no row back means a repeat: skip the budget update

-- Recent transactions on the dashboard: an index range scan.
SELECT merchant, amount_cents, category FROM transactions
WHERE account_id = $1 ORDER BY posted_at DESC LIMIT 25;`,
      },
      {
        title: 'Category lookup with user rules first',
        language: 'typescript',
        source: `type Rules = Map<string, string> // seller -> category chosen by this user

export function categorize(seller: string, userRules: Rules, sellerTable: Map<string, string>) {
  // A rule the user set always beats the shared default.
  return userRules.get(seller) ?? sellerTable.get(seller) ?? 'Uncategorized'
}`,
      },
      {
        title: 'Budget check with a one-time alert',
        language: 'typescript',
        source: `import Redis from 'ioredis'

const redis = new Redis()
const WARN_AT = 0.8

export async function addToBudget(userId: string, month: string, category: string, cents: number, limitCents: number) {
  const key = \`budget:\${userId}:\${month}\`
  const after = await redis.hincrby(key, category, cents) // integer cents: no float drift
  const before = after - cents
  // Alert only when this purchase crosses the line, not on every later one.
  const crossedWarn = before < limitCents * WARN_AT && after >= limitCents * WARN_AT
  const crossedLimit = before < limitCents && after >= limitCents
  return crossedLimit ? 'over' : crossedWarn ? 'warn' : null
}`,
      },
      {
        title: 'Sync schedule by activity',
        language: 'python',
        source: `from datetime import datetime, timedelta

def next_sync(last_login: datetime, last_sync: datetime, now: datetime) -> datetime:
    """Active users are pulled often; inactive ones once a day."""
    if now - last_login <= timedelta(days=30):
        return last_sync + timedelta(minutes=15)
    return last_sync + timedelta(days=1)`,
      },
    ],
    related: ['Message queues', 'Idempotency', 'Dead-letter queue', 'Rate limiting', 'Sharding', 'Cache-aside'],
  },
  simulator,
}
