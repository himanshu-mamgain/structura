import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator follows one team's state file through a situation, given where the
// state lives. It tracks the state's serial number and the resources each copy
// records against what really exists in AWS, so lost updates, orphans, duplicate
// creates and stale locks fall out of the timeline rather than being asserted.

type Backend = 'local' | 's3' | 'locked'
type Situation = 'concurrent' | 'nextday' | 'lost' | 'killed'

const BACKEND: Record<string, Backend> = {
  'Local file on a laptop': 'local',
  'S3, no locking': 's3',
  'S3 with a lock file': 'locked',
}
const SITUATION: Record<string, Situation> = {
  'Two people apply at once': 'concurrent',
  'A teammate plans the next day': 'nextday',
  'The laptop is lost': 'lost',
  'An apply is killed midway': 'killed',
}

const RESOURCES = 23 // what the state recorded before today
const BASE_SERIAL = 41

const BACKEND_CONFIG: Record<Backend, string> = {
  local: '# no backend block: state is ./terraform.tfstate on whoever ran apply',
  s3: 'terraform {\n  backend "s3" {\n    bucket = "priya-terraform-state"\n    key    = "orders/prod.tfstate"\n    region = "ap-south-1"\n  }\n}',
  locked: 'terraform {\n  backend "s3" {\n    bucket       = "priya-terraform-state"\n    key          = "orders/prod.tfstate"\n    region       = "ap-south-1"\n    encrypt      = true\n    use_lockfile = true   # Terraform 1.10+: a .tflock object next to the state\n  }\n}',
}

const LOCK_ERROR = (who: string, op: string, created: string) =>
  `Error: Error acquiring the state lock\n\nError message: operation error S3: PutObject, StatusCode: 412, PreconditionFailed\nLock Info:\n  ID:        6c2b9e1a-3f4d-4e7a-9b2c-9d0e5f6a7b8c\n  Path:      priya-terraform-state/orders/prod.tfstate\n  Operation: ${op}\n  Who:       ${who}\n  Version:   1.12.2\n  Created:   ${created}`

interface Outcome {
  steps: Trace['steps']
  orphans: string[]
  duplicates: string[]
  lostWork: string
  lesson: string
}

function concurrent(b: Backend): Outcome {
  if (b === 'local')
    return {
      steps: [
        {
          text: `Priya adds a Redis cache and applies from her laptop, where the state file lives: serial ${BASE_SERIAL} → ${BASE_SERIAL + 1}. At the same time Arjun adds an IAM role for the email worker, using the copy of the state Priya sent him on Slack two weeks ago, serial 38.`,
          nodes: ['Priya', 'Arjun', 'Laptop State File'],
          data: `Priya's laptop: serial ${BASE_SERIAL}, ${RESOURCES} resources → + aws_elasticache_cluster.sessions\nArjun's copy:   serial 38, 20 resources (3 added since are missing)`,
        },
        {
          text: 'Arjun\'s plan wants to create his role, and also the 3 resources his old copy doesn\'t know about. Two of them fail because they already exist; one, a security group rule, is created twice. Now there are two state files that disagree, and neither is complete.',
          nodes: ['Arjun', 'IAM Role', 'Laptop State File'],
          data: 'Plan: 4 to add, 0 to change, 0 to destroy.\n\nError: creating IAM Role (orders-api): EntityAlreadyExists\nError: creating S3 Bucket Policy: conflicting conditional operation\naws_security_group_rule.https: duplicate rule created\n\nPriya: serial 42 (24 resources) · Arjun: serial 39 (22 resources)',
        },
      ],
      orphans: [],
      duplicates: ['security group rule'],
      lostWork: 'two diverging state files to merge by hand',
      lesson: 'A state file on a laptop can\'t be shared: every copy goes stale the moment someone else applies. Put it in a remote backend.',
    }
  if (b === 's3')
    return {
      steps: [
        {
          text: `Both read the state from S3 at 10:02: serial ${BASE_SERIAL}. Priya applies a Redis cache (about 7 minutes to create); Arjun applies an IAM role (20 seconds).`,
          nodes: ['Priya', 'Arjun', 'S3 State Bucket'],
          data: `10:02:00 Priya  reads serial ${BASE_SERIAL} → apply: + aws_elasticache_cluster.sessions\n10:02:05 Arjun  reads serial ${BASE_SERIAL} → apply: + aws_iam_role.email_worker`,
        },
        {
          text: `Arjun finishes first and writes serial ${BASE_SERIAL + 1}, with his role. Seven minutes later Priya's apply finishes and writes its own serial ${BASE_SERIAL + 1}, built from the copy it read at 10:02: with her cache, without his role. Nothing stops the second write from replacing the first.`,
          nodes: ['Arjun', 'Priya', 'S3 State Bucket', 'Older State Versions'],
          data: `10:02:27 Arjun  writes serial ${BASE_SERIAL + 1}: ${RESOURCES} + role\n10:09:14 Priya  writes serial ${BASE_SERIAL + 1}: ${RESOURCES} + cache   ← overwrites Arjun's\n\nIAM role email-worker: exists in AWS, in no state file`,
        },
        {
          text: 'The role is now an orphan: it exists in AWS, but Terraform no longer knows it owns it. Arjun\'s next plan wants to create it again and fails.',
          nodes: ['Arjun', 'IAM Role'],
          data: 'Plan: 1 to add, 0 to change, 0 to destroy.\n  + aws_iam_role.email_worker\n\nError: creating IAM Role (email-worker): EntityAlreadyExists: Role with name email-worker already exists.\n\nfix: an import block for the role, then plan again',
        },
      ],
      orphans: ['IAM role email-worker'],
      duplicates: [],
      lostWork: 'Arjun\'s change, silently dropped from state',
      lesson: 'A shared remote state without a lock loses updates: the last writer wins. Locking makes the second apply wait instead.',
    }
  return {
    steps: [
      {
        text: `Priya starts her apply first. Before reading the state, Terraform creates a lock object, orders/prod.tfstate.tflock, with a conditional write that only succeeds if it doesn't exist yet.`,
        nodes: ['Priya', 'Lock File', 'S3 State Bucket'],
        data: `10:02:00 Priya  PutObject prod.tfstate.tflock (If-None-Match: *) → 200, lock held\n10:02:00 Priya  reads serial ${BASE_SERIAL} → apply: + aws_elasticache_cluster.sessions`,
      },
      {
        text: 'Arjun\'s apply tries to take the same lock five seconds later and is refused, with the details of who holds it. He re-runs with -lock-timeout=10m, and Terraform waits.',
        nodes: ['Arjun', 'Lock File'],
        data: `${LOCK_ERROR('priya@priya-mbp', 'OperationTypeApply', '2026-11-13 04:32:00 +0000 UTC')}\n\n$ terraform apply -lock-timeout=10m`,
      },
      {
        text: `Priya's apply writes serial ${BASE_SERIAL + 1} and releases the lock. Arjun's waiting run takes it, reads serial ${BASE_SERIAL + 1} with the cache in it, and plans only his role. It writes serial ${BASE_SERIAL + 2}: both changes kept.`,
        nodes: ['Arjun', 'S3 State Bucket', 'IAM Role'],
        data: `10:09:14 Priya  writes serial ${BASE_SERIAL + 1} (+ cache), deletes .tflock\n10:09:15 Arjun  acquires lock, reads serial ${BASE_SERIAL + 1}\n         Plan: 1 to add (role) · writes serial ${BASE_SERIAL + 2}\nstate: ${RESOURCES + 2} resources`,
      },
    ],
    orphans: [],
    duplicates: [],
    lostWork: 'nothing; Arjun waited 7 minutes',
    lesson: 'With a lock, two applies can\'t interleave: the second waits, then plans against the newest state. Nothing is lost.',
  }
}

function nextDay(b: Backend): Outcome {
  if (b === 'local')
    return {
      steps: [
        {
          text: `The next morning Arjun clones the repository to fix a typo in a tag. terraform.tfstate is in .gitignore (it holds secrets), so his checkout has no state at all.`,
          nodes: ['Arjun', 'Laptop State File'],
          data: '$ git clone git@github.com:priya-foods/infra.git && cd infra\n$ terraform init && terraform plan\n\nNo state file → Terraform assumes nothing exists',
        },
        {
          text: `His plan proposes creating all ${RESOURCES} resources. Luckily he reads it before applying.`,
          nodes: ['Arjun', 'AWS Resources'],
          data: `Plan: ${RESOURCES} to add, 0 to change, 0 to destroy.\n\nexpected: Plan: 0 to add, 1 to change, 0 to destroy.`,
        },
      ],
      orphans: [],
      duplicates: [],
      lostWork: 'Arjun can\'t work until he gets Priya\'s file',
      lesson: 'Local state ties the infrastructure to one laptop. Nobody else can safely plan or apply.',
    }
  return {
    steps: [
      {
        text: 'The next morning Arjun clones the repository and runs terraform init. The backend block tells Terraform where the state lives, so init connects to the S3 bucket.',
        nodes: ['Arjun', 'S3 State Bucket'],
        data: `$ terraform init\nInitializing the backend...\nSuccessfully configured the backend "s3"!\n\n$ terraform plan   (reads serial ${BASE_SERIAL + 1}, ${RESOURCES + 1} resources)`,
      },
      {
        text: 'His plan shows just his one-line tag change, because he is planning against the same state as everyone else.',
        nodes: ['Arjun', 'AWS Resources'],
        data: 'Plan: 0 to add, 1 to change, 0 to destroy.\n  ~ tags = { "team" = "orders" -> "orders-platform" }',
      },
    ],
    orphans: [],
    duplicates: [],
    lostWork: 'nothing',
    lesson: 'A remote backend gives everyone, and CI, the same state. Init once, then any checkout can plan.',
  }
}

function lost(b: Backend): Outcome {
  if (b === 'local')
    return {
      steps: [
        {
          text: `Priya's laptop is stolen from a café. The only copy of the state file was on it, describing ${RESOURCES} resources that keep running in AWS.`,
          nodes: ['Priya', 'Laptop State File'],
          data: `terraform.tfstate: gone\nAWS: ${RESOURCES} resources, still running and billing`,
        },
        {
          text: `To manage them again, the team writes an import block for each one, with its real ID found in the console, and plans until nothing else changes. It takes two days, and any setting the code didn't match shows up as a surprise change.`,
          nodes: ['Arjun', 'AWS Resources', 'Laptop State File'],
          data: `import { to = aws_vpc.main  id = "vpc-0b7e3c2a1d4f5e6a7" }\nimport { to = aws_instance.api  id = "i-0a1b2c3d4e5f60718" }\n… ${RESOURCES - 2} more\n\nPlan: ${RESOURCES} to import, 0 to add, 3 to change, 0 to destroy.`,
        },
      ],
      orphans: [`${RESOURCES} resources until imported`],
      duplicates: [],
      lostWork: 'two days of import work',
      lesson: 'If the state exists in one place, losing that place loses Terraform\'s memory of everything. Keep it in a durable, versioned backend.',
    }
  return {
    steps: [
      {
        text: 'Priya\'s laptop is stolen from a café. The state was never on it; it lives in S3, encrypted, with versioning on so every write is kept.',
        nodes: ['Priya', 'S3 State Bucket', 'Older State Versions'],
        data: `s3://priya-terraform-state/orders/prod.tfstate: serial ${BASE_SERIAL + 1}\nversions kept: 142\nlaptop: only the repo, which is on GitHub`,
      },
      {
        text: 'On her new laptop she clones the repository, runs terraform init and is back to work in minutes. IT revokes the old laptop\'s AWS sessions; there were no long-lived keys on it.',
        nodes: ['Priya', 'S3 State Bucket'],
        data: '$ terraform init && terraform plan\nNo changes. Your infrastructure matches the configuration.',
      },
    ],
    orphans: [],
    duplicates: [],
    lostWork: 'nothing',
    lesson: 'State in a remote, versioned backend outlives any laptop.',
  }
}

function killed(b: Backend): Outcome {
  const steps: Trace['steps'] = [
    {
      text: `${b === 'local' ? 'Priya applies' : 'A CI run applies'} three new resources: an IAM role, a security group and a Redis cache. Three minutes in, the role and security group are done and the cache is still being created when ${b === 'local' ? 'her laptop\'s battery dies' : 'the CI runner is killed (it hit its time limit)'}.`,
      nodes: [b === 'local' ? 'Priya' : 'CI Runner', 'IAM Role', 'Redis Cache'],
      data: `aws_iam_role.cache_access: Creation complete after 2s\naws_security_group.cache: Creation complete after 3s\naws_elasticache_cluster.sessions: Still creating... [3m0s elapsed]\nKilled (SIGKILL)`,
    },
    {
      text: 'Terraform saves state snapshots during long applies, so the role and security group made it into the state. The cache didn\'t: AWS keeps creating it, but no state records it. It is an orphan.',
      nodes: [b === 'local' ? 'Laptop State File' : 'S3 State Bucket', 'Redis Cache'],
      data: `state: serial ${BASE_SERIAL + 1}, ${RESOURCES + 2} resources (role, security group)\nAWS: cache orders-sessions → available 4 minutes later, unrecorded`,
    },
  ]
  if (b === 'locked')
    steps.push({
      text: 'The killed run never deleted its lock. The next run is refused. After checking that the CI run is really dead, someone removes the lock by its ID.',
      nodes: ['Arjun', 'Lock File'],
      data: `${LOCK_ERROR('runner@ci-7f3a', 'OperationTypeApply', '2026-11-13 05:10:00 +0000 UTC')}\n\n$ terraform force-unlock 6c2b9e1a-3f4d-4e7a-9b2c-9d0e5f6a7b8c\nTerraform state has been successfully unlocked!`,
    })
  steps.push({
    text: 'The next plan wants to create the cache again, which fails because the name is taken. An import block adopts the orphan instead.',
    nodes: ['Arjun', 'Redis Cache'],
    data: 'Error: creating ElastiCache Cache Cluster (orders-sessions): CacheClusterAlreadyExists\n\nimport {\n  to = aws_elasticache_cluster.sessions\n  id = "orders-sessions"\n}\nPlan: 1 to import, 0 to add, 0 to change, 0 to destroy.',
  })
  return {
    steps,
    orphans: ['Redis cache orders-sessions'],
    duplicates: [],
    lostWork: b === 'locked' ? 'one stale lock and one import' : 'one import',
    lesson:
      b === 'locked'
        ? 'A lock outlives a killed process on purpose: better a stuck lock than two applies at once. Check nothing is running, then force-unlock.'
        : 'A killed apply can leave resources AWS created but state never recorded. Give CI applies enough time, and import orphans rather than recreating them.',
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'backend', label: 'State lives in', options: Object.keys(BACKEND) },
    { id: 'situation', label: 'Situation', options: Object.keys(SITUATION) },
  ],
  defaults: { backend: 'S3, no locking', situation: 'Two people apply at once' },
  run({ backend, situation }) {
    const b = BACKEND[backend] ?? 's3'
    const s = SITUATION[situation] ?? 'concurrent'
    const out = s === 'concurrent' ? concurrent(b) : s === 'nextday' ? nextDay(b) : s === 'lost' ? lost(b) : killed(b)
    const steps: Trace['steps'] = [
      {
        text: `Priya and Arjun manage the orders app's ${RESOURCES} AWS resources with Terraform. ${b === 'local' ? 'The state file is terraform.tfstate on Priya\'s laptop.' : b === 's3' ? 'The state file is in an S3 bucket, so everyone reads and writes the same one.' : 'The state file is in an encrypted, versioned S3 bucket, and every run takes a lock first.'}`,
        nodes: ['Priya', 'Arjun', b === 'local' ? 'Laptop State File' : 'S3 State Bucket', ...(b === 'locked' ? ['Lock File'] : [])],
        data: BACKEND_CONFIG[b],
      },
      ...out.steps,
      {
        text: `Result: ${out.orphans.length ? `orphaned: ${out.orphans.join(', ')}; ` : ''}${out.duplicates.length ? `created twice: ${out.duplicates.join(', ')}; ` : ''}cost: ${out.lostWork}. ${out.lesson}`,
        nodes: ['Priya', 'Arjun', b === 'local' ? 'Laptop State File' : 'S3 State Bucket'],
        data: `orphans: ${out.orphans.length ? out.orphans.join(', ') : 'none'}\nduplicates: ${out.duplicates.length ? out.duplicates.join(', ') : 'none'}\ncost: ${out.lostWork}`,
      },
    ]
    const verdict = out.orphans.length ? `orphaned: ${out.orphans.join(', ')}` : out.duplicates.length ? `created twice: ${out.duplicates.join(', ')}` : 'nothing lost'
    return { input: `${backend} · ${situation.toLowerCase()} → ${verdict}`, steps }
  },
}

const run = (backend: string, situation: string) => ({ backend, situation })

export const terraformState: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'terraform-state',
  title: 'Terraform Remote State and Locking',
  blurb: 'Why state lives in S3, how a lock stops two applies colliding, and what orphans and stale locks look like',
  guides: ['how-does-terraform-turn-code-into-cloud', 'aws-ecs-fullstack-modules', 'tf-aws-vpc', 'a-cheatsheet-on-infrastructure-as-code-landscape'],
  story: {
    title: 'Two applies, one state',
    dek: 'Terraform worked well for Priya alone. Then Arjun joined, then CI, and the state file turned out to be the part that had to be shared.',
    chapters: [
      {
        heading: 'The file nobody else had',
        body: `For months the state lived in \`terraform.tfstate\` on Priya's laptop, kept out of Git because it holds secrets like database passwords in plain text. When Arjun joined, his fresh checkout had no state, and his first plan proposed creating all 23 resources again.

Sending the file on Slack worked once. Two weeks later his copy was stale, and his apply recreated a security group rule and failed on two resources that already existed.`,
        replay: { label: 'A stale copy', values: run('Local file on a laptop', 'Two people apply at once') },
      },
      {
        heading: 'One state for everyone',
        body: `A **backend** decides where state lives. With the S3 backend, a short \`backend "s3"\` block in the code points at a bucket and key, and \`terraform init\` connects to it. Everyone, and CI, reads and writes the same file.

Turn on **versioning** for the bucket, so every write is kept and a bad one can be rolled back, and encryption, because state contains secrets. Then lock down who can read it.`,
        replay: { label: 'Arjun plans the next day', values: run('S3, no locking', 'A teammate plans the next day') },
      },
      {
        heading: 'The last writer wins',
        body: `One morning Priya added a Redis cache and Arjun added an IAM role, at the same moment. Both read serial 41. Arjun's apply finished in 20 seconds and wrote serial 42. Priya's took seven minutes and also wrote serial 42, from the copy she'd read at the start, without his role.

The role kept running in AWS, but no state recorded it: an **orphan**. Arjun's next plan tried to create it again and failed with \`EntityAlreadyExists\`.`,
        replay: { label: 'Replay the collision', values: run('S3, no locking', 'Two people apply at once') },
      },
      {
        heading: 'Take a lock first',
        body: `**State locking** fixes that. Since Terraform 1.10 the S3 backend can lock with \`use_lockfile = true\`: before reading state, Terraform writes a \`.tflock\` object with a conditional write that fails if one already exists (older setups use a DynamoDB table for the same job).

Arjun's second run was refused with the lock's owner and start time. With \`-lock-timeout=10m\` it waited, then planned against Priya's new state, and both changes were kept.`,
        replay: { label: 'Replay with a lock', values: run('S3 with a lock file', 'Two people apply at once') },
      },
      {
        heading: 'The lock that stayed',
        body: `Then a CI run hit its time limit halfway through creating a cache and was killed. Two lessons came at once. The lock stayed behind, on purpose, since Terraform can't tell a dead apply from a slow one. After checking that nothing was running, Arjun removed it with \`terraform force-unlock\` and its ID.

And the cache AWS finished creating wasn't in the state. Instead of creating it again, an **import block** adopted it.

> Locks prevent collisions. Versioning undoes mistakes. Imports adopt what state forgot.`,
        replay: { label: 'Replay the killed run', values: run('S3 with a lock file', 'An apply is killed midway') },
      },
    ],
  },
  takeaways: [
    'State must be shared, so keep it in a remote backend such as S3, not on a laptop or in Git.',
    'Turn on bucket versioning and encryption, and restrict access: state can contain secrets.',
    'Without locking, two applies at once lose updates, because the last write wins.',
    'Locking (use_lockfile on S3 since Terraform 1.10, or DynamoDB before) makes the second run wait or fail clearly.',
    'A killed apply can leave a stale lock and orphaned resources: force-unlock only after checking, then import the orphans.',
    'Split large systems into several state files so one lock and one mistake don\'t cover everything.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'laptop', label: 'Priya\'s laptop' },
      { id: 'backend', label: 'Remote backend (S3, ap-south-1)' },
      { id: 'aws', label: 'Managed resources' },
    ],
    nodes: [
      { id: 'priya', label: 'Priya', shape: 'ellipse', color: 'blue', group: null },
      { id: 'arjun', label: 'Arjun', shape: 'ellipse', color: 'blue', group: null },
      { id: 'ci', label: 'CI Runner', shape: 'rectangle', color: 'orange', group: null },
      { id: 'local', label: 'Laptop State File', shape: 'rectangle', color: 'green', group: 'laptop' },
      { id: 'lock', label: 'Lock File', shape: 'diamond', color: 'yellow', group: 'backend' },
      { id: 's3', label: 'S3 State Bucket', shape: 'rectangle', color: 'green', group: 'backend' },
      { id: 'versions', label: 'Older State Versions', shape: 'rectangle', color: 'green', group: 'backend' },
      { id: 'aws', label: 'AWS Resources', shape: 'rectangle', color: 'violet', group: 'aws' },
      { id: 'role', label: 'IAM Role', shape: 'rectangle', color: 'violet', group: 'aws' },
      { id: 'cache', label: 'Redis Cache', shape: 'rectangle', color: 'red', group: 'aws' },
    ],
    edges: [
      { from: 'priya', to: 'local', label: 'local backend', dashed: true },
      { from: 'priya', to: 'lock', label: 'acquire', dashed: false },
      { from: 'arjun', to: 'lock', label: 'acquire (waits)', dashed: false },
      { from: 'ci', to: 'lock', label: 'acquire', dashed: false },
      { from: 'lock', to: 's3', label: 'then read / write', dashed: false },
      { from: 's3', to: 'versions', label: 'every write kept', dashed: true },
      { from: 'priya', to: 'cache', label: 'apply', dashed: true },
      { from: 'arjun', to: 'role', label: 'apply', dashed: true },
      { from: 'ci', to: 'aws', label: 'apply', dashed: true },
      { from: 's3', to: 'aws', label: 'records', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Terraform Remote State and Locking',
    summary:
      'Terraform\'s state file is its memory of what it manages, so a team must share one copy and never write it twice at once. A remote backend such as S3 shares it, versioning keeps every revision, and a lock makes concurrent runs wait. When runs die, locks and orphaned resources need deliberate cleanup.',
    sections: [
      {
        heading: 'Overview',
        body: '- Backend: where state is stored; local by default, or S3, Terraform Cloud, GCS and others.\n- Serial: a number that goes up on every write of the state.\n- Lineage: an ID shared by every version of one state, so Terraform can refuse an unrelated file.\n- Lock: taken before reading state for plan or apply, released at the end.\n- Orphan: a real resource that no state records.\n- force-unlock: removes a lock by ID when its owner is known to be dead.\n\nThe simulator follows the state serial and the resources each copy records against what exists in AWS, for each backend and situation.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Every engineer and CI plans against the same, current state.\n- Two applies can never interleave.\n- A lost laptop or a bad write can\'t lose the state.\n\nNon-functional:\n- State is encrypted and readable only by those who apply.\n- Recovering from a stuck run takes minutes, not days.',
      },
      {
        heading: 'Capacity estimates',
        body: '- 23 resources in one state; a typical plan refreshes them in seconds.\n- Collision window: from reading state to writing it, the length of the apply: 20 seconds for a role, 7 minutes for a cache.\n- Rebuilding a lost state by hand: one import per resource, 23 here, plus fixing every difference the plan then shows.\n- Versioning keeps every write; at a few KB to a few MB per state file, years of history cost cents.',
      },
      {
        heading: 'Step by step',
        body: '1. Priya, Arjun and the CI Runner run terraform init, which connects to the S3 State Bucket from the backend block.\n2. Each run first takes the Lock File with a conditional write; a second run is refused or waits.\n3. With the lock held, the run reads the state from the S3 State Bucket, plans and applies to the AWS Resources.\n4. It writes the new state with a higher serial; versioning keeps the previous one in Older State Versions.\n5. It deletes the lock.\n6. Without a backend, state is the Laptop State File, which nobody else can see.',
      },
      {
        heading: 'Components',
        body: '- Priya: an engineer applying from her laptop.\n- Arjun: another engineer, applying at the same time.\n- CI Runner: the pipeline that applies merged changes.\n- Laptop State File: terraform.tfstate with the default local backend.\n- Lock File: the .tflock object (or DynamoDB item) that only one run can hold.\n- S3 State Bucket: the shared, encrypted state.\n- Older State Versions: S3 versioning\'s history of every state write.\n- AWS Resources: everything the state records.\n- IAM Role: Arjun\'s new resource, orphaned when his write is overwritten.\n- Redis Cache: the resource left unrecorded by a killed apply.',
      },
      {
        heading: 'Key decisions',
        body: '- Backend: S3 with use_lockfile on AWS; Terraform Cloud or another managed backend if you also want runs and policy checks.\n- Bootstrap the state bucket once, separately, and protect it with prevent_destroy.\n- One state per environment and per component (network, data, app), so a lock or a mistake has a small blast radius.\n- Apply from CI, not laptops, so there is one queue of changes and one audit trail.\n- Never edit state by hand; use terraform state mv, rm and import blocks.\n- Restrict who can read state: it can contain secrets.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Stale locks: confirm the owner is gone (Who, Created), then force-unlock.\n- Orphans: find them in plan errors (AlreadyExists) or with tagging; adopt with import blocks.\n- Bad state write: restore the previous object version from S3, then plan to check.\n- Many teams: separate states and read others\' outputs with the terraform_remote_state data source or a parameter store.\n- Slow plans on big states mean the state is too big; split it with moved blocks and terraform state mv.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why can\'t Terraform state live in Git?\n- What happens when two people apply without a lock?\n- How does S3 locking work without DynamoDB?\n- When is force-unlock safe?\n- What is an orphaned resource, and how do you recover it?\n- How would you split one large state into several?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A bucket for state, created once (bash)',
        language: 'bash',
        source: `aws s3api create-bucket --bucket priya-terraform-state --region ap-south-1 \\
  --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-bucket-versioning --bucket priya-terraform-state \\
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket priya-terraform-state \\
  --server-side-encryption-configuration \\
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
aws s3api put-public-access-block --bucket priya-terraform-state \\
  --public-access-block-configuration \\
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
      },
      {
        title: 'Moving local state to S3 (bash)',
        language: 'bash',
        source: `cat > backend.tf <<'EOF'
terraform {
  backend "s3" {
    bucket       = "priya-terraform-state"
    key          = "orders/prod.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}
EOF

terraform init -migrate-state   # copies ./terraform.tfstate into the bucket
rm terraform.tfstate*           # after checking: terraform state list`,
      },
      {
        title: 'Waiting for, and clearing, a lock (bash)',
        language: 'bash',
        source: `# Wait up to 10 minutes for another run's lock instead of failing at once.
terraform apply -lock-timeout=10m

# A run died and left its lock. Check Who/Created in the error first;
# only then remove it, by the lock ID from the error message.
terraform force-unlock 6c2b9e1a-3f4d-4e7a-9b2c-9d0e5f6a7b8c`,
      },
      {
        title: 'Rolling back a bad state write (bash)',
        language: 'bash',
        source: `# List the previous versions of the state object.
aws s3api list-object-versions --bucket priya-terraform-state \\
  --prefix orders/prod.tfstate --query 'Versions[0:5].[VersionId,LastModified]' --output table

# Copy a known-good version back as the current one, then check with a plan.
aws s3api copy-object --bucket priya-terraform-state --key orders/prod.tfstate \\
  --copy-source "priya-terraform-state/orders/prod.tfstate?versionId=3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY"
terraform plan`,
      },
    ],
    related: ['Terraform Basics', 'Terraform Modules', 'Distributed locking', 'AWS IAM', 'Disaster recovery'],
  },
  simulator,
}
