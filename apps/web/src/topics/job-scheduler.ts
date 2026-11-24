import type { Trace } from '@structura/shared'
import { defaultTrace, json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A distributed job scheduler (cron for many machines). The hard part is not
// reading a schedule: it is that 3 million jobs can be due in the same minute,
// workers die in the middle of a run, and no job may run twice or never.
// The simulator works out the due time, the retry delays and the lease timing from
// the inputs, so the clock times on screen are the ones the design gives.

const LEASE_SECONDS = 60 // a worker owns a run for 60 s unless it renews
const SWEEP_SECONDS = 10 // the reaper looks for expired leases every 10 s
const RETRY_BASE_SECONDS = 30 // first retry waits 30 s, then 60, 120, 240
const MAX_ATTEMPTS = 5

const CLIENT = 'Client (API Caller)'
const API = 'Scheduler API'
const JOBS = 'Jobs DB (Postgres)'
const POLLER = 'Scheduler (Poller)'
const QUEUE = 'Run Queue'
const WORKER = 'Worker Pool'
const TARGET = 'Target Service'
const REAPER = 'Lease Reaper'
const DLQ = 'Dead Letter Queue'

const SCHEDULES: Record<string, { cron: string; due: number; every: number }> = {
  'Every minute (* * * * *)': { cron: '* * * * *', due: Date.parse('2026-12-01T01:59:00Z'), every: 60 },
  'Every 5 minutes (*/5 * * * *)': { cron: '*/5 * * * *', due: Date.parse('2026-12-01T02:00:00Z'), every: 300 },
  'Daily at 02:00 (0 2 * * *)': { cron: '0 2 * * *', due: Date.parse('2026-12-01T02:00:00Z'), every: 86400 },
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const stamp = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
const plus = (ms: number, seconds: number) => ms + seconds * 1000
const retryDelay = (attempt: number) => RETRY_BASE_SECONDS * 2 ** (attempt - 1) // attempt that just failed

const simulator: Simulator = {
  fields: [
    {
      id: 'schedule',
      label: 'The schedule',
      options: Object.keys(SCHEDULES),
    },
    {
      id: 'schedulers',
      label: 'Schedulers running',
      options: ['One scheduler', 'Two schedulers, row lock (SKIP LOCKED)', 'Two schedulers, no lock (unique index only)'],
    },
    {
      id: 'outcome',
      label: 'What happens to the run',
      options: ['Succeeds first time', 'Fails twice, then succeeds', 'Worker crashes mid-run', `Always fails (${MAX_ATTEMPTS} attempts)`],
    },
  ],
  defaults: { schedule: 'Every 5 minutes (*/5 * * * *)', schedulers: 'Two schedulers, row lock (SKIP LOCKED)', outcome: 'Fails twice, then succeeds' },
  run({ schedule, schedulers, outcome }) {
    const sch = SCHEDULES[schedule] ?? SCHEDULES['Every 5 minutes (*/5 * * * *)']
    const due = sch.due
    const nextDue = plus(due, sch.every)
    const two = schedulers.startsWith('Two')
    const locked = schedulers.includes('SKIP LOCKED')
    const jobId = 'job_8f2a'
    const runId = `run_${stableHash(`${jobId}${due}`).toString(16).slice(0, 8)}`
    const input = `${sch.cron}, ${schedulers.toLowerCase()}, ${outcome.toLowerCase()}`
    const steps: Trace['steps'] = []

    // 1. The job is created.
    steps.push({
      text: `A team asks for a report to be sent on the schedule "${sch.cron}". The Scheduler API checks the schedule, works out the first time it is due, ${stamp(due)}, and stores the job. Nothing runs yet: the job is only a row with a next_run_at time.`,
      nodes: [CLIENT, API, JOBS],
      data: `POST /jobs\n{"name":"daily-report","schedule":"${sch.cron}","target":"https://reports.internal/run","maxAttempts":${MAX_ATTEMPTS}}\n→ INSERT INTO jobs (id, schedule, next_run_at) VALUES ('${jobId}', '${sch.cron}', '${stamp(due)}')\n→ 201 {"id":"${jobId}","nextRunAt":"${stamp(due)}"}`,
    })

    // 2. The poller claims the due job.
    const claimAt = plus(due, 1)
    if (!two) {
      steps.push({
        text: `The Scheduler (Poller) wakes every second and asks the Jobs DB for jobs whose next_run_at has passed. At ${clock(claimAt)} it finds ${jobId}. In one transaction it adds a run row and moves next_run_at forward to ${stamp(nextDue)}, so the job fires again on time even if this run is slow.`,
        nodes: [POLLER, JOBS],
        data: `BEGIN;\nSELECT id FROM jobs WHERE enabled AND next_run_at <= now() ORDER BY next_run_at LIMIT 1000 FOR UPDATE SKIP LOCKED;\nINSERT INTO runs (id, job_id, scheduled_for, status, attempt)\n VALUES ('${runId}', '${jobId}', '${stamp(due)}', 'queued', 1);\nUPDATE jobs SET next_run_at = '${stamp(nextDue)}' WHERE id = '${jobId}';\nCOMMIT;`,
      })
    } else if (locked) {
      steps.push({
        text: `Two pollers wake at ${clock(claimAt)} and both ask for due jobs. Poller A locks ${jobId} with FOR UPDATE SKIP LOCKED. Poller B asks for the same row, sees it is locked and skips it, so B finds nothing to do. Only A adds the run and moves next_run_at to ${stamp(nextDue)}.`,
        nodes: [POLLER, JOBS],
        data: `poller A: SELECT … FOR UPDATE SKIP LOCKED → 1 row (${jobId}), lock held\npoller B: SELECT … FOR UPDATE SKIP LOCKED → 0 rows (${jobId} is locked, skipped)\npoller A: INSERT INTO runs … '${runId}'; UPDATE jobs SET next_run_at = '${stamp(nextDue)}'; COMMIT`,
      })
    } else {
      steps.push({
        text: `Two pollers wake at ${clock(claimAt)} and, with no row lock, both read ${jobId} as due. Both try to add the run. The runs table has a unique index on (job_id, scheduled_for), so the database accepts the first INSERT and refuses the second. The poller that lost stops, so only one run exists. The unique index is the safety net.`,
        nodes: [POLLER, JOBS],
        data: `poller A: INSERT INTO runs (id, job_id, scheduled_for, …) VALUES ('${runId}', '${jobId}', '${stamp(due)}', …) ON CONFLICT (job_id, scheduled_for) DO NOTHING → 1 row\npoller B: same INSERT → 0 rows (conflict), so B enqueues nothing\nUPDATE jobs SET next_run_at = '${stamp(nextDue)}' WHERE id = '${jobId}' AND next_run_at = '${stamp(due)}'`,
      })
    }

    // 3. Enqueue.
    steps.push({
      text: `The poller puts the run on the Run Queue as a small message: which run, which job and which attempt. The message holds no business data, only ids, so it stays tiny and the target can change without touching the queue.`,
      nodes: [POLLER, QUEUE],
      data: json({ runId, jobId, scheduledFor: stamp(due), attempt: 1 }),
    })

    // 4. A worker leases the run.
    const leaseAt = plus(due, 2)
    steps.push({
      text: `A worker takes the message. It does not delete it. The queue hides it for ${LEASE_SECONDS} seconds (a lease). If the worker finishes, it acknowledges and the message is gone. If the worker dies, the lease runs out and the run comes back. The Jobs DB now shows the run as running, with the lease end ${clock(plus(leaseAt, LEASE_SECONDS))}.`,
      nodes: [QUEUE, WORKER, JOBS],
      data: `UPDATE runs SET status='running', worker_id='worker-17', lease_expires_at='${stamp(plus(leaseAt, LEASE_SECONDS))}'\n WHERE id='${runId}';\nleased at ${clock(leaseAt)} → hidden until ${clock(plus(leaseAt, LEASE_SECONDS))}`,
    })

    const callHeader = (attempt: number) =>
      `POST https://reports.internal/run\nIdempotency-Key: ${runId}\n{"job":"${jobId}","scheduledFor":"${stamp(due)}","attempt":${attempt}}`

    // 5. Outcomes.
    if (outcome === 'Succeeds first time') {
      steps.push({
        text: `The worker calls the Target Service and sends the run id as an idempotency key. The target answers 200 after 1 second.`,
        nodes: [WORKER, TARGET],
        data: `${callHeader(1)}\n→ 200 OK (1 s) at ${clock(plus(leaseAt, 1))}`,
      })
      steps.push({
        text: `The worker marks the run succeeded and acknowledges the message. The job's next_run_at is already ${stamp(nextDue)}, so the next run is waiting. From due time to done it took ${(plus(leaseAt, 1) - due) / 1000} seconds.`,
        nodes: [WORKER, JOBS],
        data: `UPDATE runs SET status='succeeded', finished_at='${stamp(plus(leaseAt, 1))}' WHERE id='${runId}';\nack ${runId}\nlag = ${clock(plus(leaseAt, 1))} − ${clock(due)} = ${(plus(leaseAt, 1) - due) / 1000} s`,
      })
      return { input, steps }
    }

    if (outcome === 'Worker crashes mid-run') {
      const crashAt = plus(leaseAt, 2)
      const expiresAt = plus(leaseAt, LEASE_SECONDS)
      // The reaper sweeps on ticks that are a multiple of SWEEP_SECONDS after the due time.
      const sweepOffset = Math.ceil((expiresAt - due) / 1000 / SWEEP_SECONDS) * SWEEP_SECONDS
      const sweepAt = plus(due, sweepOffset)
      const secondLease = plus(sweepAt, 1)
      steps.push({
        text: `The worker calls the Target Service, which starts the work. Two seconds later the worker's machine is switched off by the cloud provider. The worker never records a result and never acknowledges the message.`,
        nodes: [WORKER, TARGET],
        data: `${callHeader(1)}\n→ target starts the work…\n${clock(crashAt)} worker-17 process killed (no result, no ack)`,
      })
      steps.push({
        text: `Nobody tells the scheduler the worker died. The lease is the clock that finds out: it ends at ${clock(expiresAt)}. The Lease Reaper sweeps every ${SWEEP_SECONDS} seconds, so it notices at ${clock(sweepAt)}, ${Math.round((sweepAt - crashAt) / 1000)} seconds after the crash, and puts the run back on the queue as attempt 2.`,
        nodes: [REAPER, JOBS, QUEUE],
        data: `${clock(sweepAt)} SELECT id FROM runs WHERE status='running' AND lease_expires_at < now();\n→ ${runId} (lease ended ${clock(expiresAt)})\nUPDATE runs SET status='queued', attempt=2 WHERE id='${runId}';\nenqueue {"runId":"${runId}","attempt":2}`,
      })
      steps.push({
        text: `Another worker takes attempt 2 and calls the target with the same idempotency key. The target remembers ${runId} from attempt 1, so it does not do the work twice: it returns the saved result. This is why the scheduler promises at least once, and the target makes it effectively once.`,
        nodes: [WORKER, TARGET, JOBS],
        data: `${clock(secondLease)} worker-04 leases ${runId} (attempt 2)\n${callHeader(2)}\n→ 200 OK, replayed: true (the target already knew ${runId})\nUPDATE runs SET status='succeeded' WHERE id='${runId}';\nlate by ${(plus(secondLease, 1) - due) / 1000} s because the lease had to expire first`,
      })
      return { input, steps }
    }

    // Retries: "Fails twice, then succeeds" or "Always fails".
    const failures = outcome.startsWith('Always') ? MAX_ATTEMPTS : 2
    let at = leaseAt // when this attempt starts
    const failLines: string[] = []
    for (let attempt = 1; attempt <= failures; attempt++) {
      const failedAt = plus(at, 1)
      if (attempt < MAX_ATTEMPTS) {
        const wait = retryDelay(attempt)
        failLines.push(`attempt ${attempt}: started ${clock(at)}, 503 at ${clock(failedAt)} → retry in ${wait} s (${RETRY_BASE_SECONDS} × 2^${attempt - 1})`)
        at = plus(failedAt, wait)
      } else {
        failLines.push(`attempt ${attempt}: started ${clock(at)}, 503 at ${clock(failedAt)} → out of attempts`)
      }
    }

    const firstFail = plus(leaseAt, 1)
    steps.push({
      text: `The worker calls the Target Service and gets 503 (service unavailable) after 1 second. A failure is normal, so the worker does not give up. It records the error and sends the run back to the Run Queue with a delay. The delay doubles each time: ${RETRY_BASE_SECONDS} s, then ${RETRY_BASE_SECONDS * 2} s, then ${RETRY_BASE_SECONDS * 4} s. Waiting longer gives a struggling target time to recover.`,
      nodes: [WORKER, TARGET, QUEUE],
      data: `${callHeader(1)}\n→ 503 at ${clock(firstFail)}\nUPDATE runs SET status='queued', attempt=2, error='503' WHERE id='${runId}';\nenqueue {"runId":"${runId}","attempt":2} with delay ${retryDelay(1)} s → visible at ${clock(plus(firstFail, retryDelay(1)))}`,
    })

    if (failures === MAX_ATTEMPTS) {
      const totalWait = [1, 2, 3, 4].reduce((sum, a) => sum + retryDelay(a), 0)
      steps.push({
        text: `The same thing happens again and again. The waits are ${[1, 2, 3, 4].map(retryDelay).join(' s, ')} s, which is ${totalWait} seconds (${Math.floor(totalWait / 60)} minutes ${totalWait % 60} seconds) of waiting in all. Each attempt fails, because this target is truly broken, not just busy.`,
        nodes: [QUEUE, WORKER, TARGET],
        data: failLines.join('\n'),
      })
      steps.push({
        text: `After attempt ${MAX_ATTEMPTS} the scheduler stops. Retrying forever would waste workers and hide a real bug. It moves the run to the Dead Letter Queue with the error and all attempts, and raises an alert. A person can fix the target and replay the run later. The job itself stays enabled, so tomorrow's run still starts.`,
        nodes: [WORKER, DLQ, JOBS],
        data: `UPDATE runs SET status='dead', error='503 ×${MAX_ATTEMPTS}' WHERE id='${runId}';\nDLQ ← {"runId":"${runId}","attempts":${MAX_ATTEMPTS},"lastError":"503"}\nalert: job ${jobId} run ${stamp(due)} is dead\njobs.next_run_at stays '${stamp(nextDue)}'`,
      })
      return { input, steps }
    }

    steps.push({
      text: `Attempt 2 starts after the ${retryDelay(1)}-second delay and also gets 503. The run goes back with a ${retryDelay(2)}-second delay. The worker still holds no lock on the job, so the next regular run of this job is not blocked.`,
      nodes: [QUEUE, WORKER, TARGET],
      data: failLines.join('\n'),
    })
    const successStart = at
    steps.push({
      text: `Attempt 3 starts at ${clock(successStart)}. The target has recovered and answers 200. The worker marks the run succeeded and acknowledges. The run was ${(plus(successStart, 1) - due) / 1000} seconds late in total, and the job's next run at ${stamp(nextDue)} was never moved by the problem.`,
      nodes: [WORKER, TARGET, JOBS],
      data: `${callHeader(3)}\n→ 200 OK at ${clock(plus(successStart, 1))}\nUPDATE runs SET status='succeeded', attempt=3 WHERE id='${runId}';\nack ${runId}\nlate by ${clock(plus(successStart, 1))} − ${clock(due)} = ${(plus(successStart, 1) - due) / 1000} s`,
    })
    return { input, steps }
  },
}

export const jobScheduler: StaticTopic = {
  kind: 'static',
  id: 'job-scheduler',
  title: 'Distributed Job Scheduler (Cron at Scale)',
  difficulty: 'Intermediate',
  blurb: 'Run millions of jobs on time: a due-time poller, leased runs, retries with backoff and no double runs',
  guides: [
    'scale-distributed-task-scheduling-3-parts-at-pagerduty',
    'scale-building-cron-at-google',
    'scale-distributed-cron-architecture-at-quora',
    'scale-dynein-distributed-delayed-job-queueing-system-at-airbnb',
    'why-do-we-need-to-use-a-distributed-lock',
    'how-do-we-retry-on-failures',
  ],
  takeaways: [
    'A job is only a row with a next_run_at time. A poller finds due rows and turns each into a run, so scheduling is a database query, not a timer per job.',
    'Claim due jobs with FOR UPDATE SKIP LOCKED, and add a unique index on (job_id, scheduled_for): the lock stops pollers fighting, and the index stops a duplicate run even if the lock fails.',
    'Move next_run_at forward in the same transaction that creates the run, so a slow or failed run never delays the next one.',
    'A worker leases a run for a fixed time. If it dies, the lease ends and a reaper puts the run back, so no run is lost.',
    'Delivery is at least once, so the target must accept a run id as an idempotency key to make the work happen effectively once.',
    'Retry with a growing delay and a limit. After the last attempt move the run to a dead letter queue and alert a person.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'engine', label: 'Scheduling engine' }],
    nodes: [
      { id: 'client', label: CLIENT, shape: 'ellipse', color: 'blue', group: null },
      { id: 'api', label: API, shape: 'rectangle', color: 'violet', group: null },
      { id: 'jobs', label: JOBS, shape: 'rectangle', color: 'green', group: 'engine' },
      { id: 'poller', label: POLLER, shape: 'rectangle', color: 'orange', group: 'engine' },
      { id: 'reaper', label: REAPER, shape: 'rectangle', color: 'orange', group: 'engine' },
      { id: 'queue', label: QUEUE, shape: 'rectangle', color: 'yellow', group: null },
      { id: 'worker', label: WORKER, shape: 'rectangle', color: 'orange', group: null },
      { id: 'target', label: TARGET, shape: 'rectangle', color: 'violet', group: null },
      { id: 'dlq', label: DLQ, shape: 'rectangle', color: 'yellow', group: null },
    ],
    edges: [
      { from: 'client', to: 'api', label: 'POST /jobs', dashed: false },
      { from: 'api', to: 'jobs', label: 'insert job + next_run_at', dashed: false },
      { from: 'poller', to: 'jobs', label: 'claim due jobs', dashed: false },
      { from: 'poller', to: 'queue', label: 'enqueue run', dashed: false },
      { from: 'queue', to: 'worker', label: 'lease 60 s', dashed: false },
      { from: 'worker', to: 'target', label: 'call + run id', dashed: false },
      { from: 'worker', to: 'jobs', label: 'record result', dashed: false },
      { from: 'worker', to: 'queue', label: 'retry with delay', dashed: true },
      { from: 'worker', to: 'dlq', label: 'after 5 attempts', dashed: true },
      { from: 'reaper', to: 'jobs', label: 'find expired leases', dashed: true },
      { from: 'reaper', to: 'queue', label: 're-enqueue', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'jobs',
        name: 'jobs',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'schedule', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'target_url', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'max_attempts', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'enabled', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'next_run_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(next_run_at) WHERE enabled — the poller finds due jobs without reading all 10 million'],
      },
      {
        id: 'runs',
        name: 'runs',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'job_id', type: 'text', pk: false, fk: 'jobs.id', nullable: false, unique: false },
          { name: 'scheduled_for', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: "text ('queued','running','succeeded','dead')", pk: false, fk: null, nullable: false, unique: false },
          { name: 'attempt', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'worker_id', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'lease_expires_at', type: 'timestamptz', pk: false, fk: null, nullable: true, unique: false },
          { name: 'error', type: 'text', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [
          'UNIQUE (job_id, scheduled_for) — one run for each due time, even if two pollers race',
          '(lease_expires_at) WHERE status = \'running\' — the reaper finds dead workers',
        ],
      },
    ],
    relations: [{ from: 'runs', to: 'jobs', kind: 'one-to-many', label: 'are runs of' }],
  },
  explanation: {
    title: 'Distributed Job Scheduler (Cron at Scale)',
    summary:
      'Cron runs a command at a set time on one machine. A distributed scheduler does the same for millions of jobs on many machines, and must still run each job once at its time, survive crashed workers and retry failures without hiding them.',
    sections: [
      {
        heading: 'Overview',
        body: 'A normal cron runs on one server. If that server is off at 02:00, the job is skipped. If you start two servers, the job runs twice. A distributed job scheduler fixes both problems. Teams register jobs ("send this report every day at 02:00"), and the system makes sure each run happens on time, on some healthy worker.\n\nThe design has three ideas. First, a job is only a row in a database with a next_run_at time, so finding due work is one indexed query and not a timer for each job. Second, a run is leased to a worker for a short time, so a dead worker cannot hold a run forever. Third, the system promises at least once, so the target service must accept a run id as an idempotency key to avoid doing the work twice.',
      },
      {
        heading: 'Requirements',
        body: '- Run each job at its due time, within a few seconds.\n- Never skip a run because one machine died, and never run it twice at the same time.\n- Retry a failed run with a growing delay, then stop and alert a person.\n- Handle millions of jobs, and bursts when many jobs share the same time (the top of the hour).\n- Keep a history of runs, so a person can see what ran, when and why it failed.\n- Let a job change or stop without a deploy.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Jobs: 10 million active jobs. At about 500 bytes a row, the jobs table is 10 million × 500 B = 5 GB, which one Postgres server holds easily.\n- Average load: if a job runs once an hour on average, that is 10 million ÷ 3,600 s ≈ 2,778 runs a second.\n- Peak load: people love round times. Say 30% of jobs are set for minute :00. That is 3 million runs in the first minute, or 3 million ÷ 60 s = 50k runs a second. Peak is 18 times the average.\n- Pollers: split the jobs into 64 partitions by hash(job id) mod 64. One poller owns one partition and claims up to 1k jobs a second, so 64 × 1k = 64k runs a second, above the 50k peak.\n- Workers: if a run takes 2 s and a worker does 10 at once, the average of 2,778 × 2 s = 5,556 runs in flight needs about 556 workers. At the peak, 1k workers do 1k × 10 ÷ 2 s = 5k runs a second, so the 3 million burst drains in 3 million ÷ 5k = 600 seconds. With 4k workers it drains in 150 seconds.\n- History: 10 million jobs × 24 runs a day = 240 million runs a day. At 200 bytes each that is 48 GB a day, or 336 GB for 7 days. Keep a week in Postgres, then archive older runs to cheap storage.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client (API Caller) sends POST /jobs to the Scheduler API with a schedule such as "*/5 * * * *".\n2. The Scheduler API works out the first due time and writes the job and its next_run_at to the Jobs DB (Postgres).\n3. When the time comes, the Scheduler (Poller) claims due jobs from the Jobs DB (Postgres) with FOR UPDATE SKIP LOCKED, adds a run row and moves next_run_at forward, all in one transaction.\n4. The Scheduler (Poller) puts each run on the Run Queue as a small message.\n5. A worker in the Worker Pool leases the message from the Run Queue and marks the run as running in the Jobs DB (Postgres).\n6. The Worker Pool calls the Target Service with the run id as an idempotency key.\n7. On success, the Worker Pool records the result in the Jobs DB (Postgres) and acknowledges the message.\n8. On failure, the Worker Pool sends the run back to the Run Queue with a longer delay. After the last attempt it moves the run to the Dead Letter Queue.\n9. If a worker dies, the Lease Reaper finds the expired lease in the Jobs DB (Postgres) and puts the run back on the Run Queue.',
      },
      {
        heading: 'Components',
        body: '- Client (API Caller): any team or service that creates, changes or pauses a job.\n- Scheduler API: checks the schedule text, computes the first next_run_at and stores the job. It never runs jobs itself.\n- Jobs DB (Postgres): holds jobs and runs. It is the source of truth for what is due and what has run.\n- Scheduler (Poller): every second claims due jobs, creates one run for each due time and enqueues it. Many pollers run at once, each with its own partition.\n- Run Queue: holds run messages and hides a leased message until the worker acknowledges it or the lease ends. It also supports delayed delivery for retries.\n- Worker Pool: leases runs, calls the target, renews the lease while it works and records the result.\n- Target Service: the code that does the real work. It must accept the run id as an idempotency key.\n- Lease Reaper: every 10 seconds finds runs whose lease ended without a result and puts them back on the queue.\n- Dead Letter Queue: keeps runs that failed every attempt, with their errors, so a person can fix and replay them.',
      },
      {
        heading: 'Key decisions',
        body: '- Poll a database, do not set a timer for each job. 10 million timers in memory are lost on a restart. One indexed query on next_run_at is simple and survives restarts.\n- Claim with FOR UPDATE SKIP LOCKED. A locked row is skipped, so many pollers share the work without waiting for each other.\n- Add a unique index on (job_id, scheduled_for). Locks can fail, for example in a failover. The index is the last guard: the database refuses a second run for the same due time.\n- Move next_run_at in the same transaction that creates the run. If the poller crashes in the middle, the transaction rolls back and the job is still due, so nothing is lost or doubled.\n- Lease, do not lock. A worker that dies cannot release a lock. A lease ends by itself, so the run always comes back.\n- At least once plus idempotency. Exactly once is not possible when a worker can crash after the work but before the acknowledgement. So the scheduler repeats and the target ignores repeats.\n- Retry with a doubling delay and a limit. Doubling spares a struggling target. The limit stops a broken job from using workers forever.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Many pollers: give each poller a partition (hash of job id), so two pollers rarely look at the same rows. SKIP LOCKED and the unique index cover the rare overlap.\n- Top-of-the-hour burst: the queue absorbs it and workers drain it. Autoscale workers when the queue is old, and encourage jobs to add random jitter (a small random delay) to their time.\n- Poller crash: the transaction rolls back, so the job is still due and another poller takes it in the next second.\n- Worker crash: the lease ends after 60 seconds. The reaper sweeps every 10 seconds, so the run is late by up to 70 seconds, and the target sees the same run id again.\n- Long jobs: the worker renews its lease every 20 seconds. If it stops renewing, the system assumes it is dead.\n- Clock skew: use the database clock (now()) to decide what is due, not each machine\'s clock.\n- Database overload: batch the claims, keep the due-jobs index small and move old runs to an archive.\n- Missed runs after downtime: when the poller finds a job overdue by many periods, it creates one catch-up run and moves next_run_at to the next future time, so a one-hour outage does not trigger 60 runs of an every-minute job.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Two pollers see the same due job in the same millisecond. What stops two runs?\n- A worker crashes after the target did the work but before it acknowledged. What happens, and how do you avoid a double charge?\n- How would you run 50k jobs a second at the top of the hour?\n- How do you handle a job that takes longer than its period (a 10-minute job set to run every minute)?\n- Why a lease and not a lock?\n- How would you build a job that must run only after another job finishes (a DAG of jobs)?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Claim due jobs (one transaction)',
        language: 'sql',
        source: `-- Runs every second for each partition. SKIP LOCKED means: if another poller
-- holds a row, skip it instead of waiting.
BEGIN;

WITH due AS (
  SELECT id, next_run_at
    FROM jobs
   WHERE enabled
     AND next_run_at <= now()
     AND abs(hashtext(id)) % 64 = 17     -- this poller owns partition 17 of 64
   ORDER BY next_run_at
   LIMIT 1000
   FOR UPDATE SKIP LOCKED
),
claimed AS (
  -- Move each job to its next due time in the same transaction. next_cron() stands
  -- for the code that reads the cron text and returns the next time after this one.
  UPDATE jobs j
     SET next_run_at = next_cron(j.schedule, due.next_run_at)
    FROM due
   WHERE j.id = due.id
  RETURNING j.id AS job_id, due.next_run_at AS scheduled_for
)
INSERT INTO runs (id, job_id, scheduled_for, status, attempt)
SELECT gen_random_uuid()::text, job_id, scheduled_for, 'queued', 1
  FROM claimed
ON CONFLICT (job_id, scheduled_for) DO NOTHING;   -- the last guard against a duplicate

COMMIT;`,
      },
      {
        title: 'Worker: lease, renew, finish',
        language: 'javascript',
        source: `// A worker owns a run only while its lease is fresh. It renews every 20 s
// (a third of the 60 s lease) and stops renewing if it crashes.
export async function work(queue, db, callTarget) {
  const msg = await queue.lease({ seconds: 60 })
  if (!msg) return
  const { runId, jobId, attempt } = msg.body

  const renew = setInterval(() => queue.extend(msg, 60), 20_000)
  try {
    // The run id is the idempotency key: a repeated run returns the saved result.
    await callTarget(jobId, { 'Idempotency-Key': runId })
    await db.query("UPDATE runs SET status='succeeded' WHERE id=$1", [runId])
    await queue.ack(msg)
  } catch (err) {
    await retryOrGiveUp(queue, db, msg, attempt, err)
  } finally {
    clearInterval(renew)
  }
}`,
        versions: [
          {
            language: 'python',
            source: `import threading

def work(queue, db, call_target):
    msg = queue.lease(seconds=60)
    if msg is None:
        return
    run_id, job_id, attempt = msg.body["runId"], msg.body["jobId"], msg.body["attempt"]

    # Renew every 20 s (a third of the 60 s lease); stop when the work ends.
    done = threading.Event()
    def renew():
        while not done.wait(20):
            queue.extend(msg, 60)
    threading.Thread(target=renew, daemon=True).start()
    try:
        # The run id is the idempotency key: a repeated run returns the saved result.
        call_target(job_id, headers={"Idempotency-Key": run_id})
        db.execute("UPDATE runs SET status='succeeded' WHERE id=%s", (run_id,))
        queue.ack(msg)
    except Exception as err:
        retry_or_give_up(queue, db, msg, attempt, err)
    finally:
        done.set()`,
          },
        ],
      },
      {
        title: 'Retry delay and the dead letter queue',
        language: 'javascript',
        source: `// 30 s, 60 s, 120 s, 240 s. Real systems add jitter (a little randomness)
// so thousands of failed runs do not all retry at the same second.
const BASE_SECONDS = 30
const MAX_ATTEMPTS = 5

export function retryDelay(failedAttempt) {
  return BASE_SECONDS * 2 ** (failedAttempt - 1)
}

export async function retryOrGiveUp(queue, db, msg, attempt, err) {
  const { runId } = msg.body
  if (attempt >= MAX_ATTEMPTS) {
    await db.query("UPDATE runs SET status='dead', error=$2 WHERE id=$1", [runId, String(err)])
    await queue.sendToDeadLetter(msg, err) // a person is alerted and can replay it
  } else {
    await queue.send({ ...msg.body, attempt: attempt + 1 }, { delaySeconds: retryDelay(attempt) })
  }
  await queue.ack(msg) // this attempt is finished either way
}

console.log([1, 2, 3, 4].map(retryDelay)) // [30, 60, 120, 240]  → 450 s in all`,
        versions: [
          {
            language: 'java',
            source: `static final int BASE_SECONDS = 30;
static final int MAX_ATTEMPTS = 5;

static int retryDelay(int failedAttempt) {
  return BASE_SECONDS * (1 << (failedAttempt - 1)); // 30, 60, 120, 240
}

void retryOrGiveUp(Queue queue, Db db, Message msg, int attempt, Exception err) {
  String runId = msg.runId();
  if (attempt >= MAX_ATTEMPTS) {
    db.markDead(runId, err.toString());
    queue.sendToDeadLetter(msg, err); // alert a person; they can replay it
  } else {
    queue.send(msg.withAttempt(attempt + 1), retryDelay(attempt)); // delay in seconds
  }
  queue.ack(msg);
}`,
          },
        ],
      },
      {
        title: 'The Lease Reaper',
        language: 'sql',
        source: `-- Runs every 10 seconds. A running run whose lease ended has lost its worker.
-- The attempt counter goes up, so a run that keeps killing workers still reaches the limit.
UPDATE runs
   SET status = 'queued',
       attempt = attempt + 1,
       worker_id = NULL
 WHERE status = 'running'
   AND lease_expires_at < now()
RETURNING id, job_id, attempt;   -- each returned row is put back on the queue

-- Runs whose attempt passes max_attempts are marked 'dead' and sent to the
-- dead letter queue instead.`,
      },
    ],
    related: ['Message queue', 'Retry with backoff', 'Locking', 'Leader election', 'Idempotent payments', 'Database sharding'],
  },
  simulator,
}
