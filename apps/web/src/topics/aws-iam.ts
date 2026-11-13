import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator is a small IAM policy evaluator. The policies below are real IAM JSON;
// a request is matched against them (actions and ARNs with wildcards, NotAction,
// Principal and the condition operators used here) in AWS's order for a single account:
// any explicit Deny wins, then the organisation's SCPs, then resource-based policies,
// then identity-based policies, then the permissions boundary. No allow means deny.

const ACCOUNT = '111122223333'
const BUCKET = 'arn:aws:s3:::priya-menu-photos'

type Value = string | string[]
interface Statement {
  Sid: string
  Effect: 'Allow' | 'Deny'
  Action?: Value
  NotAction?: Value
  Resource: Value
  Principal?: '*' | { AWS: Value }
  Condition?: Record<string, Record<string, Value>>
}
interface Policy {
  name: string
  kind: 'identity' | 'boundary' | 'resource' | 'scp'
  Statement: Statement[]
}

const POLICIES: Record<string, Policy> = {
  developers: {
    name: 'DevelopersAccess (group policy)',
    kind: 'identity',
    Statement: [
      { Sid: 'ReadPhotos', Effect: 'Allow', Action: ['s3:Get*', 's3:List*'], Resource: [BUCKET, `${BUCKET}/*`] },
      { Sid: 'ReadOrders', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'], Resource: `arn:aws:dynamodb:ap-south-1:${ACCOUNT}:table/Orders` },
      { Sid: 'ManageDevServers', Effect: 'Allow', Action: ['ec2:StartInstances', 'ec2:StopInstances'], Resource: '*', Condition: { StringEquals: { 'aws:ResourceTag/env': 'dev' } } },
      {
        Sid: 'NoMfaNoAccess',
        Effect: 'Deny',
        NotAction: ['iam:CreateVirtualMFADevice', 'iam:EnableMFADevice', 'iam:ListMFADevices', 'sts:GetSessionToken'],
        Resource: '*',
        Condition: { BoolIfExists: { 'aws:MultiFactorAuthPresent': 'false' } },
      },
    ],
  },
  orders: {
    name: 'OrdersTaskPolicy',
    kind: 'identity',
    Statement: [
      { Sid: 'WriteOrders', Effect: 'Allow', Action: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'], Resource: `arn:aws:dynamodb:ap-south-1:${ACCOUNT}:table/Orders` },
      { Sid: 'ReadPhotos', Effect: 'Allow', Action: 's3:GetObject', Resource: `${BUCKET}/*` },
    ],
  },
  admin: {
    name: 'AdministratorAccess',
    kind: 'identity',
    Statement: [{ Sid: 'Everything', Effect: 'Allow', Action: '*', Resource: '*' }],
  },
  boundary: {
    name: 'DeployBoundary (permissions boundary)',
    kind: 'boundary',
    Statement: [
      { Sid: 'DeployOnly', Effect: 'Allow', Action: ['ecs:*', 'ecr:*', 'ec2:*', 'autoscaling:*', 'elasticloadbalancing:*'], Resource: '*' },
      { Sid: 'PublishAssets', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${BUCKET}/*` },
      { Sid: 'PassTaskRole', Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${ACCOUNT}:role/orders-task-role` },
    ],
  },
  bucket: {
    name: 'priya-menu-photos bucket policy',
    kind: 'resource',
    Statement: [
      { Sid: 'InternsUpload', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:user/ravi` }, Action: 's3:PutObject', Resource: `${BUCKET}/menus/*` },
      { Sid: 'NeverDeleteBucket', Effect: 'Deny', Principal: '*', Action: 's3:DeleteBucket', Resource: BUCKET },
    ],
  },
  scp: {
    name: 'MumbaiOnly (service control policy)',
    kind: 'scp',
    Statement: [
      { Sid: 'FullAWSAccess', Effect: 'Allow', Action: '*', Resource: '*' },
      {
        Sid: 'DenyOutsideMumbai',
        Effect: 'Deny',
        NotAction: ['iam:*', 'sts:*', 'organizations:*', 'cloudfront:*', 'route53:*', 'support:*'],
        Resource: '*',
        Condition: { StringNotEquals: { 'aws:RequestedRegion': 'ap-south-1' } },
      },
    ],
  },
}

interface Who {
  arn: string
  short: string
  node: 'People' | 'Orders Service' | 'Deploy Pipeline'
  kind: 'user' | 'role'
  identity: string[]
  boundary?: string
  mfa?: boolean
  how: string
}

const WHO: Record<string, Who> = {
  'Asha, developer, with MFA': { arn: `arn:aws:iam::${ACCOUNT}:user/asha`, short: 'user/asha', node: 'People', kind: 'user', identity: ['developers'], mfa: true, how: 'Asha signs in to the console as an IAM user with her password and a 6-digit code from her authenticator app (MFA).' },
  'Asha, developer, no MFA': { arn: `arn:aws:iam::${ACCOUNT}:user/asha`, short: 'user/asha', node: 'People', kind: 'user', identity: ['developers'], mfa: false, how: 'Asha uses an old access key from her laptop: it proves who she is, but not with MFA.' },
  'Orders service (ECS task role)': { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/orders-task-role/9f2c41`, short: 'assumed-role/orders-task-role', node: 'Orders Service', kind: 'role', identity: ['orders'], how: 'The orders service runs on ECS with a task role. It has no stored keys: STS hands it temporary credentials that expire within hours, and the AWS SDK fetches new ones.' },
  'Deploy pipeline (admin + boundary)': { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/deploy-role/build-4182`, short: 'assumed-role/deploy-role', node: 'Deploy Pipeline', kind: 'role', identity: ['admin'], boundary: 'boundary', how: 'The CI pipeline assumes deploy-role through STS for each build. The role has AdministratorAccess, capped by a permissions boundary.' },
  'Ravi, new intern (no policies)': { arn: `arn:aws:iam::${ACCOUNT}:user/ravi`, short: 'user/ravi', node: 'People', kind: 'user', identity: [], mfa: true, how: 'Ravi signs in as an IAM user with MFA. Nobody has attached any policy to him yet.' },
}

interface Request {
  action: string
  resource: string
  region: string
  tags?: Record<string, string>
  node: 'S3 Bucket' | 'DynamoDB Orders' | 'EC2 Servers' | 'IAM Users'
  call: string
}

const ACTIONS: Record<string, Request> = {
  'Read a menu photo (S3)': { action: 's3:GetObject', resource: `${BUCKET}/menus/paneer-tikka.jpg`, region: 'ap-south-1', node: 'S3 Bucket', call: 'GetObject' },
  'Upload a menu photo (S3)': { action: 's3:PutObject', resource: `${BUCKET}/menus/dal-makhani.jpg`, region: 'ap-south-1', node: 'S3 Bucket', call: 'PutObject' },
  'Delete the photo bucket': { action: 's3:DeleteBucket', resource: BUCKET, region: 'ap-south-1', node: 'S3 Bucket', call: 'DeleteBucket' },
  'Write an order (DynamoDB)': { action: 'dynamodb:PutItem', resource: `arn:aws:dynamodb:ap-south-1:${ACCOUNT}:table/Orders`, region: 'ap-south-1', node: 'DynamoDB Orders', call: 'PutItem' },
  'Stop a production server': { action: 'ec2:StopInstances', resource: `arn:aws:ec2:ap-south-1:${ACCOUNT}:instance/i-0a1b2c3d4e5f60718`, region: 'ap-south-1', tags: { env: 'prod' }, node: 'EC2 Servers', call: 'StopInstances' },
  'Start a server in us-east-1': { action: 'ec2:RunInstances', resource: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/*`, region: 'us-east-1', node: 'EC2 Servers', call: 'RunInstances' },
  'Create a new IAM user': { action: 'iam:CreateUser', resource: `arn:aws:iam::${ACCOUNT}:user/eve`, region: 'us-east-1', node: 'IAM Users', call: 'CreateUser' },
}

const GUARDRAILS: Record<string, { bucket: boolean; scp: boolean }> = {
  'Identity policies only': { bucket: false, scp: false },
  '+ bucket policy': { bucket: true, scp: false },
  '+ organisation rule (SCP)': { bucket: true, scp: true },
}

// ---------- matching ----------

const list = (v: Value | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const wildcard = (pattern: string, value: string, caseless: boolean) => {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, caseless ? 'i' : '')
  return re.test(value)
}

interface Ctx {
  who: Who
  req: Request
}

function contextValue(key: string, { who, req }: Ctx): string | undefined {
  if (key === 'aws:MultiFactorAuthPresent') return who.kind === 'user' && who.mfa !== undefined ? String(who.mfa) : undefined
  if (key === 'aws:RequestedRegion') return req.region
  if (key.startsWith('aws:ResourceTag/')) return req.tags?.[key.slice('aws:ResourceTag/'.length)]
  return undefined
}

function conditionHolds(cond: Statement['Condition'], ctx: Ctx): boolean {
  for (const [op, pairs] of Object.entries(cond ?? {})) {
    for (const [key, expected] of Object.entries(pairs)) {
      const actual = contextValue(key, ctx)
      const wanted = list(expected)
      const ok =
        op === 'StringEquals'
          ? actual !== undefined && wanted.includes(actual)
          : op === 'StringNotEquals'
            ? actual === undefined || !wanted.includes(actual)
            : op === 'BoolIfExists'
              ? actual === undefined || wanted.includes(actual)
              : op === 'Bool'
                ? actual !== undefined && wanted.includes(actual)
                : false
      if (!ok) return false
    }
  }
  return true
}

function applies(s: Statement, ctx: Ctx, resourcePolicy: boolean): boolean {
  const { req, who } = ctx
  const actionOk = s.Action !== undefined ? list(s.Action).some((p) => wildcard(p, req.action, true)) : !list(s.NotAction).some((p) => wildcard(p, req.action, true))
  if (!actionOk) return false
  if (!list(s.Resource).some((p) => wildcard(p, req.resource, false))) return false
  if (resourcePolicy) {
    const principals = s.Principal === '*' ? ['*'] : list(s.Principal?.AWS)
    if (!principals.some((p) => p === '*' || p === who.arn)) return false
  }
  return conditionHolds(s.Condition, ctx)
}

const matching = (p: Policy, ctx: Ctx, effect: 'Allow' | 'Deny') => p.Statement.filter((s) => s.Effect === effect && applies(s, ctx, p.kind === 'resource'))

// ---------- evaluation ----------

type Decision = 'Allow' | 'ExplicitDeny' | 'ImplicitDeny'

function evaluate(who: Who, req: Request, guard: { bucket: boolean; scp: boolean }) {
  const ctx: Ctx = { who, req }
  const identity = who.identity.map((k) => POLICIES[k])
  const boundary = who.boundary ? POLICIES[who.boundary] : undefined
  const resource = guard.bucket && req.node === 'S3 Bucket' ? POLICIES.bucket : undefined
  const scp = guard.scp ? POLICIES.scp : undefined
  const all = [...identity, boundary, resource, scp].filter((p): p is Policy => Boolean(p))
  const steps: { check: string; found: string; nodes: string[]; final?: Decision; reason?: string }[] = []

  const fmt = (p: Policy, ss: Statement[]) => ss.map((s) => `${p.name} → ${s.Effect} "${s.Sid}"`).join('\n')

  // 1. Any explicit Deny, anywhere, ends it.
  const denies = all.flatMap((p) => matching(p, ctx, 'Deny').map((s) => ({ p, s })))
  steps.push({
    check: 'Is there an explicit Deny in any policy?',
    found: denies.length ? denies.map(({ p, s }) => fmt(p, [s])).join('\n') : `checked ${all.length} ${all.length === 1 ? 'policy' : 'policies'}: no Deny matches`,
    nodes: ['IAM Policy Engine', ...(denies.some((d) => d.p.kind === 'scp') ? ['Organization SCP'] : denies.some((d) => d.p.kind === 'resource') ? ['Bucket Policy'] : ['Identity Policies'])],
    final: denies.length ? 'ExplicitDeny' : undefined,
    reason: denies.length ? `with an explicit deny in ${denies[0].p.kind === 'scp' ? 'a service control policy' : denies[0].p.kind === 'resource' ? 'a resource-based policy' : 'an identity-based policy'}` : undefined,
  })
  if (denies.length) return { steps, decision: 'ExplicitDeny' as Decision, all }

  // 2. The organisation's SCPs must allow it.
  if (scp) {
    const ok = matching(scp, ctx, 'Allow')
    steps.push({ check: 'Do the organisation\'s SCPs allow it?', found: ok.length ? fmt(scp, ok) : 'no SCP allows it', nodes: ['IAM Policy Engine', 'Organization SCP'], final: ok.length ? undefined : 'ImplicitDeny', reason: `because no service control policy allows the ${req.action} action` })
    if (!ok.length) return { steps, decision: 'ImplicitDeny' as Decision, all }
  }

  // 3. In the same account, a resource-based policy that names an IAM user is enough.
  if (resource) {
    const ok = matching(resource, ctx, 'Allow')
    const enough = ok.length > 0 && who.kind === 'user' && !boundary
    steps.push({
      check: 'Does the bucket policy allow this principal?',
      found: ok.length ? fmt(resource, ok) + (enough ? '\n→ same account, names the IAM user: that alone allows it' : '') : 'no statement names this principal for this action',
      nodes: ['IAM Policy Engine', 'Bucket Policy'],
      final: enough ? 'Allow' : undefined,
    })
    if (enough) return { steps, decision: 'Allow' as Decision, all }
  }

  // 4. An identity-based policy must allow it.
  const allows = identity.flatMap((p) => matching(p, ctx, 'Allow').map((s) => ({ p, s })))
  steps.push({
    check: 'Does an identity-based policy allow it?',
    found: identity.length === 0 ? 'no policies attached to this identity' : allows.length ? allows.map(({ p, s }) => fmt(p, [s])).join('\n') : `${identity.map((p) => p.name).join(', ')}: no Allow matches ${req.action} on this resource`,
    nodes: ['IAM Policy Engine', 'Identity Policies'],
    final: allows.length ? undefined : 'ImplicitDeny',
    reason: `because no identity-based policy allows the ${req.action} action`,
  })
  if (!allows.length) return { steps, decision: 'ImplicitDeny' as Decision, all }

  // 5. A permissions boundary caps what identity policies can grant.
  if (boundary) {
    const ok = matching(boundary, ctx, 'Allow')
    steps.push({
      check: 'Does the permissions boundary allow it too?',
      found: ok.length ? fmt(boundary, ok) : `${boundary.name}: no Allow for ${req.action}`,
      nodes: ['IAM Policy Engine', 'Permissions Boundary'],
      final: ok.length ? undefined : 'ImplicitDeny',
      reason: `because no permissions boundary allows the ${req.action} action`,
    })
    if (!ok.length) return { steps, decision: 'ImplicitDeny' as Decision, all }
  }
  return { steps, decision: 'Allow' as Decision, all }
}

function lesson(who: Who, req: Request, decision: Decision, reason: string | undefined, guard: { bucket: boolean; scp: boolean }): string {
  if (decision === 'ExplicitDeny') {
    if (reason?.includes('service control')) return 'An SCP applies to every identity in the account, even administrators: the organisation decided nobody works outside Mumbai.'
    if (reason?.includes('resource-based')) return 'An explicit Deny beats every Allow, even AdministratorAccess. Putting it on the bucket protects it from every identity at once.'
    return 'The group\'s own Deny refuses everything until Asha signs in with MFA. A Deny always beats an Allow.'
  }
  if (decision === 'ImplicitDeny') {
    if (who.identity.length === 0) return 'IAM starts at no: an identity with no policies can do nothing until something allows it.'
    if (reason?.includes('boundary')) return 'The role has AdministratorAccess, but the boundary caps it: a pipeline that can deploy can\'t create users or delete data. That stops one leaked build from becoming a full takeover.'
    return `Nothing allowed ${req.action} here, so it's denied by default. Least privilege means allowing only what each identity needs.`
  }
  if (who.kind === 'user' && who.identity.length === 0) return 'A resource-based policy can grant access by itself: the bucket names Ravi, so he can upload, and only to menus/.'
  if (who.boundary && req.action.startsWith('ec2:Stop')) return 'Allowed, because the boundary includes ec2:*. A boundary is only as tight as you write it: this pipeline can stop production servers.'
  if (who.boundary) return 'Allowed by both the role\'s policy and its boundary: effective permissions are where they overlap.'
  if (who.kind === 'role') return `Allowed with temporary credentials from STS: the service never held a long-lived key.${guard.scp ? ' The SCP allowed it too, because it runs in Mumbai.' : ''}`
  return 'Allowed: an identity-based policy allows it, nothing denies it.'
}

const simulator: Simulator = {
  fields: [
    { id: 'who', label: 'Who', options: Object.keys(WHO) },
    { id: 'action', label: 'Tries to', options: Object.keys(ACTIONS) },
    { id: 'guard', label: 'Guardrails', options: Object.keys(GUARDRAILS) },
  ],
  defaults: { who: 'Deploy pipeline (admin + boundary)', action: 'Create a new IAM user', guard: 'Identity policies only' },
  run({ who: whoKey, action, guard: guardKey }) {
    const who = WHO[whoKey] ?? WHO['Asha, developer, with MFA']
    const req = ACTIONS[action] ?? ACTIONS['Read a menu photo (S3)']
    const guard = GUARDRAILS[guardKey] ?? GUARDRAILS['Identity policies only']
    const { steps: checks, decision, all } = evaluate(who, req, guard)
    const last = checks[checks.length - 1]
    const reason = decision === 'Allow' ? undefined : last.reason
    const service = req.action.split(':')[0]
    const steps: Trace['steps'] = [
      {
        text: `${who.how} It calls ${req.call} on ${service.toUpperCase() === 'DYNAMODB' ? 'DynamoDB' : service.toUpperCase()}. Every AWS API call is signed, so AWS knows exactly which identity is asking.`,
        nodes: who.kind === 'role' ? [who.node, 'STS'] : [who.node, 'IAM Policy Engine'],
        data: `principal: ${who.arn}\naction:    ${req.action}\nresource:  ${req.resource}\nregion:    ${req.region}${who.kind === 'user' ? `\nmfa:       ${who.mfa}` : '\ncredentials: temporary (STS), expire within hours'}${req.tags ? `\ntags:      env=${req.tags.env}` : ''}`,
      },
      {
        text: `IAM gathers every policy that applies: ${all.length ? all.map((p) => p.name).join(', ') : 'none at all'}. A policy is a JSON list of statements, each an Effect (Allow or Deny), Actions and Resources, and sometimes a Condition.`,
        nodes: ['IAM Policy Engine', ...(who.identity.length ? ['Identity Policies'] : []), ...(who.boundary ? ['Permissions Boundary'] : guard.bucket && req.node === 'S3 Bucket' ? ['Bucket Policy'] : guard.scp ? ['Organization SCP'] : [])],
        data: all.length
          ? JSON.stringify({ Version: '2012-10-17', Statement: (all.find((p) => p.kind === 'identity') ?? all[0]).Statement.slice(0, 2) }, null, 1).replace(/\n\s*/g, ' ').replace(/\{ "Sid"/g, '\n {"Sid"')
          : 'no policies: every request is denied by default',
      },
      ...checks.map((c, i) => ({
        text: `${i + 1}. ${c.check} ${c.final === 'ExplicitDeny' ? 'Yes: the request is denied, and nothing else is checked.' : c.final === 'ImplicitDeny' ? 'No: with nothing allowing it, the request is denied.' : c.final === 'Allow' ? 'Yes, and that is enough here.' : 'Yes, so evaluation continues.'}`.replace('Is there an explicit Deny in any policy? Yes, so evaluation continues.', 'Is there an explicit Deny in any policy? No, so evaluation continues.'),
        nodes: c.nodes,
        data: c.found,
      })),
      {
        text: `${decision === 'Allow' ? 'Allowed.' : decision === 'ExplicitDeny' ? 'Denied, explicitly.' : 'Denied, implicitly: nothing allowed it.'} ${lesson(who, req, decision, reason, guard)} CloudTrail records the call and the decision either way.`,
        nodes: [who.node, req.node, 'CloudTrail'],
        data:
          decision === 'Allow'
            ? `HTTP 200 · ${req.call} succeeded\nCloudTrail: eventName=${req.call} userIdentity=${who.short} errorCode=none`
            : `An error occurred (AccessDenied) when calling the ${req.call} operation: User: ${who.arn} is not authorized to perform: ${req.action} on resource: ${req.resource} ${reason}\nCloudTrail: eventName=${req.call} errorCode=AccessDenied`,
      },
    ]
    return { input: `${whoKey} → ${req.action} · ${guardKey.toLowerCase()} → ${decision === 'Allow' ? 'allowed' : decision === 'ExplicitDeny' ? 'explicit deny' : 'implicit deny'}`, steps }
  },
}

const run = (who: string, action: string, guard = 'Identity policies only') => ({ who, action, guard })

export const awsIam: StaticTopic = {
  kind: 'static',
  difficulty: 'Beginner',
  id: 'aws-iam',
  title: 'AWS IAM: Who Can Do What',
  blurb: 'Users, roles and JSON policies, and how AWS decides: explicit deny, SCPs, resource policies and permissions boundaries',
  guides: ['scale-scalable-iam-architecture-to-secure-access-to-100-aws-accounts-at-segm', 'scale-aardvark-and-repokid-aws-least-privilege-for-distributed-high-velocity', 'scale-detecting-credential-compromise-in-aws-at-netflix', 'what-are-the-most-important-aws-services-to-learn'],
  story: {
    title: 'The key on GitHub',
    dek: 'Priya\'s team grows from one person with the root password to developers, services, a deploy pipeline and an intern. Each step forces a new IAM idea.',
    chapters: [
      {
        heading: 'One password for everything',
        body: `When Priya opened the AWS account, she got the **root user**: the email and password that own the account and can do anything, including closing it. For a while the whole team used it.

The first rule of **IAM** (Identity and Access Management) is to stop doing that. Priya turned on MFA for root, locked it away, and created an **IAM user** for each person, with their own password and their own six-digit MFA codes. Now every action in the account was tied to a name.`,
        replay: { label: 'Asha, signed in with MFA', values: run('Asha, developer, with MFA', 'Read a menu photo (S3)') },
      },
      {
        heading: 'Everything starts at no',
        body: `A new IAM user can do nothing. Permissions come from **policies**: JSON documents of statements, each with an \`Effect\` (Allow or Deny), the \`Action\`s it covers (\`s3:GetObject\`, \`dynamodb:Query\`, or \`s3:Get*\` with a wildcard) and the \`Resource\`s, named by **ARN** (Amazon Resource Name), like \`arn:aws:s3:::priya-menu-photos/*\`.

Priya attached one policy to a **Developers** group: read the photos, query orders, start and stop servers tagged \`env=dev\`. Asha could stop a dev server; trying a production one hit an **implicit deny**: nothing allowed it, so the answer was no. And Ravi, the intern, with no policies at all, couldn't even list a bucket.`,
        replay: { label: 'Asha tries a prod server', values: run('Asha, developer, with MFA', 'Stop a production server') },
      },
      {
        heading: 'The key on GitHub',
        body: `The orders service needed to write to DynamoDB, so a developer created an **access key** (a long-lived ID and secret), pasted it into the config, and pushed it to a public repository by mistake. Automated scanners found it within minutes, and by morning the account was running crypto-mining servers in three regions.

The fix was to stop giving software keys at all. A **role** is an identity without a password or keys: it is **assumed**. The orders service runs on ECS with a **task role**, and **STS** (Security Token Service) hands it temporary credentials that expire within hours and are refreshed automatically by the AWS SDK. Nothing to leak, and nothing that works for long if it does.`,
        replay: { label: 'The service writes an order', values: run('Orders service (ECS task role)', 'Write an order (DynamoDB)') },
      },
      {
        heading: 'Deny wins',
        body: `To make MFA non-negotiable, Priya added a statement to the Developers policy: **Deny** everything except setting up MFA when \`aws:MultiFactorAuthPresent\` is false. Asha's old access key, used without MFA, now couldn't even read a photo.

That is the rule IAM never breaks: an **explicit Deny beats any Allow**. Priya used it again on the bucket itself, with a **bucket policy** (a **resource-based** policy, attached to the resource instead of the identity) that denies \`s3:DeleteBucket\` to everyone, administrators included.`,
        replay: { label: 'Asha without MFA', values: run('Asha, developer, no MFA', 'Read a menu photo (S3)') },
      },
      {
        heading: 'An admin that can\'t make admins',
        body: `The deploy pipeline needed broad rights, so it got a role with **AdministratorAccess**. Then someone pointed out that a compromised build could create a new IAM user with admin rights and keep them forever.

A **permissions boundary** caps what a role's policies can grant: its effective permissions are only what both the policy and the boundary allow. The boundary allowed ECS, ECR, EC2, load balancers and uploading assets, and nothing in IAM except passing the one task role. The pipeline could still deploy, but \`iam:CreateUser\` was denied.`,
        replay: { label: 'The pipeline tries iam:CreateUser', values: run('Deploy pipeline (admin + boundary)', 'Create a new IAM user') },
      },
      {
        heading: 'Rules for the whole organisation',
        body: `By now the company had several AWS accounts in an **AWS Organization**. A **service control policy** (SCP) sets limits for every identity in an account, root included. Remembering the crypto miners, Priya attached one that denies everything outside Mumbai (\`aws:RequestedRegion\` other than \`ap-south-1\`), except global services like IAM.

Even the admin pipeline couldn't start a server in \`us-east-1\` now. And every decision, allowed or denied, landed in **CloudTrail**, AWS's log of API calls, so the next incident would have a record.`,
        replay: { label: 'A server in us-east-1', values: run('Deploy pipeline (admin + boundary)', 'Start a server in us-east-1', '+ organisation rule (SCP)') },
      },
    ],
  },
  takeaways: [
    'Lock away the root user and give every person an IAM user, or better, single sign-on, with MFA.',
    'Everything is denied by default; policies are JSON statements that allow or deny actions on resources, named by ARN.',
    'Software should use roles, which get temporary credentials from STS, never long-lived access keys.',
    'An explicit Deny beats any Allow, wherever it is written: identity policy, resource policy or SCP.',
    'A permissions boundary caps what a role can do; an SCP caps a whole account; effective permissions are what every layer allows.',
    'Grant least privilege, and use CloudTrail to see who did what.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'who', label: 'Who is asking' },
      { id: 'policies', label: 'Policies' },
      { id: 'resources', label: 'AWS resources' },
    ],
    nodes: [
      { id: 'people', label: 'People', shape: 'ellipse', color: 'blue', group: 'who' },
      { id: 'orders', label: 'Orders Service', shape: 'rectangle', color: 'violet', group: 'who' },
      { id: 'deploy', label: 'Deploy Pipeline', shape: 'rectangle', color: 'orange', group: 'who' },
      { id: 'sts', label: 'STS', shape: 'rectangle', color: 'violet', group: null },
      { id: 'engine', label: 'IAM Policy Engine', shape: 'diamond', color: 'violet', group: null },
      { id: 'identity', label: 'Identity Policies', shape: 'rectangle', color: 'green', group: 'policies' },
      { id: 'boundary', label: 'Permissions Boundary', shape: 'rectangle', color: 'green', group: 'policies' },
      { id: 'bucketpolicy', label: 'Bucket Policy', shape: 'rectangle', color: 'green', group: 'policies' },
      { id: 'scp', label: 'Organization SCP', shape: 'rectangle', color: 'green', group: 'policies' },
      { id: 's3', label: 'S3 Bucket', shape: 'rectangle', color: 'green', group: 'resources' },
      { id: 'ddb', label: 'DynamoDB Orders', shape: 'rectangle', color: 'green', group: 'resources' },
      { id: 'ec2', label: 'EC2 Servers', shape: 'rectangle', color: 'violet', group: 'resources' },
      { id: 'iamusers', label: 'IAM Users', shape: 'rectangle', color: 'green', group: 'resources' },
      { id: 'trail', label: 'CloudTrail', shape: 'rectangle', color: 'orange', group: null },
    ],
    edges: [
      { from: 'people', to: 'engine', label: 'signed API calls', dashed: false },
      { from: 'orders', to: 'sts', label: 'task role', dashed: false },
      { from: 'deploy', to: 'sts', label: 'AssumeRole', dashed: false },
      { from: 'sts', to: 'engine', label: 'temporary credentials', dashed: false },
      { from: 'identity', to: 'engine', label: 'allow / deny', dashed: true },
      { from: 'boundary', to: 'engine', label: 'cap', dashed: true },
      { from: 'bucketpolicy', to: 'engine', label: 'allow / deny', dashed: true },
      { from: 'scp', to: 'engine', label: 'account limits', dashed: true },
      { from: 'engine', to: 's3', label: 'if allowed', dashed: false },
      { from: 'engine', to: 'ddb', label: 'if allowed', dashed: false },
      { from: 'engine', to: 'ec2', label: 'if allowed', dashed: false },
      { from: 'engine', to: 'iamusers', label: 'if allowed', dashed: false },
      { from: 'engine', to: 'trail', label: 'every decision', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'AWS IAM: Who Can Do What',
    summary:
      'IAM (Identity and Access Management) decides whether each AWS API call is allowed. Every call is signed by an identity: a user, or a role with temporary credentials. AWS gathers the policies that apply (identity policies, resource policies, permissions boundaries and organisation SCPs) and evaluates them: an explicit Deny anywhere wins, and without an Allow the answer is no.',
    sections: [
      {
        heading: 'Overview',
        body: '- Root user: the account owner; lock it away with MFA and don\'t use it day to day.\n- IAM user: a person or, historically, a program with long-lived credentials (password, access keys).\n- Group: a set of users sharing policies.\n- Role: an identity with no credentials of its own that services, other accounts or people assume, getting temporary credentials from STS.\n- Policy: JSON statements of Effect, Action, Resource and optional Condition.\n- Identity-based policies attach to users, groups and roles; resource-based policies (like bucket policies) attach to resources and name a Principal.\n- Permissions boundaries cap a user or role; SCPs cap a whole account in an AWS Organization.\n\nThe simulator is a small policy evaluator: it runs real policy JSON against the request with wildcards, NotAction, Principal and conditions, in the order AWS documents for a single account.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Developers read data and manage dev servers, with MFA.\n- Services reach exactly the tables and buckets they need.\n- The deploy pipeline deploys but can\'t grant itself more power.\n- Nobody can delete the photo bucket or work outside Mumbai.\n\nNon-functional:\n- No long-lived keys in code or config.\n- Every decision logged.',
      },
      {
        heading: 'Capacity estimates',
        body: '- IAM is a global service with no throughput to plan; its limits are quotas, such as 10 managed policies per user or role by default (raisable to 20), 6,144 characters for a managed policy, and 2,048 characters for an inline user policy.\n- Temporary credentials from AssumeRole last 1 hour by default, up to the role\'s maximum session duration (1 to 12 hours).\n- An access key that leaks to a public repository is commonly found by scanners within minutes.',
      },
      {
        heading: 'Step by step',
        body: '1. People sign API calls with their IAM user credentials; the Orders Service and Deploy Pipeline get temporary credentials from STS.\n2. The IAM Policy Engine gathers the Identity Policies, Permissions Boundary, Bucket Policy and Organization SCP that apply.\n3. Any explicit Deny in any of them refuses the request.\n4. The Organization SCP must allow the action.\n5. A Bucket Policy that names an IAM user in the same account can allow it on its own.\n6. Otherwise an Identity Policies statement must allow it, and the Permissions Boundary must allow it too.\n7. The call reaches the S3 Bucket, DynamoDB Orders, EC2 Servers or IAM Users, and CloudTrail records the decision.',
      },
      {
        heading: 'Components',
        body: '- People: IAM users (or single sign-on users) signing in with MFA.\n- Orders Service: an ECS task using a task role.\n- Deploy Pipeline: CI that assumes a deploy role for each build.\n- STS: the Security Token Service, which issues temporary credentials for roles.\n- IAM Policy Engine: evaluates every request against the policies that apply.\n- Identity Policies: JSON attached to users, groups and roles.\n- Permissions Boundary: a policy that sets the most a user or role can ever be allowed.\n- Bucket Policy: a resource-based policy on an S3 bucket, naming principals.\n- Organization SCP: a service control policy limiting every identity in an account.\n- S3 Bucket: menu photos.\n- DynamoDB Orders: the orders table.\n- EC2 Servers: the app\'s servers, tagged env=dev or env=prod.\n- IAM Users: the identities themselves, which only a few should be able to create.\n- CloudTrail: the log of API calls, allowed and denied.',
      },
      {
        heading: 'Key decisions',
        body: '- People: single sign-on (IAM Identity Center) or IAM users, always with MFA; never the root user.\n- Software: roles everywhere (EC2 instance profiles, ECS task roles, Lambda execution roles, OIDC for CI); no access keys.\n- Least privilege: start from nothing, add specific actions and ARNs; use IAM Access Analyzer to trim unused permissions.\n- Explicit Deny for things that must never happen (deleting backups, leaving a region), ideally in SCPs or resource policies.\n- Permissions boundaries when you let teams or pipelines create roles, so they can\'t create anything stronger than themselves.\n- Conditions to tighten allows: MFA, tags, source VPC, requested region.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Many accounts (per team, per environment) inside an Organization, with SCPs as guardrails, limit the damage of any one mistake.\n- Leaked keys: deactivate first, then rotate and investigate in CloudTrail; better, have no keys to leak.\n- Over-broad wildcards (s3:*, Resource "*") grow quietly; review them with Access Analyzer and last-accessed data.\n- Cross-account access needs both sides to agree: the resource policy (or role trust policy) and the caller\'s identity policy.\n- A Deny for a missing key needs care: BoolIfExists treats a missing MFA key as false, which is why that Deny is attached only to people, not to roles.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the difference between a user and a role?\n- Why are temporary credentials safer than access keys?\n- Walk through how AWS evaluates a request with an Allow in one policy and a Deny in another.\n- What does a permissions boundary do that a smaller policy doesn\'t?\n- How does an SCP differ from an IAM policy?\n- How would you find out who deleted a resource?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A least-privilege policy (bash)',
        language: 'bash',
        source: `cat > orders-task-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteOrders",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:ap-south-1:111122223333:table/Orders"
    }
  ]
}
EOF

aws iam create-policy --policy-name OrdersTaskPolicy --policy-document file://orders-task-policy.json
aws iam attach-role-policy --role-name orders-task-role \\
  --policy-arn arn:aws:iam::111122223333:policy/OrdersTaskPolicy`,
      },
      {
        title: 'Ask IAM before you find out (Python)',
        language: 'python',
        source: `import boto3

iam = boto3.client("iam")

# The IAM policy simulator evaluates a principal's real policies without making the call.
result = iam.simulate_principal_policy(
    PolicySourceArn="arn:aws:iam::111122223333:role/deploy-role",
    ActionNames=["ecs:UpdateService", "iam:CreateUser"],
    PermissionsBoundaryPolicyInputList=[open("deploy-boundary.json").read()],
)
for r in result["EvaluationResults"]:
    print(r["EvalActionName"], r["EvalDecision"])
# ecs:UpdateService allowed
# iam:CreateUser implicitDeny`,
      },
      {
        title: 'No keys in code: a task role (TypeScript)',
        language: 'typescript',
        source: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

// No access key anywhere: on ECS the SDK fetches the task role's temporary
// credentials from the container's credentials endpoint and refreshes them.
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }))

export async function saveOrder(order: { id: string; restaurantId: string; totalPaise: number }) {
  await db.send(new PutCommand({ TableName: 'Orders', Item: order }))
}`,
      },
      {
        title: 'Who did that? (bash)',
        language: 'bash',
        source: `# Recent denied calls in the account, from CloudTrail's event history (last 90 days).
aws cloudtrail lookup-events --region ap-south-1 \\
  --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteBucket \\
  --query 'Events[].{time:EventTime,user:Username,event:EventName}' --output table

# Which key does a leaked access key ID belong to?
aws sts get-access-key-info --access-key-id AKIAIOSFODNN7EXAMPLE`,
      },
    ],
    related: ['AWS Basics', 'VPC networking', 'ECS on Fargate', 'Role-based access control', 'Least privilege'],
  },
  simulator,
}
