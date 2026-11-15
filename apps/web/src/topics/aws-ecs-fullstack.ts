import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from aws-samples/amazon-ecs-fullstack-app-terraform (MIT-0): the
// architecture (Vue client and Node.js server as two ECS services behind two
// load balancers, DynamoDB, S3 assets, ECR, and a CodePipeline → CodeBuild →
// CodeDeploy blue/green pipeline with automatic rollback, a 5-minute wait before
// the old tasks are terminated, and SNS notifications) follows the sample.
// The deployment simulator, canary and alarm options, walkthrough and story are
// Structura's.

const PER_MINUTE = 3000 // API requests a minute to the server's load balancer
const BAD_ERROR_RATE = 0.3 // the broken release fails 30% of requests
const ALARM_THRESHOLD = 50 // 5xx responses in a minute
const ALARM_PERIODS = 2 // consecutive minutes over the threshold before it fires
const BLUE_WAIT = 5 // minutes the old tasks are kept after traffic has moved (as in the sample)
const NOTICE = 15 // minutes before someone notices without an alarm
const REDEPLOY = 10 // minutes to build and deploy the previous version once blue is gone
const MINUTES = 30

const STRATEGIES: Record<string, { name: string; shares: (t: number) => number }> = {
  'All at once': { name: 'CodeDeployDefault.ECSAllAtOnce', shares: () => 1 },
  'Canary: 10% for 5 minutes': { name: 'CodeDeployDefault.ECSCanary10Percent5Minutes', shares: (t) => (t < 5 ? 0.1 : 1) },
  'Linear: 10% every minute': { name: 'CodeDeployDefault.ECSLinear10PercentEvery1Minutes', shares: (t) => Math.min(1, 0.1 * (t + 1)) },
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')

function simulate(bad: boolean, strategyKey: string, alarm: boolean) {
  const s = STRATEGIES[strategyKey] ?? STRATEGIES['All at once']
  const full = [...Array(MINUTES).keys()].find((t) => s.shares(t) >= 1) ?? 0 // minute traffic is fully on green
  const rows: { t: number; green: number; errors: number; note: string }[] = []
  let over = 0
  let firstError = -1
  let state: 'shifting' | 'done' | 'rolled back' | 'redeploying' | 'fixed' = 'shifting'
  let endedAt = -1
  let blueGoneAt = full + BLUE_WAIT
  let errorsTotal = 0
  for (let t = 0; t < MINUTES; t++) {
    let green = state === 'rolled back' || state === 'fixed' ? 0 : s.shares(t)
    let note = ''
    if (state === 'redeploying') green = 1
    const errors = bad ? green * PER_MINUTE * BAD_ERROR_RATE : 0
    if (errors && firstError < 0) firstError = t
    errorsTotal += errors
    if (state === 'shifting' && t === full) note = 'all traffic on green'
    if (state === 'shifting' && t === blueGoneAt) {
      state = 'done'
      note = 'deployment succeeded; blue tasks terminated'
    }
    // The 5xx alarm, if there is one, can stop the deployment while blue still exists.
    over = errors > ALARM_THRESHOLD ? over + 1 : 0
    if (alarm && over >= ALARM_PERIODS && state === 'shifting') {
      state = 'rolled back'
      endedAt = t + 1
      note = `alarm fired (${over} minutes over ${ALARM_THRESHOLD}); traffic back to blue`
    }
    if (!alarm && bad && state !== 'rolled back' && state !== 'fixed' && firstError >= 0 && t === firstError + NOTICE) {
      if (t < blueGoneAt) {
        state = 'rolled back'
        endedAt = t + 1
        note = 'on-call notices and stops the deployment; traffic back to blue'
      } else {
        state = 'redeploying'
        note = 'on-call notices; blue is gone, so the previous version must be rebuilt and deployed'
        blueGoneAt = t + REDEPLOY
      }
    }
    if (state === 'redeploying' && t === blueGoneAt) {
      state = 'fixed'
      endedAt = t + 1
      note = 'previous version is live again'
    }
    rows.push({ t, green, errors, note })
  }
  if (state === 'shifting') state = 'done'
  return { rows, errorsTotal, state, endedAt, firstError, full, strategy: s.name }
}

const simulator: Simulator = {
  fields: [
    { id: 'release', label: 'The server release', options: ['Works', 'Returns 500 for 30% of requests'] },
    { id: 'strategy', label: 'Traffic shifting', options: Object.keys(STRATEGIES) },
    { id: 'alarm', label: 'Automatic rollback', options: ['Only if the deployment fails', 'Also when the 5xx alarm fires'] },
  ],
  defaults: { release: 'Works', strategy: 'All at once', alarm: 'Only if the deployment fails' },
  run(v) {
    const bad = v.release.startsWith('Returns')
    const alarm = v.alarm.startsWith('Also')
    const r = simulate(bad, v.strategy, alarm)
    const steps: Trace['steps'] = []

    steps.push({
      text: 'A developer pushes a change to the server code. CodePipeline watches the GitHub repository; the push starts the pipeline\'s source stage, which copies the commit into an artifact bucket.',
      nodes: ['Developer', 'GitHub Repository', 'CodePipeline'],
      data: 'commit 4f9c2e1  "products: add sorting by price"\npipeline: source → build (server, client) → deploy (server, client)',
    })
    steps.push({
      text: 'CodeBuild runs the buildspec: log in to ECR, build the server\'s Docker image, push it, and fill in the task definition and appspec templates that CodeDeploy needs.',
      nodes: ['CodePipeline', 'CodeBuild', 'ECR'],
      data: 'docker build -t $REPO_URL Code/server\ndocker push $REPO_URL:$IMAGE_TAG\n\nappspec.yaml\n  TargetService: AWS::ECS::Service\n  TaskDefinition: <TASK_DEFINITION>\n  LoadBalancerInfo: { ContainerName: server, ContainerPort: 80 }',
    })
    steps.push({
      text: 'CodeDeploy starts a second set of tasks, green, with the new image, next to the running blue set. Green registers with its own target group and must pass the /status health check before it gets any traffic.',
      nodes: ['CodeDeploy', 'Green Tasks (server)', 'Server ALB'],
      data: `blue:  tg-server-blue   4 tasks   image :41   ← all traffic\ngreen: tg-server-green  4 tasks   image :42   healthy\nconfig: ${r.strategy}`,
    })

    const shown = r.rows.filter((row) => row.t < 6 || row.note || row.t % 5 === 0).slice(0, 12)
    steps.push({
      text: `CodeDeploy moves the load balancer's listener from blue to green: ${v.strategy.toLowerCase()}. ${bad ? `The new release fails 30% of requests, so every minute green serves, ${int(PER_MINUTE * BAD_ERROR_RATE)} × its share of traffic fail.` : 'Green answers normally.'}`,
      nodes: ['Server ALB', 'Blue Tasks (server)', 'Green Tasks (server)'],
      data: `min  green  errors\n${shown.map((row) => `${String(row.t).padStart(3)}  ${String(Math.round(row.green * 100)).padStart(4)}%  ${String(int(row.errors)).padStart(6)}${row.note ? `  ${row.note}` : ''}`).join('\n')}`,
    })

    steps.push({
      text: !bad
        ? `Green is healthy, so after all traffic has moved, CodeDeploy waits ${BLUE_WAIT} minutes with blue still running, in case a rollback is needed, then terminates blue. The deployment is done.`
        : alarm
          ? `A CloudWatch alarm watches the green target group's 5xx count. After ${ALARM_PERIODS} minutes over ${ALARM_THRESHOLD}, it fires, and CodeDeploy rolls back: the listener points at blue again, which is still running, so recovery takes seconds.`
          : r.state === 'fixed'
            ? `There is no alarm, so CodeDeploy only sees that green passed its health checks. After ${BLUE_WAIT} minutes it terminates blue. Someone notices the errors ${NOTICE} minutes later, but blue is gone: the previous version has to go through the pipeline again, about ${REDEPLOY} more minutes.`
            : `There is no alarm. Someone notices the errors ${NOTICE} minutes after they start; blue is still running, so they stop the deployment and traffic returns to blue.`,
      nodes: bad ? ['5xx Alarm', 'CodeDeploy', 'Blue Tasks (server)'] : ['CodeDeploy', 'Blue Tasks (server)'],
      data: bad ? `failed requests: ${int(r.errorsTotal)}\nerrors from minute ${r.firstError} to minute ${r.endedAt - 1}` : `blue terminated at minute ${r.full + BLUE_WAIT}\nfailed requests: 0`,
    })

    steps.push({
      text: `CodeDeploy publishes the result to SNS, which emails the team${r.state === 'rolled back' ? ' that the deployment was rolled back' : ''}. The client app, served by its own load balancer, kept calling the server's API throughout, and its images still come straight from S3.`,
      nodes: ['CodeDeploy', 'SNS Notifications', 'Developer', 'Client Tasks'],
      data: `deployment: ${r.state === 'rolled back' ? 'Stopped, rolled back' : r.state === 'fixed' ? 'Succeeded (then replaced by a manual redeploy)' : 'Succeeded'}\nfailed requests: ${int(r.errorsTotal)}`,
    })

    return {
      input: `${bad ? 'broken' : 'working'} release · ${v.strategy.split(':')[0].toLowerCase()} · ${alarm ? '5xx alarm' : 'no alarm'} → ${bad ? `${int(r.errorsTotal)} failed requests, ${r.state === 'rolled back' ? 'rolled back' : 'redeployed by hand'}` : 'deployed, 0 errors'}`,
      steps,
    }
  },
}

const run = (o: Partial<Record<'release' | 'strategy' | 'alarm', string>>) => ({ ...simulator.defaults, ...o })

export { simulate as simulateFullstack }

export const awsEcsFullstack: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'aws-ecs-fullstack',
  title: 'Full-stack App on ECS',
  blurb: 'A Vue client and a Node API on ECS, with DynamoDB and S3, shipped by a pipeline with blue/green deploys',
  adaptedFrom: {
    title: 'Amazon ECS fullstack app with Terraform',
    author: 'Amazon Web Services (aws-samples)',
    url: 'https://github.com/aws-samples/amazon-ecs-fullstack-app-terraform',
    license: 'MIT-0',
    licenseUrl: 'https://github.com/aws/mit-0',
  },
  guides: ['aws-ecs-fullstack-sample', 'aws-ecs-fullstack-infrastructure', 'aws-ecs-fullstack-cicd', 'aws-ecs-fullstack-autoscaling', 'aws-ecs-fullstack-modules', 'aws-containers-roadmap-board'],
  story: {
    title: 'Friday\'s release, twice',
    dek: 'A small team adopts AWS\'s full-stack ECS sample, ships every change through one pipeline, and learns why "blue/green" is only as safe as the thing that decides to roll back.',
    chapters: [
      {
        heading: 'The whole stack, as code',
        body: `A four-person team building a product catalogue started from AWS's open-source full-stack sample, which describes everything in Terraform:
- a **Vue.js client** and a **Node.js server**, each an ECS service on Fargate with its own Application Load Balancer, in private subnets across two zones
- **DynamoDB** for the catalogue items and an **S3** bucket for product images
- **ECR** repositories for the two images
- a **CodePipeline** that takes every push to GitHub, builds both images with **CodeBuild** and deploys them with **CodeDeploy**
- autoscaling on CPU and memory at 50%, and an **SNS** topic that announces every deployment's result

\`terraform apply\` built it in one go. Nobody clicked anything in the console, so staging and production really were the same.`,
        replay: { label: 'Follow a release through the pipeline', values: run({}) },
      },
      {
        heading: 'Blue and green',
        body: `CodeDeploy deploys ECS services **blue/green**. The running tasks are blue. It starts a full second set, green, with the new image, registered in a second target group. Only when green passes its health checks does it move the load balancer's listener from blue to green.

Then it waits. The sample keeps blue running for **5 minutes** after the switch. If anything goes wrong in that window, rolling back is just pointing the listener at blue again: seconds, not a rebuild. After 5 minutes, blue is terminated.

The sample shifts traffic **all at once** and rolls back automatically only when the deployment itself fails: green won't start, or won't pass health checks.`,
      },
      {
        heading: 'Healthy and wrong',
        body: `One Friday, a change to the products endpoint passed its tests and its health checks. \`/status\` answered 200, so green was healthy. But a query bug made 30% of product requests fail with a 500.

All traffic moved at once. CodeDeploy saw a healthy green, waited its 5 minutes, and terminated blue. The errors were noticed 15 minutes after they started, when the old version no longer existed. Rolling back meant pushing the previous commit through the whole pipeline again.

23,400 requests failed. The deployment, as far as CodeDeploy was concerned, had succeeded.

> A health check says a task is alive. It doesn't say the release is right.`,
        replay: { label: 'Replay the broken release, all at once', values: run({ release: 'Returns 500 for 30% of requests' }) },
      },
      {
        heading: 'A canary and an alarm',
        body: `The team made two changes.

First, a **CloudWatch alarm** on the green target group's 5xx count: more than 50 in a minute, for 2 minutes in a row. The deployment group lists it, so when it fires during a deployment, CodeDeploy rolls back on its own.

Second, a **canary**: \`CodeDeployDefault.ECSCanary10Percent5Minutes\` sends 10% of traffic to green for 5 minutes before the rest. A bad release now hurts a tenth of users, briefly, and the alarm catches it while blue is still taking 90% of the load.

The same bug, shipped again by accident a month later, failed 180 requests instead of 23,400, and the team learned about it from an SNS email saying the deployment had been rolled back.`,
        replay: { label: 'Replay with a canary and the alarm', values: run({ release: 'Returns 500 for 30% of requests', strategy: 'Canary: 10% for 5 minutes', alarm: 'Also when the 5xx alarm fires' }) },
      },
      {
        heading: 'What the pipeline buys you',
        body: `A year later, every change, from a typo to a new endpoint, goes the same way: push, build, green, shift, watch, done. Releases happen on Fridays without anyone holding their breath.

What made it work wasn't one service. It was the pieces together:
- infrastructure in code, so environments match
- immutable images tagged by commit, so "what's running" has an exact answer
- blue/green with a wait, so rolling back is a switch, not a rebuild
- an alarm on what users feel (errors), not just on whether the process is up
- a canary, so mistakes are small while the alarm makes up its mind

> Deployment safety is a property of the system, not of the people pressing the button.`,
        replay: { label: 'Try a linear rollout with the alarm', values: run({ release: 'Returns 500 for 30% of requests', strategy: 'Linear: 10% every minute', alarm: 'Also when the 5xx alarm fires' }) },
      },
    ],
  },
  takeaways: [
    'Describe the whole stack (network, load balancers, services, data, pipeline) as code, so every environment is built the same way.',
    'A pipeline turns every push into the same steps: build an image tagged by commit, push it to ECR, deploy it with CodeDeploy.',
    'Blue/green runs the new version next to the old one and switches the load balancer, so rolling back is a switch while blue still exists.',
    'Health checks prove a task is alive, not that the release is right; roll back on an alarm that measures the errors users see.',
    'A canary or a step-by-step shift limits how many users a bad release reaches before the alarm decides.',
    'Keep the old version long enough to roll back, and make sure you hear about every deploy.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'pipeline', label: 'CI/CD pipeline' },
      { id: 'server', label: 'Server service' },
      { id: 'client', label: 'Client service' },
    ],
    nodes: [
      { id: 'dev', label: 'Developer', shape: 'ellipse', color: 'blue', group: null },
      { id: 'github', label: 'GitHub Repository', shape: 'cloud', color: 'violet', group: null },
      { id: 'pipeline', label: 'CodePipeline', shape: 'rectangle', color: 'violet', group: 'pipeline' },
      { id: 'build', label: 'CodeBuild', shape: 'rectangle', color: 'orange', group: 'pipeline' },
      { id: 'ecr', label: 'ECR', shape: 'rectangle', color: 'green', group: null },
      { id: 'deploy', label: 'CodeDeploy', shape: 'rectangle', color: 'violet', group: 'pipeline' },
      { id: 'salb', label: 'Server ALB', shape: 'rectangle', color: 'violet', group: 'server' },
      { id: 'blue', label: 'Blue Tasks (server)', shape: 'rectangle', color: 'orange', group: 'server' },
      { id: 'green', label: 'Green Tasks (server)', shape: 'rectangle', color: 'orange', group: 'server' },
      { id: 'alarm', label: '5xx Alarm', shape: 'diamond', color: 'violet', group: null },
      { id: 'visitor', label: 'Visitor', shape: 'ellipse', color: 'blue', group: null },
      { id: 'calb', label: 'Client ALB', shape: 'rectangle', color: 'violet', group: 'client' },
      { id: 'client', label: 'Client Tasks', shape: 'rectangle', color: 'orange', group: 'client' },
      { id: 'ddb', label: 'DynamoDB Table', shape: 'rectangle', color: 'green', group: null },
      { id: 's3', label: 'S3 Assets', shape: 'rectangle', color: 'green', group: null },
      { id: 'sns', label: 'SNS Notifications', shape: 'rectangle', color: 'yellow', group: null },
    ],
    edges: [
      { from: 'dev', to: 'github', label: 'git push', dashed: false },
      { from: 'github', to: 'pipeline', label: 'new commit', dashed: false },
      { from: 'pipeline', to: 'build', label: 'build', dashed: false },
      { from: 'build', to: 'ecr', label: 'docker push', dashed: false },
      { from: 'pipeline', to: 'deploy', label: 'appspec, taskdef', dashed: false },
      { from: 'deploy', to: 'green', label: 'start green', dashed: false },
      { from: 'deploy', to: 'salb', label: 'shift traffic', dashed: false },
      { from: 'salb', to: 'blue', label: 'old version', dashed: false },
      { from: 'salb', to: 'green', label: 'new version', dashed: false },
      { from: 'green', to: 'alarm', label: '5xx count', dashed: true },
      { from: 'alarm', to: 'deploy', label: 'roll back', dashed: true },
      { from: 'deploy', to: 'sns', label: 'result', dashed: false },
      { from: 'visitor', to: 'calb', label: 'https', dashed: false },
      { from: 'calb', to: 'client', label: 'pages', dashed: false },
      { from: 'client', to: 'salb', label: 'API calls', dashed: false },
      { from: 'blue', to: 'ddb', label: 'items', dashed: false },
      { from: 'green', to: 'ddb', label: 'items', dashed: false },
      { from: 'visitor', to: 's3', label: 'product images', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'items',
        name: 'items (DynamoDB)',
        columns: [
          { name: 'id', type: 'N (partition key)', pk: true, fk: null, nullable: false, unique: false },
          { name: 'title', type: 'S', pk: false, fk: null, nullable: false, unique: false },
          { name: 'path', type: 'S (S3 object URL)', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'deployments',
        name: 'deployments (CodeDeploy)',
        columns: [
          { name: 'deployment_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'task_definition', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'config', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'rollback_reason', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [],
  },
  explanation: {
    title: 'Full-stack App on ECS',
    summary:
      'A complete AWS setup for a web app. A Vue.js client and a Node.js API run as two ECS services, each behind its own load balancer, with DynamoDB and S3 for data. A pipeline (CodePipeline) builds every commit with CodeBuild and ships it with CodeDeploy blue/green deploys. Everything is described in Terraform.',
    sections: [
      {
        heading: 'Overview',
        body: 'This topic follows AWS\'s open-source sample "Amazon ECS fullstack app with Terraform" (MIT-0). It puts the pieces from VPC networking, the Application Load Balancer and ECS on Fargate together into one working system. It also adds the part that matters most every day: how a change gets safely from a git push to production.\n\nThe sample builds:\n- a VPC across two zones, with one NAT gateway;\n- two public load balancers;\n- two ECS services on Fargate, the client and the server, each task with 0.25 vCPU and 0.5 GB, scaling on CPU and memory;\n- ECR, a DynamoDB table and an S3 bucket for images;\n- a pipeline: GitHub → CodePipeline → CodeBuild → CodeDeploy, with SNS notifications.\n\nThe simulator replays a release of the server minute by minute, with different ways of shifting traffic and rolling back, and counts the requests that fail.',
      },
      {
        heading: 'Requirements',
        body: 'What it must do:\n- Serve a web client and its API, with catalogue items in DynamoDB and images in S3.\n- Build and deploy every push to the main branch automatically.\n- Roll back a bad release automatically.\n\nHow well it must do it:\n- No downtime during deploys.\n- Every environment built the same way, from code.\n- The team hears the result of every deploy.',
      },
      {
        heading: 'Capacity estimates',
        body: '- API traffic: 3,000 requests a minute (50 a second) to the server\'s load balancer.\n- A release that breaks 30% of requests: 3,000 × 0.3 = 900 failures a minute at full traffic.\n- All at once, no alarm, noticed after 15 minutes, the old version already gone, and 10 more minutes to redeploy: errors in minutes 0 to 25, so 26 × 900 = 23,400 failed requests.\n- A 10% canary with an alarm at more than 50 errors a minute for 2 minutes: 90 failures a minute × 2 = 180 failed requests.\n- Blue/green briefly doubles the server tasks (4 blue + 4 green), so subnets and service limits need room for twice the usual number.',
      },
      {
        heading: 'Step by step',
        body: '1. The Developer pushes to the GitHub Repository, which starts CodePipeline.\n2. CodeBuild builds the image, pushes it to ECR, and prepares the files that describe the deploy (the task definition and the appspec).\n3. CodeDeploy starts the Green Tasks (server) next to the Blue Tasks (server) and waits for green\'s health checks.\n4. CodeDeploy moves the Server ALB\'s traffic from blue to green: all at once, as a canary, or step by step.\n5. The 5xx Alarm watches green; if it goes off during the deploy, CodeDeploy points the traffic back at blue.\n6. After a 5-minute wait, blue is stopped, and CodeDeploy sends the result to SNS Notifications.\n7. Meanwhile, each Visitor loads the client from the Client ALB and the Client Tasks; the client calls the Server ALB for data from the DynamoDB Table, and loads images from S3 Assets.',
      },
      {
        heading: 'Components',
        body: '- Developer: pushes code, and gets an email about every deploy.\n- GitHub Repository: the one true copy of the app\'s code and the infrastructure code.\n- CodePipeline: runs the source, build and deploy steps for every commit.\n- CodeBuild: builds and pushes images, and prepares the deploy files.\n- ECR: private image registries for the client and the server.\n- CodeDeploy: blue/green deploys for ECS, with traffic shifting and automatic rollback.\n- Server ALB: the API\'s load balancer, with a blue and a green target group.\n- Blue Tasks (server): the version that\'s running now.\n- Green Tasks (server): the new version, until it becomes blue.\n- 5xx Alarm: a CloudWatch alarm on server errors that stops a bad deploy.\n- Visitor: someone using the web app.\n- Client ALB: the client\'s own load balancer.\n- Client Tasks: serve the Vue.js app.\n- DynamoDB Table: the catalogue items (id, title, image path).\n- S3 Assets: product images, loaded straight by browsers.\n- SNS Notifications: sends out the result of each deploy.',
      },
      {
        heading: 'Key decisions',
        body: '- Blue/green (CodeDeploy) or rolling (ECS): blue/green lets you test the new version, shift traffic under control, and roll back instantly while blue still exists. Rolling is simpler and needs less spare capacity.\n- Shifting traffic: all at once is fastest; a canary limits who sees the new version while the alarms decide; linear spreads the risk evenly.\n- What triggers a rollback: a failed deploy catches tasks that won\'t start, but only alarms on what users feel (error rate, slowness) catch a release that starts fine and is still wrong.\n- How long to keep blue: longer keeps rollback instant for longer, but you run two sets of tasks meanwhile.\n- Tag images by commit, never "latest", so a task definition always means one exact build.\n- The sample\'s single NAT gateway is fine for a demo; production should have one per zone.\n- The sample uses two load balancers; one ALB with host or path rules would cost less.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Scaling: target tracking at 50% CPU and memory on both services, between 1 and 4 tasks in the sample.\n- During blue/green, capacity doubles, so check Fargate quotas and subnet addresses.\n- A failed build or deploy stops the pipeline, so nothing half-deployed reaches users.\n- An alarm that\'s too sensitive rolls back good releases; one that\'s too relaxed misses bad ones. Base it on error rates over a minute or two.\n- Pipeline secrets, such as the GitHub token, belong in Secrets Manager or a CodeStar connection, not in Terraform variables on someone\'s laptop.\n- The sample keeps Terraform state on one machine; a team should keep it in S3 with locking.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Walk through what happens between a git push and users seeing the change.\n- Why did a release with passing health checks still break production? What catches it?\n- Blue/green or rolling deploys: what does each cost, and what does each protect against?\n- How would you choose the canary percentage and the alarm threshold?\n- How do you roll back a database change that the new release depends on?\n- What would you change in this sample before running it in production?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Blue/green with an alarm rollback (bash)',
        language: 'bash',
        source: `cat > codedeploy.tf <<'EOF'
resource "aws_codedeploy_deployment_group" "server" {
  app_name               = aws_codedeploy_app.server.name
  deployment_group_name  = "server"
  service_role_arn       = aws_iam_role.codedeploy.arn
  deployment_config_name = "CodeDeployDefault.ECSCanary10Percent5Minutes"

  # The sample rolls back on DEPLOYMENT_FAILURE; add the alarm to catch healthy-but-wrong releases.
  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }
  alarm_configuration {
    enabled = true
    alarms  = [aws_cloudwatch_metric_alarm.server_5xx.alarm_name]
  }

  blue_green_deployment_config {
    deployment_ready_option { action_on_timeout = "CONTINUE_DEPLOYMENT" }
    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = 5
    }
  }

  deployment_style {
    deployment_option = "WITH_TRAFFIC_CONTROL"
    deployment_type   = "BLUE_GREEN"
  }

  ecs_service {
    cluster_name = aws_ecs_cluster.main.name
    service_name = aws_ecs_service.server.name
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route { listener_arns = [aws_lb_listener.server.arn] }
      target_group { name = aws_lb_target_group.server_blue.name }
      target_group { name = aws_lb_target_group.server_green.name }
    }
  }
}
EOF`,
      },
      {
        title: 'The 5xx alarm (bash)',
        language: 'bash',
        source: `cat > alarm.tf <<'EOF'
# More than 50 server errors a minute, two minutes running.
resource "aws_cloudwatch_metric_alarm" "server_5xx" {
  alarm_name          = "server-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = aws_lb.server.arn_suffix
    TargetGroup  = aws_lb_target_group.server_green.arn_suffix
  }
}
EOF`,
      },
      {
        title: 'The build (buildspec.yml as bash)',
        language: 'bash',
        source: `# What CodeBuild runs for the server, as in the sample's buildspec.
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build -t "$REPO_URL" Code/server
docker tag "$REPO_URL" "$REPO_URL:$IMAGE_TAG"   # safer as the commit id than a fixed tag
docker push "$REPO_URL:$IMAGE_TAG"

# CodeDeploy needs these two files as build output.
mkdir -p Artifacts
cp Infrastructure/Templates/appspec.yaml Infrastructure/Templates/taskdef.json Artifacts/
sed -i "s|<REPO_URL>|$REPO_URL|g" Artifacts/taskdef.json`,
      },
      {
        title: 'Failed requests per strategy',
        language: 'javascript',
        source: `// Share of traffic on green, minute by minute, for CodeDeploy's ECS configurations.
const shares = {
  allAtOnce: () => 1,
  canary10for5: (t) => (t < 5 ? 0.1 : 1),
  linear10every1: (t) => Math.min(1, 0.1 * (t + 1)),
}

// Failed requests until an alarm (threshold per minute, N minutes running) rolls back.
export function failedRequests(share, perMinute = 3000, errorRate = 0.3, threshold = 50, periods = 2) {
  let total = 0
  let over = 0
  for (let t = 0; t < 30; t++) {
    const errors = share(t) * perMinute * errorRate
    total += errors
    over = errors > threshold ? over + 1 : 0
    if (over >= periods) break // CodeDeploy points the listener back at blue
  }
  return Math.round(total)
}

console.log(failedRequests(shares.allAtOnce), failedRequests(shares.canary10for5), failedRequests(shares.linear10every1)) // 1800 180 270`,
        versions: [
          {
            language: 'typescript',
            source: `// Share of traffic on green, minute by minute, for CodeDeploy's ECS configurations.
const shares = {
  allAtOnce: () => 1,
  canary10for5: (t: number) => (t < 5 ? 0.1 : 1),
  linear10every1: (t: number) => Math.min(1, 0.1 * (t + 1)),
}

// Failed requests until an alarm (threshold per minute, N minutes running) rolls back.
export function failedRequests(share: (t: number) => number, perMinute = 3000, errorRate = 0.3, threshold = 50, periods = 2) {
  let total = 0
  let over = 0
  for (let t = 0; t < 30; t++) {
    const errors = share(t) * perMinute * errorRate
    total += errors
    over = errors > threshold ? over + 1 : 0
    if (over >= periods) break // CodeDeploy points the listener back at blue
  }
  return Math.round(total)
}

console.log(failedRequests(shares.allAtOnce), failedRequests(shares.canary10for5), failedRequests(shares.linear10every1)) // 1800 180 270`,
          },
        ],
      },
    ],
    related: ['ECS on Fargate', 'Application Load Balancer', 'AWS VPC networking', 'Docker vs VMs', 'Feature flags', 'Monitoring and alerting'],
  },
  simulator,
}
