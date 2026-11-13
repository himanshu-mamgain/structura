import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator takes one change through three environments (dev, staging, prod)
// under three ways of organising Terraform, and works out which environments it
// reaches and when, how many files had to be edited, and what each environment's
// plan says. The point is blast radius: how much one change or one mistake can touch.

type Layout = 'copies' | 'workspaces' | 'modules'
type Change = 'prod-db' | 'waf' | 'port' | 'destroy'
type Env = 'dev' | 'staging' | 'prod'

const LAYOUT: Record<string, Layout> = {
  'Copy-pasted folder per env': 'copies',
  'One root, three workspaces': 'workspaces',
  'Versioned module, root per env': 'modules',
}
const CHANGE: Record<string, Change> = {
  'Bigger database, prod only': 'prod-db',
  'Add a WAF to every env': 'waf',
  'A wrong default (port 8008)': 'port',
  'terraform destroy in the wrong place': 'destroy',
}
const ENVS: Env[] = ['dev', 'staging', 'prod']
const RESOURCES_PER_ENV = 14

const TREE: Record<Layout, string> = {
  copies: 'envs/\n  dev/      main.tf network.tf ecs.tf rds.tf alb.tf   (≈ 420 lines)\n  staging/  main.tf network.tf ecs.tf rds.tf alb.tf   (≈ 425 lines, a fix dev lacks)\n  prod/     main.tf network.tf ecs.tf rds.tf alb.tf   (≈ 410 lines, a fix staging lacks)',
  workspaces: 'main.tf network.tf ecs.tf rds.tf alb.tf\nvariables.tf:\n  db_class = { dev = "db.t4g.medium", staging = "db.t4g.medium", prod = "db.r6g.large" }\n\n$ terraform workspace list\n  default\n  dev\n  staging\n* prod',
  modules: 'modules/service/   (its own repo, tagged v1.4.0, v1.5.0 …)\n  main.tf variables.tf outputs.tf\nenvs/\n  dev/main.tf      module "orders": ref=v1.4.0, db_class "db.t4g.medium"\n  staging/main.tf  module "orders": ref=v1.4.0, db_class "db.t4g.medium"\n  prod/main.tf     module "orders": ref=v1.4.0, db_class "db.r6g.large"',
}

interface Rollout {
  env: Env
  when: string
  plan: string
  ok: boolean
}

interface Outcome {
  edit: { files: number; what: string; data: string }
  rollout: Rollout[]
  extra?: Trace['steps'][number]
  hurt: Env[] // environments that broke or lost something
  lesson: string
}

const DB_PLAN = '  ~ module.orders.aws_db_instance.this\n      ~ instance_class = "db.r6g.large" -> "db.r6g.xlarge"\nPlan: 0 to add, 1 to change, 0 to destroy.'
const WAF_PLAN = '  + aws_wafv2_web_acl.this\n  + aws_wafv2_web_acl_association.alb\n  + aws_cloudwatch_log_group.waf\nPlan: 3 to add, 0 to change, 0 to destroy.'
const PORT_PLAN = '  ~ aws_ecs_task_definition.api   (port 8080 -> 8008, forces replacement)\n  ~ aws_lb_target_group.api       (port 8080 -> 8008, forces replacement)\n  ~ aws_ecs_service.api\nPlan: 2 to add, 1 to change, 2 to destroy.\napply → new tasks fail health checks; the ECS circuit breaker rolls back to the old revision'
const NO_CHANGES = 'No changes. Your infrastructure matches the configuration.'
const DESTROY_PLAN = `Plan: 0 to add, 0 to change, ${RESOURCES_PER_ENV} to destroy.`

function outcome(layout: Layout, change: Change): Outcome {
  if (change === 'prod-db') {
    const edit =
      layout === 'copies'
        ? { files: 1, what: 'edit envs/prod/rds.tf', data: '# envs/prod/rds.tf\n  instance_class = "db.r6g.xlarge"   # was db.r6g.large' }
        : layout === 'workspaces'
          ? { files: 1, what: 'edit the prod entry of a shared map', data: '# variables.tf (shared by all workspaces)\n  db_class = { dev = "db.t4g.medium", staging = "db.t4g.medium", prod = "db.r6g.xlarge" }' }
          : { files: 1, what: 'change one input in envs/prod', data: '# envs/prod/main.tf\nmodule "orders" {\n  source   = "git::…/service?ref=v1.4.0"\n  db_class = "db.r6g.xlarge"   # was db.r6g.large\n}' }
    return {
      edit,
      rollout: ENVS.map((env) => ({ env, when: env === 'prod' ? 'when prod is applied' : 'any time', plan: env === 'prod' ? DB_PLAN : NO_CHANGES, ok: true })),
      hurt: [],
      lesson:
        layout === 'workspaces'
          ? 'Per-environment values in a map work for small differences, but the file is shared: a review must check which workspace each entry affects.'
          : 'A change for one environment touched only that environment. Every layout manages this one; the differences show up with shared changes.',
    }
  }
  if (change === 'waf') {
    if (layout === 'copies')
      return {
        edit: { files: 3, what: 'write the same 40 lines in three folders', data: '# envs/dev/waf.tf, envs/staging/waf.tf, envs/prod/waf.tf\nresource "aws_wafv2_web_acl" "this" { … }   × 3 copies, typed three times\nstaging: copied before a review fix, so its rule set differs' },
        rollout: [
          { env: 'dev', when: 'Monday', plan: WAF_PLAN, ok: true },
          { env: 'staging', when: 'Monday', plan: WAF_PLAN.replace('3 to add', '3 to add (with the pre-review rules)'), ok: true },
          { env: 'prod', when: 'Thursday, after someone noticed it was missing', plan: WAF_PLAN, ok: true },
        ],
        hurt: [],
        lesson: 'Copies drift: the same change is written three times, a little differently each time, and nothing shows that the environments no longer match.',
      }
    if (layout === 'workspaces')
      return {
        edit: { files: 1, what: 'add waf.tf once', data: '# waf.tf (one copy, used by every workspace)\nresource "aws_wafv2_web_acl" "this" { … }' },
        rollout: [
          { env: 'dev', when: 'Monday, to test it', plan: WAF_PLAN, ok: true },
          { env: 'prod', when: 'Monday evening, during an unrelated hotfix', plan: '  + aws_wafv2_web_acl.this\n  + aws_wafv2_web_acl_association.alb\n  + aws_cloudwatch_log_group.waf\n  ~ aws_ecs_service.api   (the hotfix)\nPlan: 3 to add, 1 to change, 0 to destroy.\n(the untested WAF ships to prod with the hotfix)', ok: false },
          { env: 'staging', when: 'Tuesday', plan: WAF_PLAN, ok: true },
        ],
        hurt: ['prod'],
        lesson: 'With one root, every workspace gets the latest code on its next apply. A hotfix for prod carried the half-tested WAF with it, and a rule blocked real checkouts for 40 minutes.',
      }
    return {
      edit: { files: 4, what: 'add the WAF to the module once, tag v1.5.0, then bump each env', data: '# modules/service/waf.tf → git tag v1.5.0\n# envs/dev/main.tf\n  source = "git::…/service?ref=v1.5.0"   # was v1.4.0\n# staging and prod stay on v1.4.0 until dev looks good' },
      rollout: [
        { env: 'dev', when: 'Monday (bumped to v1.5.0)', plan: WAF_PLAN, ok: true },
        { env: 'staging', when: 'Tuesday (bumped after a day in dev)', plan: WAF_PLAN, ok: true },
        { env: 'prod', when: 'Wednesday (bumped last)', plan: WAF_PLAN, ok: true },
      ],
      extra: {
        text: 'Monday evening an urgent prod hotfix is applied from envs/prod. Prod still pins v1.4.0, so its plan contains the hotfix and nothing else.',
        nodes: ['Prod Config', 'Module Versions', 'Prod Stack'],
        data: 'envs/prod: module "orders" source = "…?ref=v1.4.0"\nPlan: 0 to add, 1 to change, 0 to destroy.   (the hotfix only)',
      },
      hurt: [],
      lesson: 'One module, written once and versioned; each environment chooses when to take a new version. The change was promoted dev → staging → prod, and prod never ran untested code.',
    }
  }
  if (change === 'port') {
    if (layout === 'copies')
      return {
        edit: { files: 1, what: 'edit envs/dev/ecs.tf', data: '# envs/dev/ecs.tf\n  container_port = 8008   # meant 8080' },
        rollout: [
          { env: 'dev', when: 'on apply', plan: PORT_PLAN, ok: false },
          { env: 'staging', when: '—', plan: NO_CHANGES, ok: true },
          { env: 'prod', when: '—', plan: NO_CHANGES, ok: true },
        ],
        hurt: ['dev'],
        lesson: 'The typo stayed in dev, because nothing is shared. The same isolation is why fixes don\'t spread either.',
      }
    if (layout === 'workspaces')
      return {
        edit: { files: 1, what: 'change a shared default', data: '# variables.tf (all workspaces)\nvariable "container_port" { default = 8008 }   # meant 8080' },
        rollout: [
          { env: 'dev', when: 'Monday', plan: PORT_PLAN, ok: false },
          { env: 'prod', when: 'Monday evening, during the hotfix', plan: PORT_PLAN, ok: false },
          { env: 'staging', when: 'Tuesday', plan: PORT_PLAN, ok: false },
        ],
        hurt: ['dev', 'prod', 'staging'],
        lesson: 'A shared default reaches every workspace on its next apply. Dev broke on Monday; prod broke the same evening, before anyone connected the two.',
      }
    return {
      edit: { files: 2, what: 'change the module default, tag v1.5.1, bump dev', data: '# modules/service/variables.tf → tag v1.5.1\nvariable "container_port" { default = 8008 }   # meant 8080\n# envs/dev/main.tf: ref=v1.5.1' },
      rollout: [
        { env: 'dev', when: 'Monday (v1.5.1)', plan: PORT_PLAN, ok: false },
        { env: 'staging', when: 'stays on v1.5.0', plan: NO_CHANGES, ok: true },
        { env: 'prod', when: 'stays on v1.5.0', plan: NO_CHANGES, ok: true },
      ],
      hurt: ['dev'],
      lesson: 'The bad version was caught in dev, the first environment to take it. staging and prod pinned the previous tag, so a mistake in shared code stayed one environment wide.',
    }
  }
  // destroy
  const rollout: Rollout[] = ENVS.map((env) => ({ env, when: env === 'prod' ? 'now' : '—', plan: env === 'prod' ? DESTROY_PLAN : NO_CHANGES, ok: env !== 'prod' }))
  if (layout === 'workspaces')
    return {
      edit: { files: 0, what: 'nothing: an engineer means to tear down a test stack in dev', data: '$ terraform destroy\n(the shell prompt doesn\'t show the workspace; prod was selected yesterday)\n\nDo you really want to destroy all resources in workspace "prod"?\n  Enter a value: yes' },
      rollout,
      hurt: ['prod'],
      lesson: `The selected workspace is invisible state on someone's laptop, and the same credentials reach every environment. One "yes" destroyed prod's ${RESOURCES_PER_ENV} resources, database included.`,
    }
  if (layout === 'copies')
    return {
      edit: { files: 0, what: 'nothing: an engineer runs destroy in the wrong terminal tab', data: '~/infra/envs/prod $ terraform destroy\n  Enter a value: yes' },
      rollout,
      hurt: ['prod'],
      lesson: 'Separate folders make the environment visible in the path, but the engineer\'s credentials could still destroy prod, and nothing protected the database.',
    }
  return {
    edit: { files: 0, what: 'nothing: an engineer runs destroy in envs/prod by mistake', data: '~/infra/envs/prod $ terraform destroy' },
    rollout: [
      { env: 'dev', when: '—', plan: NO_CHANGES, ok: true },
      { env: 'staging', when: '—', plan: NO_CHANGES, ok: true },
      { env: 'prod', when: 'refused', plan: `Error: Error acquiring the state lock\n…AccessDenied: arn:aws:sts::111122223333:assumed-role/developer/asha is not authorized to perform s3:PutObject on priya-terraform-state/orders/prod.tfstate.tflock\n\n(only the CI role can write prod state; and even then:)\nError: Instance cannot be destroyed: module.orders.aws_db_instance.this has lifecycle.prevent_destroy set`, ok: true },
    ],
    hurt: [],
    lesson: 'Prod has its own state and its own credentials, which only CI holds, and the module marks the database prevent_destroy. Two independent guards turned a slip into an error message.',
  }
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

const simulator: Simulator = {
  fields: [
    { id: 'layout', label: 'Layout', options: Object.keys(LAYOUT) },
    { id: 'change', label: 'Change', options: Object.keys(CHANGE) },
  ],
  defaults: { layout: 'One root, three workspaces', change: 'Add a WAF to every env' },
  run({ layout: layoutKey, change: changeKey }) {
    const layout = LAYOUT[layoutKey] ?? 'workspaces'
    const change = CHANGE[changeKey] ?? 'waf'
    const out = outcome(layout, change)
    const node = (env: Env, kind: 'Config' | 'State' | 'Stack') => `${env === 'dev' ? 'Dev' : env === 'staging' ? 'Staging' : 'Prod'} ${kind}`
    const reached = out.rollout.filter((r) => r.plan !== NO_CHANGES)
    const steps: Trace['steps'] = [
      {
        text: `The orders service runs in three environments: dev, staging and prod, ${RESOURCES_PER_ENV} resources each (network, load balancer, ECS service, database). ${layout === 'copies' ? 'Each environment has its own folder, a full copy of the code.' : layout === 'workspaces' ? 'One configuration serves all three through Terraform workspaces: same code, one state per workspace, differences in maps keyed by workspace.' : 'The resources live in one module, versioned with git tags. Each environment is a small root configuration that calls a pinned version with its own inputs, and has its own state.'}`,
        nodes: layout === 'modules' ? ['Service Module', 'Module Versions', 'Dev Config', 'Prod Config'] : ['Engineer', 'Dev Config', 'Staging Config', 'Prod Config'],
        data: TREE[layout],
      },
      {
        text: `The change: ${lower(changeKey)}. ${out.edit.files ? `You ${out.edit.what}: ${out.edit.files} ${out.edit.files === 1 ? 'file' : 'files'}.` : `There is no code change: ${out.edit.what}.`}`,
        nodes: ['Engineer', ...(layout === 'modules' && change !== 'destroy' && change !== 'prod-db' ? ['Service Module'] : []), ...(change === 'prod-db' || change === 'destroy' ? ['Prod Config'] : ['Dev Config'])],
        data: out.edit.data,
      },
      ...out.rollout.map((r) => ({
        text: `${r.env === 'dev' ? 'Dev' : r.env === 'staging' ? 'Staging' : 'Prod'}: ${r.plan === NO_CHANGES ? 'no changes' : r.when === 'refused' ? 'refused' : `applied ${r.when}`}. ${r.ok ? (r.plan === NO_CHANGES ? 'Its code and state are untouched by this change.' : r.when === 'refused' ? 'The destroy never ran.' : 'It works.') : r.plan === DESTROY_PLAN ? `All ${RESOURCES_PER_ENV} resources are destroyed, including the database.` : 'It breaks.'}`,
        nodes: [node(r.env, 'Config'), node(r.env, 'State'), node(r.env, 'Stack')],
        data: r.plan,
      })),
      ...(out.extra ? [out.extra] : []),
      {
        text: `Result: the change reached ${reached.length ? reached.map((r) => r.env).join(', ') : 'no environment'}${out.hurt.length ? `, and broke or damaged ${out.hurt.join(', ')}` : ', and nothing broke'}. ${out.lesson}`,
        nodes: ['Engineer', ...out.hurt.map((e) => node(e, 'Stack')).slice(0, 3)],
        data: `files edited: ${out.edit.files}\nreached: ${reached.map((r) => `${r.env} (${r.when})`).join(', ') || 'none'}\nharmed: ${out.hurt.join(', ') || 'none'}`,
      },
    ]
    return { input: `${layoutKey} · ${lower(changeKey)} → ${out.hurt.length ? `harmed ${out.hurt.join(', ')}` : 'nothing harmed'}`, steps }
  },
}

const run = (layout: string, change: string) => ({ layout, change })

export const terraformModules: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'terraform-modules',
  title: 'Terraform Modules and Environments',
  blurb: 'Copy-paste vs workspaces vs versioned modules: blast radius, promotion from dev to prod, and guarding against destroy',
  guides: ['tf-aws-ecs-service-module', 'tf-aws-vpc', 'tf-aws-alb', 'aws-ecs-fullstack-modules', 'tf-aws-ecs', 'how-does-terraform-turn-code-into-cloud'],
  story: {
    title: 'Three environments, one mistake',
    dek: 'The team needed dev, staging and prod. They tried three ways of laying out the Terraform, and each was tested by the same kinds of change.',
    chapters: [
      {
        heading: 'Three folders, three versions of the truth',
        body: `The first layout was the obvious one: copy the production folder twice, for dev and staging. It worked until changes started. A WAF (web application firewall) had to be typed into three folders; staging got an older draft of its rules, and prod got it three days late, when someone noticed it was missing.

After a few months, nobody could say how the environments differed without diffing 1,200 lines.`,
        replay: { label: 'A WAF in three copies', values: run('Copy-pasted folder per env', 'Add a WAF to every env') },
      },
      {
        heading: 'One root, three workspaces',
        body: `Next they tried **workspaces**: one configuration, and \`terraform workspace select prod\` to switch between separate state files. Differences went into maps keyed by \`terraform.workspace\`.

It removed the copies, and with them any control over timing. The code had one version, so whichever workspace was applied next got all of it. A WAF still being tested in dev reached prod that evening, carried along by an unrelated hotfix, and one of its rules blocked real checkouts for 40 minutes.`,
        replay: { label: 'The hotfix that shipped a WAF', values: run('One root, three workspaces', 'Add a WAF to every env') },
      },
      {
        heading: 'The workspace you forgot you selected',
        body: `Then an engineer cleaned up a test stack with \`terraform destroy\`. The prompt doesn't show the workspace, and prod had been selected the day before. One "yes" removed prod's 14 resources, database included, and recovery came from the RDS snapshot.

Workspaces are fine for short-lived copies of the same thing. For environments with different owners, risks and credentials, they hide exactly what matters.`,
        replay: { label: 'Destroy in the wrong workspace', values: run('One root, three workspaces', 'terraform destroy in the wrong place') },
      },
      {
        heading: 'Write it once, version it',
        body: `The layout that stuck: a **module**, a reusable folder of Terraform with **variables** as inputs and **outputs** as results, in its own repository, tagged \`v1.4.0\`, \`v1.5.0\` and so on. Each environment became a short root configuration, \`module "orders" { source = "git::…/service?ref=v1.4.0" }\`, with its own inputs and its own state.

A change is written once, tagged, and **promoted**: dev takes the new version first, then staging, then prod. When a release set a wrong default port, only dev took it, and the ECS circuit breaker rolled it back there. Staging and prod were still pinned to the previous tag.`,
        replay: { label: 'A bad default, caught in dev', values: run('Versioned module, root per env', 'A wrong default (port 8008)') },
      },
      {
        heading: 'Guards that don\'t depend on care',
        body: `Versioned modules limited what a change could reach. Two more guards limited what a mistake could reach. Prod's state and role became writable only by CI, so a laptop's credentials couldn't take prod's lock. And the module marked the database \`lifecycle { prevent_destroy = true }\`, so any plan that deleted it failed.

The same slip, \`terraform destroy\` in the prod folder, now ended in an error message.

> Good Terraform layout is about blast radius: how much one change, or one tired person, can touch.`,
        replay: { label: 'Destroy, with guards', values: run('Versioned module, root per env', 'terraform destroy in the wrong place') },
      },
    ],
  },
  takeaways: [
    'A module is a reusable folder of Terraform with input variables and outputs; write a component once and call it per environment.',
    'Pin module versions (git tags or registry versions) and promote them dev → staging → prod.',
    'Copy-pasted environments drift; workspaces share one code version, so changes reach every environment on its next apply.',
    'Give each environment its own root configuration, state and credentials to limit the blast radius.',
    'prevent_destroy and CI-only access to prod state turn dangerous mistakes into errors.',
    'Reuse well-tested public modules (terraform-aws-modules) instead of rewriting VPCs and load balancers.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'module', label: 'modules/service' },
      { id: 'dev', label: 'dev' },
      { id: 'staging', label: 'staging' },
      { id: 'prod', label: 'prod' },
    ],
    nodes: [
      { id: 'engineer', label: 'Engineer', shape: 'ellipse', color: 'blue', group: null },
      { id: 'ci', label: 'CI Pipeline', shape: 'rectangle', color: 'orange', group: null },
      { id: 'module', label: 'Service Module', shape: 'rectangle', color: 'violet', group: 'module' },
      { id: 'tags', label: 'Module Versions', shape: 'rectangle', color: 'green', group: 'module' },
      { id: 'devcfg', label: 'Dev Config', shape: 'rectangle', color: 'violet', group: 'dev' },
      { id: 'devstate', label: 'Dev State', shape: 'rectangle', color: 'green', group: 'dev' },
      { id: 'devstack', label: 'Dev Stack', shape: 'rectangle', color: 'violet', group: 'dev' },
      { id: 'stgcfg', label: 'Staging Config', shape: 'rectangle', color: 'violet', group: 'staging' },
      { id: 'stgstate', label: 'Staging State', shape: 'rectangle', color: 'green', group: 'staging' },
      { id: 'stgstack', label: 'Staging Stack', shape: 'rectangle', color: 'violet', group: 'staging' },
      { id: 'prodcfg', label: 'Prod Config', shape: 'rectangle', color: 'violet', group: 'prod' },
      { id: 'prodstate', label: 'Prod State', shape: 'rectangle', color: 'green', group: 'prod' },
      { id: 'prodstack', label: 'Prod Stack', shape: 'rectangle', color: 'violet', group: 'prod' },
    ],
    edges: [
      { from: 'engineer', to: 'module', label: 'change once', dashed: false },
      { from: 'module', to: 'tags', label: 'git tag v1.5.0', dashed: false },
      { from: 'tags', to: 'devcfg', label: 'ref=v1.5.0', dashed: false },
      { from: 'tags', to: 'stgcfg', label: 'ref=v1.5.0 next', dashed: true },
      { from: 'tags', to: 'prodcfg', label: 'ref=v1.4.0 (pinned)', dashed: true },
      { from: 'devcfg', to: 'devstate', label: 'apply', dashed: false },
      { from: 'devstate', to: 'devstack', label: 'manages', dashed: false },
      { from: 'stgcfg', to: 'stgstate', label: 'apply', dashed: false },
      { from: 'stgstate', to: 'stgstack', label: 'manages', dashed: false },
      { from: 'prodcfg', to: 'prodstate', label: 'apply (CI only)', dashed: false },
      { from: 'prodstate', to: 'prodstack', label: 'manages', dashed: false },
      { from: 'ci', to: 'prodcfg', label: 'the only writer', dashed: false },
      { from: 'engineer', to: 'devcfg', label: 'bump version', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Terraform Modules and Environments',
    summary:
      'Terraform modules package resources behind input variables and outputs, so one component can be reused across environments. How you lay out environments decides the blast radius of every change: copied folders drift, workspaces share one code version, and versioned modules with a root configuration and state per environment let changes be promoted and mistakes contained.',
    sections: [
      {
        heading: 'Overview',
        body: '- Module: a folder of .tf files called with module "name" { source = … } and its inputs.\n- Variables and outputs: a module\'s inputs and the values it returns (a URL, an ARN).\n- Root module: the configuration you run terraform in; it calls child modules.\n- Source and version: a local path, a git URL with ?ref=<tag>, or a registry address with a version constraint.\n- Workspaces: several states for one configuration, chosen with terraform workspace select.\n- Promotion: moving a module version from dev to staging to prod.\n\nThe simulator takes one change through dev, staging and prod under three layouts and reports which environments it reached, when, and which it harmed.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Dev, staging and prod built from the same definition, with deliberate differences (sizes, counts, domains).\n- A change can be tested in dev before it reaches prod.\n\nNon-functional:\n- One change, or one mistake, touches as little as possible.\n- Prod can only be changed by the pipeline.\n- The difference between environments is readable in a few lines.',
      },
      {
        heading: 'Capacity estimates',
        body: '- 14 resources per environment, 3 environments: 42 resources, in 3 states.\n- Copied folders: about 420 lines × 3; every shared change is typed 3 times.\n- Versioned module: the module once, plus about 15 lines per environment.\n- A promotion over 3 days (dev Monday, staging Tuesday, prod Wednesday) gives each version a day of real use before prod.',
      },
      {
        heading: 'Step by step',
        body: '1. The Engineer changes the Service Module once and tags a new version in Module Versions.\n2. The Engineer bumps Dev Config to the new version; dev plans and applies to Dev State and Dev Stack.\n3. When dev looks good, Staging Config is bumped and applied to Staging State and Staging Stack.\n4. Last, Prod Config is bumped and the CI Pipeline, the only identity allowed, applies it to Prod State and Prod Stack.\n5. Until then prod stays pinned to the old version, whatever else is applied there.',
      },
      {
        heading: 'Components',
        body: '- Engineer: writes module changes and bumps versions.\n- CI Pipeline: plans every change and is the only writer of prod.\n- Service Module: the reusable definition of network, load balancer, ECS service and database.\n- Module Versions: git tags (or registry versions) of the module.\n- Dev Config: the dev root configuration: module version and dev inputs.\n- Dev State: dev\'s own state file.\n- Dev Stack: dev\'s real resources.\n- Staging Config: staging\'s root configuration.\n- Staging State: staging\'s own state file.\n- Staging Stack: staging\'s real resources.\n- Prod Config: prod\'s root configuration, pinned to a tested version.\n- Prod State: prod\'s state, writable only by CI.\n- Prod Stack: prod\'s real resources.',
      },
      {
        heading: 'Key decisions',
        body: '- Root configuration and state per environment (and per component, for big systems); workspaces for throwaway copies of one environment, such as a stack per pull request.\n- Pin every module and provider version; never point at a branch.\n- Keep module interfaces small: a handful of inputs with sensible defaults, and outputs for what callers need.\n- Prefer well-maintained public modules (terraform-aws-modules for VPC, ALB, ECS) to writing your own.\n- Separate AWS accounts per environment, with prod changed only by CI.\n- prevent_destroy on data stores; deletion protection on the database itself as well.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Many environments or regions: tools like Terragrunt or Terraform Stacks reduce repetition across roots.\n- Breaking module changes: bump the major version and document the migration; use moved blocks so renamed resources aren\'t destroyed and recreated.\n- Drift between environments: compare the pinned versions and inputs, which are short, instead of whole folders.\n- Cross-environment dependencies: pass outputs through remote state data sources or parameters, never by copying IDs.\n- A bad release: roll back by pinning the previous tag and applying.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is a Terraform module, and what makes a good module interface?\n- Workspaces or separate root configurations for environments? Why?\n- How do you test an infrastructure change before it reaches prod?\n- How would you stop someone destroying production by accident?\n- How do you rename a resource inside a module without recreating it?\n- When would you use a public module instead of writing your own?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A small module (bash)',
        language: 'bash',
        source: `mkdir -p modules/service && cat > modules/service/variables.tf <<'EOF'
variable "name" {
  type = string
}
variable "db_class" {
  type = string
}
variable "desired_count" {
  type    = number
  default = 2
}
variable "container_port" {
  type    = number
  default = 8080
}
EOF

cat > modules/service/rds.tf <<'EOF'
resource "aws_db_instance" "this" {
  identifier          = "\${var.name}-db"
  instance_class      = var.db_class
  engine              = "postgres"
  allocated_storage   = 100
  deletion_protection = true
  lifecycle { prevent_destroy = true }
}
EOF

cat > modules/service/outputs.tf <<'EOF'
output "db_endpoint" { value = aws_db_instance.this.endpoint }
EOF`,
      },
      {
        title: 'One root per environment (bash)',
        language: 'bash',
        source: `cat > envs/prod/main.tf <<'EOF'
module "orders" {
  source        = "git::https://github.com/priya-foods/tf-service.git?ref=v1.4.0"
  name          = "orders-prod"
  db_class      = "db.r6g.large"
  desired_count = 6
}

output "db_endpoint" { value = module.orders.db_endpoint }
EOF

# envs/dev/main.tf is the same 10 lines with ref=v1.5.0 and smaller sizes.
cd envs/dev && terraform init -upgrade && terraform plan`,
      },
      {
        title: 'Public modules, pinned (bash)',
        language: 'bash',
        source: `cat > envs/prod/network.tf <<'EOF'
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"   # any 5.x, never 6.0 without a look

  name            = "orders-prod"
  cidr            = "10.20.0.0/16"
  azs             = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
  private_subnets = ["10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]
  public_subnets  = ["10.20.101.0/24", "10.20.102.0/24", "10.20.103.0/24"]
}
EOF`,
      },
      {
        title: 'Renaming without recreating (bash)',
        language: 'bash',
        source: `# The module renamed aws_db_instance.main to aws_db_instance.this in v1.5.0.
# A moved block tells Terraform it's the same database, not a delete and a create.
cat > modules/service/moved.tf <<'EOF'
moved {
  from = aws_db_instance.main
  to   = aws_db_instance.this
}
EOF

terraform plan   # "has moved to module.orders.aws_db_instance.this", 0 to destroy`,
      },
    ],
    related: ['Terraform Basics', 'Terraform Remote State', 'ECS on Fargate', 'AWS VPC Networking', 'Full-stack app on ECS'],
  },
  simulator,
}
