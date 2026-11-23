import type { Trace } from '@structura/shared'
import { defaultTrace, json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator replays 3 minutes of clicks on one ad (600 true clicks, one every 300 ms).
// Some clicks arrive late, some are sent twice by a retry, and the aggregator counts them in
// 1-minute windows by event time. Every count below is worked out event by event.

const CLICKS = 600
const STEP_MS = 300 // one true click every 0.3 s: 200 per minute
const WINDOW_MS = 60_000
const WINDOWS = 3
const TRUE_PER_WINDOW = WINDOW_MS / STEP_MS // 200
const CPC_CENTS = 50 // the advertiser pays $0.50 a click
const LATE_PERCENT = 10
const DUP_PERCENT = 8
const DUP_DELAY_MS = 2000 // the retry arrives 2 s after the first copy

const DUPLICATES = ['None: every click is sent once', `${DUP_PERCENT}% are sent twice (client retries)`]
const DEDUPE = ['Off: count every event that arrives', 'On: skip a click_id already seen']
const LATENESS = [`${LATE_PERCENT}% arrive 20 s late`, `${LATE_PERCENT}% arrive 90 s late`]
const WAIT = ['0 s: close a window the moment it ends', '30 s after the window ends', '2 minutes after the window ends']
const WAIT_SECONDS = [0, 30, 120]

const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`

interface Arrival {
  id: number
  eventMs: number
  arrivalMs: number
  late: boolean
  copy: boolean
}

function simulate(duplicates: string, dedupe: string, lateness: string, wait: string) {
  const sendTwice = DUPLICATES.indexOf(duplicates) === 1
  const dedupeOn = DEDUPE.indexOf(dedupe) === 1
  const lateMs = (LATENESS.indexOf(lateness) === 1 ? 90 : 20) * 1000
  const allowedMs = WAIT_SECONDS[Math.max(0, WAIT.indexOf(wait))] * 1000

  // The stream: every true click, plus a retried copy of some, in the order they reach the aggregator.
  const arrivals: Arrival[] = []
  for (let i = 0; i < CLICKS; i++) {
    const eventMs = i * STEP_MS
    const late = stableHash(`late:${i}`) % 100 < LATE_PERCENT
    const arrivalMs = eventMs + (late ? lateMs : 50)
    arrivals.push({ id: i, eventMs, arrivalMs, late, copy: false })
    if (sendTwice && stableHash(`dup:${i}`) % 100 < DUP_PERCENT) {
      arrivals.push({ id: i, eventMs, arrivalMs: arrivalMs + DUP_DELAY_MS, late, copy: true })
    }
  }
  arrivals.sort((a, b) => a.arrivalMs - b.arrivalMs || a.id - b.id)

  // A window is closed (its result is final) at its end plus the wait. Later arrivals for it are dropped.
  const wins = Array.from({ length: WINDOWS }, () => ({ counted: 0, tooLate: 0, skipped: 0, doubleCounted: 0 }))
  const seen = new Set<number>()
  for (const a of arrivals) {
    const w = Math.floor(a.eventMs / WINDOW_MS)
    if (a.arrivalMs > (w + 1) * WINDOW_MS + allowedMs) {
      wins[w].tooLate++
      continue
    }
    if (dedupeOn) {
      if (seen.has(a.id)) {
        wins[w].skipped++
        continue
      }
      seen.add(a.id)
    } else if (a.copy) wins[w].doubleCounted++
    wins[w].counted++
  }

  const sum = (f: (w: (typeof wins)[number]) => number) => wins.reduce((s, w) => s + f(w), 0)
  return {
    sendTwice,
    dedupeOn,
    lateMs,
    allowedMs,
    arrivals: arrivals.length,
    copies: arrivals.filter((a) => a.copy).length,
    lateClicks: arrivals.filter((a) => !a.copy && a.late).length,
    wins,
    counted: sum((w) => w.counted),
    tooLate: sum((w) => w.tooLate),
    skipped: sum((w) => w.skipped),
    doubleCounted: sum((w) => w.doubleCounted),
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'duplicates', label: 'Retries', options: DUPLICATES },
    { id: 'dedupe', label: 'Deduplication', options: DEDUPE },
    { id: 'lateness', label: 'Slow phones', options: LATENESS },
    { id: 'wait', label: 'Wait for late clicks', options: WAIT },
  ],
  defaults: { duplicates: DUPLICATES[1], dedupe: DEDUPE[0], lateness: LATENESS[1], wait: WAIT[1] },
  run({ duplicates, dedupe, lateness, wait }) {
    const r = simulate(duplicates, dedupe, lateness, wait)
    const truth = CLICKS
    const error = r.counted - truth
    const winLine = (i: number) => {
      const w = r.wins[i]
      return `minute ${i + 1} (${i * 60}-${(i + 1) * 60} s): true ${TRUE_PER_WINDOW}, counted ${w.counted}  (${w.counted - TRUE_PER_WINDOW >= 0 ? '+' : ''}${w.counted - TRUE_PER_WINDOW})`
    }
    const steps: Trace['steps'] = []

    steps.push({
      text: `For 3 minutes, viewers click one ad: ${truth} real clicks, one every ${STEP_MS} ms (${TRUE_PER_WINDOW} a minute). The advertiser pays ${money(CPC_CENTS)} a click, so the right bill is ${money(truth * CPC_CENTS)}. Each click makes the Click Redirect Service log a click_id and send the viewer on to the advertiser.`,
      nodes: ['Viewer', 'Click Redirect Service', 'Advertiser Site'],
      data: `ad_id: ad_77\nclick_id: c_000000 ... c_${String(truth - 1).padStart(6, '0')}\nreal clicks: ${truth}\nright bill: ${truth} × ${money(CPC_CENTS)} = ${money(truth * CPC_CENTS)}`,
    })

    steps.push({
      text: `Every click goes on the Click Stream (Kafka) with its event time, the moment the viewer tapped. ${r.lateClicks} of the ${truth} clicks (${LATE_PERCENT}%) come from slow phones and arrive ${r.lateMs / 1000} s late.${r.sendTwice ? ` ${r.copies} clicks are sent a second time by a retry, ${DUP_DELAY_MS / 1000} s after the first copy, so ${r.arrivals} events reach the stream.` : ' Nothing is retried, so each click is one event.'}`,
      nodes: ['Click Stream (Kafka)', 'Raw Click Archive (S3)'],
      data: `events on the stream: ${r.arrivals}\n  real clicks: ${truth}\n  retried copies: ${r.copies}\nlate clicks (+${r.lateMs / 1000} s): ${r.lateClicks}\nevery event is also saved in the Raw Click Archive`,
    })

    steps.push({
      text: r.dedupeOn
        ? `The Stream Aggregator asks the Dedup Cache (Redis): "have I seen this click_id?" The first copy is counted and remembered. The second copy is skipped. ${r.skipped} copies were skipped this way.`
        : `Deduplication is off, so the Stream Aggregator counts every event it receives. ${r.sendTwice ? `${r.doubleCounted} of the retried copies were counted a second time: the advertiser would pay for clicks that never happened.` : 'With no retries there are no copies, so nothing is counted twice anyway.'}`,
      nodes: ['Stream Aggregator', 'Dedup Cache (Redis)'],
      data: r.dedupeOn
        ? `SET seen:c_000007 1 NX EX 600  → OK (first time: count it)\nSET seen:c_000007 1 NX EX 600  → nil (seen: skip)\ncopies skipped: ${r.skipped}`
        : `no check on click_id\ncopies counted twice: ${r.doubleCounted}`,
    })

    const closeText = r.allowedMs ? `${r.allowedMs / 1000} s after it ends` : 'the moment it ends'
    steps.push({
      text: `The aggregator puts each click in a 1-minute window by its event time, not by when it arrived. It closes a window ${closeText}. A click that arrives after that is too late for the live count: ${r.tooLate} arrivals were left out.${r.tooLate ? ' (They are still in the archive.)' : ''}`,
      nodes: ['Stream Aggregator'],
      data: `window: 60 s, by event time\nwait after window end: ${r.allowedMs / 1000} s\n${r.wins.map((_, i) => winLine(i)).join('\n')}\narrivals too late: ${r.tooLate}`,
    })

    steps.push({
      text: `Each closed window is saved to the Aggregates Store (OLAP) as one row: ad, minute, clicks. The advertiser's total is ${r.counted}, the truth is ${truth}.`,
      nodes: ['Aggregates Store (OLAP)'],
      data: `INSERT INTO ad_clicks_minute (ad_id, minute_start, clicks)\nVALUES ${r.wins.map((w, i) => `('ad_77', ${i * 60}, ${w.counted})`).join(',\n       ')}\nON CONFLICT (ad_id, minute_start) DO UPDATE SET clicks = EXCLUDED.clicks;`,
    })

    steps.push({
      text: `Billing: the advertiser sees ${r.counted} clicks and is charged ${money(r.counted * CPC_CENTS)}. The right bill is ${money(truth * CPC_CENTS)}. ${error === 0 ? 'The live count is exact.' : error > 0 ? `They are overcharged by ${money(error * CPC_CENTS)}.` : `The advertiser is undercharged by ${money(-error * CPC_CENTS)}.`}`,
      nodes: ['Reporting API', 'Advertiser'],
      data: json({ ad_id: 'ad_77', clicks: r.counted, charge: money(r.counted * CPC_CENTS), true_clicks: truth, error_clicks: error, error_charge: money(error * CPC_CENTS) }),
    })

    steps.push({
      text: error === 0
        ? `Nothing needs fixing here. The Reconciliation Job still runs every night: it reads the archive, counts each click_id once, and checks the live numbers.`
        : `The Reconciliation Job replays the day's raw clicks from the archive, counts each click_id once, with no deadline, and rewrites the minute rows. It gets exactly ${truth}, and the ${Math.abs(error)}-click error is gone. The live count is fast and almost right; the nightly count is slow and exact. Bills are settled from the exact one.`,
      nodes: ['Reconciliation Job', 'Raw Click Archive (S3)', 'Aggregates Store (OLAP)'],
      data: `replay archive → distinct click_id → count per minute\nlive total:      ${r.counted}\nreconciled total: ${truth}\nfixed: ${error === 0 ? 0 : -error} clicks`,
    })

    return { input: `${duplicates}; dedupe ${dedupe.split(':')[0].toLowerCase()}; ${lateness}; wait ${r.allowedMs / 1000} s`, steps }
  },
}

export const adClickAggregator: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'ad-click-aggregator',
  title: 'Ad Click Aggregator',
  blurb: 'Counting billions of ad clicks per minute: windows, late events, duplicates and exact billing',
  guides: ['scale-stream-data-deduplication', 'scale-exactly-once-semantics-with-kafka', 'scale-scaling-ad-analytics-with-cassandra-at-yelp', 'scale-druid---real-time-analytics-database', 'scale-architecture-of-ad-platform-at-twitter', 'scale-athenax-streaming-analytics-platform-at-uber'],
  takeaways: [
    'Log every click first (an append-only stream plus a raw archive), and count from the log: the counts can then always be rebuilt.',
    'Count by event time, the moment the viewer tapped, not by the time the event reached you.',
    'A window closes after a wait for late events. A longer wait is more exact but shows the count later.',
    'Retries make duplicates. Give every click a unique click_id and skip any id you have seen.',
    'Run two paths: a fast stream for live dashboards, and a nightly batch over the raw archive for the numbers that become bills.',
    'Sign the click link so nobody can invent clicks, and filter bots before they are counted and paid for.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'collect', label: 'Collect: never lose a click' },
      { id: 'count', label: 'Count: fast path' },
      { id: 'exact', label: 'Fix: exact path' },
    ],
    nodes: [
      { id: 'viewer', label: 'Viewer', shape: 'ellipse', color: 'blue', group: null },
      { id: 'redirect', label: 'Click Redirect Service', shape: 'rectangle', color: 'violet', group: 'collect' },
      { id: 'site', label: 'Advertiser Site', shape: 'cloud', color: 'blue', group: null },
      { id: 'stream', label: 'Click Stream (Kafka)', shape: 'rectangle', color: 'yellow', group: 'collect' },
      { id: 'agg', label: 'Stream Aggregator', shape: 'rectangle', color: 'orange', group: 'count' },
      { id: 'dedupe', label: 'Dedup Cache (Redis)', shape: 'rectangle', color: 'red', group: 'count' },
      { id: 'olap', label: 'Aggregates Store (OLAP)', shape: 'rectangle', color: 'green', group: null },
      { id: 'raw', label: 'Raw Click Archive (S3)', shape: 'rectangle', color: 'green', group: 'exact' },
      { id: 'batch', label: 'Reconciliation Job', shape: 'rectangle', color: 'orange', group: 'exact' },
      { id: 'api', label: 'Reporting API', shape: 'rectangle', color: 'violet', group: null },
      { id: 'advertiser', label: 'Advertiser', shape: 'ellipse', color: 'blue', group: null },
    ],
    edges: [
      { from: 'viewer', to: 'redirect', label: 'tap the ad', dashed: false },
      { from: 'redirect', to: 'site', label: '302 redirect', dashed: false },
      { from: 'redirect', to: 'stream', label: 'publish click event', dashed: false },
      { from: 'stream', to: 'agg', label: 'consume', dashed: false },
      { from: 'agg', to: 'dedupe', label: 'seen this click_id?', dashed: false },
      { from: 'agg', to: 'olap', label: 'write minute counts', dashed: false },
      { from: 'stream', to: 'raw', label: 'archive every event', dashed: true },
      { from: 'raw', to: 'batch', label: 'replay the day', dashed: false },
      { from: 'batch', to: 'olap', label: 'overwrite with exact counts', dashed: true },
      { from: 'advertiser', to: 'api', label: 'open dashboard', dashed: false },
      { from: 'api', to: 'olap', label: 'sum clicks', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'ads',
        name: 'ads',
        columns: [
          { name: 'ad_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'advertiser_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'cpc_cents', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'landing_url', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(advertiser_id)'],
      },
      {
        id: 'raw_clicks',
        name: 'raw_clicks',
        columns: [
          { name: 'click_id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'ad_id', type: 'bigint', pk: false, fk: 'ads.ad_id', nullable: false, unique: false },
          { name: 'user_hash', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'clicked_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'received_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'is_bot', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(ad_id, clicked_at)'],
      },
      {
        id: 'ad_clicks_minute',
        name: 'ad_clicks_minute',
        columns: [
          { name: 'ad_id', type: 'bigint', pk: true, fk: 'ads.ad_id', nullable: false, unique: false },
          { name: 'minute_start', type: 'timestamptz', pk: true, fk: null, nullable: false, unique: false },
          { name: 'clicks', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'source', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(minute_start)'],
      },
      {
        id: 'reconciliation_runs',
        name: 'reconciliation_runs',
        columns: [
          { name: 'run_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'day', type: 'date', pk: false, fk: null, nullable: false, unique: true },
          { name: 'live_clicks', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'exact_clicks', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'finished_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'raw_clicks', to: 'ads', kind: 'one-to-many', label: 'is a click on' },
      { from: 'ad_clicks_minute', to: 'ads', kind: 'one-to-many', label: 'counts clicks for' },
    ],
  },
  explanation: {
    title: 'Ad Click Aggregator',
    summary:
      'An advertiser pays each time a viewer clicks an ad, so the count must be right and must show up fast. The design logs every click, counts them in one-minute windows on a stream, skips duplicates, and fixes the numbers every night from the raw log.',
    sections: [
      {
        heading: 'Overview',
        body: 'On a website you see an ad and tap it. The ad company takes you to the advertiser\'s page, and it must count that click, because the advertiser pays for each one. Two things make this hard. The volume is huge: a big ad network sees about a billion clicks a day. And the count is money: if you count too few, you lose revenue; too many, and you overcharge a customer.\n\nThe pattern in this topic is simple: write down every click first, count from that record, and have a slower second path that recounts everything exactly.',
      },
      {
        heading: 'Requirements',
        body: '- Count clicks per ad, per minute, and let advertisers see them within a minute or so.\n- Never lose a click, and never count one twice.\n- Handle 1 billion clicks a day, and 5 times that rate at the peak.\n- Let advertisers ask for any range (last hour, last month) and group it by ad or by campaign.\n- Produce exact numbers for billing, even if the live numbers are a little off.\n- Resist fake clicks from bots and from people who just call the click link.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Average rate: 1,000,000,000 clicks ÷ 86,400 seconds in a day = 11,574 clicks a second. At a peak 5 times the average: about 57,870 a second.\n- Event size: about 200 bytes (ids, time, ad, a hashed user, device). 1 billion × 200 B = 200 GB a day, or 73 TB a year. That is the raw archive: cheap object storage.\n- Kafka: one partition (one ordered slice of the stream) handles roughly 10,000 events a second. 57,870 ÷ 10,000 = 6, so use 12 partitions for room to grow.\n- Dedup memory: remember each click_id for 10 minutes (600 s). 57,870 × 600 = 34.7 million ids. At about 50 bytes each in Redis, that is about 1.7 GB.\n- Aggregates: one row per ad per minute is at most one row per click, so at most 1 billion rows a day. At about 40 bytes that is at most 40 GB a day, and far less in practice because many clicks share a row.',
      },
      {
        heading: 'Step by step',
        body: '1. The Viewer taps the ad. The link goes to the Click Redirect Service, not straight to the advertiser, and carries a signed ad_id and a click_id.\n2. The Click Redirect Service checks the signature, then sends a 302 redirect to the Advertiser Site so the viewer does not wait.\n3. At the same time it publishes a click event (click_id, ad_id, event time) to the Click Stream (Kafka), keyed by ad_id.\n4. The Click Stream (Kafka) also feeds the Raw Click Archive (S3): every event is saved, unchanged.\n5. The Stream Aggregator reads events and asks the Dedup Cache (Redis) whether it has seen this click_id. Seen ones are skipped.\n6. It adds each new click to a one-minute window by event time, closes the window after a short wait for late events, and writes the count to the Aggregates Store (OLAP).\n7. Each night the Reconciliation Job replays the Raw Click Archive (S3), counts each click_id once, and overwrites the minute rows in the Aggregates Store (OLAP).\n8. The Advertiser opens the dashboard. The Reporting API sums the minute rows from the Aggregates Store (OLAP).',
      },
      {
        heading: 'Components',
        body: '- Viewer: taps the ad on a phone or browser. Some phones are slow, so their events arrive late.\n- Click Redirect Service: checks the signed link, redirects the viewer, and publishes one click event. It does no counting, so it stays fast.\n- Advertiser Site: the page the advertiser wants the viewer to see.\n- Click Stream (Kafka): an append-only log of click events, split into partitions by ad_id so one ad\'s clicks stay in order.\n- Stream Aggregator: reads the stream and counts clicks in one-minute windows, by event time.\n- Dedup Cache (Redis): remembers click_ids for a few minutes so a retried click is counted once.\n- Aggregates Store (OLAP): a column database built for sums and group-bys over huge tables, such as ClickHouse, Druid or Pinot. It holds one row per ad per minute.\n- Raw Click Archive (S3): every click event, forever, in cheap object storage. It is the source of truth.\n- Reconciliation Job: a batch job that recounts the archive exactly and corrects the live numbers.\n- Reporting API: answers dashboard questions by summing minute rows.\n- Advertiser: the customer who pays per click and reads the dashboard.',
      },
      {
        heading: 'Key decisions',
        body: '- Event time or arrival time? Count by event time, when the viewer tapped. Arrival time moves clicks into the wrong minute whenever the network is slow.\n- How long to wait for late events: a window closes at its end plus a wait. In the simulator, 10% of clicks are 90 s late. A 30 s wait drops most of them; a 2-minute wait catches all. A longer wait is more exact but the final number shows later. Show a live number early and mark it as not final.\n- Duplicates: a phone that gets no response sends the click again. Give each click a click_id when the page is made, and remember it with SET key NX EX 600 in Redis. The first caller gets OK; the retry gets nothing and is skipped. The expiry must be longer than the longest retry and the wait.\n- Exactly-once counting: Kafka can deliver a message twice after a crash. Make the write idempotent: the minute row is overwritten with INSERT ... ON CONFLICT DO UPDATE, so writing the same window twice gives the same answer.\n- Two paths: the fast path (stream) is allowed to be a little wrong. The slow path (nightly batch from the archive) is exact and decides the bill. This is called a lambda architecture.\n- Hot ads: one viral ad can send most clicks to one partition. Add a random suffix (ad_id#0 to ad_id#7) to spread it, and add the eight partial counts when you read.\n- Fraud: sign each click link (an HMAC, a keyed hash) so clicks cannot be invented, drop known bot addresses, and flag a user_hash with too many clicks in a minute. Keep is_bot on the raw row, never delete it.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The Click Redirect Service is stateless: add servers behind a load balancer.\n- If the Stream Aggregator crashes, it restarts from its last committed Kafka offset (its place in the log). Because writes are overwrites, replaying a few minutes does no harm.\n- If Redis loses data, some duplicates may slip through for a few minutes. The nightly job removes them, so the cost is a briefly wrong live number, not a wrong bill.\n- If Kafka is down, the Click Redirect Service should still redirect the viewer and buffer the event on local disk. A lost redirect loses a customer; a delayed click only delays a count.\n- If the OLAP store is slow, advertisers see old numbers but nothing is lost: the stream and archive keep going.\n- Everything can be rebuilt: delete the minute rows, replay the archive, and you get them back. This is why the log is written first.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why count by event time instead of arrival time?\n- A phone retries a click. How do you avoid charging for it twice?\n- How would you choose the window size and how long to wait for late events?\n- Why run a nightly batch if the stream already counts?\n- One ad gets 100 times more clicks than the others. What breaks, and how do you fix it?\n- How do you stop bots and fake clicks from costing advertisers money?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Count clicks in one-minute windows by event time',
        language: 'javascript',
        source: `const WINDOW_MS = 60_000
const WAIT_MS = 30_000 // how long a window stays open for late clicks
const windows = new Map() // 'adId:windowStart' -> count

export function onClick({ adId, clickedAt }, now = Date.now()) {
  // The window comes from when the viewer tapped, not from now.
  const start = Math.floor(clickedAt / WINDOW_MS) * WINDOW_MS
  if (now > start + WINDOW_MS + WAIT_MS) return 'too late' // the batch job will pick it up
  const key = adId + ':' + start
  windows.set(key, (windows.get(key) ?? 0) + 1)
  return 'counted'
}

// Every few seconds: windows that are closed get written, once, and forgotten.
export function flush(save, now = Date.now()) {
  for (const [key, count] of windows) {
    const start = Number(key.split(':')[1])
    if (now > start + WINDOW_MS + WAIT_MS) {
      save(key, count) // an upsert: writing it twice gives the same row
      windows.delete(key)
    }
  }
}`,
        versions: [
          {
            language: 'java',
            source: `import java.util.HashMap;
import java.util.Map;

public class ClickWindows {
  static final long WINDOW_MS = 60_000;
  static final long WAIT_MS = 30_000; // how long a window stays open for late clicks
  final Map<String, Integer> windows = new HashMap<>(); // "adId:windowStart" -> count

  String onClick(String adId, long clickedAt, long now) {
    // The window comes from when the viewer tapped, not from now.
    long start = clickedAt / WINDOW_MS * WINDOW_MS;
    if (now > start + WINDOW_MS + WAIT_MS) return "too late"; // the batch job will pick it up
    windows.merge(adId + ":" + start, 1, Integer::sum);
    return "counted";
  }
}`,
          },
        ],
      },
      {
        title: 'Skip a click_id you have seen',
        language: 'javascript',
        source: `import { createClient } from 'redis'
const redis = await createClient().connect()

// SET ... NX only works if the key is new, so exactly one caller gets 'OK'.
// EX 600 forgets the id after 10 minutes, longer than any retry or late wait.
export async function isFirstTime(clickId) {
  const reply = await redis.set('seen:' + clickId, '1', { NX: true, EX: 600 })
  return reply === 'OK'
}

export async function handle(click) {
  if (!(await isFirstTime(click.clickId))) return 'duplicate, skipped'
  return onClick(click)
}`,
        versions: [
          {
            language: 'java',
            source: `import redis.clients.jedis.Jedis;
import redis.clients.jedis.params.SetParams;

public class Dedup {
  final Jedis redis = new Jedis("localhost", 6379);

  // SET ... NX only works if the key is new, so exactly one caller gets "OK".
  // EX 600 forgets the id after 10 minutes, longer than any retry or late wait.
  boolean isFirstTime(String clickId) {
    String reply = redis.set("seen:" + clickId, "1", SetParams.setParams().nx().ex(600));
    return "OK".equals(reply);
  }
}`,
          },
        ],
      },
      {
        title: 'Sign the click link so clicks cannot be invented',
        language: 'javascript',
        source: `import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.CLICK_SECRET // only our servers know it

// When we show the ad, we build a link: ad_id, click_id and a signature.
export function signLink(adId, clickId) {
  const sig = createHmac('sha256', SECRET).update(adId + '.' + clickId).digest('hex')
  return '/c?ad=' + adId + '&id=' + clickId + '&sig=' + sig
}

// When the click arrives, recompute the signature. A made-up link will not match.
export function isValid(adId, clickId, sig) {
  const want = createHmac('sha256', SECRET).update(adId + '.' + clickId).digest()
  const got = Buffer.from(sig, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}`,
      },
      {
        title: 'Write the minute row so a replay is harmless',
        language: 'sql',
        source: `-- The stream aggregator and the nightly job both run this.
-- If the same window is written twice, the second write replaces the first.
INSERT INTO ad_clicks_minute (ad_id, minute_start, clicks, source)
VALUES (77, '2026-11-23 10:00:00+00', 200, 'stream')
ON CONFLICT (ad_id, minute_start)
DO UPDATE SET clicks = EXCLUDED.clicks, source = EXCLUDED.source;

-- What the dashboard asks: clicks and cost for one ad over the last hour.
SELECT sum(c.clicks) AS clicks, sum(c.clicks) * a.cpc_cents / 100.0 AS dollars
FROM ad_clicks_minute c JOIN ads a USING (ad_id)
WHERE c.ad_id = 77 AND c.minute_start >= now() - interval '1 hour'
GROUP BY a.cpc_cents;`,
      },
    ],
    related: ['Stream processing', 'Event time and watermarks', 'Idempotency', 'Lambda architecture', 'Kafka', 'OLAP databases'],
  },
  simulator,
}
