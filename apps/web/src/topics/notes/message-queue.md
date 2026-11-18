# Distributed Message Queue: Hand Off Work, Survive Failure, Accept Duplicates

> 💡 **TL;DR**: A queue lets a producer hand off a job and move on. A worker **receives** a message, which only **hides** it for a while (the **visibility timeout**). The message is gone only when the worker **deletes** it, which is its "done" (the ack). If the worker crashes or is too slow, the message **comes back** and another worker gets it. After a few failed tries, it moves to a **dead-letter queue** for a person to look at. The price: every message arrives **at least once**, so every handler must be **safe to repeat** (idempotent).

Related: [Kafka basics](/?topic=kafka-basics&read) (a log, not a queue), [Notification System](/?topic=notification-system&read) (a big user of queues), [Rate Limiter](/?topic=rate-limiter&read), [Idempotent Payments](/?topic=payment-idempotency&read).

---

## Queue or log at a glance

| | Message queue: Amazon SQS (Simple Queue Service) or RabbitMQ | Log: Kafka |
| --- | --- | --- |
| Unit | A job to do once | An event that happened |
| After it is read | Hidden, then deleted on ack | Stays; the reader keeps an offset |
| Many readers of the same message | No: one worker gets it | Yes: each group reads it all |
| Replay | No (unless you kept a copy) | Yes, by moving the offset |
| Retries | Built in: visibility timeout, dead-letter queue | You build them (retry topics) |
| Ordering | None, or per FIFO (first in, first out) group | Per partition |
| Best for | Background jobs, task fan-out, smoothing bursts | Event streams, analytics, many consumers |

---

## The life of one message

1. **Send.** The producer calls SendMessage. The queue stores it on a node and a replica, then replies.
2. **Receive.** A worker long-polls. The queue returns the message and a **receipt handle**, increments the **receive count**, and hides the message for the visibility timeout.
3. **Work.** The worker does the job.
4. **Ack.** The worker calls DeleteMessage with the receipt handle. Now the message is gone.
5. **Or not.** If no delete arrives before the timeout, the message becomes visible again and the cycle repeats.
6. **Give up.** When the receive count reaches the limit (say 3), the queue moves it to the **dead-letter queue** instead.

A worker that deletes with an **old** receipt handle (the message was re-received meanwhile) does not remove the message; only the latest handle counts.

---

## The capacity math

An example: 50,000 messages a second at peak, 2 KB each.

| Quantity | Working | Result |
| --- | --- | --- |
| Ingress | 50,000 × 2 KB | about 98 MiB/s |
| Written with 3 copies | 98 MiB/s × 3 | about 293 MiB/s |
| Shards at 5,000 sends/s each | 50,000 ÷ 5,000 | 10 |
| One hour of backlog | 50,000 × 3,600 × 2 KB | about 369 GB (1.1 TB with 3 copies) |
| In flight at 200 ms a job | 50,000 × 0.2 | 10,000 messages |
| Workers at 20 jobs each | 10,000 ÷ 20 | 500 |

The in-flight number is **Little's law**: items in the system = arrival rate × time each spends there.

---

## Why duplicates are unavoidable

The worker does the work, then tells the queue. Those are two steps, and a crash can fall between them.

- **Delete before the work:** a crash loses the job (at most once).
- **Delete after the work:** a crash repeats the job (at least once).

There is no third option inside two separate systems, so queues choose the second and ask you to make the work **safe to repeat**. Put the message id in a table with a unique key, **in the same transaction** as the side effect:

```python
with db:                                   # one transaction
    db.execute("INSERT INTO processed_messages VALUES (?)", (message_id,))  # fails if seen
    db.execute("INSERT INTO charges VALUES (?, ?)", (order_id, amount_cents))
```

If the insert fails because the id exists, the work was already done: ack and move on.

---

## Choosing the visibility timeout

| Timeout | What happens | Symptom |
| --- | --- | --- |
| Shorter than the job | A second worker gets the message while the first still works | Duplicates, and after 3 receives a "failed" message in the dead-letter queue that actually succeeded |
| About p99 of the job plus a margin | Crashes recover in reasonable time; normal jobs finish first | What you want |
| Far longer than the job | A crashed worker's message waits the whole timeout | Slow recovery, growing age of the oldest message |

For jobs of unpredictable length, start small and **extend the timeout** while working (ChangeMessageVisibility), like a heartbeat.

---

## How to choose

- **One job, done once by one worker** → a queue.
- **Many systems need the same event, or you need replay** → a log such as Kafka.
- **Strict order per customer** → FIFO queue with the customer id as the message group.
- **Delayed work** (retry in 5 minutes) → delay queues or a visibility timeout that grows each attempt.
- **Tiny scale** → a database table with `FOR UPDATE SKIP LOCKED` is a fine queue, and needs no new system.

---

## ⚠️ Critical Mistakes

❌ **Assuming exactly once.** Queues deliver at least once. Without an idempotent handler, a crash between the work and the ack charges the customer twice.

❌ **A visibility timeout shorter than the job.** The message is handed to a second worker while the first is still going, so the work runs twice or three times.

❌ **No dead-letter queue.** One poison message is retried forever, burns worker time, and hides real problems. Set a receive limit and alarm on the dead-letter depth.

❌ **Deleting before the work is safe.** An ack that comes too early turns a crash into silent data loss.

❌ **Retrying instantly.** If a downstream API is down, instant retries make it worse. Back off with a growing delay.

❌ **Watching only queue depth.** Depth says how many; the **age of the oldest message** says how late. Alarm on age.

❌ **Treating the dead-letter queue as a bin.** Messages there are failed work. Keep them long enough to fix the bug, then redrive them.

---

## Interview Q&As

**Q: Why can a message be delivered twice?**

A: Because "do the work" and "tell the queue" are two steps. If the worker crashes between them, or the work outlasts the visibility timeout, the queue never sees an ack and hands the message to another worker. The queue prefers a duplicate to a loss.

**Q: How do you get exactly-once behaviour?**

A: You can't get it from the queue alone. You get at-least-once delivery plus an idempotent handler, which together behave like exactly once. Record the message id with a unique key in the same transaction as the side effect, and skip if it exists. Pass an idempotency key to any external API you call, too.

**Q: A message fails every time. What happens?**

A: Each failed attempt leaves it unacked, so it reappears after the timeout and the receive count rises. At the limit (3 to 5), the queue moves it to the dead-letter queue. An alarm tells a person; they fix the bug or the data and redrive the messages back to the main queue.

**Q: How do you pick the visibility timeout?**

A: A bit above the p99 job time. Too short causes duplicates; too long delays recovery from a crash. For variable jobs, extend the timeout from the worker while it works.

**Q: How would you scale it to 50,000 messages a second?**

A: Shard the queue across nodes, each with replicas (about 10 shards at 5,000 sends per second each), and scale workers on backlog per worker and age of the oldest message. Put a cap on worker concurrency so a slow downstream doesn't cause a pile of expiring timeouts.

**Q: Queue or Kafka?**

A: A queue when each message is a job for one worker and you want retries and dead-lettering built in. Kafka when several systems read the same events, order within a key matters, or you need replay.

---

## Related topics

- [Kafka basics](/?topic=kafka-basics&read) and [Kafka reliability](/?topic=kafka-reliability&read): the log-based alternative
- [Notification System](/?topic=notification-system&read): queues per channel with retries
- [Idempotent Payments](/?topic=payment-idempotency&read): the handler side of at-least-once delivery
- [Rate Limiter](/?topic=rate-limiter&read): protects the downstream the workers call
- [Distributed Locking](/?topic=locking&read): why "only one worker at a time" is harder than it looks

---

## Sources

- [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [RabbitMQ: consumer acknowledgements and publisher confirms](https://www.rabbitmq.com/docs/confirms)
- [PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

---

## Why This Matters

✅ "Process this in the background" appears in almost every design: emails, payments, thumbnails, exports. A queue is the standard answer.

✅ Explaining the visibility timeout, the ack and the dead-letter queue shows you understand failure, not just the happy path.

✅ At-least-once delivery plus idempotency is the pattern behind safe payments, webhooks and event processing everywhere.
