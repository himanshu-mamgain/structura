# Types of Queues

> 💡 **TL;DR**: Every queue holds messages until a worker takes them. What changes is the **promise**. A **standard** queue is fast but keeps order only roughly, and now and then delivers a message twice. A **FIFO** (first in, first out) queue keeps order within a **group**, such as one order id. A **priority** queue serves urgent work first. A **delay** queue hides a message until later. **Pub/sub** copies a message to every subscriber, while **point-to-point** gives it to one worker. **Request/reply** sends an answer back. An **in-memory** queue (Redis) trades safety for speed. And a **bounded** queue has a size limit, so you must choose what happens when it's full: the sender waits, gets refused, or the oldest message is dropped.

## At a glance

| Type | It promises | Example in a food-delivery app | Watch out for |
|---|---|---|---|
| Standard | Almost no throughput limit; rough order; at least once | Receipt emails | Messages out of order, and the odd duplicate |
| FIFO | Order within a group; no duplicate sends | Each order's status updates | Lower throughput; one stuck message blocks its group |
| Priority | Higher priority comes out first | Couriers for Gold members first | Low priority can wait forever |
| Delay | Hidden until a time | Cancel an unpaid order after 15 minutes | SQS (Simple Queue Service) stops at 15 minutes |
| Pub/sub | Every subscriber gets a copy | "Order placed" to tracking, email and couriers | Each subscriber needs its own queue |
| Request/reply | An answer comes back | Ask the Pricing Service for a fee | The caller waits; set a timeout |
| In memory (Redis) | Very fast | Resize a menu photo | A crash can lose jobs |
| Bounded | Never grows past a limit | Kitchen tablet holds 8 updates | You must choose: wait, refuse or drop |

## Standard and FIFO queues

A **standard queue** (Amazon SQS's default) is built to scale. It spreads messages over many servers, so it can take almost any number a second. The price is two weak promises:

- **Best-effort order.** Messages usually come out in the order they went in, but not always.
- **At-least-once delivery.** Now and then, a message is delivered twice.

That's fine for receipt emails. It's not fine for a tracking screen. If "ready" is applied before "cooking", the customer sees their food go back to the stove.

A **FIFO queue** (first in, first out) keeps order, but not across the whole queue. Each message carries a **group id**. Messages in the same group come out in the order they went in, **one at a time**. Different groups run in parallel. For order updates, the group id is the order id:

```javascript
await sqs.send(new SendMessageCommand({
  QueueUrl: `${base}/order-updates.fifo`,
  MessageBody: JSON.stringify({ orderId: 101, seq: 2, status: 'paid' }),
  MessageGroupId: 'order-101', // order 101's updates stay in order
  MessageDeduplicationId: 'order-101-2', // a resend within 5 minutes is dropped
}))
```

The **deduplication id** removes duplicate sends: if the Order Service retries the same send within 5 minutes, the queue keeps only one copy.

FIFO costs throughput. An SQS FIFO queue takes 300 sends a second per partition, or 3,000 with batches of 10. High-throughput mode raises that, up to 9,000 a second in Mumbai. A standard queue has no such limit.

Choose the group id with care. **One group for everything** means one message at a time, for the whole queue. **One group per order** keeps each order in step, and lets thousands of orders move at once.

## Priority queues

A **priority queue** hands out the highest priority first. Within one priority, the oldest goes first. In RabbitMQ you declare the queue with a maximum priority, and give each message a number:

```javascript
await ch.assertQueue('courier-jobs', { durable: true, maxPriority: 10 })
ch.sendToQueue('courier-jobs', Buffer.from(JSON.stringify({ orderId: 102 })), { priority: 9 }) // Gold
ch.sendToQueue('courier-jobs', Buffer.from(JSON.stringify({ orderId: 103 })), { priority: 1 })
```

Two things to know:

- **Use a few levels.** "Urgent, normal, low" is usually enough. Many levels cost memory and CPU, and are hard to reason about.
- **Starvation.** If urgent work never stops, low-priority messages wait forever. Fixes: raise a message's priority as it ages, or give each level its own queue and a share of the workers.

Amazon SQS has no priority queue. The usual answer is two queues, "urgent" and "normal", with workers that read the urgent one first.

Set a small **prefetch** too (`ch.prefetch(1)`). Otherwise a worker may grab 100 low-priority messages before an urgent one arrives, and priority can't help those 100.

## Delay queues

A **delay queue** hides a message for a while after it is sent. It suits "do this later" jobs: cancel an order still unpaid after 15 minutes, or send "How was your meal?" an hour after delivery.

```javascript
await sqs.send(new SendMessageCommand({
  QueueUrl: `${base}/payment-timeouts`,
  MessageBody: JSON.stringify({ orderId: 101 }),
  DelaySeconds: 900, // 15 minutes, the most SQS allows
}))
```

In SQS, the delay can be up to **15 minutes**. A FIFO queue has only one delay for the whole queue, not one per message. For longer or exact times, use something else:

- **A table with a `run_at` column**, and workers that take rows whose time has come.
- **A scheduler**, such as Amazon EventBridge Scheduler, for one-off timers far in the future.
- **BullMQ delayed jobs**, which wait in Redis until their time.

A delay is not the same as the **visibility timeout**. A delay hides a message when it is **first sent**. A visibility timeout hides it **after a worker takes it**, so it can come back if the worker dies.

## Pub/sub and point-to-point

There are two ways to hand out a message:

- **Point-to-point**: one queue, many workers. Each message goes to **one** of them. The workers compete, and adding workers spreads the load.
- **Pub/sub** (publish/subscribe): one message, many subscribers. **Each** subscriber gets its own copy.

Real designs combine them. The Order Service publishes "order placed" once to a **topic**. The topic copies it into three queues: tracking, email and couriers. Each queue then has its own competing workers. This is **fan-out**.

In AWS, the topic is **Amazon SNS** (Simple Notification Service: pub/sub topics) and each subscriber is an SQS queue:

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:ap-south-1:123456789012:order-events \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:ap-south-1:123456789012:emails
```

In RabbitMQ, the topic is a **fanout exchange**, and each queue is bound to it:

```javascript
await ch.assertExchange('order-events', 'fanout', { durable: true })
for (const queue of ['order-updates', 'emails', 'courier-jobs']) await ch.bindQueue(queue, 'order-events', '')
ch.publish('order-events', '', Buffer.from(JSON.stringify({ type: 'OrderPlaced', orderId: 102 })))
```

Why not have the Order Service send to three queues itself? Because then it must know every consumer. With a topic, a new consumer (say, analytics) subscribes a new queue, and the Order Service doesn't change.

A subscriber that is down still gets its copy later: it waits in that subscriber's queue. That's why each subscriber gets a **queue**, not a direct push.

## Request/reply

Usually a queue is one-way: send and forget. Sometimes the sender needs an answer, such as the delivery fee before showing the checkout page. **Request/reply** does this over queues:

1. The caller makes a **reply queue** (or uses a shared one).
2. It sends the request with two extra fields: **reply-to** (where to answer) and a **correlation id** (a unique id for this question).
3. The Pricing Service works out the fee and sends the answer to the reply-to queue, with the **same correlation id**.
4. The caller matches the answer to the question by that id, and gives up after a timeout.

```javascript
ch.sendToQueue('quote-requests', Buffer.from(JSON.stringify({ km: 4.2 })), { replyTo, correlationId })
// The Pricing Service answers: ₹25 base + ₹5 a km, 4.2 km rounds up to 5 km → ₹50
ch.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify({ fee: 50 })), { correlationId: msg.properties.correlationId })
```

Use it when you want a queue's benefits for a request: the Pricing Service can be busy or restarting, and requests wait instead of failing. But the caller still waits. If neither side needs that, a plain HTTP call is simpler. RabbitMQ also has **direct reply-to** (`amq.rabbitmq.reply-to`), which skips making a reply queue.

## In-memory queues: Redis and BullMQ

A queue in **Redis** lives in memory, so it's very fast: tens of thousands of jobs a second on one small server. It suits quick jobs that can be redone, like resizing a menu photo.

The simplest is a **Redis list**:

```bash
LPUSH photo-jobs '{"photoId":"p_77"}'     # add a job
BRPOP photo-jobs 0                          # a worker waits for one; it is removed at once
```

If the worker crashes after `BRPOP`, the job is gone. A safer version moves the job to a "working" list, and deletes it from there when done:

```bash
BLMOVE photo-jobs photo-jobs:working RIGHT LEFT 0
LREM photo-jobs:working 1 '{"photoId":"p_77"}'   # done
```

**Redis Streams** add consumer groups and acknowledgements, like a small Kafka. A job stays pending until a worker acks it, and another worker can claim it if the first one dies:

```bash
XGROUP CREATE photo-jobs resizers $ MKSTREAM
XADD photo-jobs * photoId p_77
XREADGROUP GROUP resizers worker-1 COUNT 1 BLOCK 5000 STREAMS photo-jobs >
XACK photo-jobs resizers 1731920000000-0
```

**BullMQ** is a Node.js library that builds a full job queue on Redis: retries, delays, priorities and many workers.

```javascript
import { Queue, Worker } from 'bullmq'

const connection = { host: 'localhost', port: 6379 }
const photos = new Queue('photos', { connection })

await photos.add('resize', { photoId: 'p_77' }) // as soon as a worker is free
await photos.add('resize', { photoId: 'p_78' }, { delay: 30_000 }) // not before 30 seconds
await photos.add('resize', { photoId: 'p_79' }, { priority: 1 }) // a lower number goes sooner

new Worker('photos', async (job) => resize(job.data.photoId), { connection, concurrency: 4 })
```

The catch is durability. If Redis restarts, jobs since its last save to disk are lost, unless you turn on its append-only file. Use Redis for jobs you can afford to redo. Use SQS or RabbitMQ for orders and payments.

## Bounded queues and backpressure

A queue with no limit never says no. During a rush it just grows: first the waits get longer, then the broker runs out of memory or disk. A **bounded queue** has a limit, and you choose what happens when it's full:

| When full | What happens | Good for | Bad for |
|---|---|---|---|
| **Make the sender wait** | The sender blocks until there's room | Pipelines inside one service | A web request: the customer's app spins |
| **Refuse** | The sender gets "queue full", such as a 429 | APIs: the caller retries later | Messages nobody will resend |
| **Drop the oldest** | The oldest waiting message is thrown away | Latest-value data: a courier's location | Anything that must arrive, like order updates |

Making the sender wait is called **backpressure**: the slowness flows back to whoever is sending too fast, so they slow down. RabbitMQ sets a limit with `x-max-length`, and `x-overflow` picks the behaviour: `drop-head` drops the oldest (the default), `reject-publish` refuses. In code, Java's `ArrayBlockingQueue` gives all three:

```java
BlockingQueue<String> q = new ArrayBlockingQueue<>(8);
q.put(update);                          // wait for room (backpressure)
boolean ok = q.offer(update);           // refuse: false when full
while (!q.offer(update)) q.poll();      // drop the oldest to make room
```

## What the simulator shows

The topic's simulator plays a lunch rush. 6 orders each send 4 updates (placed, paid, cooking, ready): 24 messages in about 8 seconds, about 3 a second. Orders 102 and 105 are Gold. A worker needs 0.6 to 1.4 seconds per update.

With 2 workers and no limit:

| Queue | Screens that went backwards | Delivered twice | Gold wait | Others' wait | All done |
|---|---|---|---|---|---|
| Standard | 2 of 6 | 1 | 2.0 s | 2.4 s | 12.9 s |
| FIFO | 0 | 0 | 2.1 s | 2.1 s | 12.9 s |
| Priority | 0 | 0 | 0.2 s | 2.5 s | 12.4 s |

- **Standard**: "101 paid" came twice, and two customers saw their order go backwards. Both screens ended on "cooking", though the food was ready.
- **FIFO**: every screen moved forward, at almost no cost in time.
- **Priority**: Gold orders waited 0.2 s instead of 2.5 s. Priority doesn't promise order within an order, though.

With 1 worker, the queue can't keep up: 15 messages pile up. With a FIFO queue and a limit of 8:

| When full | Lost updates | Customers missing updates | Sender waited | All done |
|---|---|---|---|---|
| No limit | 0 | 0 | never, but one update waited 14.6 s | 23.8 s |
| Make the sender wait | 0 | 0 | 12 sends, up to 6.9 s | 23.8 s |
| Refuse | 8 | 5 | never | 16.2 s |
| Drop the oldest | 8 | 5 | never | 16.5 s |

Refusing and dropping finish sooner only because they do less work. Order updates must arrive, so here the right answer is to wait, and add workers.

## A queue or a log?

Kafka is often called a queue, but it's a **log**. Messages aren't removed when read. Each consumer group keeps its own place (an offset), so many groups read the same messages, and you can replay old ones. Order is kept per **partition**, much like a FIFO group. If you need replay or many independent readers, use a log. If you need jobs done once with retries, delays and priorities, use a queue. See [Kafka Basics](/?topic=kafka-basics&read) and [Distributed Message Queue](/?topic=message-queue&read).

## How to choose

- **Order doesn't matter, volume is high**: a standard queue, with idempotent handlers.
- **Order matters per thing** (an order, a user, an account): FIFO, with that thing's id as the group id.
- **Some work is more urgent**: a priority queue with a few levels, or one queue per level.
- **"Do this later"**: a delay queue up to 15 minutes; a `run_at` table, a scheduler or BullMQ beyond that.
- **Several consumers need the same event**: pub/sub fan-out to one queue each.
- **The sender needs an answer**: request/reply with a correlation id and a timeout, or just HTTP.
- **Quick jobs you can redo**: Redis or BullMQ. **Money and orders**: SQS or RabbitMQ.
- **Always**: a limit, a plan for when it's full, and a dead-letter queue.

## ⚠️ Critical Mistakes

- **Using a standard queue for things that must stay in order.** Status updates arrive out of order, and screens go backwards.
- **One FIFO group id for the whole queue.** Everything runs one message at a time.
- **Assuming FIFO means no duplicates on the worker's side.** If a worker is slower than the visibility timeout, the message comes back. Keep handlers idempotent.
- **Hundreds of priority levels, and no plan for starvation.**
- **A big prefetch with a priority queue.** Workers grab low-priority messages before the urgent ones arrive.
- **Long delays in SQS.** It stops at 15 minutes; chaining delays is fragile. Use a scheduler or a `run_at` table.
- **Sending to each consumer's queue yourself instead of using a topic.** Every new consumer means changing the sender.
- **Request/reply without a timeout.** The caller waits forever when the reply never comes.
- **Payments in a Redis list with `BRPOP`.** A crash after the pop loses the job.
- **No limit on an in-memory queue.** A long rush ends with the process running out of memory.
- **Dropping the oldest for messages that must arrive.** Customers silently miss updates.

## Interview Q&As

**Q: Why not make every queue FIFO?**

A: FIFO costs throughput and parallelism. An SQS FIFO queue takes 300 sends a second per partition, 3,000 with batching, while a standard queue has almost no limit. And messages in one group go one at a time, so a slow or failing message holds up its whole group. Use FIFO only where order matters, and choose a group id fine enough to keep things parallel.

**Q: Two workers handle updates for the same order. How do you keep the tracking screen correct?**

A: Either stop it happening, or make it harmless. A FIFO queue with the order id as the group id makes sure only one update per order is in flight. Or send a step number with each update, and have the worker ignore anything lower than the step it has already saved: `UPDATE orders SET status = $1, seq = $2 WHERE id = $3 AND seq < $2`.

**Q: How would you cancel an unpaid order after 30 minutes, when SQS delays stop at 15?**

A: Store the order with a `cancel_at` time, and have a worker check every minute for unpaid orders past it. Or use a scheduler such as EventBridge Scheduler to fire once at that time. Or use BullMQ's delayed jobs. Whatever fires, the worker checks the order's state first, since it may have been paid in the meantime.

**Q: What should happen when a queue fills up?**

A: It depends on the messages. For things that must arrive, like orders, make the sender wait or refuse with a 429 so the caller retries, and add workers. For latest-value data, like a courier's location, dropping the oldest is fine. Never let it grow without limit, and alert on the depth and the age of the oldest message.

**Q: What's the difference between pub/sub and a queue?**

A: In a queue, each message goes to one worker: workers compete. In pub/sub, each subscriber gets its own copy. Most systems combine them: a topic fans out to one queue per subscriber, and each queue has competing workers. So "order placed" reaches tracking, email and couriers once each.

**Q: When would you choose Redis over SQS or RabbitMQ?**

A: For quick jobs that can be redone, where speed matters more than never losing a job: thumbnails, cache warming, sending a notification that can be resent. Redis keeps the queue in memory, so a restart can lose recent jobs. For orders and payments, use a broker that saves every message to disk.

## Related topics

- [Distributed Message Queue](/?topic=message-queue&read): visibility timeouts, acks and dead-letter queues inside one queue.
- [Kafka Basics](/?topic=kafka-basics&read): a log instead of a queue, with partitions and consumer groups.
- [Retries: Backoff and Jitter](/?topic=retry-backoff&read): how workers should retry a failed job.
- [Notification System](/?topic=notification-system&read): fan-out and priorities for push, email and SMS (text message).
- [Redis Basics](/?topic=redis-basics&read): lists, sorted sets and streams.
- [Idempotent Payments](/?topic=payment-idempotency&read): handlers that are safe to run twice.

## Sources

- Amazon SQS: [Standard and FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-queue-types.html), [FIFO exactly-once processing](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html), [delay queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-delay-queues.html), [message timers](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-timers.html) and [quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- Amazon SNS: [Fan-out to SQS queues](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html)
- RabbitMQ: [Priority queues](https://www.rabbitmq.com/docs/priority), [queue length limit](https://www.rabbitmq.com/docs/maxlength) and [direct reply-to](https://www.rabbitmq.com/docs/direct-reply-to)
- Redis: [Lists](https://redis.io/docs/latest/develop/data-types/lists/) and [Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- BullMQ: [documentation](https://docs.bullmq.io/)

## Why This Matters

"Put a queue in between" is one of the most common moves in system design, and interviewers follow it up straight away: which kind, and what does it promise? Being able to say "FIFO grouped by order id, because status updates must stay in order; a standard queue for emails, with idempotent handlers; a priority queue for couriers, with a plan for starvation; a limit of so many, and refuse with a 429 when full" shows you chose each queue for a reason.
