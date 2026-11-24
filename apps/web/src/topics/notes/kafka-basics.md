# Kafka Basics: Topics, Partitions, Groups

> 💡 **TL;DR**: **Kafka** is a system that stores **events** (small records such as "order 4101 was paid") in a **log**: a list you only add to, kept for days whether or not anyone has read it. Events go into a **topic** (such as `orders`), which is split into **partitions** so several readers can work at once. Each event's **key** (the order ID) picks its partition, so all events for one order stay in order. Readers join a **consumer group**: the group shares the partitions, one reader per partition, and saves its place in each as an **offset**. Because reading doesn't delete anything, many groups can read the same events, and any group can go back and read them again.

## At a glance

| Term | What it means |
|---|---|
| Event | One record: a key, a value and a time, such as `order-4101 → {"type":"paid"}` |
| Topic | A named stream of events, such as `orders` |
| Partition | One of a topic's logs; a topic has one or more |
| Offset | An event's position in its partition: 0, 1, 2 and so on |
| Broker | A Kafka server; a topic's partitions are spread over several brokers |
| Producer | A program that sends events in; the key decides the partition |
| Consumer group | Readers that share a group name; each partition goes to one member |
| Committed offset | Where a group will carry on reading in each partition |
| Retention | How long events stay, read or not: 7 days by default |
| Lag | How many events a group still has to read: the health signal |

## What Kafka is, and why it exists

Picture a food-delivery app. When an order is paid, billing must make an invoice, analytics must count it, and email must send a receipt. Without Kafka, the Order Service calls each of them in turn. If email is slow, paying is slow; if billing is down, orders fail.

With Kafka, the Order Service writes one event, "order 4101 paid", to the `orders` topic and moves on. Billing, analytics and email each read it when they're ready. Adding a fourth reader needs no change to the Order Service.

The difference from an ordinary **message queue** (where a job is handed to one worker and then deleted) is that Kafka **keeps** events. Each reader just remembers how far it has read. That's what lets several teams read the same events, and lets you read old events again after fixing a bug.

## Follow twelve events all the way through

The Order Service sends 12 events for 4 orders. The topic has 3 partitions, and the billing group has 2 consumers. These partitions come from Kafka's real partitioner (the `murmur2` hash of the key, divided by 3, keeping the remainder):

| Key | Partition |
|---|---|
| order-4101 | 2 |
| order-4102 | 1 |
| order-4104 | 0 |
| order-4109 | 0 |

Each partition is a log. New events go at the end with the next offset:

| Partition | Its log (offset: event) |
|---|---|
| 0 | 0: 4104 placed, 1: 4109 placed, 2: 4104 paid, 3: 4109 paid, 4: 4104 delivered, 5: 4109 delivered |
| 1 | 0: 4102 placed, 1: 4102 paid, 2: 4102 delivered |
| 2 | 0: 4101 placed, 1: 4101 paid, 2: 4101 delivered |

Now the billing group reads them:

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Each event is sent with its order ID as the key | Order Service → Partitioner |
| 2 | The key's hash picks the partition; the event goes at the end of that log | Partition 0, Partition 1, Partition 2 |
| 3 | Kafka gives Consumer A partitions 0 and 1, and Consumer B partition 2 | Consumer A, Consumer B |
| 4 | Each consumer reads its partitions from the lowest offset up: 4104 is always placed, then paid, then delivered | Consumer A, Consumer B |
| 5 | Each writes invoices | Invoices DB |
| 6 | Each saves its place: partition 0 at offset 6, partition 1 at 3, partition 2 at 3 | Committed Offsets |
| 7 | The analytics team starts its own group; it reads all 12 events from offset 0, with its own offsets | Analytics Consumer |

Two things to notice. Order holds **within** a partition, not across them: Consumer B may finish order 4101 before Consumer A starts 4104, and that's fine because they're different orders. And partition 0 got half the events, because only 4 keys were hashed; with thousands of keys, partitions even out.

## Keys and partitions

Kafka picks a partition as `murmur2(key) % partitions`: `murmur2` is a fast hash function that turns the key into a big number, and `%` keeps the remainder after dividing by the number of partitions. The same key always gives the same number, so it always lands in the same partition.

This JavaScript producer sends events with a key, using the `kafkajs` library:

```javascript
import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'order-service', brokers: ['localhost:9092'] })
const producer = kafka.producer()
await producer.connect()

// Same key, same partition: this order's events stay in order.
export async function publish(orderId, type) {
  await producer.send({
    topic: 'orders',
    messages: [{ key: orderId, value: JSON.stringify({ orderId, type }) }],
  })
}
```

`brokers` lists the Kafka servers to connect to; `9092` is Kafka's usual port.

Choose as the key whatever must stay in order together: an order ID, a user ID. With no key, events are spread evenly, but with no order per key.

## Consumer groups: sharing the work

A **consumer group** is any set of consumers started with the same group name. Kafka hands each partition to exactly one member, so the group never processes an event twice (in normal running). This consumer joins the `billing` group:

```javascript
const consumer = kafka.consumer({ groupId: 'billing' })
await consumer.connect()
await consumer.subscribe({ topic: 'orders', fromBeginning: true })
await consumer.run({
  // The offset is committed after eachMessage returns, so a crash re-reads, never skips.
  eachMessage: async ({ partition, message }) => {
    const event = JSON.parse(message.value.toString())
    await upsertInvoice(event) // safe to repeat: keyed by order ID
  },
})
```

`fromBeginning: true` means a brand-new group starts at offset 0 instead of only reading new events. Start a second copy of this program and the group **rebalances**: the partitions are shared out again, and reading pauses for a moment while that happens.

The rule that follows: **a group can use at most as many consumers as the topic has partitions**. With 3 partitions and 4 consumers, one consumer gets nothing and sits idle.

## Offsets: stopping and carrying on

After processing, a consumer **commits** its offset: for each partition, the offset of the next event to read. Commits are stored in Kafka itself, in a built-in topic called `__consumer_offsets`. If a consumer restarts, it carries on from its last commit.

Committing **after** processing means a crash between the two re-reads the last few events. That's called **at-least-once** delivery: nothing is lost, but some events may arrive twice. So handlers must be **idempotent** (safe to repeat): "insert the invoice for order 4101 if it isn't there" rather than "add another invoice".

This command shows where a group is, and its lag:

```bash
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group billing
# TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# orders  0          1532            1540            8
```

`CURRENT-OFFSET` is the group's committed place, `LOG-END-OFFSET` is where the log ends, and `LAG` is the difference: 1540 − 1532 = 8 events still to read.

## Replay: reading history again

Say a bug charged the wrong tax on yesterday's invoices. Fix the code, stop the billing consumers, and move the group's offsets back:

```bash
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --group billing \
  --topic orders --reset-offsets --to-datetime 2026-11-12T00:00:00.000 --execute
```

When the consumers start again, they read everything since midnight on 12 November and rebuild the invoices. Nobody had to send the events again, because they were still in the log. This only works for events still inside the retention period (7 days by default), and only if writing invoices is idempotent.

## The numbers, worked out

- **Traffic**: 120 events a second at dinner time; one billing consumer can process 50 a second.
- **Consumers needed**: 120 ÷ 50 = 2.4, so 3, which means the topic needs **at least 3 partitions**.
- **3 partitions, 2 consumers**: each partition gets 120 ÷ 3 = 40 a second. Consumer A owns 2 partitions, so 80 a second against its 50: it falls behind by 30 a second, which is **18k events** after 10 minutes (30 × 600 s).
- **1 partition**: only one consumer can work, whatever you start. It falls behind by 120 − 50 = 70 a second: **42k events** in 10 minutes.
- **3 partitions, 3 consumers**: 40 a second each, under 50, so the group keeps up.
- **Storage**: 120 events a second × 1 KB (kilobyte) × 86,400 seconds ≈ 10 GB (gigabytes) a day; 7 days ≈ 70 GB per copy.

## What it costs and where it stops

- **Order is per partition only.** There is no order across a whole topic with more than one partition.
- **Partitions cap parallel work.** You can't use more consumers in a group than partitions.
- **Adding partitions later moves keys**: `murmur2(key) % 4` differs from `% 3`, so an order's new events may land in a different partition from its old ones, and order breaks for a while.
- **Hot keys**: one very busy key puts all its events in one partition, read by one consumer.
- **Duplicates are normal**: at-least-once delivery means handlers must be idempotent.
- **Running Kafka is work**: brokers, disks and upgrades. Managed services (Confluent Cloud, Amazon MSK (Managed Streaming for Apache Kafka)) do it for you, at a price.

## How to choose

- **Each job should go to one worker and then be gone** (send this email, resize this image)? A plain message queue such as RabbitMQ or Amazon SQS (Simple Queue Service) is simpler.
- **Several systems need the same events**, events must stay **in order per key**, or you may need to **replay**? Kafka.
- **Picking the key**: whatever must stay in order together.
- **Picking the partition count**: at least the most consumers you expect in one group, with room to grow, because changing it later breaks key order.
- **One group per separate use**: billing, analytics and search each get their own group and their own offsets.

## ⚠️ Critical Mistakes

- **More consumers than partitions.** The extra consumers sit idle. Add partitions first.
- **No key on events that must stay in order.** Events of one order spread across partitions and arrive out of order.
- **Committing before processing.** A crash then skips events for good. Commit after.
- **Handlers that aren't idempotent.** A restart re-reads events and creates duplicate invoices.
- **Adding partitions to a busy keyed topic without a plan.** Keys move, and order breaks during the change.
- **Ignoring lag.** A group can fall hours behind quietly. Alert when lag keeps growing.

## Interview Q&As

**Q: How is Kafka different from a message queue?**

A: A queue hands each message to one worker and deletes it. Kafka keeps events in a log for a set time; each consumer group reads everything and tracks its own offsets, so many groups can read the same events and replay them.

**Q: How does Kafka keep events in order?**

A: Only within a partition. Events with the same key go to the same partition, and one consumer per group reads that partition in offset order, so all events for one key are handled in order.

**Q: Why can't a group use more consumers than partitions?**

A: Each partition is given to exactly one consumer in a group, to keep its order. With 3 partitions, at most 3 consumers get work; a fourth sits idle.

**Q: Your consumer lag keeps growing. What do you do?**

A: Check whether processing got slower (a slow database, a poison message). If the group is simply short of capacity, add consumers up to the number of partitions; beyond that, add partitions or make each event cheaper to process.

## Related topics

- [Kafka: Event Streaming](/?topic=kafka&read): brokers, copies, acks and leader election.
- [Kafka Reliability](/?topic=kafka-reliability&read): never losing or doubling an event.
- [Message Queue](/?topic=message-queue&read): queues versus logs.
- [Idempotent Payments](/?topic=payment-idempotency&read): making a repeated event harmless.

## Sources

- Apache Kafka: [Introduction](https://kafka.apache.org/intro) and [Documentation: consumers and offsets](https://kafka.apache.org/documentation/#intro_consumers) (Apache 2.0)
- Apache Kafka: [Topic configuration: retention.ms](https://kafka.apache.org/documentation/#topicconfigs_retention.ms) (7 days by default)
- KafkaJS: [Consuming messages](https://kafka.js.org/docs/consuming)

## Why This Matters

Kafka sits behind order pipelines, activity feeds, metrics and change data streams in most large companies, and interviewers ask about it constantly. Knowing that the key picks the partition, that order holds only within a partition, that partitions cap a group's consumers, and that offsets make replay possible lets you design with it, and explain lag and duplicates when they happen.
