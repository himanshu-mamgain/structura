import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator sizes the pipeline from the fleet and the interval, then replays a
// CPU graph through a real "for 5 minutes" alert rule, so every number is computed.

const METRICS_PER_SERVER = 200
const BYTES_RAW = 16 // 8-byte timestamp + 8-byte float
const BYTES_PACKED = 1.37 // delta-of-delta timestamps + XOR floats (Facebook's Gorilla paper)
const SHARD_RATE = 500_000 // samples per second one TSDB shard takes: a planning figure
const THRESHOLD = 90 // alert when CPU > 90 %...
const FOR_SECONDS = 300 // ...for 5 minutes in a row
const EVAL_EVERY = 15 // the rule is checked every 15 s
const GROUP_WAIT = 30 // Alert Manager waits 30 s to group related alerts
const SPIKE_START = 60
const HORIZON = 1200

const FLEETS: Record<string, number> = { '100 servers': 100, '1,000 servers': 1000, '10,000 servers': 10000 }
const INTERVALS: Record<string, number> = { '1 s': 1, '15 s': 15, '60 s': 60 }
const MODES = ['Pull (collectors scrape)', 'Push (agents send)']
const SCENARIOS = ['CPU at 95% for 3 minutes', 'CPU at 95% for 8 minutes', 'CPU flaps 95% / 35% every 30 s']

const n = (x: number, digits = 0) => x.toLocaleString('en-US', { maximumFractionDigits: digits })
const gb = (bytes: number) => (bytes >= 1e12 ? `${n(bytes / 1e12, 1)} TB` : bytes >= 1e9 ? `${n(bytes / 1e9, 1)} GB` : `${n(bytes / 1e6, 1)} MB`)

/** The CPU the graph would show at second t. */
function cpuAt(scenario: string, t: number): number {
  if (t < SPIKE_START) return 35
  if (scenario === SCENARIOS[0]) return t < SPIKE_START + 180 ? 95 : 35
  if (scenario === SCENARIOS[1]) return t < SPIKE_START + 480 ? 95 : 35
  // Flapping: 30 s high, 30 s low, for ten minutes.
  return t < SPIKE_START + 600 && (t - SPIKE_START) % 60 < 30 ? 95 : 35
}

interface Evaluation {
  firedAt: number | null
  pendingAt: number | null
  resets: number
  seen: string
}

/** Runs the rule `cpu > 90 for 5m`: pending when it first holds, firing once it has held 300 s. */
function evaluate(scenario: string, interval: number): Evaluation {
  const samples: number[] = []
  for (let t = 0; t <= HORIZON; t += interval) samples.push(t)
  let pendingAt: number | null = null
  let firstPending: number | null = null
  let resets = 0
  for (let t = 0; t <= HORIZON; t += EVAL_EVERY) {
    const last = samples[Math.floor(t / interval)] // newest sample at or before this check
    const hot = cpuAt(scenario, last) > THRESHOLD
    if (hot) {
      if (pendingAt === null) {
        pendingAt = t
        firstPending ??= t
      }
      if (t - pendingAt >= FOR_SECONDS) return { firedAt: t, pendingAt: firstPending, resets, seen: seen(scenario, interval) }
    } else if (pendingAt !== null) {
      pendingAt = null
      resets++
    }
  }
  return { firedAt: null, pendingAt: firstPending, resets, seen: seen(scenario, interval) }
}

/** The first few samples after the spike starts, as the scraper recorded them. */
function seen(scenario: string, interval: number): string {
  const out: string[] = []
  for (let t = Math.ceil(SPIKE_START / interval) * interval; out.length < 6 && t <= HORIZON; t += interval) out.push(`${t}s→${cpuAt(scenario, t)}`)
  return out.join('  ')
}

const mmss = (s: number) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`

const simulator: Simulator = {
  fields: [
    { id: 'fleet', label: 'Fleet size', options: Object.keys(FLEETS) },
    { id: 'interval', label: 'Collection interval', options: Object.keys(INTERVALS) },
    { id: 'mode', label: 'Collection model', options: MODES },
    { id: 'scenario', label: 'What happens to CPU', options: SCENARIOS },
  ],
  defaults: { fleet: '10,000 servers', interval: '15 s', mode: MODES[0], scenario: SCENARIOS[1] },
  run({ fleet, interval, mode, scenario }) {
    const servers = FLEETS[fleet] ?? 10000
    const every = INTERVALS[interval] ?? 15
    const pull = mode !== MODES[1]
    const series = servers * METRICS_PER_SERVER
    const rate = series / every
    const perDay = rate * 86400
    const rawDay = perDay * BYTES_RAW
    const packedDay = perDay * BYTES_PACKED
    const shards = Math.max(1, Math.ceil(rate / SHARD_RATE))
    const rollupDay = series * (86400 / 300) * BYTES_PACKED // 5-minute averages
    const ev = evaluate(scenario, every)
    const delay = ev.firedAt === null ? null : ev.firedAt - SPIKE_START

    const steps: Trace['steps'] = [
      {
        text: `${n(servers)} servers each expose ${METRICS_PER_SERVER} metrics: counters (requests served), gauges (CPU, memory) and histograms (latency buckets). Each one is a time series: a name plus labels, with a value every ${interval}.`,
        nodes: ['Monitored Services'],
        data: `cpu_usage_percent{service="checkout",host="web-0042"} 35\nhttp_requests_total{service="checkout",host="web-0042",code="200"} 1843920\nactive series: ${n(servers)} × ${METRICS_PER_SERVER} = ${n(series)}`,
      },
      pull
        ? {
            text: `Pull model: Service Discovery lists the live servers, and the Metrics Collectors fetch /metrics from each one every ${interval}. A server that does not answer is recorded as up=0, so a dead server is itself a signal.`,
            nodes: ['Service Discovery', 'Metrics Collectors', 'Monitored Services'],
            data: `targets from discovery: ${n(servers)}\nGET http://web-0042:9100/metrics every ${interval}\nup{host="web-0042"} 1   (a crashed server would show 0)`,
          }
        : {
            text: `Push model: an agent on each server batches its samples and sends them to the Metrics Collectors every ${interval}. There is no discovery to run, and it works behind firewalls, but a silent agent could mean a dead server or just a dead agent.`,
            nodes: ['Monitored Services', 'Metrics Collectors'],
            data: `POST /v1/write  (agent on web-0042, every ${interval})\nbatch: ${METRICS_PER_SERVER} samples, snappy-compressed\nno request for a dead server: silence is ambiguous`,
          },
      {
        text: `The collectors put every batch on Kafka Buffer, so a slow database never makes collectors drop data. Load: ${n(series)} series ÷ ${every} s = ${n(rate)} samples per second, about ${n(rate * 40 / 1e6, 1)} MB/s on the wire at roughly 40 bytes a sample.`,
        nodes: ['Metrics Collectors', 'Kafka Buffer'],
        data: `topic: metrics.raw, partition = hash(series_id) % 64\n${n(rate)} samples/s\n≈ ${n(rate * 40 / 1e6, 1)} MB/s`,
      },
      {
        text: `Ingest Workers read Kafka and write to Time-Series DB in large batches. Time-series data compresses extremely well: timestamps are almost evenly spaced and values change slowly, so ${BYTES_PACKED} bytes a sample replaces ${BYTES_RAW}. That is ${shards} ingest shard${shards > 1 ? 's' : ''} at about ${n(SHARD_RATE)} samples per second each.`,
        nodes: ['Kafka Buffer', 'Ingest Workers', 'Time-Series DB'],
        data: `samples per day: ${n(perDay)}\nraw (${BYTES_RAW} B): ${gb(rawDay)}/day\ncompressed (${BYTES_PACKED} B): ${gb(packedDay)}/day\nshards needed: ceil(${n(rate)} / ${n(SHARD_RATE)}) = ${shards}`,
      },
      {
        text: `Old data is rolled up. Raw samples stay for 15 days (${gb(packedDay * 15)}), then Long-term Archive keeps 5-minute averages for a year. Averages are ${n(300 / every)}× fewer points, so a year of history costs ${gb(rollupDay * 365)} rather than ${gb(packedDay * 365)}.`,
        nodes: ['Time-Series DB', 'Long-term Archive'],
        data: `raw: ${every}s resolution, 15 days → ${gb(packedDay * 15)}\nrollup: 5m avg/max, 365 days → ${gb(rollupDay * 365)}\nreduction vs raw: ${n(300 / every)}×`,
      },
      {
        text: 'Meanwhile an engineer opens a dashboard. Query Service answers from the newest raw data for the last hours and from rollups for the last months, so a one-year graph does not scan billions of points.',
        nodes: ['Dashboards', 'Query Service', 'Time-Series DB', 'Long-term Archive'],
        data: `avg(cpu_usage_percent{service="checkout"}) by (host)\nrange: last 6h → raw (${n((6 * 3600) / every)} points per series)\nrange: last 90d → 5m rollup (${n((90 * 86400) / 300)} points per series)`,
      },
      {
        text: `Alert Rules Evaluator checks the rule \`cpu > ${THRESHOLD} for 5m\` every ${EVAL_EVERY} s. CPU goes up at ${mmss(SPIKE_START)}. The "for" part stops a single spike from paging anyone: the condition must hold for ${FOR_SECONDS} s straight. ${
          ev.pendingAt === null
            ? `No sample the collector took was above ${THRESHOLD}%, so the rule never became pending.${scenario === SCENARIOS[2] ? ' The graph is high for 30 s and low for 30 s, and a sample every 60 s happened to land only on the low halves: a sampling blind spot.' : ''}`
            : ev.firedAt !== null
              ? `It turned pending at ${mmss(ev.pendingAt)} and became firing at ${mmss(ev.firedAt)}.`
              : `It turned pending at ${mmss(ev.pendingAt)}, but the condition ${ev.resets > 0 ? 'broke before 5 minutes passed, which resets the timer' : 'ended too soon'}, so it never fired.`
        }`,
        nodes: ['Alert Rules Evaluator', 'Time-Series DB'],
        data: `samples seen after the spike: ${ev.seen}\nrule: cpu_usage_percent > ${THRESHOLD} for ${FOR_SECONDS}s, eval every ${EVAL_EVERY}s\nstate: ${ev.firedAt !== null ? `pending ${mmss(ev.pendingAt ?? 0)} → FIRING ${mmss(ev.firedAt)}` : ev.pendingAt !== null ? `pending ${mmss(ev.pendingAt)} → reset (${ev.resets}×) → inactive` : 'inactive the whole time'}`,
      },
    ]

    if (ev.firedAt !== null && delay !== null) {
      steps.push({
        text: `Alert Manager waits ${GROUP_WAIT} s to group related alerts into one message (so ten hosts breaching together make one page, not ten), then sends it to On-call Pager. From the real start of the problem to a phone buzzing: ${mmss(delay + GROUP_WAIT)}.`,
        nodes: ['Alert Rules Evaluator', 'Alert Manager', 'On-call Pager'],
        data: `alert: HighCPU{service="checkout"} severity=page\ngroup_wait ${GROUP_WAIT}s, then notify\ndetection delay: ${mmss(delay)} (the "for") + ${GROUP_WAIT}s grouping = ${mmss(delay + GROUP_WAIT)}`,
      })
    } else {
      steps.push({
        text: `No alert is sent, and that is by design for a short spike: nobody is paged for a problem that fixed itself. The dashboard still shows it. If it should have paged, shorten the "for" or alert on a rate or an average rather than raw samples.`,
        nodes: ['Alert Rules Evaluator', 'Dashboards'],
        data: `alert events created: 0\nlongest unbroken run above ${THRESHOLD}%: ${scenario === SCENARIOS[0] ? '3m00s' : scenario === SCENARIOS[2] ? `${every >= 60 ? '0s seen' : '15s to 30s'}` : 'n/a'}\nrequired: ${FOR_SECONDS}s`,
      })
    }

    return { input: `${fleet}, every ${interval}, ${pull ? 'pull' : 'push'}, ${scenario.toLowerCase()}`, steps }
  },
}

export const metricsMonitoring: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'metrics-monitoring',
  title: 'Metrics & Monitoring System',
  blurb: 'Collecting millions of samples a second, storing them as compressed time series, and alerting without false pages',
  guides: ['push-vs-pull-in-metrics-collecting-systems', 'choose-the-right-database-for-metric-collecting-system', 'logging-tracing-metrics', 'cloud-monitoring-cheat-sheet'],
  takeaways: [
    'A metric is a time series: a name, labels and a stream of (timestamp, value) points.',
    'Pull makes a dead server visible (up=0); push suits short-lived jobs and firewalled hosts, but silence is ambiguous.',
    'Buffer between collectors and the database (a queue like Kafka) so a slow database never drops samples.',
    'Time-series databases compress to about 1.4 bytes a sample, and roll old data up to cut years of storage.',
    'Alert on symptoms with a "for" duration, so a short blip does not page anyone.',
    'Group and de-duplicate alerts: one incident should be one page, however many hosts it touches.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'collect', label: 'Collection' },
      { id: 'store', label: 'Storage' },
      { id: 'alerting', label: 'Alerting' },
    ],
    nodes: [
      { id: 'services', label: 'Monitored Services', shape: 'rectangle', color: 'blue', group: null },
      { id: 'discovery', label: 'Service Discovery', shape: 'rectangle', color: 'violet', group: 'collect' },
      { id: 'collectors', label: 'Metrics Collectors', shape: 'rectangle', color: 'orange', group: 'collect' },
      { id: 'kafka', label: 'Kafka Buffer', shape: 'rectangle', color: 'yellow', group: 'collect' },
      { id: 'ingest', label: 'Ingest Workers', shape: 'rectangle', color: 'orange', group: 'store' },
      { id: 'tsdb', label: 'Time-Series DB', shape: 'rectangle', color: 'green', group: 'store' },
      { id: 'archive', label: 'Long-term Archive', shape: 'rectangle', color: 'green', group: 'store' },
      { id: 'query', label: 'Query Service', shape: 'rectangle', color: 'violet', group: null },
      { id: 'dash', label: 'Dashboards', shape: 'ellipse', color: 'blue', group: null },
      { id: 'rules', label: 'Alert Rules Evaluator', shape: 'rectangle', color: 'violet', group: 'alerting' },
      { id: 'manager', label: 'Alert Manager', shape: 'rectangle', color: 'violet', group: 'alerting' },
      { id: 'pager', label: 'On-call Pager', shape: 'ellipse', color: 'blue', group: null },
    ],
    edges: [
      { from: 'discovery', to: 'collectors', label: 'target list', dashed: true },
      { from: 'collectors', to: 'services', label: 'scrape /metrics', dashed: false },
      { from: 'services', to: 'collectors', label: 'or push', dashed: true },
      { from: 'collectors', to: 'kafka', label: 'batches', dashed: false },
      { from: 'kafka', to: 'ingest', label: 'consume', dashed: false },
      { from: 'ingest', to: 'tsdb', label: 'batched writes', dashed: false },
      { from: 'tsdb', to: 'archive', label: 'rollups after 15 days', dashed: true },
      { from: 'dash', to: 'query', label: 'PromQL-style query', dashed: false },
      { from: 'query', to: 'tsdb', label: 'recent data', dashed: false },
      { from: 'query', to: 'archive', label: 'old data', dashed: true },
      { from: 'rules', to: 'tsdb', label: 'evaluate every 15 s', dashed: false },
      { from: 'rules', to: 'manager', label: 'firing alerts', dashed: false },
      { from: 'manager', to: 'pager', label: 'grouped page', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'services',
        name: 'services',
        columns: [
          { name: 'service_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'owner_team', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'series',
        name: 'series',
        columns: [
          { name: 'series_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'service_id', type: 'bigint', pk: false, fk: 'services.service_id', nullable: false, unique: false },
          { name: 'metric_name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'labels', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(metric_name, labels)', '(service_id)'],
      },
      {
        id: 'samples',
        name: 'samples',
        columns: [
          { name: 'series_id', type: 'bigint', pk: true, fk: 'series.series_id', nullable: false, unique: false },
          { name: 'ts', type: 'timestamptz', pk: true, fk: null, nullable: false, unique: false },
          { name: 'value', type: 'double', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(series_id, ts) in time-ordered blocks'],
      },
      {
        id: 'alert_rules',
        name: 'alert_rules',
        columns: [
          { name: 'rule_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'expr', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'for_seconds', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'severity', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'team', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(team)'],
      },
      {
        id: 'alert_events',
        name: 'alert_events',
        columns: [
          { name: 'event_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'rule_id', type: 'bigint', pk: false, fk: 'alert_rules.rule_id', nullable: false, unique: false },
          { name: 'state', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'started_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'notified_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(rule_id, started_at)'],
      },
    ],
    relations: [
      { from: 'series', to: 'services', kind: 'one-to-many', label: 'belongs to' },
      { from: 'samples', to: 'series', kind: 'one-to-many', label: 'points of' },
      { from: 'alert_events', to: 'alert_rules', kind: 'one-to-many', label: 'raised by' },
    ],
  },
  explanation: {
    title: 'Metrics & Monitoring System',
    summary:
      'A monitoring system collects numbers from every server (CPU, requests, errors, latency), stores them as time series, draws them on dashboards and wakes someone when something is wrong. The write load is huge and steady, reads are mostly recent data, and the alerting path must keep working exactly when everything else is on fire.',
    sections: [
      {
        heading: 'Overview',
        body: 'A metric is a measurement over time, such as `cpu_usage_percent{service="checkout",host="web-0042"}`. The name plus its labels identify one series; each series gets a new value every few seconds.\n\nThe system has three jobs: collect (get samples from the servers), store and query (keep them cheaply, answer dashboards fast) and alert (notice trouble and tell the right person once). Logs and traces answer "what happened"; metrics answer "is something wrong, and how badly".',
      },
      {
        heading: 'Requirements',
        body: '- Collect metrics from tens of thousands of servers every few seconds.\n- Keep recent data at full resolution and old data at a lower one.\n- Dashboards load in a second or two.\n- Alerts fire within minutes of a real problem, with few false pages.\n- The monitoring system must stay up when the thing it watches is down.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 10,000 servers, 200 metrics each, one sample every 15 seconds.\n- Active series: 10,000 × 200 = 2,000,000.\n- Write rate: 2,000,000 / 15 = 133,333 samples per second.\n- Samples per day: 133,333 × 86,400 = 11.52 billion.\n- Raw size at 16 bytes a sample: 184 GB a day. Compressed to about 1.37 bytes: 15.8 GB a day, so 15 days of raw data is about 237 GB.\n- Rolling up to 5-minute averages gives 2,000,000 × 288 = 576 million points a day, 0.79 GB a day, 288 GB for a year.\n- One ingest shard handles about 500,000 samples per second (a planning figure), so 133,333 fits on one shard; run three for redundancy and headroom.',
      },
      {
        heading: 'Step by step',
        body: '1. The Monitored Services expose their metrics (or run an agent that sends them).\n2. Service Discovery keeps the list of live servers, so the Metrics Collectors know what to scrape.\n3. Metrics Collectors fetch the numbers every 15 seconds (or receive pushed batches) and write them to Kafka Buffer.\n4. Ingest Workers read Kafka Buffer and write large batches into Time-Series DB.\n5. After 15 days, Time-Series DB hands rolled-up averages to Long-term Archive.\n6. Dashboards send queries to Query Service, which reads recent data from Time-Series DB and old data from Long-term Archive.\n7. Alert Rules Evaluator runs every rule against Time-Series DB every 15 seconds.\n8. Firing alerts go to Alert Manager, which groups and de-duplicates them and sends one page to On-call Pager.',
      },
      {
        heading: 'Components',
        body: '- Monitored Services: the servers and apps being watched; each exposes /metrics or runs an agent.\n- Service Discovery: the live list of servers (from Kubernetes or a cloud API), so new hosts are found without a config change.\n- Metrics Collectors: fetch (pull) or receive (push) samples and tag them with the labels.\n- Kafka Buffer: a queue between collection and storage; absorbs bursts and lets the database be down for a while without losing data.\n- Ingest Workers: read from the queue and write big batches, which is much cheaper than one write per sample.\n- Time-Series DB: stores samples in time-ordered, compressed blocks; fast for recent ranges.\n- Long-term Archive: cheap storage (object storage) for rolled-up averages and maximums of old data.\n- Query Service: turns a dashboard query into reads, choosing raw data or rollups by time range, and caches results.\n- Dashboards: graphs and tables the engineers look at.\n- Alert Rules Evaluator: runs the alert rules on a schedule and tracks pending and firing states.\n- Alert Manager: groups, de-duplicates, silences and routes alerts to the right team.\n- On-call Pager: the phone, SMS or chat message that reaches the engineer on duty.',
      },
      {
        heading: 'Key decisions',
        body: '- Pull or push: pull (Prometheus-style) shows a dead server as up=0 and lets you test a target by hand; push (StatsD, agents) suits short batch jobs and hosts behind firewalls. Many systems offer both.\n- A queue in the middle: costs a hop, but a database restart no longer loses data.\n- Storage: a general database struggles with millions of appends a second. A time-series database writes in order, compresses timestamps (delta-of-delta) and values (XOR with the previous value) and drops whole blocks at retention time.\n- Retention and rollups: full resolution for days, averages for months or years. You cannot recover detail from an average, so keep max as well as avg.\n- Cardinality: every distinct label combination is a new series. A label like user_id with a million values makes a million series and can take the database down. Keep labels low-cardinality.\n- Alerting on symptoms: page on "error rate above 2% for 5 minutes", not on "one disk at 80%". The "for" removes blips.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Shard series across ingest and storage nodes by a hash of the series id, and replicate each shard.\n- Run collectors in groups, each owning a share of the targets, with a standby per group.\n- Make the alert path independent: evaluate rules in at least two places, and have a "dead man\'s switch" alert that always fires, so silence from the monitor itself raises an alarm elsewhere.\n- Sampling blind spots: a 60 s interval can miss a 30 s spike, or alias with it. Use histograms and rates for fast things.\n- Alert fatigue: too many pages train people to ignore them. Every page must be urgent, real and actionable.\n- Watch the watchers: monitor ingest lag, dropped samples and series count.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Pull or push, and what does each do when a server crashes?\n- How would you stop a developer adding a high-cardinality label?\n- Why does an alert need a "for" duration, and what does it cost in detection time?\n- How do you alert when the monitoring system itself is down?\n- How would you store a year of data for 2 million series?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Expose metrics in the text format a scraper reads',
        language: 'typescript',
        source: `import http from 'node:http'

let requests = 0 // a counter only ever goes up; the database computes rates

http.createServer((req, res) => {
  if (req.url === '/metrics') {
    const cpu = 35 // in real code: read from the OS
    res.setHeader('Content-Type', 'text/plain; version=0.0.4')
    res.end(
      '# TYPE http_requests_total counter\\n' +
      \`http_requests_total{service="checkout",code="200"} \${requests}\\n\` +
      '# TYPE cpu_usage_percent gauge\\n' +
      \`cpu_usage_percent{service="checkout"} \${cpu}\\n\`,
    )
    return
  }
  requests++
  res.end('ok')
}).listen(9100)`,
      },
      {
        title: 'A "for" duration: pending, then firing',
        language: 'python',
        source: `def evaluate(samples, threshold=90, hold_seconds=300):
    """samples: list of (time_in_seconds, value), oldest first."""
    pending_since = None
    for t, value in samples:
        if value > threshold:
            pending_since = t if pending_since is None else pending_since
            if t - pending_since >= hold_seconds:
                return "firing", t
        else:
            pending_since = None  # one good sample resets the timer
    return "pending" if pending_since is not None else "inactive", None

# 95% from t=60 to t=540 (every 15 s): fires at t=360, 300 s after it first held.`,
      },
      {
        title: 'Roll raw samples up to 5-minute average and max',
        language: 'sql',
        source: `-- Keep max as well as avg: a 10-second spike vanishes in an average.
INSERT INTO samples_5m (series_id, bucket, avg_value, max_value)
SELECT series_id,
       to_timestamp(floor(extract(epoch FROM ts) / 300) * 300) AS bucket,
       avg(value), max(value)
FROM samples
WHERE ts >= now() - interval '16 days'
  AND ts <  now() - interval '15 days'     -- only the day that just aged out
GROUP BY series_id, bucket;`,
      },
      {
        title: 'Why timestamps compress so well',
        language: 'python',
        source: `def delta_of_delta(timestamps):
    deltas = [b - a for a, b in zip(timestamps, timestamps[1:])]
    return [b - a for a, b in zip(deltas, deltas[1:])]

ts = [1700000000, 1700000015, 1700000030, 1700000045, 1700000060]
print(delta_of_delta(ts))  # [0, 0, 0]: steady 15 s steps cost about 1 bit each
# A late scrape (1700000046 instead of 1700000045) gives [0, 1, -1]: still tiny.`,
      },
    ],
    related: ['Time-series database', 'Pull vs push', 'Cardinality', 'Alert fatigue', 'Downsampling', 'SLOs and error budgets'],
  },
  simulator,
}
