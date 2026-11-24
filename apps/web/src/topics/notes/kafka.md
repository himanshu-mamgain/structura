# Kafka: Event Streaming

> 💡 **TL;DR**: **Kafka** keeps a durable, ordered **log** of events that many systems read at their own pace. This note goes under the hood of what Kafka Basics introduced. A topic's partitions live on several servers called **brokers**, and each partition is **copied** to other brokers: one copy is the **leader** that takes writes, the others are **followers**. With `acks=all` and `min.insync.replicas=2`, the producer hears "saved" only once at least two copies have the event, so losing one broker loses nothing. A **controller** (Kafka's **KRaft** system) picks a new leader when a broker dies. Consumers commit offsets **after** processing, which gives **at-least-once** delivery, so every handler must be safe to repeat; events that keep failing go to a **dead-letter topic** so they can't block a partition.

## At a glance

| Question | Answer |
|---|---|
| Broker | A Kafka server; a cluster has several |
| Leader | The copy of a partition that takes reads and writes |
| Followers | Copies on other brokers that fetch from the leader |
| In-sync replicas (ISR) | The copies that are fully caught up |
| `acks=all` | The leader confirms only after the in-sync copies have the event |
| `min.insync.replicas=2` | Refuse writes unless at least 2 copies are in sync |
| A broker dies | The controller makes an in-sync follower the new leader |
| Delivery | At least once: commit after processing, handle duplicates |
| Poison event | An event that always fails; after a few retries, send it to a dead-letter topic |
| Retention | Keep events for N days, or keep only the latest per key (compaction) |

## What event streaming is, and why Kafka exists

Without Kafka, the Order Service calls billing, analytics, email and search itself. If one is slow or down, orders fail, and every new reader means changing the Order Service.

**Event streaming** turns that around: the Order Service writes one event, "order 1001 paid", to a log and moves on. Every system that cares reads the log when it's ready. Kafka is the most widely used system for this. Unlike a classic queue, reading an event doesn't delete it; each reader (a **consumer group**) remembers its own position (its **offset**).

For this to be safe for payments, the log must survive a server dying. That is what this note is about.

## The cluster: brokers, leaders and copies

A topic's partitions are spread over the brokers. Each partition has a **replication factor**, the number of copies, usually 3:

| Partition | Leader | Followers |
|---|---|---|
| `orders-0` | Broker 1 | Brokers 2 and 3 |
| `orders-1` | Broker 2 | Brokers 3 and 1 |
| `orders-2` | Broker 3 | Brokers 1 and 2 |

Producers and consumers talk to each partition's leader. Followers keep fetching new events from the leader. A follower that has everything the leader has is **in sync**; together these form the **in-sync replicas (ISR)**. A follower that falls too far behind (30 seconds by default, `replica.lag.time.max.ms`) drops out of the ISR until it catches up.

The **controller** keeps track of which brokers are alive and who leads each partition. Since Kafka 3.3 this uses **KRaft** (Kafka Raft: Kafka's own built-in way for a few controller servers to agree), replacing the separate ZooKeeper service Kafka used before.

## Follow one event all the way through

The Order Service sends "order-1001 paid, ₹1,499" with `acks=all`.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The producer sends the event, keyed by order ID | Producer (Order Service) |
| 2 | `murmur2("order-1001")` = 297523878; 297523878 % 3 = 0, so partition 0 | Partitioner (hash of key) |
| 3 | Partition 0's leader adds it to the end of its log at offset 48210 | `Broker 1 · P0 leader` |
| 4 | A follower fetches it; now 2 of 3 copies have offset 48210, so the leader confirms | `Broker 2 · P1 leader` |
| 5 | In the billing group, partition 0 belongs to Billing Consumer 1, which reads it | Billing Consumer 1 |
| 6 | It writes the invoice in a way that's safe to repeat | Billing DB |
| 7 | It commits offset 48211: "next time, start after this event" | __consumer_offsets |
| 8 | The Analytics Consumer reads the same event later, with its own offsets | Analytics Consumer |

`murmur2` is the hash function Kafka's default partitioner uses; `%` keeps the remainder after dividing by the 3 partitions.

**What if Broker 1 crashes right after step 4?** The controller sees it's gone and makes Broker 2, which is in the ISR and has offset 48210, the new leader of partition 0. The event survives. With `acks=1` instead, Broker 1 would have confirmed before any follower had the event; if it crashed then, the new leader's log would end at 48209 and the order would be lost, even though the producer was told it succeeded.

## acks and min.insync.replicas

`acks` is a producer setting: how many copies must have the event before the producer hears "done".

| Setting | Confirmed when | Can lose a confirmed event? |
|---|---|---|
| `acks=0` | Never: the producer doesn't wait | Yes, and it never knows |
| `acks=1` | The leader has written it | Yes, if the leader dies before a follower copies it |
| `acks=all` (also `-1`) | Every in-sync copy has it | No, as long as `min.insync.replicas` ≥ 2 |

`min.insync.replicas` is a topic setting. With 3 copies and `min.insync.replicas=2`, one broker can be down and writes still succeed; if two are down, the leader refuses writes rather than keep the only copy. That's the usual setting for anything you can't lose. `acks=all` is the producer's default since Kafka 3.0.

This JavaScript producer (with the `kafkajs` library) asks for all copies and turns on the **idempotent producer**, which gives each batch a sequence number so a retried send can't write the event twice into the log:

```javascript
import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'order-service', brokers: ['kafka-1:9092', 'kafka-2:9092', 'kafka-3:9092'] })
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 })
await producer.connect()

export async function orderPaid(orderId, amountInr) {
  await producer.send({
    topic: 'orders',
    acks: -1, // acks=all: wait for the in-sync copies
    messages: [{ key: orderId, value: JSON.stringify({ order_id: orderId, amount_inr: amountInr }) }],
  })
}
```

`maxInFlightRequests: 5` lets up to 5 batches be on the way at once; with the idempotent producer, Kafka still keeps them in order.

## What "delivered" means

- **At most once**: commit the offset, then process. A crash after the commit skips the event for good.
- **At least once**: process, then commit. A crash between the two re-reads the event. Nothing is lost; some events arrive twice. **This is the normal choice.**
- **Exactly once**: within Kafka (read from one topic, write to another), transactions make the read, the write and the offset commit happen together or not at all. When the result goes to your own database, the practical way is at-least-once plus an idempotent write.

This consumer writes the invoice with a unique order ID, so a repeated event inserts nothing, and commits only after the write:

```javascript
await consumer.run({
  autoCommit: false, // commit only after the invoice is written
  eachMessage: async ({ topic, partition, message }) => {
    const event = JSON.parse(message.value.toString())
    await pool.query(
      'INSERT INTO invoices (order_id, amount_inr) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING',
      [event.order_id, event.amount_inr],
    )
    await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }])
  },
})
```

`ON CONFLICT (order_id) DO NOTHING` is Postgres for "if this order already has an invoice, skip it". The committed offset is the **next** one to read, hence `+ 1`.

## Poison events and dead letters

A **poison event** is one that fails every time: bad data, a missing field. Since one consumer reads a partition in order, retrying it forever blocks every event behind it. The fix: retry a few times, then write it to a **dead-letter topic** (here `orders.DLQ`, a dead-letter queue) with the error, commit, and move on. A person or a repair job looks at the dead letters later.

## Keeping events: time or compaction

- **Time-based retention** keeps everything for N days (7 by default, `retention.ms`), then deletes old log segments.
- **Log compaction** keeps only the **latest** event for each key, for ever. It suits "current state" topics such as a product's current price: a new reader can rebuild the latest state without reading years of history.

## The numbers, worked out

An example: 50k order events a second at peak, about 1 KB (kilobyte) each.

- **Writes**: 50k × 1 KB = **50 MB (megabytes) a second**; with 3 copies, 150 MB a second of disk writes across the cluster.
- **Storage for 7 days**: 7 × 86,400 s = 604,800 s. 50 MB × 604,800 ≈ **30 TB (terabytes) per copy**, about 90 TB for all 3.
- **Partitions**: if one consumer handles 5k events a second, one group needs 50k ÷ 5k = **10 partitions** to keep up at peak. Teams often choose 2 to 3 times that, because adding partitions later moves keys.

## What it costs and where it stops

- **`acks=all` is slower**: each write waits for a follower, adding a few milliseconds.
- **3 copies triple the disk**: 90 TB instead of 30 TB in the example.
- **Rebalances pause reading** when consumers join or leave; cooperative rebalancing and fixed member IDs (static membership) keep the pauses short.
- **Order is per partition only**, and changing the partition count moves keys.
- **Exactly-once ends at Kafka's edge**: once you write to another system, you need idempotent writes.
- **Operating it is real work**: managed services (Confluent Cloud, Amazon MSK (Managed Streaming for Apache Kafka)) take that on.

## How to choose

- **Events you must not lose** (payments, orders)? 3 copies, `min.insync.replicas=2`, `acks=all`, idempotent producer.
- **Events you can lose a few of** (click tracking, metrics)? `acks=1` for speed.
- **Writing results to your own database?** At-least-once plus idempotent writes.
- **Reading from Kafka and writing back to Kafka?** Kafka transactions give exactly-once.
- **Current state per key?** A compacted topic. **History?** Time-based retention.
- **Each job to one worker, no replay?** A plain queue (RabbitMQ, Amazon SQS (Simple Queue Service)) is simpler.

## ⚠️ Critical Mistakes

- **`acks=1` for payments.** A leader crash loses events the producer was told were saved.
- **`min.insync.replicas=1` with `acks=all`.** "All" can mean just the leader, so the guarantee is gone.
- **Committing before processing.** A crash skips events silently.
- **Handlers that aren't idempotent.** At-least-once delivery creates duplicate invoices.
- **Retrying a poison event for ever.** The whole partition stops. Use a dead-letter topic.
- **Not watching lag.** A group can fall hours behind without anyone noticing.

## Interview Q&As

**Q: How does Kafka avoid losing events when a broker dies?**

A: Each partition has copies on other brokers. With `acks=all` and `min.insync.replicas=2`, an event is confirmed only after at least two in-sync copies have it. When the leader dies, the controller makes an in-sync follower the leader, and that follower already has every confirmed event.

**Q: What does at-least-once mean, and how do you live with it?**

A: The consumer commits its offset only after processing, so a crash in between makes it read the same event again. You make the processing idempotent, for example with a unique key in the database, so the second time changes nothing.

**Q: Can Kafka give exactly-once?**

A: Inside Kafka, yes: the idempotent producer stops duplicate writes, and transactions commit the output and the consumer's offsets together. Once results go to an outside database, you rely on idempotent writes instead.

**Q: One event crashes the consumer every time. What happens, and what do you do?**

A: It blocks its partition, because events are read in order. Retry a few times, then send it to a dead-letter topic with the error, commit, and carry on.

## Related topics

- [Kafka Basics](/?topic=kafka-basics&read): topics, partitions, groups and offsets.
- [Kafka Reliability](/?topic=kafka-reliability&read): the guarantees in more depth.
- [Idempotent Payments](/?topic=payment-idempotency&read): making repeats harmless.
- [Leader Election](/?topic=leader-election&read): how a cluster picks a new leader.
- [Message Queue](/?topic=message-queue&read): when a plain queue is enough.

## Sources

- Apache Kafka: [Documentation: replication](https://kafka.apache.org/documentation/#replication) and [producer configs (acks, enable.idempotence)](https://kafka.apache.org/documentation/#producerconfigs) (Apache 2.0)
- Apache Kafka: [KIP-679: producer enables the strongest delivery guarantee by default](https://cwiki.apache.org/confluence/display/KAFKA/KIP-679%3A+Producer+will+enable+the+strongest+delivery+guarantee+by+default) (Kafka 3.0)
- Apache Kafka: [KRaft](https://kafka.apache.org/documentation/#kraft)
- KafkaJS: [Producing messages](https://kafka.js.org/docs/producing)

## Why This Matters

"How do you make sure a payment event is never lost and never charged twice?" is a standard follow-up whenever Kafka comes up. The answer needs exactly these parts: copies with `acks=all` and `min.insync.replicas=2`, leader election, commit after processing, idempotent handlers and dead letters. Knowing them lets you set Kafka up safely and explain what happens on the day a broker dies.
