import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator plays a disaster against one of AWS's four disaster-recovery strategies
// and a backup setting, and works out the recovery time (RTO), the data lost (RPO) in
// orders, and what the standby costs each month. Every duration is a stated assumption
// below; the totals are computed from them.

const ORDERS_PER_HOUR = 1500
const DB_GB = 500
const PROD_MONTHLY = 2000 // the Mumbai stack: servers, Multi-AZ RDS, load balancer
const DISASTER = '18:00'
const SNAPSHOT_AT = '02:00'
const SINCE_SNAPSHOT_MIN = 16 * 60
const REGION_DOWN_MIN = 6 * 60
const PITR_LAG_MIN = 10 // cross-region automated backups: transaction logs arrive within minutes
const REPLICA_LAG_S = 5 // cross-region async replica
const GLOBAL_LAG_S = 1 // Aurora Global Database or DynamoDB global tables: typically under a second
const NOTICE_BUG_MIN = 20 // how long before someone notices the deleted table

type Strategy = 'backup' | 'pilot' | 'warm' | 'active'
type Disaster = 'region' | 'bug' | 'az'
type Backups = 'local' | 'copied' | 'pitr'

const STRATEGY: Record<string, Strategy> = {
  'Backup and restore': 'backup',
  'Pilot light': 'pilot',
  'Warm standby': 'warm',
  'Multi-site active/active': 'active',
}
const DISASTERS: Record<string, Disaster> = {
  'Mumbai region goes down for 6 h': 'region',
  'A bug deletes the orders table': 'bug',
  'One Availability Zone fails': 'az',
}
const BACKUPS: Record<string, Backups> = {
  'Nightly snapshots, same region': 'local',
  'Nightly snapshots copied to Hyderabad': 'copied',
  'Point-in-time recovery, cross-region': 'pitr',
}

// What the standby in Hyderabad costs a month (illustrative, against a $2,000 production stack).
const STANDBY_COST: Record<Strategy, number> = { backup: 0, pilot: 400, warm: 850, active: 2100 }
const BACKUP_COST: Record<Backups, number> = { local: 25, copied: 60, pitr: 110 }

const STANDBY_TEXT: Record<Strategy, { text: string; data: string; nodes: string[] }> = {
  backup: {
    text: 'Backup and restore: nothing runs in Hyderabad. The infrastructure is described in Terraform, ready to be created, and recovery starts from backups.',
    data: 'Hyderabad (ap-south-2): nothing running\nTerraform: the whole stack, ready to apply\nstandby cost: $0 a month beyond backups',
    nodes: ['Terraform', 'Snapshot Copies in Hyderabad'],
  },
  pilot: {
    text: 'Pilot light: only the database runs in Hyderabad, as a cross-region read replica kept up to date asynchronously. App servers are defined but scaled to zero, like a pilot light waiting to start the furnace.',
    data: `Hyderabad: RDS read replica (async, ~${REPLICA_LAG_S} s behind)\nAuto Scaling group: min 0, desired 0\nstandby cost: about $${STANDBY_COST.pilot} a month`,
    nodes: ['Mumbai Database', 'Hyderabad Database', 'Hyderabad App Servers'],
  },
  warm: {
    text: 'Warm standby: a complete, smaller copy runs in Hyderabad: the replica plus 2 app servers behind their own load balancer, health-checked by Route 53 and ready to scale up.',
    data: `Hyderabad: RDS read replica + 2 app servers + load balancer\nRoute 53: failover record with health checks\nstandby cost: about $${STANDBY_COST.warm} a month`,
    nodes: ['Hyderabad Load Balancer', 'Hyderabad App Servers', 'Hyderabad Database', 'Route 53'],
  },
  active: {
    text: `Multi-site active/active: both regions serve customers all the time. Route 53 sends each user to a healthy region, and the data is in a global database (Aurora Global Database or DynamoDB global tables) replicated in about ${GLOBAL_LAG_S} s.`,
    data: `Mumbai and Hyderabad: full stacks, both live\nRoute 53: latency routing with health checks\nreplication: global database, ~${GLOBAL_LAG_S} s\nstandby cost: about $${STANDBY_COST.active} a month (the second region, plus cross-region traffic)`,
    nodes: ['Route 53', 'Mumbai Load Balancer', 'Hyderabad Load Balancer', 'Hyderabad Database'],
  },
}

const BACKUP_TEXT: Record<Backups, string> = {
  local: `RDS takes a snapshot every night at ${SNAPSHOT_AT} and keeps it in Mumbai.`,
  copied: `RDS takes a snapshot every night at ${SNAPSHOT_AT}, and a copy is sent to Hyderabad within about an hour.`,
  pitr: 'RDS keeps continuous backups (point-in-time recovery to any second in the last 7 days), and replicates its snapshots and transaction logs to Hyderabad within minutes.',
}

interface Phase {
  label: string
  minutes: number
}

const sum = (ps: Phase[]) => ps.reduce((t, p) => t + p.minutes, 0)
const dur = (min: number) => {
  if (min < 2) return `${Math.round(min * 60)} s`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}
const orders = (minutes: number) => Math.round((ORDERS_PER_HOUR / 60) * minutes)
const n = (x: number) => x.toLocaleString('en-US')

interface Outcome {
  steps: Trace['steps']
  rtoMin: number
  rpoMin: number
  lesson: string
}

function regionOutage(s: Strategy, b: Backups): Outcome {
  const steps: Trace['steps'] = []
  const replicaRpo = REPLICA_LAG_S / 60
  if (s === 'backup') {
    if (b === 'local') {
      steps.push({
        text: 'The on-call engineer wants to restore in Hyderabad, but the only snapshots are in Mumbai, which is down. There is nothing to restore from: the shop waits for the region to come back.',
        nodes: ['On-call Engineer', 'Snapshots in Mumbai'],
        data: `snapshots in ap-south-1: unreachable\nsnapshot copies in ap-south-2: none\n→ wait for Mumbai: ${dur(REGION_DOWN_MIN)}`,
      })
      return { steps, rtoMin: REGION_DOWN_MIN, rpoMin: 0, lesson: 'Backups in the same region as the disaster are no backups at all for it. Copy them to another region.' }
    }
    const phases: Phase[] = [
      { label: 'notice, decide to fail over', minutes: 30 },
      { label: 'terraform apply in ap-south-2 (network, load balancer, servers)', minutes: 45 },
      { label: `restore ${DB_GB} GB database from the newest copy`, minutes: 60 },
      { label: 'smoke tests', minutes: 15 },
      { label: 'switch DNS (TTL 300 s)', minutes: 5 },
    ]
    const rpo = b === 'pitr' ? PITR_LAG_MIN : SINCE_SNAPSHOT_MIN
    steps.push({
      text: 'The on-call engineer decides to fail over. Terraform creates the whole stack in Hyderabad from code, and the database is restored from the newest backup copy there.',
      nodes: ['On-call Engineer', 'Terraform', 'Snapshot Copies in Hyderabad', 'Hyderabad Database'],
      data: phases.map((p) => `${String(p.minutes).padStart(3)} min  ${p.label}`).join('\n') + `\n${'-'.repeat(20)}\n${dur(sum(phases))} until orders work again`,
    })
    steps.push({
      text: b === 'pitr' ? `The restore uses the transaction logs replicated to Hyderabad, so it is about ${PITR_LAG_MIN} minutes behind the moment Mumbai went down.` : `The newest copy is the ${SNAPSHOT_AT} snapshot, so every order since then is missing: ${dur(rpo)} of them.`,
      nodes: ['Snapshot Copies in Hyderabad', 'Hyderabad Database'],
      data: b === 'pitr' ? `latest restorable time in ap-south-2: ${DISASTER} − ${PITR_LAG_MIN} min\nlost: ${PITR_LAG_MIN} min × ${n(ORDERS_PER_HOUR)}/h = ${n(orders(rpo))} orders` : `snapshot ${SNAPSHOT_AT} → disaster ${DISASTER}: ${dur(rpo)}\nlost: 16 h × ${n(ORDERS_PER_HOUR)}/h = ${n(orders(rpo))} orders`,
    })
    return { steps, rtoMin: sum(phases), rpoMin: rpo, lesson: `The cheapest strategy, and the slowest: ${dur(sum(phases))} of building before customers can order${b === 'copied' ? ', with a day\'s orders gone' : ''}. Fine for systems that can be down for hours.` }
  }
  if (s === 'pilot') {
    const phases: Phase[] = [
      { label: 'notice, decide to fail over', minutes: 15 },
      { label: 'promote the replica to a primary (servers start at the same time)', minutes: 10 },
      { label: 'switch DNS (TTL 300 s)', minutes: 5 },
    ]
    steps.push({
      text: 'The on-call engineer promotes the Hyderabad replica to a standalone primary and sets the app servers\' desired count from 0 to 8. They boot while the database is promoted.',
      nodes: ['On-call Engineer', 'Hyderabad Database', 'Hyderabad App Servers'],
      data: `aws rds promote-read-replica --region ap-south-2 --db-instance-identifier orders-dr\naws autoscaling set-desired-capacity --region ap-south-2 --auto-scaling-group-name orders-api --desired-capacity 8\n\n${phases.map((p) => `${String(p.minutes).padStart(3)} min  ${p.label}`).join('\n')}`,
    })
    steps.push(lagStep(replicaRpo, 'replica'))
    return { steps, rtoMin: sum(phases), rpoMin: replicaRpo, lesson: 'The data is always ready; only the servers have to start. Recovery in about half an hour, for about a fifth of production\'s cost.' }
  }
  if (s === 'warm') {
    const phases: Phase[] = [
      { label: 'Route 53 health checks fail (3 × 30 s), DNS fails over', minutes: 2 },
      { label: 'automation promotes the replica', minutes: 8 },
      { label: 'scale 2 → 8 servers (serving at reduced capacity meanwhile)', minutes: 0 },
    ]
    steps.push({
      text: 'Route 53\'s health checks see Mumbai fail and send customers to Hyderabad automatically. Automation promotes the replica; the 2 running servers take orders at once while Auto Scaling adds 6 more.',
      nodes: ['Route 53', 'Hyderabad Load Balancer', 'Hyderabad App Servers', 'Hyderabad Database'],
      data: phases.map((p) => `${String(p.minutes).padStart(3)} min  ${p.label}`).join('\n') + '\nmeanwhile: browsing works on 2 servers; orders wait for the promotion',
    })
    steps.push(lagStep(replicaRpo, 'replica'))
    return { steps, rtoMin: sum(phases), rpoMin: replicaRpo, lesson: 'Everything already runs, so recovery is minutes and can be automatic. You pay for a small second copy all the time.' }
  }
  steps.push({
    text: 'Route 53 stops sending anyone to Mumbai within about 2 minutes of its health checks failing. Hyderabad was already serving half the customers; Auto Scaling grows it to take all of them.',
    nodes: ['Route 53', 'Hyderabad Load Balancer', 'Hyderabad App Servers', 'Hyderabad Database'],
    data: '  2 min  health checks fail, Mumbai removed from DNS answers\nHyderabad: already live, scaling from 4 to 8 servers\nno promotion step: Hyderabad already accepts writes',
  })
  steps.push(lagStep(GLOBAL_LAG_S / 60, 'global'))
  return { steps, rtoMin: 2, rpoMin: GLOBAL_LAG_S / 60, lesson: 'Near-zero downtime and data loss, for about double the cost, and the hardest design: two regions writing the same data must handle conflicts.' }
}

function lagStep(rpoMin: number, kind: 'replica' | 'global'): Trace['steps'][number] {
  const lost = (ORDERS_PER_HOUR / 3600) * rpoMin * 60
  return {
    text: `Replication to Hyderabad is asynchronous: orders confirmed in Mumbai in the last ${dur(rpoMin)} before it went down never arrived. That is the RPO.`,
    nodes: ['Mumbai Database', 'Hyderabad Database'],
    data: `${kind === 'global' ? 'global database' : 'replica'} lag: ~${Math.round(rpoMin * 60)} s\nlost: ${Math.round(rpoMin * 60)} s × ${(ORDERS_PER_HOUR / 3600).toFixed(2)} orders/s ≈ ${lost < 1 ? 'under 1 order' : `${Math.round(lost)} orders`}`,
  }
}

function deletedTable(s: Strategy, b: Backups): Outcome {
  const steps: Trace['steps'] = []
  if (s !== 'backup')
    steps.push({
      text: `A migration with a bug runs DROP TABLE orders in Mumbai. ${s === 'active' ? 'The global database' : 'The replica in Hyderabad'} applies the same statement a moment later: replication copies mistakes as faithfully as data.`,
      nodes: ['Mumbai Database', 'Hyderabad Database'],
      data: `${DISASTER}:00.000 Mumbai: DROP TABLE orders;\n${DISASTER}:0${s === 'active' ? '1' : '5'}.000 Hyderabad: DROP TABLE orders; (replicated)`,
    })
  else
    steps.push({
      text: 'A migration with a bug runs DROP TABLE orders. Mumbai is perfectly healthy, and that is the problem: the database did exactly what it was told.',
      nodes: ['Mumbai App Servers', 'Mumbai Database'],
      data: `${DISASTER}:00 DROP TABLE orders;\nMulti-AZ standby: dropped too (synchronous copy)`,
    })
  const restore = b === 'pitr' ? 'restores the database to 17:59:59, one second before the bug' : `restores the ${SNAPSHOT_AT} snapshot`
  const phases: Phase[] = [
    { label: 'support tickets; someone finds the dropped table', minutes: NOTICE_BUG_MIN },
    { label: `RDS ${b === 'pitr' ? 'point-in-time restore' : 'snapshot restore'} to a new instance (${DB_GB} GB)`, minutes: 60 },
    { label: 'point the app at it, smoke tests', minutes: 15 },
  ]
  const rpo = b === 'pitr' ? 1 / 60 : SINCE_SNAPSHOT_MIN
  steps.push({
    text: `After ${NOTICE_BUG_MIN} minutes of failed orders someone finds the dropped table and ${restore}. No standby helps here; only a backup from before the mistake does.`,
    nodes: ['On-call Engineer', 'Snapshots in Mumbai', 'Mumbai Database'],
    data: phases.map((p) => `${String(p.minutes).padStart(3)} min  ${p.label}`).join('\n') + `\n${b === 'pitr' ? 'aws rds restore-db-instance-to-point-in-time --restore-time 2026-11-13T12:29:59Z …' : `aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier orders-2026-11-13-0200 …`}`,
  })
  steps.push({
    text: b === 'pitr' ? 'Point-in-time recovery brings back every order up to the second before the bug.' : `The snapshot is from ${SNAPSHOT_AT}: every order from the 16 hours since is gone, and has to be rebuilt from payment records, if at all.`,
    nodes: ['Snapshots in Mumbai', 'Mumbai Database'],
    data: b === 'pitr' ? 'lost: orders in the last second before the DROP (≈ 0)' : `lost: 16 h × ${n(ORDERS_PER_HOUR)}/h = ${n(orders(rpo))} orders`,
  })
  return {
    steps,
    rtoMin: sum(phases),
    rpoMin: rpo,
    lesson: s === 'backup' ? (b === 'pitr' ? 'Point-in-time recovery turned a lost day into a lost second.' : 'Nightly snapshots mean a bad statement can cost a day of orders. Turn on point-in-time recovery.') : `The ${s === 'active' ? 'second region' : 'standby'} costs $${STANDBY_COST[s]} a month and didn't help: it deleted the table too. Disaster recovery needs backups as well as replicas.`,
  }
}

function azFailure(): Outcome {
  return {
    steps: [
      {
        text: 'Availability Zone ap-south-1a loses power. The load balancer stops sending requests there, Auto Scaling replaces its servers in 1b, and RDS Multi-AZ fails over to its synchronous standby in about 90 seconds.',
        nodes: ['Mumbai Load Balancer', 'Mumbai App Servers', 'Mumbai Database'],
        data: 'ap-south-1a: down · ap-south-1b: healthy\nRDS Multi-AZ failover: ~90 s, synchronous standby, nothing lost\nHyderabad: not involved',
      },
    ],
    rtoMin: 1.5,
    rpoMin: 0,
    lesson: 'A zone failure is handled inside the region by Multi-AZ, whatever the DR strategy. A second region is for losing the whole region, or the account.',
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'strategy', label: 'Strategy', options: Object.keys(STRATEGY) },
    { id: 'disaster', label: 'Disaster', options: Object.keys(DISASTERS) },
    { id: 'backups', label: 'Backups', options: Object.keys(BACKUPS) },
  ],
  defaults: { strategy: 'Backup and restore', disaster: 'Mumbai region goes down for 6 h', backups: 'Nightly snapshots, same region' },
  run({ strategy, disaster, backups }) {
    const s = STRATEGY[strategy] ?? 'backup'
    const d = DISASTERS[disaster] ?? 'region'
    const b = BACKUPS[backups] ?? 'local'
    const out = d === 'region' ? regionOutage(s, b) : d === 'bug' ? deletedTable(s, b) : azFailure()
    const cost = STANDBY_COST[s] + BACKUP_COST[b]
    const lost = Math.round((ORDERS_PER_HOUR / 60) * out.rpoMin)
    const compare = (Object.keys(STRATEGY) as string[]).map((label) => {
      const k = STRATEGY[label]
      const o = d === 'region' ? regionOutage(k, b) : d === 'bug' ? deletedTable(k, b) : azFailure()
      return `${k === s ? '→' : ' '} ${label.padEnd(25)} RTO ${dur(o.rtoMin).padEnd(10)} RPO ${dur(o.rpoMin).padEnd(7)} $${n(STANDBY_COST[k] + BACKUP_COST[b])}/month`
    })
    const steps: Trace['steps'] = [
      {
        text: `The food-delivery app runs in Mumbai (ap-south-1): Route 53 points customers at a load balancer, app servers in two Availability Zones, and a Multi-AZ RDS database. It takes about ${n(ORDERS_PER_HOUR)} orders an hour.`,
        nodes: ['Customers', 'Route 53', 'Mumbai Load Balancer', 'Mumbai Database'],
        data: `primary: ap-south-1 (Mumbai) · recovery region: ap-south-2 (Hyderabad)\ndatabase: ${DB_GB} GB, RDS Multi-AZ\nproduction cost: about $${n(PROD_MONTHLY)} a month`,
      },
      { text: STANDBY_TEXT[s].text, nodes: STANDBY_TEXT[s].nodes, data: STANDBY_TEXT[s].data },
      {
        text: BACKUP_TEXT[b],
        nodes: b === 'local' ? ['Mumbai Database', 'Snapshots in Mumbai'] : ['Mumbai Database', 'Snapshots in Mumbai', 'Snapshot Copies in Hyderabad'],
        data: b === 'local' ? `snapshot: daily at ${SNAPSHOT_AT}, kept in ap-south-1\ncost: about $${BACKUP_COST.local} a month` : b === 'copied' ? `snapshot: daily at ${SNAPSHOT_AT}, copied to ap-south-2\ncost: about $${BACKUP_COST.copied} a month` : `backup retention: 7 days, restore to any second\ncross-region automated backups → ap-south-2\ncost: about $${BACKUP_COST.pitr} a month`,
      },
      ...(d === 'region'
        ? [{ text: `Today at ${DISASTER}, Mumbai's region has a major failure. Its services are unreachable for 6 hours. The data there is safe, but nobody can reach it.`, nodes: ['Customers', 'Route 53', 'Mumbai Load Balancer', 'Mumbai Database'], data: `${DISASTER} ap-south-1: elevated errors across EC2, RDS, ELB\nexpected recovery: 6 hours` }]
        : []),
      ...out.steps,
      {
        text: `Result: orders worked again after ${dur(out.rtoMin)} (RTO) and ${out.rpoMin === 0 ? 'no orders were lost' : `${lost < 1 ? 'under 1 order was' : `${n(lost)} orders were`} lost (RPO ${dur(out.rpoMin)})`}. ${out.lesson}`,
        nodes: ['Customers', 'Route 53', ...(s === 'backup' ? ['Terraform'] : ['Hyderabad App Servers'])],
        data: `RTO (how long it was down): ${dur(out.rtoMin)}\nRPO (how much data was lost): ${dur(out.rpoMin)} ≈ ${n(lost)} orders\nDR cost: about $${n(cost)} a month (${Math.round((cost / PROD_MONTHLY) * 100)}% of production)\n\n${compare.join('\n')}`,
      },
    ]
    return { input: `${strategy} · ${disaster.toLowerCase()} · ${backups.toLowerCase()} → RTO ${dur(out.rtoMin)}, ${n(lost)} orders lost`, steps }
  },
}

const run = (strategy: string, disaster: string, backups: string) => ({ strategy, disaster, backups })

export const awsDisasterRecovery: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'aws-disaster-recovery',
  title: 'Disaster Recovery Across AWS Regions',
  blurb: 'RTO and RPO, the four AWS strategies from backup-and-restore to active/active, and why replicas are not backups',
  guides: ['cloud-disaster-recovery-strategies', 'scale-aws-dos-and-donts', 'scale-on-efficiency-reliability-scaling---james-hamilton-vp-at-aws', 'hidden-costs-of-the-cloud'],
  story: {
    title: 'The evening Mumbai went dark',
    dek: 'Priya\'s food-delivery app had survived lost zones and failed servers. Then a whole AWS region went down at dinner time, and a month later her own team deleted a table.',
    chapters: [
      {
        heading: 'Two numbers',
        body: `Disaster recovery planning starts with two numbers the business chooses:

- **RTO** (recovery time objective): how long the app may be down.
- **RPO** (recovery point objective): how much recent data you can afford to lose, measured in time.

Priya's answer was "an hour, and a few minutes of orders". The **Multi-AZ** setup already handled a lost data centre in seconds. The question was a lost **region**: every zone in Mumbai at once. It's rare, but it has happened to AWS regions, for hours.`,
        replay: { label: 'A zone fails: Multi-AZ handles it', values: run('Backup and restore', 'One Availability Zone fails', 'Nightly snapshots copied to Hyderabad') },
      },
      {
        heading: 'Backups in the wrong place',
        body: `Her plan was **backup and restore**: nightly RDS snapshots, and Terraform to rebuild everything somewhere else. At 6 pm one Friday, Mumbai went down. The engineer on call opened the console for Hyderabad (\`ap-south-2\`), went to restore the database, and found nothing: the snapshots lived in Mumbai, with everything else.

The shop was closed for six hours, until the region came back.`,
        replay: { label: 'Replay the outage', values: run('Backup and restore', 'Mumbai region goes down for 6 h', 'Nightly snapshots, same region') },
      },
      {
        heading: 'Copies, and the cost of rebuilding',
        body: `The first fix was cheap: copy every snapshot to Hyderabad. Played again, the outage now ended in about two and a half hours: deciding, \`terraform apply\` for the network and servers, an hour to restore 500 GB, tests, DNS. But the newest copy was from 2 a.m., so 16 hours of orders, 24,000 of them, were gone.

**Point-in-time recovery** with cross-region automated backups fixed most of that: RDS replicates its transaction logs to Hyderabad within minutes, so a restore there is about 10 minutes behind, not 16 hours.`,
        replay: { label: 'Replay with copies', values: run('Backup and restore', 'Mumbai region goes down for 6 h', 'Nightly snapshots copied to Hyderabad') },
      },
      {
        heading: 'Pilot light and warm standby',
        body: `Two and a half hours still missed the one-hour RTO, so Priya looked at the other strategies AWS describes.

A **pilot light** keeps only the data running in the second region: a cross-region **read replica**, a few seconds behind, with app servers defined but scaled to zero. Recovery means promoting the replica and starting servers: about half an hour, for about a fifth of production's cost.

A **warm standby** keeps a small but complete copy running: replica, two servers, a load balancer, and **Route 53** health checks that move traffic automatically. About 10 minutes, for roughly 40% of production. She chose warm standby.`,
        replay: { label: 'Replay with warm standby', values: run('Warm standby', 'Mumbai region goes down for 6 h', 'Point-in-time recovery, cross-region') },
      },
      {
        heading: 'Replicas copy mistakes too',
        body: `A month later a migration with a bug ran \`DROP TABLE orders\` at dinner time. Mumbai was fine. The Multi-AZ standby dropped the table too, synchronously. So did the warm standby's replica in Hyderabad, five seconds later.

What saved the evening was the boring part: **point-in-time recovery** restored the database to one second before the bug. With only nightly snapshots, 16 hours of orders would have gone.

> Replicas protect you from losing a place. Backups protect you from losing the data.`,
        replay: { label: 'Replay the dropped table', values: run('Warm standby', 'A bug deletes the orders table', 'Point-in-time recovery, cross-region') },
      },
      {
        heading: 'Active/active, and its price',
        body: `The last option is **multi-site active/active**: both regions serve customers all the time, with a global database (Aurora Global Database or DynamoDB global tables) replicating in about a second. A region failure costs a couple of minutes and a second of data.

It also costs about as much as production again, and the hardest problem moves into the code: two regions accepting writes to the same data need a rule for conflicts. For Priya's orders, warm standby was enough. For a payments ledger, it might not be.`,
        replay: { label: 'Replay with active/active', values: run('Multi-site active/active', 'Mumbai region goes down for 6 h', 'Point-in-time recovery, cross-region') },
      },
    ],
  },
  takeaways: [
    'RTO is how long you can be down; RPO is how much recent data you can lose. The business picks them, and they decide the design.',
    'Multi-AZ handles a lost data centre; a second region is for losing the whole region.',
    'AWS\'s four strategies trade cost for speed: backup and restore (hours), pilot light (tens of minutes), warm standby (minutes), active/active (near zero).',
    'Backups must live outside the region they protect, or a regional outage takes them too.',
    'Replication copies mistakes: only point-in-time backups undo a deleted table.',
    'Asynchronous replication always risks the last few seconds of writes; test failover regularly, or it won\'t work when you need it.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'mumbai', label: 'Mumbai ap-south-1 (primary)' },
      { id: 'hyderabad', label: 'Hyderabad ap-south-2 (recovery)' },
      { id: 'backups', label: 'Backups' },
    ],
    nodes: [
      { id: 'customers', label: 'Customers', shape: 'ellipse', color: 'blue', group: null },
      { id: 'dns', label: 'Route 53', shape: 'diamond', color: 'violet', group: null },
      { id: 'oncall', label: 'On-call Engineer', shape: 'ellipse', color: 'blue', group: null },
      { id: 'tf', label: 'Terraform', shape: 'rectangle', color: 'orange', group: null },
      { id: 'mlb', label: 'Mumbai Load Balancer', shape: 'rectangle', color: 'violet', group: 'mumbai' },
      { id: 'mapp', label: 'Mumbai App Servers', shape: 'rectangle', color: 'violet', group: 'mumbai' },
      { id: 'mdb', label: 'Mumbai Database', shape: 'rectangle', color: 'green', group: 'mumbai' },
      { id: 'hlb', label: 'Hyderabad Load Balancer', shape: 'rectangle', color: 'violet', group: 'hyderabad' },
      { id: 'happ', label: 'Hyderabad App Servers', shape: 'rectangle', color: 'violet', group: 'hyderabad' },
      { id: 'hdb', label: 'Hyderabad Database', shape: 'rectangle', color: 'green', group: 'hyderabad' },
      { id: 'msnap', label: 'Snapshots in Mumbai', shape: 'rectangle', color: 'green', group: 'backups' },
      { id: 'hsnap', label: 'Snapshot Copies in Hyderabad', shape: 'rectangle', color: 'green', group: 'backups' },
    ],
    edges: [
      { from: 'customers', to: 'dns', label: 'orders.example.in', dashed: false },
      { from: 'dns', to: 'mlb', label: 'healthy: Mumbai', dashed: false },
      { from: 'dns', to: 'hlb', label: 'failover', dashed: true },
      { from: 'mlb', to: 'mapp', label: 'requests', dashed: false },
      { from: 'mapp', to: 'mdb', label: 'SQL', dashed: false },
      { from: 'hlb', to: 'happ', label: 'requests', dashed: false },
      { from: 'happ', to: 'hdb', label: 'SQL', dashed: false },
      { from: 'mdb', to: 'hdb', label: 'async replication', dashed: true },
      { from: 'mdb', to: 'msnap', label: 'nightly / continuous', dashed: false },
      { from: 'msnap', to: 'hsnap', label: 'cross-region copy', dashed: true },
      { from: 'hsnap', to: 'hdb', label: 'restore', dashed: true },
      { from: 'tf', to: 'happ', label: 'rebuild', dashed: true },
      { from: 'oncall', to: 'tf', label: 'terraform apply', dashed: true },
      { from: 'oncall', to: 'dns', label: 'fail over', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Disaster Recovery Across AWS Regions',
    summary:
      'Disaster recovery (DR) is how a system comes back after losing a whole region or its data. Two targets drive the design: RTO, how long it may be down, and RPO, how much recent data it may lose. AWS describes four strategies, from backup-and-restore (cheap, hours) to multi-site active/active (costly, near zero), and none of them replaces point-in-time backups.',
    sections: [
      {
        heading: 'Overview',
        body: '- Multi-AZ protects against losing a data centre inside a region, automatically and in seconds.\n- DR protects against losing a region, an account, or the data itself.\n- Backup and restore: copy backups to another region; rebuild everything there with infrastructure as code. RTO in hours, RPO from minutes to a day.\n- Pilot light: keep the data live in the second region (a replica); start the rest on demand. RTO tens of minutes, RPO seconds.\n- Warm standby: a scaled-down full copy always running, with automatic DNS failover. RTO minutes, RPO seconds.\n- Multi-site active/active: both regions serve traffic with a global database. RTO and RPO near zero.\n\nThe simulator plays a regional outage, a dropped table or a zone failure against each strategy and backup setting, and computes RTO, RPO in lost orders, and the monthly DR cost from stated timings.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Take orders again after Mumbai fails, from Hyderabad.\n- Undo a destructive mistake in the database.\n\nNon-functional:\n- RTO under 1 hour, RPO of a few minutes, for a regional outage.\n- DR spending proportionate to the cost of downtime.\n- A failover that has been tested, not just written down.',
      },
      {
        heading: 'Capacity estimates',
        body: '- 1,500 orders an hour = 25 a minute: a 16-hour RPO (nightly snapshot at 2 a.m., disaster at 6 p.m.) loses 24,000 orders; 10 minutes loses 250; 5 seconds loses about 2.\n- Backup and restore RTO: 30 min to decide + 45 min Terraform + 60 min restoring 500 GB + 15 min tests + 5 min DNS = 155 min.\n- Pilot light RTO: 15 min to decide + 10 min promote (servers boot in parallel) + 5 min DNS = 30 min.\n- Warm standby RTO: about 2 min for health checks and DNS + 8 min automated promotion = 10 min.\n- Active/active RTO: about 2 min for health checks; RPO about 1 s.\n- Standby cost against a $2,000 production stack (illustrative): $0, $400, $850, $2,100 a month.',
      },
      {
        heading: 'Step by step',
        body: '1. Customers reach Route 53, which answers with the Mumbai Load Balancer while Mumbai is healthy.\n2. Mumbai App Servers write to the Mumbai Database, which replicates asynchronously to the Hyderabad Database (pilot light, warm standby, active/active).\n3. Backups go to Snapshots in Mumbai and are copied to Snapshot Copies in Hyderabad.\n4. When Mumbai fails, the On-call Engineer (or automation) fails over: Terraform rebuilds Hyderabad App Servers for backup and restore, or the replica is promoted.\n5. Route 53 sends customers to the Hyderabad Load Balancer.\n6. For a deleted table, the database is restored to a point in time from backups instead.',
      },
      {
        heading: 'Components',
        body: '- Customers: people ordering food.\n- Route 53: AWS\'s DNS; health checks and failover or latency records decide which region answers.\n- On-call Engineer: the person who declares the disaster and runs the runbook.\n- Terraform: the infrastructure as code that rebuilds a region from scratch.\n- Mumbai Load Balancer: the primary region\'s entry point.\n- Mumbai App Servers: the primary region\'s application.\n- Mumbai Database: the primary RDS database, Multi-AZ.\n- Hyderabad Load Balancer: the recovery region\'s entry point, live in warm standby and active/active.\n- Hyderabad App Servers: scaled to zero, scaled down or fully live, depending on the strategy.\n- Hyderabad Database: a cross-region replica, promoted on failover, or a global database member.\n- Snapshots in Mumbai: RDS snapshots and continuous backups in the primary region.\n- Snapshot Copies in Hyderabad: the backups that survive a regional outage.',
      },
      {
        heading: 'Key decisions',
        body: '- Set RTO and RPO per system with the business; a payments ledger and an analytics dashboard deserve different answers.\n- Choose the cheapest strategy that meets them: most systems need warm standby at most.\n- Always keep point-in-time backups, copied to another region, and ideally another account, so a compromised account can\'t delete them (AWS Backup vault lock).\n- Keep infrastructure in code so the recovery region can be built and rebuilt identically.\n- Automate failover where you can, but decide who declares a disaster: failing over by mistake is costly too.\n- Make DNS failover fast: health checks and a low TTL on the records that move.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Untested DR fails: run game days that actually fail over, at least twice a year.\n- Failing back is a second migration: re-sync Mumbai from Hyderabad before moving traffic home.\n- Asynchronous replication can lose the last seconds of writes; reconcile from payment-provider records after a failover.\n- Quotas in the recovery region (instance limits, IP addresses) must be raised before the day you need them.\n- Some services are global or anchored in one region (IAM, Route 53\'s control plane); prefer data-plane operations during an incident.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What are RTO and RPO, and who decides them?\n- Compare backup and restore, pilot light, warm standby and active/active.\n- Why doesn\'t a replica protect you from a bad migration?\n- How does Route 53 failover work, and what limits how fast it is?\n- What makes active/active hard for writes?\n- How would you prove your DR plan works?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Backups that survive the region (bash)',
        language: 'bash',
        source: `# Point-in-time recovery: keep 7 days of continuous backups.
aws rds modify-db-instance --region ap-south-1 \\
  --db-instance-identifier orders --backup-retention-period 7 --apply-immediately

# Replicate those backups (snapshots and transaction logs) to Hyderabad.
aws rds start-db-instance-automated-backups-replication --region ap-south-2 \\
  --source-db-instance-arn arn:aws:rds:ap-south-1:111122223333:db:orders \\
  --backup-retention-period 7`,
      },
      {
        title: 'Pilot light: a replica in Hyderabad (bash)',
        language: 'bash',
        source: `# Keep the data live in the recovery region.
aws rds create-db-instance-read-replica --region ap-south-2 \\
  --db-instance-identifier orders-dr \\
  --source-db-instance-identifier arn:aws:rds:ap-south-1:111122223333:db:orders \\
  --db-instance-class db.r6g.large

# Disaster: promote it, then start the app servers.
aws rds promote-read-replica --region ap-south-2 --db-instance-identifier orders-dr
aws autoscaling set-desired-capacity --region ap-south-2 \\
  --auto-scaling-group-name orders-api --desired-capacity 8`,
      },
      {
        title: 'Undo a bad migration (bash)',
        language: 'bash',
        source: `# Restore to one second before the DROP TABLE (times are UTC; 18:00 IST = 12:30 UTC).
aws rds restore-db-instance-to-point-in-time --region ap-south-1 \\
  --source-db-instance-identifier orders \\
  --target-db-instance-identifier orders-restored \\
  --restore-time 2026-11-13T12:29:59Z

# Then point the app at orders-restored, check it, and rename when happy.`,
      },
      {
        title: 'Measuring RPO from replica lag (TypeScript)',
        language: 'typescript',
        source: `import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch'

const cw = new CloudWatchClient({ region: 'ap-south-2' })

// ReplicaLag is how far the cross-region replica is behind, in seconds: your RPO right now.
export async function currentRpoSeconds(): Promise<number> {
  const now = new Date()
  const res = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/RDS',
    MetricName: 'ReplicaLag',
    Dimensions: [{ Name: 'DBInstanceIdentifier', Value: 'orders-dr' }],
    StartTime: new Date(now.getTime() - 5 * 60_000),
    EndTime: now,
    Period: 60,
    Statistics: ['Maximum'],
  }))
  return Math.max(0, ...(res.Datapoints ?? []).map((d) => d.Maximum ?? 0))
}`,
      },
    ],
    related: ['AWS Basics', 'Redis persistence and replication', 'Database sharding', 'Leader election', 'Key-value store'],
  },
  simulator,
}
