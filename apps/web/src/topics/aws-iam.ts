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
  blurb: 'Who can do what in AWS: users, roles and JSON policies, and how AWS decides yes or no',
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
    'Lock away the root user, and give every person their own IAM user, or better, single sign-on, with MFA.',
    'Everything is denied until a policy allows it; policies are JSON statements that allow or deny actions on resources.',
    'Software should use roles, which get temporary credentials from STS, never long-lived access keys.',
    'An explicit Deny beats any Allow, wherever it\'s written: identity policy, resource policy or SCP.',
    'A permissions boundary limits one role, an SCP limits a whole account, and you can only do what every layer allows.',
    'Give only what each job needs, and use CloudTrail to see who did what.',
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
      'IAM (Identity and Access Management) decides whether each request to AWS is allowed. Every request is signed by an identity: a user, or a role with short-lived credentials. AWS gathers every policy that applies and checks them. One explicit Deny anywhere means no, and if nothing says Allow, the answer is also no.',
    sections: [
      {
        heading: 'Overview',
        body: '- Root user: the account\'s owner. Lock it away with MFA (a second check, like a code from your phone) and don\'t use it day to day.\n- IAM user: one person (or, in older setups, a program) with long-lived credentials: a password or access keys.\n- Group: a set of users who share the same policies.\n- Role: an identity with no password or keys of its own. Services, other accounts or people take it on, and STS gives them temporary credentials.\n- Policy: a JSON document. Each statement says the Effect (Allow or Deny), the Action, the Resource, and optionally a Condition.\n- Identity policies are attached to users, groups and roles. Resource policies, such as an S3 bucket policy, are attached to the resource itself and name who they apply to (the Principal).\n- A permissions boundary limits what one user or role can ever do; an SCP limits a whole account in an AWS Organization.\n\nThe simulator is a small policy checker. It runs real policy JSON against a request, with wildcards, NotAction, Principal and conditions, in the order AWS documents for a single account.',
      },
      {
        heading: 'Requirements',
        body: 'What it must do:\n- Developers can read data and manage dev servers, with MFA.\n- Each service can reach exactly the tables and buckets it needs, and nothing more.\n- The deploy pipeline can deploy, but can\'t give itself more power.\n- Nobody can delete the photo bucket or work outside the Mumbai region.\n\nHow well it must do it:\n- No long-lived keys in code or settings.\n- Every decision is logged.',
      },
      {
        heading: 'Capacity estimates',
        body: '- IAM has no traffic to plan for. Its limits are quotas, such as 10 managed policies per user or role by default (you can ask for 20), 6,144 characters for a managed policy, and 2,048 for a policy written into one user.\n- Temporary credentials from AssumeRole last 1 hour by default, and up to the role\'s maximum, which you set between 1 and 12 hours.\n- An access key pushed to a public repository is often found by scanning bots within minutes.',
      },
      {
        heading: 'Step by step',
        body: '1. People sign their requests with their IAM user credentials; the Orders Service and the Deploy Pipeline get temporary credentials from STS.\n2. The IAM Policy Engine gathers the Identity Policies, Permissions Boundary, Bucket Policy and Organization SCP that apply.\n3. An explicit Deny in any of them refuses the request.\n4. The Organization SCP must allow the action.\n5. A Bucket Policy that names an IAM user in the same account can allow it on its own.\n6. Otherwise, an Identity Policies statement must allow it, and the Permissions Boundary must allow it too.\n7. The request reaches the S3 Bucket, DynamoDB Orders, EC2 Servers or IAM Users, and CloudTrail records the decision.',
      },
      {
        heading: 'Components',
        body: '- People: IAM users (or single sign-on users) signing in with MFA.\n- Orders Service: an ECS task that uses a task role.\n- Deploy Pipeline: the CI system, which takes on a deploy role for each build.\n- STS: the Security Token Service, which hands out temporary credentials for roles.\n- IAM Policy Engine: checks every request against the policies that apply.\n- Identity Policies: JSON attached to users, groups and roles.\n- Permissions Boundary: a policy that sets the most a user or role can ever be allowed.\n- Bucket Policy: a resource policy on an S3 bucket that names who it applies to.\n- Organization SCP: a service control policy that limits every identity in an account.\n- S3 Bucket: the menu photos.\n- DynamoDB Orders: the orders table.\n- EC2 Servers: the app\'s servers, tagged env=dev or env=prod.\n- IAM Users: the identities themselves, which only a few people should be able to create.\n- CloudTrail: the log of requests, allowed and denied.',
      },
      {
        heading: 'Key decisions',
        body: '- People: single sign-on (IAM Identity Center) or IAM users, always with MFA, and never the root user.\n- Software: roles everywhere (EC2 instance profiles, ECS task roles, Lambda execution roles, and OIDC for CI), and no access keys.\n- Least privilege: start from nothing and add specific actions on specific resources (named by their ARN, AWS\'s full name for a resource). IAM Access Analyzer shows what isn\'t used, so you can remove it.\n- An explicit Deny for things that must never happen, like deleting backups or leaving a region, ideally in an SCP or a resource policy.\n- Permissions boundaries when teams or pipelines can create roles, so they can\'t create anything stronger than themselves.\n- Conditions to narrow an Allow: only with MFA, only with a certain tag, only from your network, only in one region.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Many accounts (one per team or environment) inside an Organization, with SCPs as guardrails, limit the damage any one mistake can do.\n- A leaked key: turn it off first, then replace it and look in CloudTrail for what it did. Better still, have no keys to leak.\n- Wide wildcards (s3:*, Resource "*") creep in quietly. Review them with Access Analyzer and "last used" data.\n- Access between accounts needs both sides to agree: the resource policy (or the role\'s trust policy) and the caller\'s own policy.\n- A Deny that depends on a missing value needs care: BoolIfExists treats a missing MFA value as false, which is why that Deny is attached only to people, not to roles.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What\'s the difference between a user and a role?\n- Why are temporary credentials safer than access keys?\n- Walk through how AWS decides a request with an Allow in one policy and a Deny in another.\n- What does a permissions boundary do that a smaller policy doesn\'t?\n- How is an SCP different from an IAM policy?\n- How would you find out who deleted something?',
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
        title: 'Ask IAM before you find out',
        language: 'javascript',
        source: `import { readFileSync } from 'node:fs'
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam'

const iam = new IAMClient({})

// The IAM policy simulator evaluates a principal's real policies without making the call.
const result = await iam.send(
  new SimulatePrincipalPolicyCommand({
    PolicySourceArn: 'arn:aws:iam::111122223333:role/deploy-role',
    ActionNames: ['ecs:UpdateService', 'iam:CreateUser'],
    PermissionsBoundaryPolicyInputList: [readFileSync('deploy-boundary.json', 'utf8')],
  }),
)
for (const r of result.EvaluationResults) console.log(r.EvalActionName, r.EvalDecision)
// ecs:UpdateService allowed
// iam:CreateUser implicitDeny`,
        versions: [
          {
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
        ],
      },
      {
        title: 'No keys in code: a task role',
        language: 'javascript',
        source: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

// No access key anywhere: on ECS the SDK fetches the task role's temporary
// credentials from the container's credentials endpoint and refreshes them.
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }))

export async function saveOrder(order) {
  await db.send(new PutCommand({ TableName: 'Orders', Item: order }))
}`,
        versions: [
          {
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
        ],
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
