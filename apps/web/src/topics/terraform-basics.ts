import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator is a small Terraform. It holds a configuration, a state file and the
// real infrastructure as separate maps, refreshes state from "AWS", diffs the
// configuration against it attribute by attribute (with each resource type's
// force-new attributes), and prints the plan in Terraform's own format. On apply it
// walks the dependency graph in waves, as Terraform does, and writes a new state.

type Attrs = Record<string, string>

interface Resource {
  addr: string
  node: string
  forceNew: string[]
  deps: string[]
  id: string
  /** Seconds to create, destroy and modify, as the provider would report them. */
  times: { create: string; destroy: string; modify: string }
}

const RES: Resource[] = [
  { addr: 'aws_vpc.main', node: 'VPC', forceNew: ['cidr_block'], deps: [], id: 'vpc-0b7e3c2a1d4f5e6a7', times: { create: '2s', destroy: '1s', modify: '1s' } },
  { addr: 'aws_subnet.app', node: 'Subnet', forceNew: ['cidr_block', 'availability_zone', 'vpc_id'], deps: ['aws_vpc.main'], id: 'subnet-0c4d2e1f3a5b7c9d1', times: { create: '1s', destroy: '1s', modify: '1s' } },
  { addr: 'aws_security_group.web', node: 'Security Group', forceNew: ['name', 'vpc_id'], deps: ['aws_vpc.main'], id: 'sg-0e2f4a6b8c1d3e5f7', times: { create: '3s', destroy: '1s', modify: '2s' } },
  { addr: 'aws_instance.api', node: 'EC2 Instance', forceNew: ['ami', 'subnet_id'], deps: ['aws_subnet.app', 'aws_security_group.web'], id: 'i-0a1b2c3d4e5f60718', times: { create: '13s', destroy: '41s', modify: '1m2s' } },
  { addr: 'aws_s3_bucket.photos', node: 'S3 Bucket', forceNew: ['bucket'], deps: [], id: 'priya-menu-photos', times: { create: '2s', destroy: '1s', modify: '1s' } },
  { addr: 'aws_elasticache_cluster.sessions', node: 'ElastiCache Cluster', forceNew: ['cluster_id', 'engine'], deps: ['aws_subnet.app'], id: 'orders-sessions', times: { create: '7m12s', destroy: '5m31s', modify: '9m40s' } },
]
const BY = new Map(RES.map((r) => [r.addr, r]))

const BASE: Record<string, Attrs> = {
  'aws_vpc.main': { cidr_block: '10.0.0.0/16' },
  'aws_subnet.app': { vpc_id: 'aws_vpc.main.id', cidr_block: '10.0.1.0/24', availability_zone: 'ap-south-1a' },
  'aws_security_group.web': { name: 'web', vpc_id: 'aws_vpc.main.id', ingress: 'tcp 443 from 0.0.0.0/0' },
  'aws_instance.api': { ami: 'ami-0abcdef1234567890', instance_type: 'm6i.large', subnet_id: 'aws_subnet.app.id', 'tags.Name': 'orders-api' },
  'aws_s3_bucket.photos': { bucket: 'priya-menu-photos' },
  'aws_elasticache_cluster.sessions': { cluster_id: 'orders-sessions', engine: 'redis', node_type: 'cache.t4g.micro' },
}

type Change = 'first' | 'type' | 'ami' | 'bucket' | 'remove' | 'drift'

const CHANGES: Record<string, Change> = {
  'First apply (nothing exists yet)': 'first',
  'Change the instance type': 'type',
  'Change the AMI': 'ami',
  'Rename the bucket': 'bucket',
  'Delete the cache from the code': 'remove',
  'Someone edited it in the console': 'drift',
}
const RUN: Record<string, 'plan' | 'apply'> = { 'terraform plan': 'plan', 'terraform apply': 'apply' }
const STATE: Record<string, boolean> = { 'State file present': true, 'State file lost': false }

const clone = (m: Record<string, Attrs>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v }]))

function scenario(change: Change, statePresent: boolean) {
  const config = clone(BASE)
  // What exists in AWS and what the state file remembers, before this run.
  let real: Record<string, Attrs> = change === 'first' ? {} : clone(BASE)
  let state: Record<string, Attrs> = change === 'first' ? {} : clone(BASE)
  let hcl = ''
  if (change === 'type') {
    config['aws_instance.api'].instance_type = 'm6i.xlarge'
    hcl = 'resource "aws_instance" "api" {\n  ami           = "ami-0abcdef1234567890"\n  instance_type = "m6i.xlarge"   # was m6i.large\n  subnet_id     = aws_subnet.app.id\n}'
  } else if (change === 'ami') {
    config['aws_instance.api'].ami = 'ami-0fedcba9876543210'
    hcl = 'resource "aws_instance" "api" {\n  ami           = "ami-0fedcba9876543210"   # a newer image\n  instance_type = "m6i.large"\n  subnet_id     = aws_subnet.app.id\n}'
  } else if (change === 'bucket') {
    config['aws_s3_bucket.photos'].bucket = 'priya-menu-images'
    hcl = 'resource "aws_s3_bucket" "photos" {\n  bucket = "priya-menu-images"   # was priya-menu-photos\n}'
  } else if (change === 'remove') {
    delete config['aws_elasticache_cluster.sessions']
    hcl = '# resource "aws_elasticache_cluster" "sessions" { … }   ← deleted from cache.tf'
  } else if (change === 'drift') {
    real['aws_instance.api'].instance_type = 'm6i.2xlarge'
    hcl = '# no change to the code: someone resized the server in the AWS console\n# from m6i.large to m6i.2xlarge "just for tonight"'
  } else {
    hcl = 'resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }\nresource "aws_subnet" "app" { vpc_id = aws_vpc.main.id … }\nresource "aws_instance" "api" { instance_type = "m6i.large" … }\n… 6 resources in main.tf, network.tf, cache.tf'
  }
  if (!statePresent) state = {}
  return { config, real, state, hcl }
}

type Action = 'create' | 'update' | 'replace' | 'destroy' | 'noop'

interface Planned {
  addr: string
  action: Action
  changed: string[]
  before?: Attrs
  after?: Attrs
}

function plan(config: Record<string, Attrs>, refreshed: Record<string, Attrs>): Planned[] {
  const addrs = RES.map((r) => r.addr).filter((a) => a in config || a in refreshed)
  return addrs.map((addr) => {
    const c = config[addr]
    const s = refreshed[addr]
    if (c && !s) return { addr, action: 'create', changed: Object.keys(c), after: c }
    if (!c && s) return { addr, action: 'destroy', changed: Object.keys(s), before: s }
    const changed = Object.keys(c).filter((k) => c[k] !== s[k])
    if (!changed.length) return { addr, action: 'noop', changed, before: s, after: c }
    const forces = changed.some((k) => BY.get(addr)!.forceNew.includes(k))
    return { addr, action: forces ? 'replace' : 'update', changed, before: s, after: c }
  })
}

const q = (v: string) => (v.includes('.id') && v.startsWith('aws_') ? '(known after apply)' : `"${v}"`)
const [rtype, rname] = [(a: string) => a.split('.')[0], (a: string) => a.split('.')[1]]

/** One resource block of a plan, in Terraform's own format. */
function render(p: Planned): string {
  const r = BY.get(p.addr)!
  const head = `resource "${rtype(p.addr)}" "${rname(p.addr)}" {`
  if (p.action === 'create')
    return `  # ${p.addr} will be created\n  + ${head}\n${Object.entries(p.after!).map(([k, v]) => `      + ${k.padEnd(17)} = ${q(v)}`).join('\n')}\n      + id                = (known after apply)\n    }`
  if (p.action === 'destroy')
    return `  # ${p.addr} will be destroyed\n  # (because ${p.addr} is not in configuration)\n  - ${head}\n      - id         = "${r.id}" -> null\n${Object.entries(p.before!).slice(0, 2).map(([k, v]) => `      - ${k.padEnd(10)} = "${v}" -> null`).join('\n')}\n    }`
  const lines = p.changed.map((k) => `      ~ ${k.padEnd(13)} = "${p.before![k]}" -> "${p.after![k]}"${p.action === 'replace' && r.forceNew.includes(k) ? ' # forces replacement' : ''}`)
  if (p.action === 'replace')
    return `  # ${p.addr} must be replaced\n-/+ ${head}\n${lines.join('\n')}\n      ~ id            = "${r.id}" -> (known after apply)\n    }`
  return `  # ${p.addr} will be updated in-place\n  ~ ${head}\n        id            = "${r.id}"\n${lines.join('\n')}\n    }`
}

/** Dependency depth: resources with nothing to wait for are wave 1. */
function depth(addr: string): number {
  const deps = BY.get(addr)!.deps
  return deps.length ? 1 + Math.max(...deps.map(depth)) : 1
}

const NEW_IDS: Record<string, string> = {
  'aws_vpc.main': 'vpc-09f8e7d6c5b4a3921',
  'aws_subnet.app': 'subnet-07a6b5c4d3e2f1a09',
  'aws_security_group.web': 'sg-05d4c3b2a1f0e9d87',
  'aws_instance.api': 'i-0f9e8d7c6b5a43210',
}

function apply(plans: Planned[], real: Record<string, Attrs>, statePresent: boolean) {
  const lines: string[] = []
  const errors: string[] = []
  const work = plans.filter((p) => p.action !== 'noop')
  const waves = new Map<number, Planned[]>()
  for (const p of work) {
    // Destroys run in reverse dependency order; everything else forward.
    const w = p.action === 'destroy' ? 10 - depth(p.addr) : depth(p.addr)
    waves.set(w, [...(waves.get(w) ?? []), p])
  }
  let created = 0
  let changed = 0
  let destroyed = 0
  for (const w of [...waves.keys()].sort((a, b) => a - b)) {
    for (const p of waves.get(w)!) {
      const r = BY.get(p.addr)!
      if (p.action === 'update') {
        lines.push(`${p.addr}: Modifying... [id=${r.id}]`, `${p.addr}: Modifications complete after ${r.times.modify} [id=${r.id}]`)
        changed++
      } else if (p.action === 'destroy') {
        lines.push(`${p.addr}: Destroying... [id=${r.id}]`, `${p.addr}: Destruction complete after ${r.times.destroy}`)
        destroyed++
      } else if (p.action === 'replace') {
        lines.push(`${p.addr}: Destroying... [id=${r.id}]`)
        if (p.addr === 'aws_s3_bucket.photos') {
          errors.push(`Error: deleting S3 Bucket (${r.id}): BucketNotEmpty: The bucket you tried to delete is not empty`)
          continue
        }
        lines.push(`${p.addr}: Destruction complete after ${r.times.destroy}`, `${p.addr}: Creating...`, `${p.addr}: Creation complete after ${r.times.create} [id=${NEW_IDS[p.addr] ?? r.id}]`)
        created++
        destroyed++
      } else {
        // Without a state file, the real resources are still there: Terraform doesn't know.
        const exists = !statePresent && real[p.addr]
        lines.push(`${p.addr}: Creating...`)
        if (exists && p.addr === 'aws_s3_bucket.photos') {
          errors.push(`Error: creating S3 Bucket (priya-menu-photos): BucketAlreadyOwnedByYou: Your previous request to create the named bucket succeeded and you already own it.`)
          continue
        }
        if (exists && p.addr === 'aws_elasticache_cluster.sessions') {
          errors.push('Error: creating ElastiCache Cache Cluster (orders-sessions): CacheClusterAlreadyExists: Cache cluster already exists')
          continue
        }
        const id = exists ? NEW_IDS[p.addr] : r.id
        lines.push(`${p.addr}: Creation complete after ${r.times.create} [id=${id}]`)
        created++
      }
    }
  }
  return { lines, errors, created, changed, destroyed, waves: [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([, ps]) => ps.map((p) => p.addr)) }
}

const simulator: Simulator = {
  fields: [
    { id: 'change', label: 'Change', options: Object.keys(CHANGES) },
    { id: 'run', label: 'Run', options: Object.keys(RUN) },
    { id: 'state', label: 'State', options: Object.keys(STATE) },
  ],
  defaults: { change: 'Change the AMI', run: 'terraform plan', state: 'State file present' },
  run({ change: changeKey, run: runKey, state: stateKey }) {
    const change = CHANGES[changeKey] ?? 'ami'
    const doApply = (RUN[runKey] ?? 'plan') === 'apply'
    const statePresent = STATE[stateKey] ?? true
    const { config, real, state, hcl } = scenario(change, statePresent)

    // Refresh: for every resource the state knows, read its real attributes from AWS.
    const refreshed = Object.fromEntries(Object.keys(state).filter((a) => real[a]).map((a) => [a, { ...real[a] }]))
    const drifted = Object.keys(state).filter((a) => real[a] && Object.keys(real[a]).some((k) => real[a][k] !== state[a][k]))
    const plans = plan(config, refreshed)
    const count = (a: Action) => plans.filter((p) => p.action === a).length
    const add = count('create') + count('replace')
    const chg = count('update')
    const del = count('destroy') + count('replace')
    const summary = add + chg + del ? `Plan: ${add} to add, ${chg} to change, ${del} to destroy.` : 'No changes. Your infrastructure matches the configuration.'
    const touched = plans.filter((p) => p.action !== 'noop').map((p) => BY.get(p.addr)!.node)

    const steps: Trace['steps'] = [
      {
        text: `You describe the infrastructure you want in .tf files, in HCL (HashiCorp Configuration Language): six resources for the orders app, a VPC, subnet, security group, EC2 server, S3 bucket and Redis cache. ${change === 'first' ? 'Nothing exists in AWS yet.' : change === 'drift' ? 'This time nobody changed the code.' : 'Then you change one thing.'}`,
        nodes: ['Engineer', 'Your .tf Files'],
        data: hcl,
      },
      {
        text: statePresent
          ? `Terraform reads the state file, its record of what it created last time and each resource's real ID, then refreshes it: the AWS provider asks AWS for each resource's current settings.${drifted.length ? ' One no longer matches: someone changed it outside Terraform.' : ''}`
          : `Terraform looks for its state file and finds none${change === 'first' ? ', which is normal before the first apply' : ', though the laptop that had it was replaced last week. All six resources still exist in AWS, but Terraform has no record of them'}.`,
        nodes: ['State File', 'AWS Provider', 'AWS APIs'],
        data: statePresent
          ? `terraform.tfstate: serial 14, ${Object.keys(state).length} resources\n${Object.keys(state).length ? Object.keys(state).map((a) => `  ${a.padEnd(34)} ${BY.get(a)!.id}`).join('\n') : '  (empty)'}${drifted.length ? `\n\nNote: Objects have changed outside of Terraform\n  # aws_instance.api has changed\n  ~ instance_type = "m6i.large" -> "m6i.2xlarge"` : ''}`
          : `terraform.tfstate: not found → Terraform assumes nothing exists\nin AWS right now: ${Object.keys(real).length} resources${Object.keys(real).length ? ` (${Object.keys(real).map((a) => BY.get(a)!.id).slice(0, 3).join(', ')}, …)` : ''}`,
      },
      {
        text: `Terraform compares the configuration with the refreshed state, attribute by attribute, and builds a dependency graph from the references (the subnet uses aws_vpc.main.id, so it comes after the VPC). Some attributes can be changed in place; others, like an instance's AMI or a bucket's name, force AWS to replace the resource.`,
        nodes: ['Terraform Core', 'Dependency Graph', ...touched.slice(0, 2)],
        data: plans.map((p) => `${{ create: '+', update: '~', replace: '-/+', destroy: '-', noop: ' ' }[p.action].padEnd(3)} ${p.addr.padEnd(34)} ${p.action === 'noop' ? 'no change' : p.action === 'replace' ? `replace (${p.changed.filter((k) => BY.get(p.addr)!.forceNew.includes(k)).join(', ')} forces it)` : p.action === 'update' ? `update ${p.changed.join(', ')}` : p.action}`).join('\n'),
      },
      {
        text: `terraform plan prints exactly what it would do, and changes nothing. ${count('replace') ? 'Read the replacements carefully: "-/+" means the old resource is destroyed first, and anything stored in it goes with it.' : count('destroy') ? 'A "-" means a real resource will be deleted.' : drifted.length ? 'Terraform will put the server back to what the code says, undoing the console change.' : !statePresent && change !== 'first' ? `It plans to create all ${add} resources again, because without state it doesn't know they exist.` : chg ? 'An in-place update keeps the resource and its ID; for an instance type, AWS stops and starts the server.' : ''}`.trim(),
        nodes: ['Terraform Core', 'Plan'],
        data: `Terraform will perform the following actions:\n\n${plans.filter((p) => p.action !== 'noop').map(render).join('\n\n') || '  (none)'}\n\n${summary}`,
      },
    ]

    let resultText: string
    let resultData: string
    if (doApply && add + chg + del) {
      const out = apply(plans, real, statePresent)
      steps.push({
        text: `terraform apply runs the plan. It walks the dependency graph in waves, up to 10 operations at a time: ${out.waves.map((w) => w.map((a) => BY.get(a)!.node).join(' and ')).join(', then ')}.${out.errors.length ? ' Then it stops with errors.' : ''}`,
        nodes: ['Terraform Core', 'AWS Provider', 'AWS APIs', ...touched.slice(0, 1)],
        data: [...out.lines, ...(out.errors.length ? ['', ...out.errors] : []), '', out.errors.length ? `Apply failed: ${out.created} added, ${out.changed} changed, ${out.destroyed} destroyed before the errors.` : `Apply complete! Resources: ${out.created} added, ${out.changed} changed, ${out.destroyed} destroyed.`].join('\n'),
      })
      steps.push({
        text: `Terraform writes the new state: serial ${statePresent && change !== 'first' ? 15 : 1}, with every resource it created or changed and its real ID. Next time, this file is how it knows what it owns.`,
        nodes: ['Terraform Core', 'State File'],
        data: `terraform.tfstate: serial ${statePresent && change !== 'first' ? '14 → 15' : '1'}\nresources recorded: ${Object.keys(config).length - out.errors.length + (change === 'bucket' && out.errors.length ? 1 : 0)}${out.errors.length && change === 'bucket' ? '\naws_s3_bucket.photos: still the old bucket (replacement failed)' : ''}`,
      })
      if (!statePresent && change !== 'first') {
        const failed = out.errors.map((e) => (e.includes('S3') ? 'bucket' : 'cache'))
        resultText = `Without its state file, Terraform created a second VPC, subnet, security group and server next to the real ones (another $73 a month for the duplicate server), and failed on the ${failed.join(' and ')}, whose ${failed.length > 1 ? 'names' : 'name'} must be unique. The state file is the only link between your code and what you already run: keep it safe and shared, which is the next topic.`
        resultData = `duplicates created: ${out.created} (vpc, subnet, security group, instance)\nfailed: ${failed.length} (${failed.map((f) => (f === 'bucket' ? 'bucket name taken' : 'cache id taken')).join(', ')})\nto recover: terraform import (or import blocks) to adopt the originals, then delete the copies`
      } else if (out.errors.length) {
        resultText = 'The rename planned a replacement, and replacing means deleting the old bucket first. AWS refused because it holds 1,240 menu photos. Bucket names can\'t be changed in place: copy the objects to a new bucket, then move the resource (or set force_destroy only if losing them is fine).'
        resultData = `old bucket: still there, 1,240 objects\nnew bucket: not created\nsafer: create the new bucket alongside, copy, switch the app, then remove the old one`
      } else {
        resultText = `Applied: ${out.created} created, ${out.changed} changed, ${out.destroyed} destroyed, in dependency order.${change === 'ami' ? ' The server was destroyed before its replacement started: about a minute without it. lifecycle { create_before_destroy = true } reverses that order.' : change === 'drift' ? ' The console change is gone. Changes made outside Terraform get undone by the next apply, so make them in code.' : change === 'remove' ? ' Deleting the code deleted the cluster and everything in it.' : ''}`
        resultData = `applied: +${out.created} ~${out.changed} -${out.destroyed}\nstate serial: ${statePresent && change !== 'first' ? 15 : 1}`
      }
    } else {
      resultText = doApply ? 'Nothing to do: AWS already matches the code.' : `Plan only: ${summary.replace('Plan: ', '')} Nothing in AWS changed. ${count('replace') ? 'Before applying, ask whether losing the old resource is acceptable.' : 'Review it, then run terraform apply.'}`
      resultData = `${summary}\nnothing changed in AWS (plan is read-only)`
    }
    steps.push({ text: `Result: ${resultText}`, nodes: ['Engineer', 'Plan', 'State File'], data: resultData })
    return { input: `${changeKey} · ${runKey} · ${stateKey.toLowerCase()} → ${summary}`, steps }
  },
}

const run = (change: string, runCmd = 'terraform plan', state = 'State file present') => ({ change, run: runCmd, state })

export const terraformBasics: StaticTopic = {
  kind: 'static',
  difficulty: 'Beginner',
  id: 'terraform-basics',
  title: 'Terraform Basics: Plan, Apply, State',
  blurb: 'Infrastructure as code: resources, the dependency graph, in-place vs replace, drift, and why the state file matters',
  guides: ['how-does-terraform-turn-code-into-cloud', 'a-cheatsheet-on-infrastructure-as-code-landscape', 'tf-aws-vpc-simple', 'aws-ecs-fullstack-modules'],
  story: {
    title: 'The servers nobody could rebuild',
    dek: 'Priya\'s team had built everything by clicking in the AWS console. Then they needed a second copy for testing, and nobody remembered every setting. So they wrote it down as code.',
    chapters: [
      {
        heading: 'Clicks you can\'t repeat',
        body: `Two years of clicking had produced a VPC, subnets, security groups, servers, a bucket and a Redis cache. When the team needed a staging copy, nobody could say exactly which settings the originals had.

**Terraform** describes infrastructure as code. You write **resources** in \`.tf\` files, like \`resource "aws_instance" "api" { instance_type = "m6i.large" }\`. A **provider** plugin, here the AWS provider, turns them into API calls. \`terraform init\` downloads the providers; \`terraform plan\` shows what would change; \`terraform apply\` does it. Run it again and nothing happens: the code describes the end state, not the steps.`,
        replay: { label: 'The first apply', values: run('First apply (nothing exists yet)', 'terraform apply') },
      },
      {
        heading: 'The state file',
        body: `After the first apply, Terraform wrote \`terraform.tfstate\`: every resource it created, with its real AWS ID. It's how Terraform knows that \`aws_instance.api\` in the code is \`i-0a1b2c3d4e5f60718\` in AWS.

Each plan starts by **refreshing** the state, asking AWS for each resource's current settings, then compares the code with that. Resizing the server from \`m6i.large\` to \`m6i.xlarge\` became a one-line change and an **in-place update**: same server, same ID, a stop and start.`,
        replay: { label: 'Change the instance type', values: run('Change the instance type', 'terraform apply') },
      },
      {
        heading: 'Read the plan before you apply',
        body: `Not every change can be made in place. A new AMI (the server's disk image) can't be swapped into a running instance, so the plan said **must be replaced**, marked \`-/+\`: destroy the old server, then create a new one.

Then someone renamed the bucket in the code. The plan said replace again, and the apply failed: AWS won't delete a bucket that still holds 1,240 menu photos. The plan had been honest. Nobody had read it.`,
        replay: { label: 'Rename the bucket', values: run('Rename the bucket', 'terraform apply') },
      },
      {
        heading: 'Changes made outside the code',
        body: `During a busy evening, someone resized the server to \`m6i.2xlarge\` in the console "just for tonight". The next plan noticed: **objects have changed outside of Terraform**. That's **drift**. Applying would set it back to \`m6i.large\`, because the code is the source of truth.

The team's rule became simple: if it matters, change it in code. The console is for looking.`,
        replay: { label: 'Plan after the console change', values: run('Someone edited it in the console') },
      },
      {
        heading: 'The lost state file',
        body: `The state file lived on Priya's laptop. When the laptop was replaced, a teammate ran \`terraform apply\` from a fresh checkout. With no state, Terraform believed nothing existed, so it created a second VPC, subnet, security group and server next to the real ones, and failed on the bucket and cache, whose names were taken.

They cleaned up the copies and brought the originals back under Terraform with \`terraform import\`. Then they moved the state somewhere shared and locked, which is the next lesson.

> The code says what you want. The state says what you have. Lose the state, and Terraform forgets everything it built.`,
        replay: { label: 'Apply without the state', values: run('Change the instance type', 'terraform apply', 'State file lost') },
      },
    ],
  },
  takeaways: [
    'Terraform describes infrastructure as code; plan shows the changes, apply makes them, and running it again changes nothing.',
    'The state file maps each resource in the code to a real ID; without it, Terraform thinks nothing exists.',
    'References between resources form a dependency graph, which sets the order of creates and destroys.',
    'Some changes are in-place (~), others force a replacement (-/+) that destroys the old resource first; read the plan.',
    'Changes made in the console are drift, and the next apply undoes them.',
    'Recover unmanaged or orphaned resources with terraform import instead of creating them again.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'terraform', label: 'Terraform on your machine or CI' },
      { id: 'aws', label: 'AWS (ap-south-1)' },
    ],
    nodes: [
      { id: 'engineer', label: 'Engineer', shape: 'ellipse', color: 'blue', group: null },
      { id: 'files', label: 'Your .tf Files', shape: 'rectangle', color: 'green', group: 'terraform' },
      { id: 'core', label: 'Terraform Core', shape: 'rectangle', color: 'violet', group: 'terraform' },
      { id: 'graph', label: 'Dependency Graph', shape: 'diamond', color: 'violet', group: 'terraform' },
      { id: 'plan', label: 'Plan', shape: 'rectangle', color: 'yellow', group: 'terraform' },
      { id: 'state', label: 'State File', shape: 'rectangle', color: 'green', group: 'terraform' },
      { id: 'provider', label: 'AWS Provider', shape: 'rectangle', color: 'violet', group: 'terraform' },
      { id: 'apis', label: 'AWS APIs', shape: 'cloud', color: 'blue', group: null },
      { id: 'vpc', label: 'VPC', shape: 'rectangle', color: 'violet', group: 'aws' },
      { id: 'subnet', label: 'Subnet', shape: 'rectangle', color: 'violet', group: 'aws' },
      { id: 'sg', label: 'Security Group', shape: 'rectangle', color: 'violet', group: 'aws' },
      { id: 'ec2', label: 'EC2 Instance', shape: 'rectangle', color: 'violet', group: 'aws' },
      { id: 's3', label: 'S3 Bucket', shape: 'rectangle', color: 'green', group: 'aws' },
      { id: 'cache', label: 'ElastiCache Cluster', shape: 'rectangle', color: 'red', group: 'aws' },
    ],
    edges: [
      { from: 'engineer', to: 'files', label: 'writes HCL', dashed: false },
      { from: 'engineer', to: 'core', label: 'plan / apply', dashed: false },
      { from: 'files', to: 'core', label: 'desired', dashed: false },
      { from: 'state', to: 'core', label: 'last known', dashed: false },
      { from: 'core', to: 'graph', label: 'builds', dashed: false },
      { from: 'graph', to: 'plan', label: 'diff', dashed: false },
      { from: 'core', to: 'provider', label: 'create / update / delete', dashed: false },
      { from: 'provider', to: 'apis', label: 'HTTPS', dashed: false },
      { from: 'apis', to: 'vpc', label: '', dashed: false },
      { from: 'apis', to: 'subnet', label: '', dashed: false },
      { from: 'apis', to: 'sg', label: '', dashed: false },
      { from: 'apis', to: 'ec2', label: '', dashed: false },
      { from: 'apis', to: 's3', label: '', dashed: false },
      { from: 'apis', to: 'cache', label: '', dashed: false },
      { from: 'core', to: 'state', label: 'writes after apply', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Terraform Basics: Plan, Apply, State',
    summary:
      'Terraform turns .tf files describing the infrastructure you want into API calls that make it so. It keeps a state file mapping each resource in the code to a real one, refreshes it, diffs the code against it, and shows a plan: create, update in place, replace or destroy. Apply follows the dependency graph and writes the new state.',
    sections: [
      {
        heading: 'Overview',
        body: '- Provider: a plugin that talks to an API (AWS, Cloudflare, GitHub…); terraform init downloads it.\n- Resource: something to manage, like aws_instance.api, with arguments.\n- Variable and output: inputs to a configuration, and values it reports (a URL, an ID).\n- Reference: aws_subnet.app.id inside another resource; it creates a dependency.\n- State: terraform.tfstate, the record of what Terraform manages and the real IDs.\n- Plan: the difference between the code and the refreshed state; apply carries it out.\n- Drift: real resources changed outside Terraform.\n\nThe simulator keeps the code, the state and the real resources apart, refreshes, diffs attribute by attribute using which attributes force replacement, prints the plan in Terraform\'s format, and applies it in dependency waves.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Recreate the orders app\'s infrastructure (VPC, subnet, security group, server, bucket, cache) from code.\n- Show every change before it happens.\n- Make staging an exact copy of production.\n\nNon-functional:\n- Running it twice changes nothing (idempotent).\n- Changes are reviewed like code.\n- The team shares one record of what exists.',
      },
      {
        heading: 'Capacity estimates',
        body: '- 6 resources in 3 dependency waves: VPC and bucket; subnet and security group; server and cache.\n- Terraform runs up to 10 operations in parallel (-parallelism=10), so waves, not resources, set the time: about 7 minutes here, almost all of it the ElastiCache cluster.\n- An instance type change: stop, modify, start, about a minute. An AMI change: destroy (41 s) then create (13 s).\n- A duplicate m6i.large from a lost state file: $0.101 × 720 h ≈ $73 a month until someone notices.',
      },
      {
        heading: 'Step by step',
        body: '1. The Engineer edits Your .tf Files and runs terraform plan.\n2. Terraform Core reads the State File and refreshes it through the AWS Provider and the AWS APIs.\n3. It builds the Dependency Graph from references and diffs the code against the refreshed state.\n4. It prints the Plan: + create, ~ update in place, -/+ replace, - destroy.\n5. terraform apply executes the plan in graph order, calling the AWS APIs for the VPC, Subnet, Security Group, EC2 Instance, S3 Bucket and ElastiCache Cluster.\n6. Terraform Core writes the new State File.',
      },
      {
        heading: 'Components',
        body: '- Engineer: writes the code and reviews the plan.\n- Your .tf Files: the configuration, in HCL.\n- Terraform Core: reads code and state, plans and applies.\n- Dependency Graph: the order implied by references between resources.\n- Plan: the list of actions, shown before anything changes.\n- State File: the record of managed resources and their real IDs.\n- AWS Provider: the plugin that turns resources into AWS API calls.\n- AWS APIs: the AWS endpoints that do the work.\n- VPC: the private network.\n- Subnet: an address range in one Availability Zone.\n- Security Group: the server\'s firewall rules.\n- EC2 Instance: the API server.\n- S3 Bucket: the menu photos; its name is global and can\'t be changed in place.\n- ElastiCache Cluster: the Redis cache for sessions.',
      },
      {
        heading: 'Key decisions',
        body: '- Always read the plan; in CI, save it (terraform plan -out=tfplan) and apply exactly that file.\n- Pin provider versions (required_providers with a version constraint) and commit the .terraform.lock.hcl file.\n- Use lifecycle blocks deliberately: create_before_destroy for zero-downtime replacement, prevent_destroy on data you can\'t lose.\n- Keep state out of Git and off laptops: a remote, locked backend (next topic).\n- Adopt existing resources with import blocks instead of recreating them.\n- Variables for what differs between environments; everything else stays in code.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A failed apply leaves partial changes: the state records what succeeded, and the next plan continues from there.\n- Large configurations get slow to refresh; split them into smaller root configurations by lifetime or team.\n- Drift detection: run terraform plan on a schedule and alert on changes.\n- Secrets in state: state can contain passwords and keys, so encrypt it and restrict who can read it.\n- Provider upgrades can change defaults; upgrade deliberately and read the plan.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is Terraform state and why does it exist?\n- What is the difference between an in-place update and a replacement?\n- How does Terraform decide the order of operations?\n- What happens if someone changes a resource in the console?\n- How would you bring existing infrastructure under Terraform?\n- Why commit the dependency lock file?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A first configuration (bash)',
        language: 'bash',
        source: `cat > main.tf <<'EOF'
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "ap-south-1" }

resource "aws_s3_bucket" "photos" {
  bucket = "priya-menu-photos"
  lifecycle { prevent_destroy = true }  # refuse any plan that deletes it
}

output "bucket_arn" { value = aws_s3_bucket.photos.arn }
EOF

terraform init      # download the AWS provider, write .terraform.lock.hcl
terraform plan      # read-only: what would change
terraform apply     # do it, after typing yes`,
      },
      {
        title: 'Resources that reference each other (bash)',
        language: 'bash',
        source: `cat > network.tf <<'EOF'
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "app" {
  vpc_id            = aws_vpc.main.id   # a reference: created after the VPC
  cidr_block        = "10.0.1.0/24"
  availability_zone = "ap-south-1a"
}

resource "aws_instance" "api" {
  ami           = var.ami
  instance_type = var.instance_type
  subnet_id     = aws_subnet.app.id
  lifecycle { create_before_destroy = true }  # new server first, then remove the old
}

variable "ami" { type = string }
variable "instance_type" { default = "m6i.large" }
EOF`,
      },
      {
        title: 'Review exactly what you apply (bash)',
        language: 'bash',
        source: `terraform plan -out=tfplan          # save the plan
terraform show tfplan | less        # read it; look for -/+ and -
terraform apply tfplan              # applies that plan and nothing else

# Show drift without changing anything: exit code 2 means changes are pending.
terraform plan -refresh-only -detailed-exitcode`,
      },
      {
        title: 'Adopting what already exists (bash)',
        language: 'bash',
        source: `# Terraform 1.5+: declare the import in code, then plan and apply.
cat > imports.tf <<'EOF'
import {
  to = aws_instance.api
  id = "i-0a1b2c3d4e5f60718"
}
import {
  to = aws_s3_bucket.photos
  id = "priya-menu-photos"
}
EOF

terraform plan    # shows "will be imported"; fix the code until nothing else changes
terraform apply`,
      },
    ],
    related: ['Terraform Remote State', 'Terraform Modules', 'AWS Basics', 'AWS VPC Networking', 'Full-stack app on ECS'],
  },
  simulator,
}
