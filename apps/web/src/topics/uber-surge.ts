import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Illustrative numbers throughout: a simple riders-to-drivers rule, not Uber's
// real pricing model. The narrated video (apps/video, UberSurge) uses the same rule.

const BASE_FARE = 250 // ₹
const CELL = '882a100d2dfffff' // an H3 index at resolution 8 (about 0.7 km² per hexagon)

/** 1× until riders outnumber drivers, then +0.4× per extra rider per driver, capped at 3×. */
function surge(riders: number, drivers: number): number {
  const ratio = riders / Math.max(1, drivers)
  return Math.round(Math.min(3, Math.max(1, 1 + (ratio - 1) * 0.4)) * 10) / 10
}

/** Many drivers leaving one hexagon within two minutes looks coordinated, not like normal churn. */
const isCoordinated = (offline: number, usual: number) => offline >= 5 && offline / Math.max(1, usual) >= 0.3

const simulator: Simulator = {
  fields: [
    { id: 'riders', label: 'Riders waiting in the hexagon', options: ['4', '8', '16', '30'] },
    { id: 'usual', label: 'Drivers usually online there', options: ['6', '14', '25'] },
    { id: 'offline', label: 'Drivers who went offline in the last 2 minutes', options: ['0', '2', '6', '12'] },
  ],
  defaults: { riders: '8', usual: '14', offline: '12' },
  run(values) {
    const riders = Number(values.riders)
    const usual = Number(values.usual)
    const offline = Math.min(usual, Number(values.offline))
    const online = usual - offline
    const snapshot = surge(riders, online)
    const flagged = isCoordinated(offline, usual)
    // Supply the pricing service trusts: flagged drop-offs don't count as a real shortage.
    const trusted = flagged ? usual : online
    // 10-minute window (the last 2 minutes at the new level) blended 50/50 with the neighbouring hexagons.
    const windowAvg = (8 * usual + 2 * trusted) / 10
    const smoothed = Math.round((0.5 * windowAvg + 0.5 * usual) * 10) / 10
    const multiplier = surge(riders, smoothed)
    const fare = Math.round(BASE_FARE * multiplier)

    const steps: Trace['steps'] = [
      {
        text: `Every Driver App reports its location and status every few seconds through the API Gateway. In the last two minutes, ${offline} of the ${usual} drivers in this hexagon switched to offline.`,
        nodes: ['Driver App', 'API Gateway'],
        data: json({ driver_id: 'd_1042', status: offline ? 'offline' : 'online', lat: 28.5562, lng: 77.1, h3: CELL, at: '2026-10-15T18:02:11Z' }),
      },
      {
        text: `Riders opening the Rider App count as demand in the same hexagon: ${riders} are waiting.`,
        nodes: ['Rider App', 'API Gateway'],
        data: `POST /v1/quotes\n${json({ rider_id: 'r_77', pickup_h3: CELL, dropoff: 'Connaught Place' })}`,
      },
      {
        text: 'Events land in Kafka, and the Stream Processor keeps running counts per H3 hexagon.',
        nodes: ['Kafka (location events)', 'Stream Processor', 'Supply & Demand per H3 Cell'],
        data: json({ h3: CELL, window: '18:00–18:02', riders, drivers_online: online, drivers_usual: usual, went_offline: offline }),
      },
      {
        text: `A naive design would price from this snapshot: ${riders} riders ÷ ${online} drivers gives ${snapshot.toFixed(1)}×. That is the number a coordinated logout tries to trigger.`,
        nodes: ['Supply & Demand per H3 Cell'],
        data: `snapshot multiplier = surge(${riders}, ${online}) = ${snapshot.toFixed(1)}×  → ₹${Math.round(BASE_FARE * snapshot)}`,
      },
      flagged
        ? {
            text: `Coordinated drop-off? Yes: ${offline} drivers (${Math.round((offline / usual) * 100)}% of the hexagon) left within two minutes. Their drop is not treated as a real shortage, and the accounts go to review.`,
            nodes: ['Coordinated Drop-off?'],
            data: `rule: went_offline >= 5 AND went_offline / usual >= 30%\n${offline} >= 5 ✓, ${Math.round((offline / usual) * 100)}% >= 30% ✓ → flagged\nsupply used for pricing = ${trusted}`,
          }
        : {
            text: `Coordinated drop-off? No: ${offline} drivers leaving is normal churn, so the drop counts as real.`,
            nodes: ['Coordinated Drop-off?'],
            data: `went_offline = ${offline} → not flagged\nsupply used for pricing = ${trusted}`,
          },
      {
        text: 'Smooth over Time & Space: average the trusted supply over the last 10 minutes, and blend in the neighbouring hexagons, so a short dip barely moves it.',
        nodes: ['Smooth over Time & Space'],
        data: `10-min average = (8 min × ${usual} + 2 min × ${trusted}) / 10 = ${windowAvg.toFixed(1)}\nneighbours     = ${usual}\nsmoothed       = 0.5 × ${windowAvg.toFixed(1)} + 0.5 × ${usual} = ${smoothed}`,
      },
      {
        text: `The Pricing Service applies the rule to the smoothed supply: ${multiplier.toFixed(1)}× instead of ${snapshot.toFixed(1)}×.`,
        nodes: ['Pricing Service', 'Demand Forecast'],
        data: `multiplier = surge(${riders}, ${smoothed}) = ${multiplier.toFixed(1)}×\nfare = ₹${BASE_FARE} × ${multiplier.toFixed(1)} = ₹${fare}`,
      },
      {
        text: 'The rider gets a Locked Upfront Quote: whatever happens to supply in the next two minutes, this price holds.',
        nodes: ['Locked Upfront Quote', 'Rider App'],
        data: json({ quote_id: 'q_7f3a', fare_inr: fare, multiplier, expires_in_s: 120 }),
      },
      multiplier >= 1.3
        ? {
            text: 'Real demand is high, so the Driver Heatmap shows this hexagon to nearby drivers: supply comes in and the price settles.',
            nodes: ['Driver Heatmap', 'Driver App'],
            data: json({ h3: CELL, level: 'high', message: 'Busy near the airport' }),
          }
        : {
            text: 'With a normal price, Dispatch / Matching simply offers the trip to the nearest driver.',
            nodes: ['Dispatch / Matching', 'Driver App'],
            data: json({ trip_id: 't_5521', offered_to: 'd_2210', eta_min: 3 }),
          },
    ]
    return { input: `${riders} riders, ${usual} drivers usually, ${offline} went offline`, steps }
  },
}

export const uberSurge: StaticTopic = {
  kind: 'static',
  id: 'uber-surge',
  title: 'Uber Surge Pricing & Artificial Scarcity',
  blurb: 'Supply and demand per hexagon, gamed logouts, and how to price robustly',
  video: '/videos/uber-surge.mp4',
  chapters: [
    [0, "Introduction"],
    [4, "How surge works"],
    [25, "Gaming the surge"],
    [49, "Fix 1: smooth the signal"],
    [63, "Fixes 2–4"],
    [81, "Under the hood"],
    [98, "Recap"],
  ],
  guides: [
    "uber-tech-stack",
    "evolution-of-uber's-api-layer",
    "the-ultimate-kafka-101-you-cannot-miss",
    "top-5-kafka-use-cases",
  ],
  takeaways: [
    "Surge compares riders asking with free drivers, per H3 hexagon.",
    "A price driven by live supply can be gamed: a coordinated logout fakes a shortage.",
    "Smooth supply over minutes and neighbouring hexagons, never one snapshot.",
    "Flag many drivers going offline in one place at once.",
    "Lock the rider's price when they request.",
    "Forecast demand and bring drivers in before the spike.",
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'stream', label: 'Real-time pipeline' },
      { id: 'pricing', label: 'Pricing' },
    ],
    nodes: [
      { id: 'driver', label: 'Driver App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'rider', label: 'Rider App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: null },
      { id: 'kafka', label: 'Kafka (location events)', shape: 'rectangle', color: 'orange', group: 'stream' },
      { id: 'processor', label: 'Stream Processor', shape: 'rectangle', color: 'orange', group: 'stream' },
      { id: 'cells', label: 'Supply & Demand per H3 Cell', shape: 'rectangle', color: 'green', group: 'stream' },
      { id: 'detect', label: 'Coordinated Drop-off?', shape: 'diamond', color: 'red', group: 'pricing' },
      { id: 'smooth', label: 'Smooth over Time & Space', shape: 'rectangle', color: 'violet', group: 'pricing' },
      { id: 'forecast', label: 'Demand Forecast', shape: 'rectangle', color: 'light-violet', group: 'pricing' },
      { id: 'pricing', label: 'Pricing Service', shape: 'rectangle', color: 'violet', group: 'pricing' },
      { id: 'quote', label: 'Locked Upfront Quote', shape: 'rectangle', color: 'green', group: null },
      { id: 'heatmap', label: 'Driver Heatmap', shape: 'rectangle', color: 'light-green', group: null },
      { id: 'dispatch', label: 'Dispatch / Matching', shape: 'rectangle', color: 'violet', group: null },
    ],
    edges: [
      { from: 'driver', to: 'gateway', label: 'GPS + status', dashed: false },
      { from: 'rider', to: 'gateway', label: 'quote request', dashed: false },
      { from: 'gateway', to: 'kafka', label: 'events', dashed: false },
      { from: 'kafka', to: 'processor', label: 'consume', dashed: false },
      { from: 'processor', to: 'cells', label: 'count per hexagon', dashed: false },
      { from: 'cells', to: 'detect', label: 'supply drops', dashed: false },
      { from: 'detect', to: 'smooth', label: 'trusted supply', dashed: false },
      { from: 'smooth', to: 'pricing', label: 'smoothed ratio', dashed: false },
      { from: 'forecast', to: 'pricing', label: 'expected demand', dashed: true },
      { from: 'pricing', to: 'quote', label: 'multiplier', dashed: false },
      { from: 'quote', to: 'rider', label: 'price locked', dashed: true },
      { from: 'pricing', to: 'heatmap', label: 'busy zones', dashed: true },
      { from: 'heatmap', to: 'driver', label: 'go here', dashed: true },
      { from: 'quote', to: 'dispatch', label: 'rider confirms', dashed: false },
      { from: 'dispatch', to: 'driver', label: 'trip offer', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'drivers',
        name: 'drivers',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'under_review', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'driver_status_events',
        name: 'driver_status_events',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'driver_id', type: 'uuid', pk: false, fk: 'drivers.id', nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'h3_cell', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(h3_cell, at)', '(driver_id, at)'],
      },
      {
        id: 'surge_snapshots',
        name: 'surge_snapshots',
        columns: [
          { name: 'h3_cell', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'window_start', type: 'timestamptz', pk: true, fk: null, nullable: false, unique: false },
          { name: 'riders', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'drivers_raw', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'drivers_smoothed', type: 'numeric(6,1)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'multiplier', type: 'numeric(3,1)', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'quotes',
        name: 'quotes',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'rider_id', type: 'uuid', pk: false, fk: null, nullable: false, unique: false },
          { name: 'h3_cell', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'multiplier', type: 'numeric(3,1)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'fare', type: 'numeric(10,2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'expires_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(rider_id, expires_at)'],
      },
    ],
    relations: [{ from: 'driver_status_events', to: 'drivers', kind: 'one-to-many', label: 'reports' }],
  },
  explanation: {
    title: 'Uber Surge Pricing & Artificial Scarcity',
    summary:
      'Surge pricing raises the price where riders outnumber free drivers, to pull more drivers in. Because the price reacts to supply, drivers can fake a shortage by going offline together: artificial scarcity. A robust design prices from smoothed, sanity-checked supply and locks the price the rider sees.',
    sections: [
      {
        heading: 'Overview',
        body: 'A ride app is a marketplace with two sides. When riders in one area outnumber free drivers, waits get long. Surge pricing raises the price there, which does two things: some riders wait or choose another option, and drivers nearby head over. Supply and demand meet again.\n\nThe area unit matters. Uber divides cities into hexagons with H3, its open-source grid. Hexagons are used because every neighbour is the same distance away, which makes "this cell and its neighbours" easy to compute.',
      },
      {
        heading: 'The problem: artificial scarcity',
        body: 'The price is a function of supply, so whoever controls supply controls the price. News reports have described drivers at some airports switching off the app together. The map shows no free cars, the price surges, and the drivers switch back on to take the higher fares.\n\nThat is artificial scarcity: the shortage is fake, the price is real. Riders overpay, and the honest signal the system depends on is corrupted. The same weakness applies to any price driven by live supply, like flash sales and ticketing.',
      },
      {
        heading: 'Step by step',
        body: '1. The Driver App sends location and online status every few seconds through the API Gateway.\n2. The Rider App asks for a quote; that request is demand in the rider\'s hexagon.\n3. Events go into Kafka (location events), and the Stream Processor keeps counts per hexagon in Supply & Demand per H3 Cell.\n4. Coordinated Drop-off? checks whether many drivers left one hexagon at once.\n5. Smooth over Time & Space averages trusted supply over minutes and nearby hexagons.\n6. The Pricing Service turns the smoothed ratio, plus the Demand Forecast, into a multiplier.\n7. The rider gets a Locked Upfront Quote, and the Driver Heatmap shows busy zones to drivers.\n8. Dispatch / Matching offers the trip to a nearby driver.',
      },
      {
        heading: 'Fixes',
        body: '- Smooth the signal. Never price from one snapshot. Average supply over a window of minutes and blend in neighbouring hexagons. A sudden dip that lasts two minutes barely moves a 10-minute average.\n- Detect coordination. Normal churn is spread out; a coordinated logout is many drivers, one hexagon, one minute. Leave those drop-offs out of supply and review the accounts.\n- Lock the price. The rider sees one upfront price when they request, valid for a short time, so a manipulated spike a minute later cannot change it.\n- Forecast and nudge. Flights landing, concerts ending and rain are predictable. Use forecasts and heatmaps to bring drivers in before the spike, so there is less shortage to exploit.\n- Change the incentive. Pay drivers bonuses tied to an area and time window rather than the live multiplier at the moment of acceptance, so logging off to spike the price stops paying.',
      },
      {
        heading: 'Components',
        body: '- API Gateway: authenticates the apps and turns their updates into events.\n- Kafka (location events): a durable, ordered stream; hundreds of thousands of drivers sending updates every few seconds is a high-volume write stream that a database should not take directly.\n- Stream Processor: a streaming job (Flink is common) that keeps windowed counts per hexagon in memory.\n- Supply & Demand per H3 Cell: the current counts, kept in a fast key-value store and also written to surge_snapshots for analysis.\n- Coordinated Drop-off?: rules or a model over driver_status_events.\n- Pricing Service: reads smoothed counts and forecasts, and returns a multiplier per hexagon.\n- Locked Upfront Quote: a short-lived quote stored with an expiry, honoured at booking.',
      },
      {
        heading: 'Key decisions',
        body: '- Hexagon size: smaller cells react to local demand but have few drivers each, so the counts are noisy and easier to manipulate. Larger cells are stable but blunt. Smoothing across neighbours gets some of both.\n- Window length: a longer window resists manipulation but reacts more slowly to real spikes, like a stadium emptying. Forecasts help cover the gap.\n- Fairness and caps: many places limit surge during emergencies; the pricing service needs a cap per region.\n- Explainability: store the inputs for every multiplier (surge_snapshots), so you can answer "why was this ride ₹600?".',
      },
      {
        heading: 'Scaling and failure',
        body: '- Partition the Kafka topic by hexagon (or region), so one processor owns the counts for a set of cells and no coordination is needed.\n- If the stream lags, prices go stale. Fail safe: fall back to 1× or the last good value with a short expiry, never to an extreme multiplier.\n- Late and duplicate GPS events happen on mobile networks; count by event time, deduplicate by (driver, timestamp), and tolerate a little lateness.\n- Hot cells (airports, stadiums) get far more events; keep enough processor partitions for them.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you detect a coordinated logout that is spread over 10 minutes instead of 1?\n- How do you choose the hexagon size and the smoothing window?\n- What happens to prices if the stream processor is 2 minutes behind?\n- How would you design surge so that it stays fair during an emergency?\n- How would you prevent riders from gaming it, for example by requesting from a cheaper neighbouring hexagon?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Robust surge multiplier',
        language: 'typescript',
        source: `interface CellWindow {
  riders: number
  usualDrivers: number // typical supply for this cell and hour
  driversPerMinute: number[] // online drivers, last 10 minutes
  wentOfflineLast2Min: number
  neighbourDrivers: number // average supply in the 6 neighbouring cells
}

const surge = (riders: number, drivers: number) =>
  Math.min(3, Math.max(1, 1 + (riders / Math.max(1, drivers) - 1) * 0.4))

export function multiplier(cell: CellWindow): number {
  // 1. Coordinated drop-off: many drivers, one cell, two minutes.
  const coordinated =
    cell.wentOfflineLast2Min >= 5 && cell.wentOfflineLast2Min / cell.usualDrivers >= 0.3
  const recent = coordinated
    ? cell.driversPerMinute.map((d) => Math.max(d, cell.usualDrivers)) // ignore the fake dip
    : cell.driversPerMinute

  // 2. Smooth over time (10-minute average) and space (neighbouring cells).
  const average = recent.reduce((a, b) => a + b, 0) / recent.length
  const supply = 0.5 * average + 0.5 * cell.neighbourDrivers

  return Math.round(surge(cell.riders, supply) * 10) / 10
}`,
      },
      {
        title: 'Spot coordinated drop-offs',
        language: 'sql',
        source: `-- Hexagons where many drivers went offline in the same 2 minutes.
-- Uses the index on driver_status_events(h3_cell, at).
SELECT h3_cell,
       date_bin('2 minutes', at, timestamptz '2026-01-01') AS bucket,
       count(DISTINCT driver_id) AS went_offline,
       array_agg(DISTINCT driver_id) AS drivers
FROM driver_status_events
WHERE status = 'offline'
  AND at > now() - interval '1 hour'
GROUP BY h3_cell, bucket
HAVING count(DISTINCT driver_id) >= 5
ORDER BY went_offline DESC;`,
      },
    ],
    related: ['Stream processing', 'Kafka', 'Geospatial indexing', 'Rate limiting', 'Fraud detection'],
  },
  simulator,
}
