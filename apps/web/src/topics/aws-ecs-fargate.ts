import type { Trace } from '@structura/shared'
import type { Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from terraform-aws-modules/terraform-aws-ecs (Apache License 2.0) for
// the service, task size, autoscaling and circuit breaker settings, and from
// aws-samples/amazon-ecs-fullstack-app-terraform (MIT-0) for the CPU target of
// 50% with 60-second cooldowns. The minute-by-minute simulation, walkthrough and
// story are Structura's.

const SIZES: Record<string, { cpu: number; memory: number }> = {
  '0.25 vCPU, 0.5 GB': { cpu: 256, memory: 512 },
  '0.5 vCPU, 1 GB': { cpu: 512, memory: 1024 },
  '1 vCPU, 2 GB': { cpu: 1024, memory: 2048 },
}

const REQ_PER_VCPU = 400 // requests a second one vCPU of this app handles at 100% CPU
const MINUTES = 30
const MIN_TASKS = 2
const MAX_TASKS = 12
const TARGET = 50 // % CPU
const START_MINUTES = 2 // pull the image, start, pass the load balancer's health checks
const SCALE_IN_AFTER = 15 // minutes below 90% of the target before target tracking removes tasks

// us-east-1 Fargate list prices, Linux/x86
const VCPU_HOUR = 0.04048
const GB_HOUR = 0.004445

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const usd = (n: number, d = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`

interface Minute {
  t: number
  load: number
  tasks: number
  cpu: number
  dropped: number
  desired: number
  failed: number
}

function simulate(sizeKey: string, sale: boolean, scaling: boolean, deploy: 'none' | 'stuck' | 'breaker') {
  const size = SIZES[sizeKey]
  const perTask = (size.cpu / 1024) * REQ_PER_VCPU
  let running = MIN_TASKS
  let desired = MIN_TASKS
  const starting: number[] = [] // minute each pending task becomes healthy
  let lastScaleOut = -99
  let lowFor = 0
  const minutes: Minute[] = []
  const events: string[] = []
  let failedTasks = 0
  let deployState: 'none' | 'running' | 'stuck' | 'rolled back' = deploy === 'none' ? 'none' : 'running'
  let threshold = 3
  // Without the breaker ECS keeps relaunching the failing tasks, backing off: minutes 10, 11, 13, 17, 25.
  const attempts = deploy === 'none' ? [] : deploy === 'breaker' ? [10, 11, 12, 13, 14, 15] : [10, 11, 13, 17, 25]

  for (let t = 0; t < MINUTES; t++) {
    while (starting.length && starting[0] <= t) {
      starting.shift()
      running++
    }
    const load = !sale || t < 5 ? 200 : t === 5 ? 600 : t === 6 ? 900 : 1200
    const capacity = running * perTask
    const cpu = Math.min(100, (load / capacity) * 100)
    const dropped = Math.max(0, load - capacity)
    let failed = 0

    if (deployState === 'running' && attempts.includes(t)) {
      // A rolling deploy starts new tasks next to the old ones; the broken image exits on start.
      if (t === attempts[0]) threshold = Math.min(200, Math.max(3, Math.ceil(0.5 * desired))) // set from the desired count when the deploy starts
      failed = desired
      failedTasks += failed
      if (deploy === 'breaker' && failedTasks >= threshold) {
        deployState = 'rolled back'
        events.push(`minute ${t}: ${failedTasks} new tasks have failed (threshold ${threshold}); the circuit breaker stops the deployment and rolls back`)
      } else if (t === attempts[0]) events.push(`minute ${t}: deployment starts ${desired} new tasks; they exit on start and are replaced`)
    }
    if (deploy === 'stuck' && t === MINUTES - 1) {
      deployState = 'stuck'
      events.push(`minute ${t}: still "IN_PROGRESS" after ${failedTasks} failed tasks; nobody has been told`)
    }

    // Target tracking, on the previous minute's average CPU.
    if (scaling && t > 0) {
      const metric = minutes[t - 1].cpu
      if (metric > TARGET && t - lastScaleOut >= 1) {
        // Capacity in proportion to the metric, measured on the tasks that produced it.
        const want = Math.min(MAX_TASKS, Math.ceil((minutes[t - 1].tasks * metric) / TARGET))
        if (want > desired) {
          for (let i = 0; i < want - desired; i++) starting.push(t + START_MINUTES)
          events.push(`minute ${t}: CPU was ${Math.round(metric)}%, above ${TARGET}%: desired ${desired} → ${want}`)
          desired = want
          lastScaleOut = t
        }
        lowFor = 0
      } else if (metric < TARGET * 0.9) {
        lowFor++
        if (lowFor >= SCALE_IN_AFTER && desired > MIN_TASKS) {
          const want = Math.max(MIN_TASKS, Math.ceil((running * metric) / TARGET))
          events.push(`minute ${t}: CPU below ${TARGET * 0.9}% for ${SCALE_IN_AFTER} minutes: desired ${desired} → ${want}`)
          running = want
          desired = want
          lowFor = 0
        }
      } else lowFor = 0
    }
    minutes.push({ t, load, tasks: running, cpu, dropped, desired, failed })
  }

  const taskMinutes = minutes.reduce((s, m) => s + m.tasks + m.failed * 0.5, 0) // a failed task runs for about 30 s
  const cost = (taskMinutes / 60) * ((size.cpu / 1024) * VCPU_HOUR + (size.memory / 1024) * GB_HOUR)
  const totalRequests = minutes.reduce((s, m) => s + m.load * 60, 0)
  const dropped = minutes.reduce((s, m) => s + m.dropped * 60, 0)
  return { minutes, events, cost, totalRequests, dropped, failedTasks, threshold, deployState, perTask, size, peak: Math.max(...minutes.map((m) => m.tasks)) }
}

const simulator: Simulator = {
  fields: [
    { id: 'size', label: 'Task size', options: Object.keys(SIZES) },
    { id: 'traffic', label: 'Traffic', options: ['Steady 200 requests/s', 'Sale: 1,200 requests/s from minute 5'] },
    { id: 'scaling', label: 'Scaling', options: ['Target tracking: CPU at 50%', 'Fixed at 2 tasks'] },
    { id: 'deploy', label: 'At minute 10', options: ['Nothing', 'Deploy a broken image', 'Deploy a broken image, circuit breaker on'] },
  ],
  defaults: { size: '0.5 vCPU, 1 GB', traffic: 'Sale: 1,200 requests/s from minute 5', scaling: 'Target tracking: CPU at 50%', deploy: 'Nothing' },
  run(v) {
    const sizeKey = SIZES[v.size] ? v.size : '0.5 vCPU, 1 GB'
    const sale = v.traffic.startsWith('Sale')
    const scaling = v.scaling.startsWith('Target')
    const deploy = v.deploy.startsWith('Nothing') ? 'none' : v.deploy.includes('circuit') ? 'breaker' : 'stuck'
    const r = simulate(sizeKey, sale, scaling, deploy)
    const steps: Trace['steps'] = []
    const { cpu, memory } = r.size

    steps.push({
      text: `The Task Definition describes one copy of the app: the image in the ECR Repository, ${cpu / 1024} vCPU and ${memory / 1024} GB (Fargate sells fixed combinations), the port, the log destination and where its secrets come from. The ECS Service keeps ${MIN_TASKS} copies running and registered with the load balancer.`,
      nodes: ['Task Definition', 'ECR Repository', 'ECS Service', 'Secrets Manager'],
      data: JSON.stringify({ family: 'shop-api', cpu: String(cpu), memory: String(memory), networkMode: 'awsvpc', containerDefinitions: [{ name: 'api', image: '123456789012.dkr.ecr.ap-south-1.amazonaws.com/shop-api:1.42.0', portMappings: [{ containerPort: 3001 }], secrets: [{ name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:…:shop/db' }] }] }, null, 2),
    })

    steps.push({
      text: `Fargate runs each task on its own small VM with its own network interface and private address, spread across zones. Nobody manages servers: each task is billed per second for the vCPU and memory it asked for. One task of this size handles about ${int(r.perTask)} requests a second at full CPU.`,
      nodes: ['ECS Service', 'Fargate Task (zone a)', 'Fargate Task (zone b)', 'Load Balancer'],
      data: `task 1: 10.0.3.25 (zone a)   task 2: 10.0.4.31 (zone b)\ncapacity: ${MIN_TASKS} × ${int(r.perTask)} = ${int(MIN_TASKS * r.perTask)} requests/s at 100% CPU\nprice: ${cpu / 1024} × ${usd(VCPU_HOUR, 5)} + ${memory / 1024} × ${usd(GB_HOUR, 6)} = ${usd((cpu / 1024) * VCPU_HOUR + (memory / 1024) * GB_HOUR, 5)} an hour per task`,
    })

    const rows = r.minutes.filter((m) => m.t % 3 === 0 || m.t === 5 || m.t === 7).map((m) => `${String(m.t).padStart(2)}  ${String(m.load).padStart(5)}  ${String(m.tasks).padStart(5)}  ${String(Math.round(m.cpu)).padStart(4)}%  ${m.dropped ? int(m.dropped) : '-'}`)
    steps.push({
      text: sale
        ? `At minute 5 the sale starts and traffic climbs to 1,200 requests a second. ${scaling ? 'CPU jumps, CloudWatch reports it a minute later, and new tasks need about two more minutes to start and pass health checks, so for a few minutes requests are dropped.' : `With a fixed ${MIN_TASKS} tasks, capacity is ${int(MIN_TASKS * r.perTask)} requests a second, and everything above that is dropped for the rest of the sale.`}`
        : `Traffic stays at 200 requests a second. ${MIN_TASKS} tasks run at ${Math.round(r.minutes[0].cpu)}% CPU${r.minutes[0].cpu < TARGET ? ', comfortably under the target' : ''}.`,
      nodes: ['Shoppers', 'Load Balancer', 'Fargate Task (zone a)', 'CloudWatch Metrics'],
      data: `min   req/s  tasks   CPU  dropped/s\n${rows.join('\n')}`,
    })

    const scaleEvents = r.events.filter((e) => e.includes('desired'))
    steps.push({
      text: scaling
        ? `The Auto Scaling Policy is target tracking: keep average CPU near ${TARGET}%. When CPU is above target it sets the desired count in proportion (current tasks × CPU ÷ ${TARGET}), at most once a minute. It removes tasks only after ${SCALE_IN_AFTER} minutes well below target, so a short dip doesn't cause a scale-in followed by a scale-out.`
        : 'There is no scaling policy, so the desired count stays where it was set. The service replaces tasks that crash, but never adds more.',
      nodes: ['CloudWatch Metrics', 'CPU Above Target?', 'ECS Service'],
      data: scaleEvents.length ? scaleEvents.join('\n') + `\npeak: ${r.peak} tasks (max ${MAX_TASKS})` : `desired count: ${MIN_TASKS} the whole time`,
    })

    if (deploy !== 'none') {
      const deployEvents = r.events.filter((e) => !e.includes('desired'))
      steps.push({
        text:
          deploy === 'breaker'
            ? `A new image is deployed. It crashes on start (a missing environment variable). The rolling deploy starts new tasks next to the old ones; old tasks keep serving because at least 100% must stay healthy. After ${r.threshold} failed tasks (half the desired count, at least 3) the deployment circuit breaker marks it failed and rolls back to the last working task definition, and the pipeline is told.`
            : 'A new image is deployed. It crashes on start. Old tasks keep serving, so users notice nothing, but ECS keeps launching new tasks that fail, more slowly over time. The deployment stays "in progress" for hours, and the next deploy queues behind it.',
        nodes: ['Deploy Pipeline', 'New Tasks Healthy?', 'Task Definition', 'ECS Service'],
        data: `${deployEvents.join('\n')}\nfailed tasks: ${r.failedTasks}\nresult: ${r.deployState === 'rolled back' ? 'FAILED, rolled back to shop-api:41' : 'IN_PROGRESS, no end in sight'}`,
      })
    }

    const droppedShare = r.dropped / r.totalRequests
    steps.push({
      text: `Over the ${MINUTES} minutes: ${int(r.totalRequests)} requests, ${r.dropped ? `${int(r.dropped)} dropped (${(droppedShare * 100).toFixed(1)}%)` : 'none dropped'}, at a compute cost of ${usd(r.cost, 3)}. Logs from every task go to CloudWatch Logs.`,
      nodes: ['ECS Service', 'CloudWatch Logs', 'Shoppers'],
      data: `requests: ${int(r.totalRequests)}\ndropped: ${int(r.dropped)}\npeak tasks: ${r.peak}\ncompute: ${usd(r.cost, 3)} for ${MINUTES} minutes${r.failedTasks ? `\nfailed deploy tasks: ${r.failedTasks}` : ''}`,
    })

    return {
      input: `${sizeKey} · ${sale ? 'sale' : 'steady'} · ${scaling ? 'target 50%' : 'fixed 2'}${deploy === 'none' ? '' : deploy === 'breaker' ? ' · bad deploy + breaker' : ' · bad deploy'} → ${(droppedShare * 100).toFixed(1)}% dropped, peak ${r.peak} tasks, ${usd(r.cost, 3)}${deploy === 'none' ? '' : `, deploy ${r.deployState}`}`,
      steps,
    }
  },
}

const run = (o: Partial<Record<'size' | 'traffic' | 'scaling' | 'deploy', string>>) => ({ ...simulator.defaults, ...o })

export { simulate as simulateFargate }

export const awsEcsFargate: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'aws-ecs-fargate',
  title: 'ECS on Fargate',
  blurb: 'Running containers without servers: task definitions, services, autoscaling on CPU and safe rolling deploys',
  adaptedFrom: {
    title: 'terraform-aws-ecs',
    author: 'terraform-aws-modules (Anton Babenko and contributors)',
    url: 'https://github.com/terraform-aws-modules/terraform-aws-ecs',
    license: 'Apache License 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  guides: ['tf-aws-ecs', 'tf-aws-ecs-fargate', 'tf-aws-ecs-service-module', 'tf-aws-ecs-container-definition', 'aws-ecs-fullstack-autoscaling', 'aws-containers-roadmap'],
  story: {
    title: 'The sale that outran the containers',
    dek: 'A team moves its API onto Fargate, learns how ECS keeps tasks running and scales them, and finds out what a deploy does when the new image won\'t even start.',
    chapters: [
      {
        heading: 'No servers to look after',
        body: `A shop's API ran on two virtual machines that someone had to patch, resize and restart. When the team containerised it, they chose **ECS** (Elastic Container Service) on **Fargate**: AWS runs each container on its own small machine, and you never see a server.

Four ideas cover most of it:
- A **task definition** is the recipe: which image, how much CPU and memory, which port, where logs go and which secrets to inject. Each change makes a new numbered revision.
- A **task** is one running copy of it, with its own network interface and private address.
- A **service** keeps a desired number of tasks running, replaces any that die, and registers them with the load balancer.
- A **cluster** groups services; with Fargate it's little more than a name.

They picked 0.5 vCPU and 1 GB per task. At about 200 requests a second per task, two tasks in two zones were plenty for a normal day.`,
        replay: { label: 'Watch a normal day', values: run({ traffic: 'Steady 200 requests/s' }) },
      },
      {
        heading: 'Sale day, fixed at two',
        body: `For the first sale, nobody had set up scaling. Traffic went from 200 to 1,200 requests a second at 10 o'clock. Two tasks can handle 400.

For the whole sale, two thirds of requests were dropped. The tasks weren't broken; there simply weren't enough of them, and nothing was going to add more.`,
        replay: { label: 'Replay the sale with two fixed tasks', values: run({ scaling: 'Fixed at 2 tasks' }) },
      },
      {
        heading: 'Target tracking',
        body: `They added an autoscaling policy, the same shape as AWS's own sample app: **target tracking** on average CPU, target 50%. When CPU is above 50%, the policy raises the desired count in proportion: 2 tasks at 100% CPU means "you need 4". It removes tasks only after a long time well below target, so it doesn't flap.

At the next sale, scaling worked, but not instantly. CPU is reported once a minute, a new task needs about two minutes to pull its image, start and pass the load balancer's health checks, and a saturated CPU can't say how much more capacity is needed, only "more". So capacity doubled roughly every three minutes: 2, 4, 8, then 12 tasks at 50% CPU ten minutes after the sale began. Over the half hour, 9% of requests were dropped, nearly all in those ten minutes.

The fix for those minutes was not faster scaling. It was a **scheduled action** that raised the minimum to 12 tasks fifteen minutes before each planned sale.`,
        replay: { label: 'Replay the sale with target tracking', values: run({}) },
      },
      {
        heading: 'The deploy that never finished',
        body: `A Friday deploy shipped an image that crashed on start: a new environment variable had been added to the code but not to the task definition.

ECS deploys by **rolling update**: start new tasks, wait until they're healthy, then stop old ones. With "minimum healthy 100%", the old tasks keep serving until new ones are ready, so customers saw nothing. But the new tasks never became ready. ECS kept relaunching them, more slowly each time, and the deployment sat "in progress" all weekend. Monday's urgent fix queued behind it.

The **deployment circuit breaker** fixes exactly this. It counts failed new tasks; after half the desired count (at least 3), it marks the deployment failed and rolls back to the last task definition that worked. The pipeline sees the failure in minutes and alerts the person who shipped it.`,
        replay: { label: 'Replay the broken deploy', values: run({ traffic: 'Steady 200 requests/s', deploy: 'Deploy a broken image' }) },
      },
      {
        heading: 'Right-sizing',
        body: `With scaling and safe deploys in place, the team looked at the bill. Bigger tasks aren't more efficient on Fargate: price is per vCPU and per GB, so one 1-vCPU task costs about the same as two 0.5-vCPU tasks. Smaller tasks scale in finer steps, but each has its own overhead (the app's memory, a sidecar, a connection pool to the database).

One trap: when they tried 0.25 vCPU tasks, the maximum of 12 tasks now meant only 1,200 requests a second at 100% CPU. The sale ran at the limit the whole time. Halve the task, double the maximum.

They kept 0.5 vCPU, set memory from what the app actually used plus headroom, and moved background jobs that could be interrupted to **Fargate Spot**, which is cheaper but can be stopped with two minutes' notice.

> Containers don't make capacity planning go away. They make it a setting you can change in a pull request.`,
        replay: { label: 'Try the sale with 0.25 vCPU tasks', values: run({ size: '0.25 vCPU, 0.5 GB' }) },
      },
    ],
  },
  takeaways: [
    'A task definition is the recipe, a task is a running copy, and a service keeps the desired number of tasks running behind a load balancer.',
    'Fargate runs each task on its own small VM with its own IP address, billed per second for the vCPU and memory requested.',
    'Target tracking scales in proportion to how far a metric is from its target, but new tasks still take a few minutes to help.',
    'For known peaks, schedule a higher minimum ahead of time instead of relying on reactive scaling.',
    'Rolling deploys with 100% minimum healthy keep old tasks serving, and the circuit breaker rolls back a deploy whose new tasks keep failing.',
    'Fargate prices scale linearly with size, so pick task size for granularity and memory needs, not discounts.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'cluster', label: 'ECS cluster' },
      { id: 'scaling', label: 'Scaling' },
    ],
    nodes: [
      { id: 'shoppers', label: 'Shoppers', shape: 'ellipse', color: 'blue', group: null },
      { id: 'alb', label: 'Load Balancer', shape: 'rectangle', color: 'violet', group: null },
      { id: 'service', label: 'ECS Service', shape: 'rectangle', color: 'violet', group: 'cluster' },
      { id: 'taskdef', label: 'Task Definition', shape: 'rectangle', color: 'green', group: null },
      { id: 'ecr', label: 'ECR Repository', shape: 'rectangle', color: 'green', group: null },
      { id: 'a', label: 'Fargate Task (zone a)', shape: 'rectangle', color: 'orange', group: 'cluster' },
      { id: 'b', label: 'Fargate Task (zone b)', shape: 'rectangle', color: 'orange', group: 'cluster' },
      { id: 'metrics', label: 'CloudWatch Metrics', shape: 'rectangle', color: 'green', group: 'scaling' },
      { id: 'policy', label: 'CPU Above Target?', shape: 'diamond', color: 'violet', group: 'scaling' },
      { id: 'breaker', label: 'New Tasks Healthy?', shape: 'diamond', color: 'violet', group: 'cluster' },
      { id: 'logs', label: 'CloudWatch Logs', shape: 'rectangle', color: 'green', group: null },
      { id: 'secrets', label: 'Secrets Manager', shape: 'rectangle', color: 'green', group: null },
      { id: 'pipeline', label: 'Deploy Pipeline', shape: 'rectangle', color: 'violet', group: null },
    ],
    edges: [
      { from: 'shoppers', to: 'alb', label: 'https', dashed: false },
      { from: 'alb', to: 'a', label: 'requests', dashed: false },
      { from: 'alb', to: 'b', label: 'requests', dashed: false },
      { from: 'pipeline', to: 'ecr', label: 'push image', dashed: false },
      { from: 'pipeline', to: 'taskdef', label: 'new revision', dashed: false },
      { from: 'taskdef', to: 'service', label: 'deploy', dashed: false },
      { from: 'service', to: 'a', label: 'run task', dashed: false },
      { from: 'service', to: 'b', label: 'run task', dashed: false },
      { from: 'a', to: 'ecr', label: 'pull image', dashed: true },
      { from: 'a', to: 'secrets', label: 'DB password', dashed: true },
      { from: 'a', to: 'logs', label: 'stdout', dashed: false },
      { from: 'b', to: 'logs', label: 'stdout', dashed: false },
      { from: 'service', to: 'metrics', label: 'CPU, memory', dashed: false },
      { from: 'metrics', to: 'policy', label: 'every minute', dashed: false },
      { from: 'policy', to: 'service', label: 'desired count', dashed: true },
      { from: 'service', to: 'breaker', label: 'during a deploy', dashed: false },
      { from: 'breaker', to: 'taskdef', label: 'roll back', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'ECS on Fargate',
    summary:
      'Amazon ECS (Elastic Container Service) runs containers as tasks, kept at a desired count by a service and registered with a load balancer. On Fargate, AWS supplies a small VM per task, so there are no servers to manage; you choose CPU and memory per task and pay for them by the second.',
    sections: [
      {
        heading: 'Overview',
        body: 'A container image packages an app with everything it needs. ECS decides where and how many copies run. With the EC2 launch type you supply and patch the servers; with Fargate, AWS does, and every task gets its own isolated VM and network interface.\n\nThe building blocks are the task definition (image, CPU, memory, ports, secrets, logs), the task (a running copy), the service (keeps N tasks running, replaces failures, registers them with a load balancer, scales and deploys) and the cluster (a namespace for services).\n\nThe simulator runs a service minute by minute: traffic, CPU, target tracking with its one-minute metrics and two-minute task start-up, rolling deploys with or without the circuit breaker, and the Fargate bill.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Run the API as containers behind a load balancer in at least two zones.\n- Scale with traffic automatically, and ahead of planned sales.\n- Deploy a new version with no downtime, and roll back automatically when it doesn\'t start.\n\nNon-functional:\n- No servers to patch.\n- Handle 1,200 requests a second at peak, 200 normally.\n- Secrets never in images or task definitions in plain text.',
      },
      {
        heading: 'Capacity estimates',
        body: '- One vCPU of this app serves about 400 requests a second at 100% CPU, so a 0.5-vCPU task serves 200.\n- Normal: 200 requests/s needs 1 task at 100%; 2 tasks run at 50%, the target.\n- Sale: 1,200 requests/s at 50% CPU needs 1,200 ÷ (200 × 0.5) = 12 tasks; at 100%, 6.\n- Price per 0.5 vCPU / 1 GB task (us-east-1): 0.5 × $0.04048 + 1 × $0.004445 = $0.024685 an hour, about $18 a month.\n- 2 tasks all month ≈ $36; 12 tasks for a 3-hour sale add 10 × 3 × $0.024685 ≈ $0.74.\n- Circuit breaker threshold: max(3, ceil(0.5 × desired)) failed tasks, so 3 for 2 tasks, 5 for 10.',
      },
      {
        heading: 'Step by step',
        body: '1. The Deploy Pipeline pushes an image to the ECR Repository and registers a new Task Definition revision.\n2. The ECS Service starts tasks from it: Fargate Task (zone a) and Fargate Task (zone b), each pulling the image and its secrets from Secrets Manager.\n3. The service registers each task\'s address with the Load Balancer, which sends Shoppers\' requests to healthy tasks.\n4. Tasks write logs to CloudWatch Logs, and the service reports CPU and memory to CloudWatch Metrics.\n5. CPU Above Target? compares average CPU with 50% every minute and sets the service\'s desired count.\n6. During a deploy, New Tasks Healthy? counts failed new tasks; past the threshold it rolls the service back to the previous Task Definition.',
      },
      {
        heading: 'Components',
        body: '- Shoppers: the traffic, steady or spiking.\n- Load Balancer: routes requests to healthy tasks by IP address.\n- ECS Service: keeps the desired number of tasks running, replaces failed ones, deploys and scales.\n- Task Definition: the versioned recipe: image, CPU and memory, ports, environment, secrets and logging.\n- ECR Repository: the private container registry the tasks pull from.\n- Fargate Task (zone a): one running copy with its own network interface.\n- Fargate Task (zone b): the same in another zone, so one zone failing halves capacity instead of ending it.\n- CloudWatch Metrics: per-service CPU and memory, every minute.\n- CPU Above Target?: the target tracking policy that sets the desired count.\n- New Tasks Healthy?: the deployment circuit breaker.\n- CloudWatch Logs: everything the containers write to stdout.\n- Secrets Manager: database passwords and keys, injected as environment variables at start.\n- Deploy Pipeline: builds, pushes and updates the service.',
      },
      {
        heading: 'Key decisions',
        body: '- Fargate or EC2: Fargate for no servers and per-task isolation; EC2 when you need GPUs, very large tasks, or the lower cost of densely packed, reserved instances.\n- Task size: valid CPU and memory pairs only (0.25 vCPU with 0.5 to 2 GB, 0.5 vCPU with 1 to 4 GB, and so on). Smaller tasks scale in finer steps.\n- Scaling metric: CPU for CPU-bound apps; request count per target from the load balancer for I/O-bound ones; queue depth for workers.\n- Reactive and scheduled: target tracking for surprises, scheduled minimums for known peaks.\n- Deploys: rolling with minimum healthy 100% and maximum 200%, plus the circuit breaker with rollback; blue/green through CodeDeploy when you need test traffic and instant switch-back.\n- Spot: Fargate Spot for interruptible work, mixed with on-demand through capacity provider weights.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Start-up time is the limit on reactive scaling: smaller images, fewer start-up steps and shorter health check intervals help.\n- Set a maximum task count that your database and downstream services can take.\n- Zone failure: spread tasks across zones; the service starts replacements in the remaining zones.\n- Each task uses one IP address in its subnet, so size subnets for the maximum count during deploys.\n- Failing tasks: read the stopped reason (exit code, health check, image pull, out of memory) in the service events.\n- Graceful shutdown: on SIGTERM, finish in-flight requests within the stop timeout and the load balancer\'s deregistration delay.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What is the difference between a task definition, a task and a service?\n- Traffic triples in a minute. Walk through what target tracking does and when capacity actually arrives.\n- A deploy\'s new tasks keep crashing. What do users see, and what does the circuit breaker change?\n- When would you choose EC2 over Fargate?\n- How would you scale a queue worker on ECS?\n- How do you get a database password into a container safely?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'A Fargate service with terraform-aws-ecs (bash)',
        language: 'bash',
        source: `cat > ecs.tf <<'EOF'
module "ecs_service" {
  source  = "terraform-aws-modules/ecs/aws//modules/service"
  version = "~> 7.0"

  name        = "shop-api"
  cluster_arn = module.ecs_cluster.arn
  cpu         = 512
  memory      = 1024

  container_definitions = {
    api = {
      image        = "\${aws_ecr_repository.api.repository_url}:1.42.0"
      portMappings = [{ containerPort = 3001, protocol = "tcp" }]
      secrets      = [{ name = "DB_PASSWORD", valueFrom = aws_secretsmanager_secret.db.arn }]
    }
  }

  load_balancer = {
    service = {
      target_group_arn = module.alb.target_groups["api"].arn
      container_name   = "api"
      container_port   = 3001
    }
  }

  subnet_ids = module.vpc.private_subnets

  # Roll back automatically when new tasks keep failing.
  deployment_circuit_breaker = { enable = true, rollback = true }

  autoscaling_min_capacity = 2
  autoscaling_max_capacity = 12
  autoscaling_policies = {
    cpu = {
      policy_type = "TargetTrackingScaling"
      target_tracking_scaling_policy_configuration = {
        predefined_metric_specification = { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
        target_value       = 50
        scale_out_cooldown = 60
        scale_in_cooldown  = 60
      }
    }
  }
}
EOF`,
      },
      {
        title: 'Target tracking arithmetic (TypeScript)',
        language: 'typescript',
        source: `// Target tracking sets capacity in proportion to how far the metric is from its target.
export function desiredTasks(current: number, metric: number, target = 50, min = 2, max = 12): number {
  const want = Math.ceil((current * metric) / target)
  return Math.min(max, Math.max(min, want))
}

desiredTasks(2, 100) // 4: two tasks at 100% CPU need twice as many
desiredTasks(4, 100) // 8: still saturated a minute later, double again
desiredTasks(8, 75)  // 12

// The deployment circuit breaker's failure threshold.
export const breakerThreshold = (desired: number) => Math.min(200, Math.max(3, Math.ceil(0.5 * desired)))`,
      },
      {
        title: 'Raise the minimum before a planned sale (bash)',
        language: 'bash',
        source: `# 15 minutes before the sale, at least 12 tasks; back to 2 when it ends.
aws application-autoscaling put-scheduled-action \\
  --service-namespace ecs \\
  --resource-id service/shop/shop-api \\
  --scalable-dimension ecs:service:DesiredCount \\
  --scheduled-action-name sale-warmup \\
  --schedule "at(2026-11-27T04:15:00)" \\
  --scalable-target-action MinCapacity=12,MaxCapacity=16

aws application-autoscaling put-scheduled-action \\
  --service-namespace ecs \\
  --resource-id service/shop/shop-api \\
  --scalable-dimension ecs:service:DesiredCount \\
  --scheduled-action-name sale-cooldown \\
  --schedule "at(2026-11-27T18:30:00)" \\
  --scalable-target-action MinCapacity=2,MaxCapacity=16`,
      },
      {
        title: 'Why did my task stop? (bash)',
        language: 'bash',
        source: `aws ecs describe-services --cluster shop --services shop-api \\
  --query 'services[0].deployments[].[status,rolloutState,rolloutStateReason,failedTasks]'

aws ecs list-tasks --cluster shop --service-name shop-api --desired-status STOPPED \\
  --query 'taskArns[0]' --output text |
  xargs -I{} aws ecs describe-tasks --cluster shop --tasks {} \\
    --query 'tasks[0].[stoppedReason,containers[0].exitCode,containers[0].reason]'`,
      },
    ],
    related: ['AWS VPC networking', 'Application Load Balancer', 'Full-stack app on ECS', 'Docker vs VMs', 'Autoscaling', 'Rate limiter'],
  },
  simulator,
}
