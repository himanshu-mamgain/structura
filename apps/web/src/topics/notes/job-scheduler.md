# Distributed Job Scheduler (Cron at Scale)

> 💡 **TL;DR**: **Cron** runs a task at set times ("every day at 02:00") on one server. If that server is off at 02:00, the task is skipped; if you run cron on two servers, the task runs twice. A **distributed job scheduler** fixes both. A job is just a **row in a database** with a `next_run_at` time. **Pollers** claim due rows every second with `FOR UPDATE SKIP LOCKED`, create a **run** and move `next_run_at` forward in one transaction, and put the run on a **queue**. **Workers** take runs under a **lease** (a lock that ends by itself), so a dead worker can't hold a run for ever. The system promises **at least once**, so the job's target must use the run ID to ignore repeats.

## At a glance

| Question | Answer |
|---|---|
| A job | A row: what to call, its schedule, and `next_run_at` |
| A run | One execution of a job for one due time |
| Finding due work | One indexed query on `next_run_at`, every second |
| Many pollers, no double runs | `FOR UPDATE SKIP LOCKED`, plus a unique index on (job, due time) |
| Crash safety | Creating the run and moving `next_run_at` happen in one transaction |
| Dead workers | Leases end after 60 s; a reaper puts the run back |
| Guarantee | At least once; the target treats the run ID as an idempotency key |
| Failures | Retries with a doubling delay, then a dead letter queue |
| Load in the example | 10 million jobs: about 2,778 runs a second, 50k at the top of the hour |
| Time | The database's clock decides what's due, not each machine's |

## What cron is, and what goes wrong at scale

**Cron** is the classic Unix tool for running a command on a schedule. A schedule is written as five fields: minute, hour, day of month, month, day of week.

```text
0 2 * * *      every day at 02:00
*/5 * * * *    every 5 minutes
0 9 * * 1      every Monday at 09:00
```

`*` means "any", and `*/5` means "every 5th".

Cron on one server has two problems:
- **That server is a single point of failure.** If it's down or rebooting at 02:00, the nightly report never runs, and nobody notices.
- **You can't just add a second server.** Both would run every job, so every email goes out twice.

A **distributed job scheduler** lets many teams register jobs, and makes sure each run happens on time, exactly when due, on some healthy machine, with retries and a history.

## Follow one run all the way through

The finance team registers "send the daily report at 02:00". At 02:00:00 on 26 November, here's what happens.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Earlier, the team sent `POST /jobs` with schedule `0 2 * * *` | Client (API Caller) → Scheduler API |
| 2 | The API worked out the first due time and saved the job with `next_run_at = 2026-11-26 02:00` | Jobs DB (Postgres) |
| 3 | At 02:00:00 a poller claims due jobs in its partition (see the query below) | Scheduler (Poller) |
| 4 | In the same transaction it inserts run 88412 for 02:00 and moves `next_run_at` to 27 November 02:00 | Jobs DB (Postgres) |
| 5 | It puts a small message, "run 88412", on the queue | Run Queue |
| 6 | A worker leases the message for 60 seconds and marks the run `running` | Worker Pool |
| 7 | It calls the report service with `Idempotency-Key: run-88412` | Target Service |
| 8 | The report is sent; the worker records `succeeded` and acknowledges the message | Worker Pool → Jobs DB (Postgres) |
| 9 | (If the worker had died at step 7: the lease ends, the reaper puts run 88412 back, another worker retries with the same key) | Lease Reaper |
| 10 | (If it failed 5 times: the run moves to the dead letter queue and someone is alerted) | Dead Letter Queue |

## Jobs are rows, and pollers claim them

Keeping a timer in memory for each of 10 million jobs fails on every restart. Instead, each job is a row, and "what's due?" is one query:

```sql
WITH due AS (
  SELECT id, next_run_at FROM jobs
  WHERE next_run_at <= now() AND partition = 17 AND paused = false
  ORDER BY next_run_at
  LIMIT 500
  FOR UPDATE SKIP LOCKED
)
INSERT INTO runs (job_id, scheduled_for, status)
SELECT id, next_run_at, 'queued' FROM due
RETURNING id, job_id;
-- then, in the same transaction: UPDATE jobs SET next_run_at = <next time from its schedule> WHERE id IN (...)
```

- `next_run_at <= now()` finds due jobs; an index on `next_run_at` makes it fast. `now()` is the **database's** clock, so servers with slightly wrong clocks don't matter.
- `FOR UPDATE` locks the rows this poller takes. `SKIP LOCKED` makes other pollers **skip** rows already locked instead of waiting, so many pollers share the work without blocking each other.
- `partition = 17`: jobs are split into 64 groups by a hash of their ID, and each poller owns some groups, so pollers rarely even look at the same rows.

Creating the run and moving `next_run_at` happen in **one transaction**: both happen, or neither. If the poller crashes in between, everything rolls back and the job is still due, so the next poller picks it up. Nothing is skipped or doubled.

As a last guard, a **unique index** on `(job_id, scheduled_for)` makes the database refuse a second run for the same due time, even if locks fail during a database failover.

## Leases: a lock that ends by itself

A worker that takes a run could crash and never say so. If it held a normal lock, the run would be stuck for ever. A **lease** is a lock with an expiry: the run belongs to the worker for 60 seconds. A long job renews its lease every 20 seconds while it works.

The **Lease Reaper** checks every 10 seconds for runs whose lease ended without a result and puts them back on the queue. So a crashed worker delays a run by at most about 70 seconds (60 + 10), never for ever.

## At least once, so the target must ignore repeats

A worker can finish the work and crash before recording it. The lease then ends and the run is tried again: the work happens twice. **Exactly once** isn't possible here; the scheduler can only promise **at least once**.

So the worker passes the run ID to the target as an **idempotency key**, and the target remembers keys it has handled:

```javascript
async function sendDailyReport(req) {
  const key = req.headers['idempotency-key'] // "run-88412"
  const first = await db.query(
    'INSERT INTO handled (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [key])
  if (first.rowCount === 0) return { status: 200, body: 'already done' } // a repeat: do nothing
  await emailReport()
  return { status: 200, body: 'sent' }
}
```

`ON CONFLICT DO NOTHING` inserts the key only if it's new; `rowCount === 0` means it was already there, so this is a repeat.

## Retries and the dead letter queue

A failed run goes back on the queue with a growing delay: 30 seconds, 1 minute, 2, 4, 8. Doubling gives a struggling target time to recover. After the last try, the run goes to the **dead letter queue** with its error, an alert fires, and a person can fix the cause and replay it. A broken job never ties up workers for ever.

## The numbers, worked out

- **Jobs table**: 10 million jobs × about 500 bytes = **5 GB**, easy for one Postgres server.
- **Average**: if a job runs once an hour on average, 10 million ÷ 3,600 s ≈ **2,778 runs a second**.
- **Top of the hour**: people love round times. If 30% of jobs are set for minute :00, that's 3 million runs in one minute: 3 million ÷ 60 s = **50k a second**, 18 times the average.
- **Pollers**: 64 partitions × 1k claims a second each = **64k a second**, above the 50k peak.
- **Workers**: a run takes 2 s and a worker does 10 at once. On average 2,778 × 2 s ≈ 5,556 runs are in flight, so about **556 workers**. At the peak, 1k workers do 1k × 10 ÷ 2 s = 5k runs a second, so the 3 million burst drains in 600 seconds (10 minutes); 4k workers drain it in 150 seconds.
- **History**: 240 million runs a day × 200 bytes = **48 GB a day**. Keep 7 days (336 GB) in Postgres and archive the rest.

## What it costs and where it stops

- **"On time" means seconds, not milliseconds.** Pollers run every second and bursts take time to drain.
- **Round-time bursts.** Encourage jobs to add **jitter** (a small random delay) to their time, and scale workers on queue age.
- **Long downtime**: after an hour's outage, an every-minute job is 60 runs behind. Create one catch-up run and skip to the next future time, instead of 60 runs at once.
- **A job longer than its period** (10 minutes of work every minute): decide whether runs may overlap, skip, or queue up, and store that per job.
- **The database is the heart.** Keep the due-jobs index small and archive old runs, or the poll query slows down.

## How to choose

- **A few jobs on one server, a skipped run is fine?** Plain cron.
- **Several servers, each job must run once?** A database-backed scheduler like this one, or a library that does the same (claim rows with `SKIP LOCKED`).
- **On a cloud?** Its scheduler (such as EventBridge Scheduler on AWS) may be enough.
- **Long multi-step workflows with branches and waits?** A workflow engine rather than a scheduler.

## ⚠️ Critical Mistakes

- **Running cron on two servers "for safety".** Every job runs twice. Use one scheduler that claims runs.
- **Plain `SELECT` then `UPDATE` to claim jobs.** Two pollers both see the job as due. Use `FOR UPDATE SKIP LOCKED` and the unique index.
- **Moving `next_run_at` in a separate step.** A crash between the two skips or repeats a run. One transaction.
- **Locks instead of leases.** A dead worker holds the run for ever.
- **Assuming exactly once.** Crashes cause repeats. Pass the run ID as an idempotency key.
- **Each machine's own clock.** Clocks drift. Let the database decide what's due.

## Interview Q&As

**Q: Two pollers see the same due job in the same millisecond. What stops two runs?**

A: `FOR UPDATE SKIP LOCKED`: the first poller locks the row and the second skips it. Partitions make overlap rare to begin with. And a unique index on (job, due time) makes the database refuse a second run even if locking fails.

**Q: A worker crashes after the target did the work but before acknowledging. What happens?**

A: The lease ends, the reaper puts the run back, and another worker calls the target again. The target sees the same run ID as its idempotency key and does nothing the second time.

**Q: How would you handle 50k runs a second at the top of the hour?**

A: Partition the jobs across many pollers, put runs on a queue so the burst waits there, autoscale workers on queue age, and ask jobs to add random jitter so they don't all pick minute :00.

**Q: Why a lease and not a lock?**

A: A worker that dies can't release a lock, so the run would be stuck. A lease ends by itself after a set time; the worker renews it while alive, and the reaper reclaims it when it isn't.

## Related topics

- [Message Queue](/?topic=message-queue&read): visibility timeouts, acknowledgements and dead letters.
- [Locking](/?topic=locking&read): `FOR UPDATE`, `SKIP LOCKED` and leases in depth.
- [Leader Election](/?topic=leader-election&read): another way to make sure only one machine does a job.
- [Retries: Backoff and Jitter](/?topic=retry-backoff&read): why delays double and why jitter helps.
- [Idempotent Payments](/?topic=payment-idempotency&read): idempotency keys when the work moves money.

## Sources

- PostgreSQL: [SELECT, the locking clause (FOR UPDATE, SKIP LOCKED)](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- PostgreSQL: [INSERT, ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
- crontab(5): [The cron schedule format](https://man7.org/linux/man-pages/man5/crontab.5.html)
- AWS: [What is Amazon EventBridge Scheduler?](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)

## Why This Matters

Every company runs scheduled work: reports, billing, cleanups, reminders. "Design a distributed cron" tests whether you can make work happen once, on time, when machines die: claiming rows safely, leases instead of locks, one transaction for the state change, and idempotency at the target. These same ideas power queues, payment retries and workflow engines.
