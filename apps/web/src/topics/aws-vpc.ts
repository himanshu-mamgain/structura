import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from terraform-aws-modules/terraform-aws-vpc (Apache License 2.0): the
// three subnet tiers per availability zone and the NAT gateway scenarios (single,
// one per zone) follow the module's documented options. The subnet calculator,
// route lookups, walkthrough, costs and story are Structura's.

// ---------- addresses ----------

const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
const toIp = (n: number) => [3, 2, 1, 0].map((i) => Math.floor(n / 256 ** i) % 256).join('.')
const int = (n: number) => Math.round(n).toLocaleString('en-US')
const rate = (n: number) => `$${n.toFixed(3)}`
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** AWS keeps 5 addresses in every subnet: network, VPC router (+1), DNS (+2), future use (+3) and the last one. */
const RESERVED = 5

interface Subnet {
  tier: 'public' | 'private' | 'database'
  zone: string
  base: number
  prefix: number
}

const cidr = (s: Subnet) => `${toIp(s.base)}/${s.prefix}`
const size = (prefix: number) => 2 ** (32 - prefix)

/** Like Terraform's cidrsubnet(): carve equal subnets out of the VPC range, tier by tier. */
function plan(vpcBase: number, vpcPrefix: number, subnetPrefix: number, zones: string[]) {
  const tiers: Subnet['tier'][] = ['public', 'private', 'database']
  const needed = tiers.length * zones.length
  const slots = subnetPrefix >= vpcPrefix ? 2 ** (subnetPrefix - vpcPrefix) : 0
  if (needed > slots) return { ok: false as const, needed, slots }
  const subnets: Subnet[] = []
  tiers.forEach((tier, t) => zones.forEach((zone, z) => subnets.push({ tier, zone, base: vpcBase + (t * zones.length + z) * size(subnetPrefix), prefix: subnetPrefix })))
  return { ok: true as const, needed, slots, subnets }
}

// ---------- prices (us-east-1 list prices) ----------

const NAT_HOUR = 0.045
const NAT_GB = 0.045
const CROSS_AZ_GB = 0.01 // charged on each side
const HOURS = 730
const API_GB = 500 // a month of calls to outside APIs, requests and responses
const S3_GB = 30_000 // a month of reads and writes to S3 (backups, uploads)

const EXTERNAL = '203.0.113.10' // documentation address standing in for a payment provider's API

const simulator: Simulator = {
  fields: [
    { id: 'vpc', label: 'VPC range', options: ['10.0.0.0/16 (65,536 addresses)', '10.0.0.0/20 (4,096 addresses)'] },
    { id: 'zones', label: 'Availability zones', options: ['3 zones', '2 zones'] },
    { id: 'subnet', label: 'Subnet size', options: ['/24 (256 addresses)', '/20 (4,096 addresses)'] },
    { id: 'nat', label: 'NAT gateways', options: ['One NAT gateway', 'One NAT gateway per zone', 'No NAT gateway'] },
    { id: 'flow', label: 'Follow', options: ['A visitor opens the website', 'A task calls an external API', 'A task reads from S3'] },
    { id: 'outage', label: 'Zones', options: ['All zones healthy', 'Zone a goes down'] },
  ],
  defaults: { vpc: '10.0.0.0/16 (65,536 addresses)', zones: '3 zones', subnet: '/24 (256 addresses)', nat: 'One NAT gateway', flow: 'A visitor opens the website', outage: 'All zones healthy' },
  run(v) {
    const vpcPrefix = v.vpc.includes('/20 ') ? 20 : 16
    const vpcBase = toInt('10.0.0.0')
    const vpcCidr = `10.0.0.0/${vpcPrefix}`
    const zones = v.zones.startsWith('2') ? ['a', 'b'] : ['a', 'b', 'c']
    const subnetPrefix = v.subnet.startsWith('/20') ? 20 : 24
    const nat: 'single' | 'per-zone' | 'none' = v.nat.startsWith('No') ? 'none' : v.nat.includes('per zone') ? 'per-zone' : 'single'
    const down = v.outage.startsWith('Zone a')
    const steps: Trace['steps'] = []
    const p = plan(vpcBase, vpcPrefix, subnetPrefix, zones)

    if (!p.ok) {
      steps.push({
        text: `The plan doesn't fit. A ${vpcCidr} VPC has room for ${p.slots} subnet${p.slots === 1 ? '' : 's'} of /${subnetPrefix}, but 3 tiers × ${zones.length} zones need ${p.needed}. A VPC's main range can't be changed after creation (you can only add secondary ranges), so this is the moment to choose a bigger range or smaller subnets.`,
        nodes: ['Public Route Table', 'Private Route Table'],
        data: `${vpcCidr} = ${int(size(vpcPrefix))} addresses\n/${subnetPrefix} subnet = ${int(size(subnetPrefix))} addresses\nfits: ${int(size(vpcPrefix))} ÷ ${int(size(subnetPrefix))} = ${p.slots}; needed: ${p.needed}`,
      })
      steps.push({
        text: 'Common fixes: use a /16 for the VPC, which leaves room to grow, or /24 subnets inside a smaller VPC. Pick a range that doesn\'t overlap your office network or other VPCs, or you can\'t connect them later.',
        nodes: ['App Tasks (zone a)', 'App Tasks (zone b)'],
        data: `10.0.0.0/16 with /24 subnets: 256 slots, ${p.needed} used\n10.0.0.0/20 with /24 subnets: 16 slots, ${p.needed} used`,
      })
      return { input: `${vpcCidr} · ${zones.length} zones · /${subnetPrefix} → doesn't fit (${p.needed} subnets, room for ${p.slots})`, steps }
    }

    const subnets = p.subnets
    const sub = (tier: Subnet['tier'], zone: string) => subnets.find((s) => s.tier === tier && s.zone === zone)!
    const usable = size(subnetPrefix) - RESERVED
    const natZones = nat === 'none' ? [] : nat === 'single' ? ['a'] : zones
    steps.push({
      text: `The VPC ${vpcCidr} is cut into ${subnets.length} subnets: a public, a private and a database subnet in each of ${zones.length} availability zones (separate data centres). AWS keeps 5 addresses in every subnet, so each /${subnetPrefix} has ${int(usable)} usable. Every Fargate task takes one address, so a private subnet can hold at most ${int(usable)} tasks.`,
      nodes: ['Load Balancer', 'App Tasks (zone a)', 'App Tasks (zone b)', 'Database (primary)'],
      data: [
        ...(['public', 'private', 'database'] as const).map((t) => `${t.padEnd(9)} ${zones.map((z) => `${z}: ${cidr(sub(t, z))}`).join('   ')}`),
        `reserved in ${cidr(sub('private', 'a'))}: ${[0, 1, 2, 3].map((i) => toIp(sub('private', 'a').base + i)).join(', ')}, ${toIp(sub('private', 'a').base + size(subnetPrefix) - 1)}`,
        `used: ${int(subnets.length * size(subnetPrefix))} of ${int(size(vpcPrefix))} addresses`,
      ].join('\n'),
    })

    const task = (z: string) => toIp(sub('private', z).base + 25)
    const route = (dest: string, table: 'public' | 'private' | 'database', zone: string) => {
      // Longest prefix wins: the S3 prefix list is more specific than 0.0.0.0/0.
      const rows: { dest: string; target: string; prefix: number; match: boolean }[] = [{ dest: vpcCidr, target: 'local', prefix: vpcPrefix, match: dest !== 's3' && dest !== EXTERNAL && Math.floor(toInt(dest) / size(vpcPrefix)) === Math.floor(vpcBase / size(vpcPrefix)) }]
      if (table === 'public') rows.push({ dest: '0.0.0.0/0', target: 'igw', prefix: 0, match: true })
      if (table === 'private') {
        rows.push({ dest: 'pl-s3 (S3 prefix list)', target: 'vpce-s3', prefix: 16, match: dest === 's3' })
        const natZone = nat === 'single' ? 'a' : zone
        if (nat !== 'none') rows.push({ dest: '0.0.0.0/0', target: `nat-${natZone}`, prefix: 0, match: true })
      }
      const hit = rows.filter((r) => r.match).sort((a, b) => b.prefix - a.prefix)[0]
      return { rows, hit }
    }
    const table = (rows: { dest: string; target: string }[], hit?: { dest: string }) => rows.map((r) => `${r.dest.padEnd(24)} → ${r.target}${hit && r.dest === hit.dest ? '   ← match' : ''}`).join('\n')

    let ok = true
    let summary = ''
    const zone = down ? 'b' : 'a'
    if (v.flow.startsWith('A visitor')) {
      const alive = zones.filter((z) => !(down && z === 'a'))
      steps.push({
        text: `A visitor's browser resolves the site to the load balancer, which has a node in every public subnet. The Internet Gateway lets traffic in to anything in a public subnet that has a public address.${down ? ' Zone a is down; DNS stops returning its node, so visitors reach the nodes in the other zones.' : ''}`,
        nodes: ['Visitor', 'Internet', 'Internet Gateway', 'Load Balancer'],
        data: `load balancer nodes: ${alive.map((z) => `${toIp(sub('public', z).base + 10)} (zone ${z})`).join(', ')}${down ? '\nzone a: down' : ''}`,
      })
      const r = route(task(zone), 'public', zone)
      steps.push({
        text: `The load balancer forwards the request to a task in a private subnet. The destination is inside the VPC range, so the public subnet's route table matches the local route: traffic inside a VPC never leaves it. The task has no public address and can't be reached from the internet directly.`,
        nodes: ['Load Balancer', 'Public Route Table', `App Tasks (zone ${zone})`],
        data: `to ${task(zone)}\n${table(r.rows, r.hit)}`,
      })
      steps.push({
        text: `The task reads the order from the database in a database subnet, again by the local route. Database subnets have no route to the internet at all, in either direction.`,
        nodes: [`App Tasks (zone ${zone})`, 'Database (primary)', 'Database (standby)'],
        data: `to ${toIp(sub('database', 'a').base + 50)}:5432 → local\n${table(route('10.0.0.1', 'database', 'a').rows)}`,
      })
      summary = down ? `serving from ${alive.length} of ${zones.length} zones (${Math.round((alive.length / zones.length) * 100)}% capacity)` : 'served'
    } else {
      const s3 = v.flow.includes('S3')
      const dest = s3 ? 's3' : EXTERNAL
      const r = route(dest, 'private', zone)
      steps.push({
        text: `A task in zone ${zone} (${task(zone)}) ${s3 ? 'writes a backup to S3' : `calls the payment provider's API at ${EXTERNAL}`}. The private subnet's route table picks the most specific matching route.${down ? ' Zone a is down, so this is a task in zone b.' : ''}`,
        nodes: [`App Tasks (zone ${zone})`, 'Private Route Table'],
        data: `to ${s3 ? 'S3' : EXTERNAL}\n${table(r.rows, r.hit)}`,
      })
      if (s3) {
        steps.push({
          text: 'The S3 prefix list is more specific than 0.0.0.0/0, so traffic goes to the S3 gateway endpoint and straight to S3 over AWS\'s network: no NAT gateway, no internet, and no data charge.',
          nodes: ['Private Route Table', 'S3 Gateway Endpoint', 'S3'],
          data: `${int(S3_GB)} GB a month to S3\nthrough the gateway endpoint: $0.00\nthrough a NAT gateway it would cost ${int(S3_GB)} × ${rate(NAT_GB)} = ${usd(S3_GB * NAT_GB)} a month`,
        })
        summary = 'reached S3, free'
      } else if (!r.hit || r.hit.target === 'local') {
        ok = false
        steps.push({
          text: 'There is no NAT gateway, so nothing matches 0.0.0.0/0: the packet has nowhere to go and is dropped. Private subnets can still reach S3 and other AWS services through VPC endpoints, but not the internet.',
          nodes: ['Private Route Table', `App Tasks (zone ${zone})`],
          data: `to ${EXTERNAL}: no matching route → dropped\nfix: a NAT gateway, or an interface endpoint if the service offers one`,
        })
        summary = 'no route: call fails'
      } else {
        const natZone = r.hit.target.slice(4)
        const natUp = !(down && natZone === 'a')
        const crossAz = natZone !== zone
        steps.push({
          text: natUp
            ? `The route sends the packet to the NAT gateway in zone ${natZone}${crossAz ? `, in another zone: that crossing costs ${rate(CROSS_AZ_GB)} a GB on each side` : ', in the same zone'}. The NAT gateway replaces the task's private address with its own Elastic IP, then the public route table sends it out through the Internet Gateway. Replies come back the same way; nobody outside can start a connection in.`
            : 'The route points at the NAT gateway in zone a, and zone a is down. The task in zone b is healthy, but every call to the internet fails: one NAT gateway is a single point of failure for every zone.',
          nodes: natUp ? [`NAT Gateway (zone ${natZone === 'a' ? 'a' : 'b'})`, 'Public Route Table', 'Internet Gateway', 'External API'] : ['NAT Gateway (zone a)', 'Private Route Table', 'App Tasks (zone b)'],
          data: natUp
            ? `source ${task(zone)} → ${toIp(sub('public', natZone).base + 20)} (NAT) → Elastic IP 198.51.100.7\n${table(route(EXTERNAL, 'public', natZone).rows, { dest: '0.0.0.0/0' })}`
            : `nat-a: unreachable (zone a down)\ncalls from zones ${zones.filter((z) => z !== 'a').join(' and ')}: failing`,
        })
        ok = natUp
        summary = natUp ? `reached the API through nat-${natZone}${crossAz ? ' (cross-zone)' : ''}` : 'NAT gateway down: call fails'
      }
    }

    const natMonthly = natZones.length * NAT_HOUR * HOURS
    const crossShare = nat === 'single' ? (zones.length - 1) / zones.length : 0
    const processing = nat === 'none' ? 0 : API_GB * NAT_GB
    const cross = API_GB * crossShare * CROSS_AZ_GB * 2
    steps.push({
      text: `What the egress design costs a month at us-east-1 list prices: NAT gateways are charged by the hour and by the GB, and with a single NAT gateway, traffic from the other zones also pays to cross zones.`,
      nodes: nat === 'none' ? ['S3 Gateway Endpoint', 'Private Route Table'] : nat === 'single' ? ['NAT Gateway (zone a)', 'Private Route Table'] : ['NAT Gateway (zone a)', 'NAT Gateway (zone b)', 'Private Route Table'],
      data: [
        `NAT gateways: ${natZones.length} × ${HOURS} h × ${rate(NAT_HOUR)} = ${usd(natMonthly)}`,
        `processing: ${int(nat === 'none' ? 0 : API_GB)} GB to outside APIs × ${rate(NAT_GB)} = ${usd(processing)}`,
        `cross-zone: ${int(API_GB * crossShare)} GB × ${rate(CROSS_AZ_GB)} × 2 sides = ${usd(cross)}`,
        `S3 through the gateway endpoint: $0.00`,
        `total: ${usd(natMonthly + processing + cross)} a month${down && nat === 'single' ? '; survives losing zone a: no' : nat === 'per-zone' ? '; survives losing a zone: yes' : ''}`,
      ].join('\n'),
    })

    return {
      input: `${vpcCidr} · ${zones.length} zones · /${subnetPrefix} · ${nat === 'none' ? 'no NAT' : nat === 'single' ? '1 NAT' : `${zones.length} NATs`}${down ? ' · zone a down' : ''} → ${ok ? '✓' : '✗'} ${summary} · ${usd(natMonthly + processing + cross)}/month egress`,
      steps,
    }
  },
}

const run = (o: Partial<Record<'vpc' | 'zones' | 'subnet' | 'nat' | 'flow' | 'outage', string>>) => ({ ...simulator.defaults, ...o })

export const awsVpc: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'aws-vpc',
  title: 'AWS VPC Networking',
  blurb: 'Your own network in AWS: CIDR ranges, public and private subnets, route tables, NAT gateways and endpoints',
  adaptedFrom: {
    title: 'terraform-aws-vpc',
    author: 'terraform-aws-modules (Anton Babenko and contributors)',
    url: 'https://github.com/terraform-aws-modules/terraform-aws-vpc',
    license: 'Apache License 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  guides: ['tf-aws-vpc', 'tf-aws-vpc-simple', 'tf-aws-vpc-complete', 'tf-aws-vpc-endpoints', 'tf-aws-vpc-flow-log', 'aws-ecs-fullstack-infrastructure'],
  story: {
    title: 'The NAT gateway that took three zones down',
    dek: 'A startup builds its first real network in AWS, then learns what a route table decides, what a NAT gateway costs and why "highly available" needs more than one of everything.',
    chapters: [
      {
        heading: 'A network of your own',
        body: `For its first year, a small bill-payments startup in Pune ran on one server in the default network AWS gives every account. Every machine had a public address. When their first enterprise customer sent a security questionnaire, "Is your database reachable from the internet?" had an uncomfortable answer.

So Kiran, their only infrastructure engineer, built a **VPC** (virtual private cloud): a private network with an address range they chose, \`10.0.0.0/16\`, 65,536 addresses. She cut it into **subnets**, one smaller range per purpose in each of three **availability zones**, separate data centres in the same region:
- **public** subnets for the load balancer
- **private** subnets for the app's containers
- **database** subnets for Postgres

What makes a subnet public is not its name. It's its **route table**: a public subnet has a route \`0.0.0.0/0 → internet gateway\`, and a private one doesn't. Visitors now reach only the load balancer; it forwards to the app over the VPC's local route, and the database has no route to the internet at all.

One surprise: each /24 subnet has 256 addresses, but only 251 are usable. AWS keeps five in every subnet, for the network address, the VPC router, DNS, future use and broadcast.`,
        replay: { label: 'Follow a visitor in', values: run({}) },
      },
      {
        heading: 'Private, but still reaching out',
        body: `The app had to call their payment provider's API. From a private subnet, with no route to the internet, every call failed.

The answer is a **NAT gateway** (network address translation) in a public subnet. The private route table sends \`0.0.0.0/0\` to it; it swaps the container's private address for its own public Elastic IP and sends the request out through the internet gateway. Replies find their way back, but nobody outside can open a connection in. The payment provider even let them allow-list that single Elastic IP.`,
        replay: { label: 'Follow a call to the payment API', values: run({ flow: 'A task calls an external API' }) },
      },
      {
        heading: 'A $1,350 line on the bill',
        body: `The next month's bill had a line nobody expected: NAT gateway data processing. The app wrote nightly backups and customer uploads to S3, 30 TB a month, and all of it went through the NAT gateway at $0.045 a GB:
- 30,000 GB × $0.045 = **$1,350** a month, to reach a service in the same region

The fix was free. A **gateway endpoint** for S3 adds a route for S3's address ranges to the private route tables. That route is more specific than \`0.0.0.0/0\`, so it wins, and S3 traffic stays on AWS's network with no NAT and no processing charge.`,
        replay: { label: 'Follow a backup to S3', values: run({ flow: 'A task reads from S3' }) },
      },
      {
        heading: 'The zone that took everything with it',
        body: `To save money, Kiran had created one NAT gateway, in zone a, and pointed all three private route tables at it. That's the default in many examples, and it cost $32.85 a month.

Then zone a had a power problem. The app kept running in zones b and c, and the load balancer moved visitors there, but every call to the payment provider failed. The NAT gateway those zones depended on was in the zone that was down.

> High availability means every zone can work without the others. One shared NAT gateway quietly undoes that.

She moved to **one NAT gateway per zone**, each private route table pointing at the NAT gateway in its own zone. It costs $65.70 a month more, and it also removed the cross-zone data charge for traffic from zones b and c.`,
        replay: { label: 'Replay zone a going down', values: run({ flow: 'A task calls an external API', outage: 'Zone a goes down' }) },
      },
      {
        heading: 'Running out of addresses',
        body: `Two years later, the team ran about 200 containers per zone on Fargate, where every task gets its own network interface and its own address. A routine deploy started a full set of new tasks before stopping the old ones, which briefly needs 400 addresses in each zone.

Each private /24 has 251. New tasks sat stuck in PENDING with "insufficient free addresses in subnet", and the deploy timed out.

Because the VPC was a /16, there was room to add new /20 private subnets (4,091 usable addresses each) and move the services over. Had they picked a /20 for the whole VPC on day one, there would have been nowhere to go.

> Choose a big VPC range that won't overlap anything you'll connect to, and keep subnets for containers generously sized.`,
        replay: { label: 'Try /20 subnets in a /20 VPC', values: run({ vpc: '10.0.0.0/20 (4,096 addresses)', subnet: '/20 (4,096 addresses)' }) },
      },
    ],
  },
  takeaways: [
    'A VPC is your own address range in a region, split into subnets that each live in one availability zone.',
    'A subnet is public only because its route table sends 0.0.0.0/0 to an internet gateway; private subnets have no such route.',
    'Private subnets reach the internet through a NAT gateway, which allows outbound connections only.',
    'Gateway endpoints for S3 and DynamoDB are free and skip the NAT gateway\'s per-GB charge.',
    'Put a NAT gateway in each zone, or one zone\'s failure can cut off the others.',
    'AWS reserves 5 addresses per subnet, and every Fargate task uses one, so size container subnets generously.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'public', label: 'Public subnets' },
      { id: 'private', label: 'Private subnets' },
      { id: 'database', label: 'Database subnets' },
    ],
    nodes: [
      { id: 'visitor', label: 'Visitor', shape: 'ellipse', color: 'blue', group: null },
      { id: 'internet', label: 'Internet', shape: 'cloud', color: 'blue', group: null },
      { id: 'igw', label: 'Internet Gateway', shape: 'rectangle', color: 'violet', group: null },
      { id: 'alb', label: 'Load Balancer', shape: 'rectangle', color: 'violet', group: 'public' },
      { id: 'pubrt', label: 'Public Route Table', shape: 'diamond', color: 'violet', group: 'public' },
      { id: 'nata', label: 'NAT Gateway (zone a)', shape: 'rectangle', color: 'violet', group: 'public' },
      { id: 'natb', label: 'NAT Gateway (zone b)', shape: 'rectangle', color: 'violet', group: 'public' },
      { id: 'taska', label: 'App Tasks (zone a)', shape: 'rectangle', color: 'orange', group: 'private' },
      { id: 'taskb', label: 'App Tasks (zone b)', shape: 'rectangle', color: 'orange', group: 'private' },
      { id: 'privrt', label: 'Private Route Table', shape: 'diamond', color: 'violet', group: 'private' },
      { id: 'vpce', label: 'S3 Gateway Endpoint', shape: 'rectangle', color: 'violet', group: 'private' },
      { id: 's3', label: 'S3', shape: 'rectangle', color: 'green', group: null },
      { id: 'api', label: 'External API', shape: 'cloud', color: 'violet', group: null },
      { id: 'db', label: 'Database (primary)', shape: 'rectangle', color: 'green', group: 'database' },
      { id: 'dbs', label: 'Database (standby)', shape: 'rectangle', color: 'green', group: 'database' },
    ],
    edges: [
      { from: 'visitor', to: 'internet', label: 'https', dashed: false },
      { from: 'internet', to: 'igw', label: 'in', dashed: false },
      { from: 'igw', to: 'alb', label: 'public address', dashed: false },
      { from: 'alb', to: 'taska', label: 'local route', dashed: false },
      { from: 'alb', to: 'taskb', label: 'local route', dashed: false },
      { from: 'taska', to: 'privrt', label: 'outbound', dashed: false },
      { from: 'taskb', to: 'privrt', label: 'outbound', dashed: false },
      { from: 'privrt', to: 'vpce', label: 'S3 prefix list', dashed: false },
      { from: 'vpce', to: 's3', label: 'AWS network', dashed: false },
      { from: 'privrt', to: 'nata', label: '0.0.0.0/0', dashed: false },
      { from: 'privrt', to: 'natb', label: '0.0.0.0/0 (zone b)', dashed: true },
      { from: 'nata', to: 'pubrt', label: 'from Elastic IP', dashed: false },
      { from: 'natb', to: 'pubrt', label: 'from Elastic IP', dashed: false },
      { from: 'pubrt', to: 'igw', label: '0.0.0.0/0', dashed: false },
      { from: 'igw', to: 'api', label: 'out', dashed: false },
      { from: 'taska', to: 'db', label: '5432', dashed: false },
      { from: 'taskb', to: 'db', label: '5432', dashed: false },
      { from: 'db', to: 'dbs', label: 'sync replica', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'AWS VPC Networking',
    summary:
      'A VPC (virtual private cloud) is a private network in an AWS region with an address range you choose. You split it into subnets in several availability zones, and route tables decide where traffic from each subnet can go: to the internet, through a NAT gateway, to an AWS service endpoint, or only inside the VPC.',
    sections: [
      {
        heading: 'Overview',
        body: 'Everything you run in AWS that has a network address (containers, servers, databases, load balancers) lives in a VPC. You choose its range in CIDR notation: 10.0.0.0/16 means the first 16 bits are fixed, leaving 2^16 = 65,536 addresses.\n\nThe VPC is divided into subnets, each in one availability zone (AZ), an isolated data centre within the region. A subnet\'s route table decides what it can reach. The usual layout has three tiers in every zone: public subnets for load balancers and NAT gateways, private subnets for the application, and database subnets with no internet route at all.\n\nThe simulator really carves the subnets, looks up each route by longest prefix match and works out the monthly cost of the egress design.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Visitors reach the website through a load balancer; nothing else is reachable from the internet.\n- Application tasks can call outside APIs and AWS services.\n- Databases are reachable only from the application.\n\nNon-functional:\n- Keep working when one availability zone fails.\n- Room for at least 1,000 tasks per zone in future.\n- No data charges for traffic to S3.',
      },
      {
        heading: 'Capacity estimates',
        body: '- 10.0.0.0/16: 2^16 = 65,536 addresses. Split into /24 subnets: 2^(24−16) = 256 subnets of 256 addresses.\n- Usable per subnet: 256 − 5 reserved = 251 for a /24, 4,096 − 5 = 4,091 for a /20.\n- 3 tiers × 3 zones = 9 subnets. As /24s they use 2,304 addresses; as /20s, 36,864 of 65,536.\n- NAT gateways (us-east-1 list prices): $0.045 an hour × 730 = $32.85 a month each, plus $0.045 a GB processed. One per zone in 3 zones: $98.55 a month before data.\n- 30 TB a month to S3 through NAT: 30,000 × $0.045 = $1,350. Through a gateway endpoint: $0.',
      },
      {
        heading: 'Step by step',
        body: 'A visitor:\n1. The Visitor\'s request crosses the Internet to the Internet Gateway and reaches the Load Balancer in a public subnet.\n2. The Load Balancer forwards it to App Tasks (zone a) or App Tasks (zone b) by the local route.\n3. The task queries Database (primary), which replicates to Database (standby) in another zone.\n\nA task calling out:\n4. App Tasks look up the Private Route Table. S3 traffic matches the S3 prefix list and goes through the S3 Gateway Endpoint to S3.\n5. Other traffic matches 0.0.0.0/0 and goes to the NAT Gateway (zone a), or with one per zone to NAT Gateway (zone b) for zone b.\n6. The NAT gateway uses the Public Route Table to send it through the Internet Gateway to the External API.',
      },
      {
        heading: 'Components',
        body: '- Visitor: anyone on the internet using the site.\n- Internet: everything outside AWS.\n- Internet Gateway: the VPC\'s door to the internet, for subnets whose route table points at it.\n- Load Balancer: has a node in each public subnet and forwards to private targets.\n- Public Route Table: local route plus 0.0.0.0/0 to the internet gateway.\n- NAT Gateway (zone a): lets private subnets open outbound connections from one Elastic IP; zonal.\n- NAT Gateway (zone b): the same, for zone b, so each zone survives alone.\n- App Tasks (zone a): containers in a private subnet, each with its own address.\n- App Tasks (zone b): the same service in a second zone.\n- Private Route Table: local route, the S3 prefix list to the endpoint, and 0.0.0.0/0 to a NAT gateway.\n- S3 Gateway Endpoint: a free route to S3 (and DynamoDB has one too) that never touches the internet.\n- S3: object storage, outside the VPC.\n- External API: a third-party service, such as a payment provider.\n- Database (primary): in a database subnet with only the local route.\n- Database (standby): a synchronous replica in another zone, promoted if the primary\'s zone fails.',
      },
      {
        heading: 'Key decisions',
        body: '- The VPC range: big (/16) and not overlapping your offices, other VPCs or partners, because the main range can\'t change and overlapping ranges can\'t be peered.\n- Zones: at least two, usually three, with the same subnets in each.\n- NAT: one per zone for availability; one shared NAT gateway only for test environments. IPv6 with an egress-only internet gateway avoids NAT charges for IPv6 traffic.\n- Endpoints: gateway endpoints for S3 and DynamoDB always; interface endpoints (charged hourly) for other AWS APIs when traffic or security justifies them.\n- Security groups (stateful, per network interface) do most access control; network ACLs (stateless, per subnet) are a coarse second layer.\n- Flow logs to see what was accepted and rejected when debugging.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Zone failure: run every tier in every zone, give each zone its own NAT gateway, and keep a standby database in another zone.\n- Address exhaustion: Fargate tasks, Lambda functions in a VPC and load balancer nodes all use addresses. Add a secondary CIDR range and new subnets if you run out.\n- NAT limits: a NAT gateway handles up to 55,000 simultaneous connections to one destination; many connections to one API need connection reuse or more NAT addresses.\n- Data costs: watch NAT processing and cross-zone traffic in the bill; keep chatty services in the same zone where you can.\n- Connecting VPCs: peering for a few, a transit gateway for many.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What actually makes a subnet public?\n- Why does a /24 subnet give you 251 usable addresses?\n- Your private tasks can\'t reach an outside API. What do you check, in order?\n- One NAT gateway or one per zone? What does each cost, and what fails?\n- How do you stop paying NAT charges for S3 traffic?\n- You need to connect this VPC to another company\'s network with an overlapping range. What now?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'The VPC with terraform-aws-vpc (HCL as bash)',
        language: 'bash',
        source: `# main.tf: three zones, three tiers, one NAT gateway per zone.
cat > main.tf <<'EOF'
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "payments"
  cidr = "10.0.0.0/16"
  azs  = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]

  public_subnets   = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"]
  private_subnets  = ["10.0.16.0/20", "10.0.32.0/20", "10.0.48.0/20"]
  database_subnets = ["10.0.6.0/24", "10.0.7.0/24", "10.0.8.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway     = false
  one_nat_gateway_per_az = true
}
EOF
terraform init && terraform plan`,
      },
      {
        title: 'Subnet maths like cidrsubnet() (TypeScript)',
        language: 'typescript',
        source: `const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
const toIp = (n: number) => [3, 2, 1, 0].map((i) => Math.floor(n / 256 ** i) % 256).join('.')

// cidrsubnet("10.0.0.0/16", 8, 3) = "10.0.3.0/24"
export function cidrsubnet(cidr: string, newBits: number, index: number): string {
  const [ip, bits] = cidr.split('/')
  const prefix = Number(bits) + newBits
  if (index >= 2 ** newBits) throw new Error('index out of range')
  return \`\${toIp(toInt(ip) + index * 2 ** (32 - prefix))}/\${prefix}\`
}

// AWS keeps the first four addresses and the last one in every subnet.
export const usable = (prefix: number) => 2 ** (32 - prefix) - 5

console.log(cidrsubnet('10.0.0.0/16', 8, 3), usable(24)) // 10.0.3.0/24 251`,
      },
      {
        title: 'S3 gateway endpoint (Terraform)',
        language: 'bash',
        source: `cat > endpoints.tf <<'EOF'
# Adds a route for S3's address ranges to the private route tables, so S3
# traffic skips the NAT gateway and its per-GB charge.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.ap-south-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids
}
EOF`,
      },
      {
        title: 'Checking routes when a call fails (bash)',
        language: 'bash',
        source: `# Which route table does this subnet use, and what does it say?
aws ec2 describe-route-tables \\
  --filters Name=association.subnet-id,Values=subnet-0abc123 \\
  --query 'RouteTables[].Routes[].[DestinationCidrBlock,DestinationPrefixListId,GatewayId,NatGatewayId,State]' \\
  --output table

# Is the NAT gateway in that route healthy?
aws ec2 describe-nat-gateways --nat-gateway-ids nat-0def456 \\
  --query 'NatGateways[].[State,SubnetId,NatGatewayAddresses[0].PublicIp]'`,
      },
    ],
    related: ['ECS on Fargate', 'Application Load Balancer', 'Full-stack app on ECS', 'CDN', 'Scaling on AWS', 'Load balancing'],
  },
  simulator,
}
