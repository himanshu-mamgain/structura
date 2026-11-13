import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator runs a month of a food-delivery app's traffic, hour by hour, four
// ways: servers you buy, a fixed number of rented EC2 servers, EC2 with Auto Scaling,
// and Lambda. It works out the bill, the requests turned away and how much of what
// you paid for was used. Prices are AWS's on-demand prices in Mumbai (ap-south-1).

const HOURS = 720 // a 30-day month
const PER_SERVER = 200 // requests a second one m6i.large-sized server handles
const EC2_HOUR = 0.101 // m6i.large, on demand, ap-south-1
const OWN_PRICE = 1800 // buying a comparable server
const OWN_MONTH = 70 // $50 of hardware over 3 years + $20 power, cooling, rack space and network
const LAMBDA_PER_REQ = 0.2 / 1e6 + 0.1 * 0.5 * 0.0000166667 // $0.20 per million + 100 ms at 512 MB
const TARGET = 0.7 // Auto Scaling keeps average CPU near 70%
const LAUNCH_MIN = 5 // a new EC2 server boots and passes health checks
const NOTICE_MIN = 30 // someone sees the alarm and adds servers by hand
const RDS_FAILOVER_S = 90 // RDS Multi-AZ switches to its standby in about 1 to 2 minutes
const OUTAGE_DAY = 11 // day 12
const OUTAGE_HOURS = [19, 20] // 7 pm to 9 pm
const SALE_DAY = 19 // day 20
const SALE_HOURS = [10, 11, 12, 13, 14, 15]
const SALE_RPS = 4000

type Traffic = 'steady' | 'evenings' | 'sale'
type Approach = 'own' | 'fixed' | 'auto' | 'lambda'

const TRAFFIC: Record<string, Traffic> = {
  'Steady all day (an API)': 'steady',
  'Busy evenings (food delivery)': 'evenings',
  'Quiet, then a big sale': 'sale',
}
const APPROACH: Record<string, Approach> = {
  'Servers you buy': 'own',
  'Rented EC2 servers, fixed count': 'fixed',
  'EC2 with Auto Scaling': 'auto',
  'Lambda (no servers)': 'lambda',
}
const THEN: Record<string, boolean> = {
  'A normal month': false,
  'A data centre fails for 2 hours': true,
}

// Requests a second for each hour of a normal day.
const EVENING_DAY = [60, 60, 60, 60, 60, 60, 60, 150, 150, 150, 150, 500, 500, 500, 500, 250, 250, 600, 1200, 1200, 1200, 1200, 300, 300]

function demand(t: Traffic, h: number): number {
  const day = Math.floor(h / 24)
  const hour = h % 24
  if (t === 'steady') return 600
  if (t === 'evenings') return EVENING_DAY[hour]
  return day === SALE_DAY && SALE_HOURS.includes(hour) ? SALE_RPS : 300
}

/** The busiest hour you planned for: last month's peak, without a sale nobody predicted. */
const plannedPeak = (t: Traffic) => (t === 'steady' ? 600 : t === 'evenings' ? 1200 : 300)
const fixedCount = (t: Traffic) => Math.max(2, Math.ceil((plannedPeak(t) * 1.3) / PER_SERVER))
const autoCount = (rps: number) => Math.max(2, Math.ceil(rps / (PER_SERVER * TARGET)))

interface Result {
  bill: number
  upfront: number
  turnedAway: number
  serverHours: number
  requests: number
  capacityUsed: number // share of paid capacity that served requests
  saleLost: number
  outageLost: number
  extraNote: string
}

function simulate(t: Traffic, a: Approach, outage: boolean): Result {
  let requests = 0
  let served = 0
  let turnedAway = 0
  let serverHours = 0
  let saleLost = 0
  let outageLost = 0
  let manualExtraHours = 0
  const fixed = fixedCount(t)
  let prevAuto = autoCount(demand(t, 0))
  for (let h = 0; h < HOURS; h++) {
    const rps = demand(t, h)
    const day = Math.floor(h / 24)
    const hour = h % 24
    const isSale = t === 'sale' && day === SALE_DAY && SALE_HOURS.includes(hour)
    const isOutage = outage && day === OUTAGE_DAY && OUTAGE_HOURS.includes(hour)
    const firstOutageHour = isOutage && hour === OUTAGE_HOURS[0]
    requests += rps * 3600
    let lost = 0

    if (a === 'own') {
      // Capacity is what you bought. More takes weeks to arrive.
      serverHours += fixed
      lost = isOutage ? rps * 3600 : Math.max(0, rps - fixed * PER_SERVER) * 3600
    } else if (a === 'fixed') {
      let servers = fixed
      if (isSale) {
        // Someone notices after 30 minutes and adds servers; they take 5 more to start.
        const needed = Math.ceil(rps / PER_SERVER)
        if (hour === SALE_HOURS[0]) lost += Math.max(0, rps - fixed * PER_SERVER) * (NOTICE_MIN + LAUNCH_MIN) * 60
        manualExtraHours += needed - fixed
        servers = needed
      }
      if (isOutage) {
        // Zone A holds half the servers. By hand, they are replaced in Zone B after 35 minutes.
        const left = Math.floor(servers / 2) * PER_SERVER
        if (firstOutageHour) lost += Math.max(0, rps - left) * (NOTICE_MIN + LAUNCH_MIN) * 60 + rps * RDS_FAILOVER_S
      }
      serverHours += servers
    } else if (a === 'auto') {
      const servers = autoCount(rps)
      // New servers take 5 minutes: until then the previous hour's fleet carries the load.
      if (servers > prevAuto) lost += Math.max(0, rps - prevAuto * PER_SERVER) * LAUNCH_MIN * 60
      if (firstOutageHour) {
        const left = Math.floor(servers / 2) * PER_SERVER
        lost += Math.max(0, rps - left) * LAUNCH_MIN * 60 + rps * RDS_FAILOVER_S
      }
      serverHours += servers
      prevAuto = servers
    } else {
      // Lambda runs a copy per request in flight: at 100 ms each, 4,000/s is 400 at once,
      // under the default limit of 1,000. Only the database failover hurts.
      if (firstOutageHour) lost += rps * RDS_FAILOVER_S
    }
    turnedAway += lost
    served += rps * 3600 - lost
    if (isSale) saleLost += lost
    if (isOutage) outageLost += lost
  }
  const bill =
    a === 'own' ? fixed * OWN_MONTH : a === 'lambda' ? requests * LAMBDA_PER_REQ : serverHours * EC2_HOUR
  const capacityUsed = a === 'lambda' ? 1 : served / (serverHours * PER_SERVER * 3600)
  return {
    bill,
    upfront: a === 'own' ? fixed * OWN_PRICE : 0,
    turnedAway,
    serverHours,
    requests,
    capacityUsed,
    saleLost,
    outageLost,
    extraNote: manualExtraHours ? `${manualExtraHours} extra server-hours for the sale ($${(manualExtraHours * EC2_HOUR).toFixed(2)})` : '',
  }
}

const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
const n = (x: number) => Math.round(x).toLocaleString('en-US')
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`
const clock = (h: number) => `${String(h).padStart(2, '0')}:00`

const NODES: Record<Approach, string[]> = {
  own: ['Own Servers'],
  fixed: ['Load Balancer', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
  auto: ['CloudWatch', 'Auto Scaling', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
  lambda: ['Lambda Functions'],
}

const LABEL: Record<Approach, string> = {
  own: 'servers you buy',
  fixed: 'fixed EC2',
  auto: 'EC2 with Auto Scaling',
  lambda: 'Lambda',
}

function setupStep(t: Traffic, a: Approach): Trace['steps'][number] {
  const count = fixedCount(t)
  switch (a) {
    case 'own':
      return {
        text: `You buy ${count} servers, sized for last month's peak plus 30%, and rack them in a data centre you rent space in. That's ${usd(count * OWN_PRICE)} before the first request, and ordering more takes about 6 weeks.`,
        nodes: ['Own Servers'],
        data: `planned peak: ${n(plannedPeak(t))} req/s × 1.3 = ${n(plannedPeak(t) * 1.3)} → ${count} servers × ${PER_SERVER} req/s\nup front: ${count} × ${usd(OWN_PRICE)} = ${usd(count * OWN_PRICE)}\nrunning: ${count} × ${usd(OWN_MONTH)}/month ($50 hardware over 3 years + $20 power, space, network)\nnot counted: the people who look after them`,
      }
    case 'fixed':
      return {
        text: `You rent the same ${count} servers from AWS as EC2 instances (m6i.large, $${EC2_HOUR} an hour each in Mumbai), split across two Availability Zones: separate data centres in the same region. A Load Balancer spreads requests over them. No money up front, and a new server starts in minutes.`,
        nodes: ['Load Balancer', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
        data: `region: ap-south-1 (Mumbai) · zones: ap-south-1a, ap-south-1b\n${count} × m6i.large (2 vCPU, 8 GiB) × $${EC2_HOUR}/hour × ${HOURS} hours = ${usd(count * EC2_HOUR * HOURS)}/month\nup front: $0`,
      }
    case 'auto':
      return {
        text: `You rent EC2 servers through an Auto Scaling group. CloudWatch measures average CPU; when it passes 70% the group adds servers, and when traffic drops it removes them. At least 2 run, one per Availability Zone.`,
        nodes: ['CloudWatch', 'Auto Scaling', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
        data: `min 2 · target average CPU 70% · a new server is ready in about ${LAUNCH_MIN} minutes\nservers needed = ceil(req/s ÷ (${PER_SERVER} × 0.7))\nm6i.large at $${EC2_HOUR}/hour, billed by the second`,
      }
    case 'lambda':
      return {
        text: 'No servers to choose at all. Each request runs a Lambda function for about 100 ms with 512 MB of memory; AWS runs as many copies as there are requests in flight and bills per request and per GB-second.',
        nodes: ['Internet', 'Lambda Functions'],
        data: `$0.20 per million requests + $0.0000166667 per GB-second\n100 ms × 0.5 GB = 0.05 GB-s per request\n→ $${(LAMBDA_PER_REQ * 1e6).toFixed(2)} per million requests\nconcurrency at 4,000 req/s × 0.1 s = 400 (default limit 1,000)`,
      }
  }
}

/** Requests a normal day turns away while Auto Scaling's new servers start. */
function rampLoss(t: Traffic): number {
  let lost = 0
  for (let hour = 0; hour < 24; hour++) {
    const before = autoCount(demand(t, (hour + 23) % 24))
    lost += Math.max(0, demand(t, hour) - before * PER_SERVER) * LAUNCH_MIN * 60
  }
  return lost
}

function dayStep(t: Traffic, a: Approach): Trace['steps'][number] {
  const hours = t === 'steady' ? [3, 13, 20] : t === 'evenings' ? [3, 9, 12, 17, 19, 23] : [3, 13, 20]
  const count = fixedCount(t)
  const rows = hours.map((hour) => {
    const rps = demand(t, hour)
    if (a === 'lambda') return `${clock(hour)}  ${n(rps).padStart(5)} req/s → ${n(rps * 0.1)} copies running`
    const servers = a === 'auto' ? autoCount(rps) : count
    const used = rps / (servers * PER_SERVER)
    return `${clock(hour)}  ${n(rps).padStart(5)} req/s · ${servers} servers · ${Math.round(used * 100)}% busy`
  })
  const text =
    a === 'own' || a === 'fixed'
      ? t === 'evenings'
        ? `On a normal day the dinner rush fits, but the same ${count} servers sit almost idle at night: you pay for the 8 pm peak all day.`
        : `On a normal day traffic is flat, so ${count} servers stay usefully busy around the clock.`
      : a === 'auto'
        ? t === 'evenings'
          ? `The fleet follows the day: 2 servers at night, 9 for dinner, so you pay for the dinner rush only during dinner. The catch is each sudden jump: new servers take ${LAUNCH_MIN} minutes to start, and ${n(rampLoss(t))} requests a day are turned away meanwhile.`
          : 'Traffic is flat, so the group settles at one size and stays there: autoscaling has little to do.'
        : 'Lambda runs exactly as many copies as there are requests in flight, from a handful at night to hundreds at the peak, and you pay only for those.'
  return { text, nodes: ['Customers', ...NODES[a]].slice(0, 4), data: rows.join('\n') }
}

function saleStep(a: Approach, r: Result, t: Traffic): Trace['steps'][number] {
  const count = fixedCount(t)
  const over = SALE_RPS - count * PER_SERVER
  const text = {
    own: `Day 20, 10 am: a sale brings ${n(SALE_RPS)} requests a second for 6 hours. Your ${count} servers handle ${n(count * PER_SERVER)}; more would take 6 weeks to arrive, so ${n(over)} requests a second are turned away all day.`,
    fixed: `Day 20, 10 am: a sale brings ${n(SALE_RPS)} requests a second. After 30 minutes someone notices and starts ${Math.ceil(SALE_RPS / PER_SERVER) - count} more servers, which are ready 5 minutes later. Requests are turned away for those 35 minutes, then everything fits.`,
    auto: `Day 20, 10 am: a sale brings ${n(SALE_RPS)} requests a second. CloudWatch sees the CPU jump and the group grows to ${autoCount(SALE_RPS)} servers on its own. Only the 5 minutes while they start are a problem.`,
    lambda: `Day 20, 10 am: a sale brings ${n(SALE_RPS)} requests a second. Lambda simply runs more copies, 400 at once, still under the default limit of 1,000. Nothing is turned away, though new copies add a short cold start.`,
  }[a]
  const nodes = a === 'own' ? ['Customers', 'Own Servers'] : a === 'lambda' ? ['Customers', 'Lambda Functions'] : a === 'auto' ? ['CloudWatch', 'Auto Scaling', 'EC2 Servers in Zone B'] : ['Load Balancer', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B']
  return { text, nodes, data: `sale: ${n(SALE_RPS)} req/s × 6 hours = ${n(SALE_RPS * 6 * 3600)} requests\nturned away during the sale: ${n(r.saleLost)}${r.extraNote ? `\n${r.extraNote}` : ''}` }
}

function outageStep(a: Approach, r: Result, t: Traffic): Trace['steps'][number] {
  const rps = demand(t, OUTAGE_HOURS[0])
  if (a === 'own')
    return {
      text: `Day 12, 7 pm: the data centre loses power for 2 hours. Your servers and your database are in that one building, so the whole app is down: every request for 2 hours fails.`,
      nodes: ['Own Servers', 'Customers'],
      data: `${n(rps)} req/s × 7,200 s = ${n(r.outageLost)} requests failed\na second data centre would mean buying everything twice`,
    }
  const zoneText =
    a === 'lambda'
      ? 'Lambda already runs in every zone of the region, so it carries on.'
      : a === 'auto'
        ? 'Zone B\'s servers carry on, and the Auto Scaling group starts replacements in Zone B within about 5 minutes.'
        : 'Zone B\'s servers carry on, but with half the capacity until someone starts replacements by hand, 35 minutes later.'
  return {
    text: `Day 12, 7 pm: Availability Zone A goes dark for 2 hours. ${zoneText} The RDS database fails over to its standby copy in Zone B in about 90 seconds; requests that need it fail meanwhile.`,
    nodes: a === 'lambda' ? ['Lambda Functions', 'RDS Primary', 'RDS Standby'] : ['EC2 Servers in Zone A', 'EC2 Servers in Zone B', 'RDS Primary', 'RDS Standby'],
    data: `zone A down: 19:00 to 21:00 at ${n(rps)} req/s\ndatabase failover: ${RDS_FAILOVER_S} s × ${n(rps)} = ${n(rps * RDS_FAILOVER_S)} requests\nturned away in total: ${n(r.outageLost)} (${pct(r.outageLost / (rps * 7200))} of those 2 hours)`,
  }
}

function lesson(t: Traffic, a: Approach, outage: boolean, all: Record<Approach, Result>): string {
  const r = all[a]
  if (outage && a === 'own') return 'One building is one failure away from a full outage. Availability Zones give you several buildings in one region without buying twice.'
  if (t === 'sale' && a === 'own') return 'Capacity you buy is fixed for weeks. The cloud\'s first promise is elasticity: get servers in minutes and give them back after.'
  if (a === 'lambda' && t === 'steady')
    return `Lambda costs ${usd(r.bill)} a month for traffic ${fixedCount(t)} rented servers handle for ${usd(all.fixed.bill)}. Paying per request is cheap when traffic is low or spiky, and expensive when it's high and steady.`
  if (a === 'lambda') return `Lambda never turned a request away for lack of capacity and you managed no servers, for ${usd(r.bill)} against ${usd(all.auto.bill)} with Auto Scaling.`
  if (a === 'auto' && t === 'steady') return `Flat traffic gives Auto Scaling nothing to do, and its 30% headroom costs ${usd(r.bill - all.fixed.bill)} more than fixed servers. For steady load, commit to a Savings Plan instead.`
  if (a === 'auto' && t === 'sale')
    return `Auto Scaling cost ${usd(r.bill - all.fixed.bill)} more than ${fixedCount(t)} fixed servers, mostly for its headroom, but turned away ${n(r.turnedAway)} requests instead of ${n(all.fixed.turnedAway)}. A sale you know about is better met with a scheduled action that adds servers before it starts.`
  if (a === 'auto') return `The bill follows the traffic: ${usd(r.bill)} against ${usd(all.fixed.bill)} for servers sized for the peak. A scheduled action that adds servers at 5:45 pm would avoid most of the requests turned away while new servers start.`
  if (a === 'fixed' && t === 'evenings') return `You paid for the dinner rush all day: only ${pct(r.capacityUsed)} of the capacity you rented did any work. Renting is easy; renting the right amount each hour is what saves money.`
  if (a === 'fixed') return `Renting removed the upfront cost and the 6-week wait, but a fixed fleet still needs a person to react.${t === 'steady' ? ' For steady traffic like this, it is the cheapest way to run on AWS.' : ''}`
  return `No AWS bill, but ${usd(r.upfront)} up front, weeks to grow, and the servers, power and repairs are yours to manage.`
}

const simulator: Simulator = {
  fields: [
    { id: 'traffic', label: 'Traffic', options: Object.keys(TRAFFIC) },
    { id: 'approach', label: 'Run it on', options: Object.keys(APPROACH) },
    { id: 'then', label: 'Then', options: Object.keys(THEN) },
  ],
  defaults: { traffic: 'Busy evenings (food delivery)', approach: 'Servers you buy', then: 'A normal month' },
  run({ traffic, approach, then }) {
    const t = TRAFFIC[traffic] ?? 'evenings'
    const a = APPROACH[approach] ?? 'own'
    const outage = THEN[then] ?? false
    const all = { own: simulate(t, 'own', outage), fixed: simulate(t, 'fixed', outage), auto: simulate(t, 'auto', outage), lambda: simulate(t, 'lambda', outage) }
    const r = all[a]
    const peak = t === 'sale' ? SALE_RPS : plannedPeak(t)
    const steps: Trace['steps'] = [
      {
        text: `Customers order through an app. ${t === 'evenings' ? 'Traffic is low at night and peaks at dinner time.' : t === 'steady' ? 'Traffic is about the same every hour.' : 'Traffic is low and steady, until a sale on day 20 that nobody planned capacity for.'} Over a month that's ${r.requests >= 1e9 ? `${(r.requests / 1e9).toFixed(2)} billion` : `${n(r.requests / 1e6)} million`} requests, and each one has to run on some computer somewhere.`,
        nodes: ['Customers', 'Internet'],
        data: `peak: ${n(peak)} req/s · average: ${n(r.requests / (HOURS * 3600))} req/s\nrequests this month: ${n(r.requests)}\none server handles ${PER_SERVER} req/s`,
      },
      setupStep(t, a),
      dayStep(t, a),
    ]
    if (t === 'sale') steps.push(saleStep(a, r, t))
    if (outage) steps.push(outageStep(a, r, t))
    const bill =
      a === 'own'
        ? `${fixedCount(t)} servers × ${usd(OWN_MONTH)} = ${usd(r.bill)}/month, after ${usd(r.upfront)} up front`
        : a === 'lambda'
          ? `${n(r.requests / 1e6)} million requests × $${(LAMBDA_PER_REQ * 1e6).toFixed(2)} = ${usd(r.bill)}`
          : `${n(r.serverHours)} server-hours × $${EC2_HOUR} = ${usd(r.bill)}`
    steps.push({
      text: `The month's bill: ${usd(r.bill)}${r.upfront ? `, after ${usd(r.upfront)} up front` : ''}. ${a === 'lambda' ? 'You paid only for requests that ran.' : `Of the capacity you paid for, ${pct(r.capacityUsed)} did useful work.`}`,
      nodes: a === 'own' ? ['Own Servers'] : a === 'lambda' ? ['Lambda Functions'] : ['Auto Scaling', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'].slice(a === 'auto' ? 0 : 1),
      data: `${bill}\ncapacity used: ${a === 'lambda' ? '100% (billed per request)' : pct(r.capacityUsed)}\nnot counted: load balancer or API gateway, database, data transfer`,
    })
    steps.push({
      text: `Result: ${usd(r.bill)} for the month, ${r.turnedAway ? `${n(r.turnedAway)} requests turned away (${pct(r.turnedAway / r.requests)})` : 'no requests turned away'}. ${lesson(t, a, outage, all)}`,
      nodes: ['Customers', ...NODES[a]].slice(0, 4),
      data: (Object.keys(all) as Approach[])
        .map((k) => `${k === a ? '→' : ' '} ${LABEL[k].padEnd(22)} ${usd(all[k].bill).padStart(7)}/month${all[k].upfront ? ` + ${usd(all[k].upfront)} up front` : ''} · ${n(all[k].turnedAway)} turned away`)
        .join('\n'),
    })
    return { input: `${traffic} · ${approach}${outage ? ' · zone outage' : ''} → ${usd(r.bill)}/month, ${n(r.turnedAway)} requests turned away`, steps }
  },
}

const run = (traffic: string, approach: string, then = 'A normal month') => ({ traffic, approach, then })

export const awsBasics: StaticTopic = {
  kind: 'static',
  difficulty: 'Beginner',
  id: 'aws-basics',
  title: 'AWS Basics: What the Cloud Is and Why',
  blurb: 'Buying servers vs renting them, regions and Availability Zones, Auto Scaling and Lambda, and what each costs',
  guides: ['what-are-the-most-important-aws-services-to-learn', 'aws-services-cheat-sheet', '2-decades-of-cloud-evolution', 'hidden-costs-of-the-cloud', 'cloud-cost-reduction-techniques', 'how-does-aws-lambda-work-behind-the-scenes'],
  story: {
    title: 'Why a food app stopped buying servers',
    dek: 'Priya runs a food-delivery app in Pune. Its traffic is quiet all night and wild at dinner time. Here is what changed when she moved it to AWS, and what didn\'t.',
    chapters: [
      {
        heading: 'Eight servers and a long wait',
        body: `In the first year Priya bought her own servers. Last month's dinner peak was 1,200 requests a second, one server handles about 200, and she wanted 30% spare: **8 servers**, $14,400 before a single order, racked in a rented data centre. Ordering more took six weeks.

The dinner rush fit. But at 3 a.m. the app gets 60 requests a second, and the same 8 servers hummed along, paid for and almost idle. Over the month only about a quarter of the capacity she bought did any work.`,
        replay: { label: 'Run it on bought servers', values: run('Busy evenings (food delivery)', 'Servers you buy') },
      },
      {
        heading: 'Renting computers by the hour',
        body: `**AWS** (Amazon Web Services) rents out computing: servers, storage, databases and about two hundred other services, by the hour or by the request, started and stopped from a website or an API. A rented server is an **EC2 instance**; an \`m6i.large\` (2 vCPUs, 8 GiB) costs $0.101 an hour in Mumbai.

AWS runs in **regions**, separate areas of the world such as Mumbai (\`ap-south-1\`). Each region has several **Availability Zones**: separate data centres with their own power and network, a few kilometres apart. Priya rented the same 8 servers, four in each of two zones. No money up front, and a new server in minutes. The bill was about the same as owning them, and the servers still sat idle at night.`,
        replay: { label: 'Run it on fixed EC2', values: run('Busy evenings (food delivery)', 'Rented EC2 servers, fixed count') },
      },
      {
        heading: 'Servers that follow the traffic',
        body: `The real change came with **Auto Scaling**. **CloudWatch**, AWS's monitoring service, measures the servers' average CPU. When it passes 70% the Auto Scaling group starts more servers; when traffic falls it stops them. At night 2 run, one per zone. At dinner, 9.

Because EC2 bills by the second, the bill now followed the orders. The catch: a new server takes about 5 minutes to boot and pass health checks, so the first minutes of the rush were tight. A **scheduled action** that adds servers at 5:45 pm fixed that.`,
        replay: { label: 'Run it with Auto Scaling', values: run('Busy evenings (food delivery)', 'EC2 with Auto Scaling') },
      },
      {
        heading: 'The sale nobody planned for',
        body: `Priya's other app, for a grocery chain, ran at a calm 300 requests a second, so it had 2 servers. Then the chain announced a sale on day 20 and **4,000 requests a second** arrived for six hours.

On bought servers there was nothing to do: more hardware was weeks away, and 3,600 requests a second failed for six hours. On fixed EC2, someone noticed after half an hour and started 18 more servers. With Auto Scaling, the group grew on its own within minutes. That's **elasticity**: capacity you get when you need it and give back after.`,
        replay: { label: 'Replay the sale on bought servers', values: run('Quiet, then a big sale', 'Servers you buy') },
      },
      {
        heading: 'When a data centre goes dark',
        body: `Data centres fail: power, cooling, a cut fibre. When Priya's own building lost power for two hours one evening, the whole app went with it, database included.

On AWS her servers were split across two Availability Zones and her **RDS** database (Postgres that AWS runs for her) kept a standby copy in the second zone. When zone A went dark, zone B's servers carried on, Auto Scaling replaced the lost ones there, and RDS switched to the standby in about 90 seconds. Customers saw a minute and a half of errors instead of two hours.

> Spreading across zones is the cheapest reliability you can buy in the cloud.`,
        replay: { label: 'Replay the outage with Auto Scaling', values: run('Busy evenings (food delivery)', 'EC2 with Auto Scaling', 'A data centre fails for 2 hours') },
      },
      {
        heading: 'No servers at all?',
        body: `Then a teammate suggested **Lambda**: no servers, just functions AWS runs per request, billed per request and per millisecond. For the spiky grocery app it was perfect, with nothing to scale and nothing turned away.

For a partner API with a steady 600 requests a second, the maths flipped: about $1,600 a month on Lambda against under $300 for four rented servers that are busy all day. Pay-per-use is cheapest when usage is low or spiky.

The cloud didn't make things free. It turned hardware into a bill that follows what you use, and made choosing the right model, and watching that bill, part of the job.`,
        replay: { label: 'Run steady traffic on Lambda', values: run('Steady all day (an API)', 'Lambda (no servers)') },
      },
    ],
  },
  takeaways: [
    'AWS rents computing (servers, storage, databases and more) by the hour or by the request, with no hardware to buy.',
    'A region is a geographic area like Mumbai; each has several Availability Zones, separate data centres, so spreading across two survives one failing.',
    'Owning servers means paying for your peak up front and waiting weeks for more; renting lets you add capacity in minutes.',
    'Auto Scaling makes the server count, and the bill, follow the traffic; for flat traffic a fixed fleet with a Savings Plan is cheaper.',
    'Lambda bills per request: ideal for low or spiky traffic, expensive for high, steady traffic.',
    'Managed services like RDS hand AWS the running of the software, but you still choose the design and watch the bill.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'onprem', label: 'Your own data centre' },
      { id: 'regional', label: 'AWS Region ap-south-1 (Mumbai)' },
      { id: 'aza', label: 'Availability Zone A' },
      { id: 'azb', label: 'Availability Zone B' },
    ],
    nodes: [
      { id: 'customers', label: 'Customers', shape: 'ellipse', color: 'blue', group: null },
      { id: 'internet', label: 'Internet', shape: 'cloud', color: 'blue', group: null },
      { id: 'own', label: 'Own Servers', shape: 'rectangle', color: 'orange', group: 'onprem' },
      { id: 'lb', label: 'Load Balancer', shape: 'rectangle', color: 'violet', group: 'regional' },
      { id: 'cw', label: 'CloudWatch', shape: 'rectangle', color: 'orange', group: 'regional' },
      { id: 'asg', label: 'Auto Scaling', shape: 'diamond', color: 'violet', group: 'regional' },
      { id: 'lambda', label: 'Lambda Functions', shape: 'rectangle', color: 'violet', group: 'regional' },
      { id: 's3', label: 'S3 Bucket', shape: 'rectangle', color: 'green', group: 'regional' },
      { id: 'ec2a', label: 'EC2 Servers in Zone A', shape: 'rectangle', color: 'violet', group: 'aza' },
      { id: 'rdsa', label: 'RDS Primary', shape: 'rectangle', color: 'green', group: 'aza' },
      { id: 'ec2b', label: 'EC2 Servers in Zone B', shape: 'rectangle', color: 'violet', group: 'azb' },
      { id: 'rdsb', label: 'RDS Standby', shape: 'rectangle', color: 'green', group: 'azb' },
    ],
    edges: [
      { from: 'customers', to: 'internet', label: 'HTTPS', dashed: false },
      { from: 'internet', to: 'own', label: 'before', dashed: true },
      { from: 'internet', to: 'lb', label: 'on AWS', dashed: false },
      { from: 'internet', to: 'lambda', label: 'serverless', dashed: true },
      { from: 'lb', to: 'ec2a', label: 'requests', dashed: false },
      { from: 'lb', to: 'ec2b', label: 'requests', dashed: false },
      { from: 'ec2a', to: 'cw', label: 'CPU metrics', dashed: true },
      { from: 'cw', to: 'asg', label: 'alarm at 70%', dashed: false },
      { from: 'asg', to: 'ec2a', label: 'add / remove', dashed: true },
      { from: 'asg', to: 'ec2b', label: 'add / remove', dashed: true },
      { from: 'ec2a', to: 'rdsa', label: 'SQL', dashed: false },
      { from: 'ec2b', to: 'rdsa', label: 'SQL', dashed: false },
      { from: 'lambda', to: 'rdsa', label: 'SQL', dashed: false },
      { from: 'rdsa', to: 'rdsb', label: 'synchronous copy', dashed: true },
      { from: 'ec2a', to: 's3', label: 'menu photos', dashed: false },
    ],
  },
  database: null,
  explanation: {
    title: 'AWS Basics: What the Cloud Is and Why',
    summary:
      'AWS (Amazon Web Services) rents out computing, such as servers, storage, databases and networking, by the hour or by the request. Instead of buying hardware for your peak and waiting weeks for more, you start what you need in minutes, spread it across data centres, and pay for what you use. The trade-off is a bill that you have to design for and watch.',
    sections: [
      {
        heading: 'Overview',
        body: 'The cloud is someone else\'s data centres, rented through an API:\n- Compute: EC2 (virtual servers), containers (ECS, EKS) and Lambda (functions run per request).\n- Storage: S3 (files of any size), EBS (disks for servers).\n- Databases: RDS (managed Postgres, MySQL and others), DynamoDB (key-value).\n- Networking: VPC (your private network), load balancers, CloudFront (CDN).\n- Security and operations: IAM (who can do what), CloudWatch (metrics, logs, alarms).\n\nAWS is organised into regions, such as Mumbai (ap-south-1), each with several Availability Zones: separate data centres with independent power and networking. You pick the region close to your users and spread across zones for reliability.\n\nThe simulator runs a month of traffic, hour by hour, on servers you buy, on rented EC2 servers, on EC2 with Auto Scaling and on Lambda, and works out the bill, the requests turned away and the capacity actually used.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Serve the app\'s API to customers, with a database and file storage.\n\nNon-functional:\n- Handle the daily peak and an unexpected sale without turning customers away.\n- Survive one data centre failing.\n- Pay for what is used, not for idle machines.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Food-delivery traffic: 60 req/s at night, 1,200 req/s at dinner; about 1.03 billion requests a month.\n- One server (m6i.large) handles about 200 req/s: 8 servers for the peak plus 30%.\n- Bought: 8 × $1,800 = $14,400 up front, then 8 × $70 = $560 a month.\n- Rented, fixed: 8 × $0.101 × 720 hours = $582 a month.\n- Auto Scaling at 70% CPU: 2 to 9 servers, 2,670 server-hours ≈ $270 a month.\n- Lambda at 100 ms and 512 MB: about $1.03 per million requests ≈ $1,062 a month.\n- Only 24.8% of the capacity of 8 fixed servers is used over a day; Auto Scaling uses 53%.',
      },
      {
        heading: 'Step by step',
        body: '1. Customers send requests over the Internet.\n2. Before the cloud, they reach Own Servers in a single data centre.\n3. On AWS, the Load Balancer spreads them across EC2 Servers in Zone A and EC2 Servers in Zone B.\n4. CloudWatch watches their CPU; Auto Scaling adds or removes servers to keep it near 70%.\n5. Alternatively, Lambda Functions run one copy per request with no servers to manage.\n6. Every option reads and writes the RDS Primary, which keeps an RDS Standby in the other zone, and stores files in the S3 Bucket.',
      },
      {
        heading: 'Components',
        body: '- Customers: people using the app.\n- Internet: the public network between them and the servers.\n- Own Servers: hardware you buy and run in your own or a rented data centre.\n- Load Balancer: spreads requests over healthy servers in several zones.\n- CloudWatch: AWS\'s metrics, logs and alarms.\n- Auto Scaling: keeps the number of servers in line with a target, such as 70% CPU.\n- Lambda Functions: code AWS runs per request, billed per request and per millisecond.\n- S3 Bucket: object storage for files such as menu photos.\n- EC2 Servers in Zone A: rented virtual servers in the first data centre.\n- RDS Primary: the managed database that serves reads and writes.\n- EC2 Servers in Zone B: rented virtual servers in a second, independent data centre.\n- RDS Standby: a synchronous copy of the database that takes over if the primary\'s zone fails.',
      },
      {
        heading: 'Key decisions',
        body: '- Buy or rent: owning can be cheaper for large, steady, predictable load, if you have people to run it; renting wins on speed, elasticity and reliability.\n- Region: close to your users (latency), and where your data is allowed to live.\n- Two or more Availability Zones for anything that must stay up.\n- Pricing model: On-Demand for flexibility, Savings Plans or Reserved Instances (a 1- or 3-year commitment for a lower price) for steady load, Spot (spare capacity, up to 90% cheaper, can be taken back) for work that can be interrupted.\n- Servers, containers or functions: Lambda for spiky or low traffic and glue code, servers or containers for high, steady traffic.\n- Managed services (RDS, S3) over running your own on EC2 when you\'d rather not patch and back up databases yourself.\n- Shared responsibility: AWS secures the hardware and data centres; you secure your accounts, data, network rules and code.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Zone failure: spread servers and databases across zones; a load balancer stops sending traffic to an unhealthy zone.\n- Region failure is rarer; surviving it needs a second region and is a disaster-recovery decision.\n- New servers take minutes to start: schedule capacity ahead of known peaks.\n- Service quotas (such as Lambda\'s default 1,000 concurrent executions) can be raised, but only if you ask before you need them.\n- Bills surprise people: data transfer out, NAT gateways and forgotten resources. Set an AWS Budget with an alert on day one.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the difference between a region and an Availability Zone?\n- When is buying servers cheaper than the cloud?\n- How does Auto Scaling decide how many servers to run, and what goes wrong in the first minutes of a spike?\n- When would you choose Lambda over EC2, and when not?\n- What does AWS secure, and what is still your job?\n- How would you keep a cloud bill under control?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'First look with the AWS CLI (bash)',
        language: 'bash',
        source: `# Who am I signed in as?
aws sts get-caller-identity

# The Availability Zones in Mumbai
aws ec2 describe-availability-zones --region ap-south-1 \\
  --query 'AvailabilityZones[].ZoneName' --output text
# ap-south-1a  ap-south-1b  ap-south-1c

# A bucket for files, then upload one
aws s3 mb s3://priya-menu-photos-2026 --region ap-south-1
aws s3 cp paneer-tikka.jpg s3://priya-menu-photos-2026/menus/`,
      },
      {
        title: 'Renting a server (bash)',
        language: 'bash',
        source: `# Start one m6i.large running the latest Amazon Linux, in zone A's subnet.
aws ec2 run-instances --region ap-south-1 \\
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \\
  --instance-type m6i.large \\
  --subnet-id subnet-0a1b2c3d4e5f60718 \\
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=orders-api}]'

# Billed by the second while it runs; stop paying when you terminate it.
aws ec2 terminate-instances --instance-ids i-0123456789abcdef0`,
      },
      {
        title: 'Auto Scaling on CPU (bash)',
        language: 'bash',
        source: `# Keep the group's average CPU near 70%: AWS adds and removes servers to do it.
aws autoscaling put-scaling-policy \\
  --auto-scaling-group-name orders-api \\
  --policy-name cpu-70 \\
  --policy-type TargetTrackingScaling \\
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": { "PredefinedMetricType": "ASGAverageCPUUtilization" },
    "TargetValue": 70
  }'

# The dinner rush is predictable: have 9 servers ready at 5:45 pm IST every day.
aws autoscaling put-scheduled-update-group-action \\
  --auto-scaling-group-name orders-api --scheduled-action-name dinner \\
  --recurrence "45 17 * * *" --time-zone "Asia/Kolkata" --min-size 9
aws autoscaling put-scheduled-update-group-action \\
  --auto-scaling-group-name orders-api --scheduled-action-name after-dinner \\
  --recurrence "0 22 * * *" --time-zone "Asia/Kolkata" --min-size 2`,
      },
      {
        title: 'The same endpoint as a Lambda (TypeScript)',
        language: 'typescript',
        source: `import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

// AWS runs one copy per request in flight and bills per request and per millisecond.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const restaurantId = event.pathParameters?.id
  if (!restaurantId) return { statusCode: 400, body: 'missing restaurant id' }
  const menu = await loadMenu(restaurantId) // reads from RDS or DynamoDB
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(menu) }
}

declare function loadMenu(id: string): Promise<unknown>`,
      },
    ],
    related: ['IAM', 'VPC networking', 'Application Load Balancer', 'ECS on Fargate', 'Scaling to millions of users'],
  },
  simulator,
}
