import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Cron, but for many machines',
      text: 'Cron is a tool that runs a command at a set time on one server. If that server is off, the job is skipped. If you start two servers, the job runs twice. A distributed job scheduler fixes both problems for millions of jobs.',
      focus: ['Client (API Caller)'],
      remember: 'Each job runs once per due time, even when machines die.',
    },
    {
      title: 'A job is just a row',
      text: 'The Scheduler API stores each job as a row with a schedule and a next_run_at time. Nothing runs yet. Finding work is one database query, not a timer for each of 10 million jobs.',
      focus: ['Scheduler API', 'Jobs DB (Postgres)'],
      example: "next_run_at = 2026-12-01T02:00:00Z\nschedule = '*/5 * * * *'",
    },
    {
      title: 'The poller finds due jobs',
      text: 'Every second the Scheduler (Poller) asks the database for jobs whose next_run_at has passed. For each one it adds a run row and moves next_run_at to the next time, all in one transaction. A transaction is a group of changes that all happen or none do.',
      focus: ['Scheduler (Poller)', 'Jobs DB (Postgres)'],
      remember: 'Move next_run_at in the same transaction, so a slow run never delays the next one.',
    },
    {
      title: 'Two pollers, one run',
      text: 'Many pollers run at once. FOR UPDATE SKIP LOCKED makes a poller skip rows another poller holds. A unique index on (job_id, scheduled_for) is a second guard: the database refuses a second run for the same time.',
      focus: ['Scheduler (Poller)', 'Jobs DB (Postgres)'],
      example: 'UNIQUE (job_id, scheduled_for)',
    },
    {
      title: 'The queue and the lease',
      text: 'The poller puts a small message on the Run Queue. A worker takes it, and the queue hides it for 60 seconds. That is a lease. If the worker finishes, it acknowledges and the message is deleted.',
      focus: ['Run Queue', 'Worker Pool'],
      example: 'leased at 02:00:02 → hidden until 02:01:02',
    },
    {
      title: 'When a worker dies',
      text: 'A dead worker cannot say it died. So the lease ends by itself. The Lease Reaper checks every 10 seconds, finds runs whose lease ended, and puts them back on the queue. A crash at 02:00:04 is found at 02:01:10.',
      focus: ['Lease Reaper', 'Jobs DB (Postgres)', 'Run Queue'],
      remember: 'A lock needs its owner to release it. A lease ends by itself.',
    },
    {
      title: 'At least once, so be idempotent',
      text: 'After a crash the new worker may repeat work the first one half did. So the worker sends the run id as an idempotency key. The Target Service remembers it and does the work only once, and returns the saved answer the second time.',
      focus: ['Worker Pool', 'Target Service'],
      example: 'Idempotency-Key: run_3c1f9a22',
    },
    {
      title: 'Retry, then give up',
      text: 'When the target fails, the worker retries with a doubling delay: 30, 60, 120 and 240 seconds. Waiting longer gives a struggling target time to recover. After 5 attempts the run goes to the Dead Letter Queue and a person is alerted.',
      focus: ['Worker Pool', 'Run Queue', 'Dead Letter Queue'],
      example: '30 + 60 + 120 + 240 = 450 seconds of waiting',
    },
  ],
  quiz: [
    {
      question: 'Why does the poller move next_run_at in the same transaction that creates the run?',
      options: ['To save disk space', 'So a crash cannot lose the run or create it twice', 'To make the target faster', 'So the queue stays empty'],
      answer: 1,
      why: 'If the poller crashes, the transaction rolls back and the job is still due, so another poller takes it. Nothing is lost or doubled.',
    },
    {
      question: 'Why use a lease instead of a lock for a running job?',
      options: ['A lease is faster to write', 'A dead worker cannot release a lock, but a lease ends by itself', 'A lease lets two workers run the job', 'A lock cannot be stored in a database'],
      answer: 1,
      why: 'When a worker crashes, nobody releases its lock. The lease has an end time, so the reaper can put the run back on the queue.',
    },
    {
      question: 'A job fails 4 times in a row with a 30-second first delay that doubles. How long did it wait in total before the 5th attempt?',
      options: ['120 seconds', '300 seconds', '450 seconds', '900 seconds'],
      answer: 2,
      why: 'The waits are 30, 60, 120 and 240 seconds. Together that is 450 seconds.',
    },
  ],
}

export default lesson
