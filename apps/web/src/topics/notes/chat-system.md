# Chat System (WhatsApp-style)

> 💡 **TL;DR**: In a chat app, each phone keeps one **WebSocket** open to a **gateway** server: a connection that stays open, so the server can push a message the moment it exists. When you send a message, the **Chat Service** gives it an ID, **stores it first**, then delivers it: it looks up which gateway holds the recipient's connection in a **session registry** and sends it there through a queue. If the recipient is offline, they get a push notification and, when the app opens, it **syncs** everything after its last message ID. Delivery is **at least once**, so apps drop duplicates by message ID. Groups cost one delivery per member, so they have a size limit.

## At a glance

| Question | Answer |
|---|---|
| Connection | One WebSocket per phone, to a gateway that holds about 50k of them |
| First thing done with a message | Stored in the Message Store, before any delivery |
| Finding the recipient | The Session Registry (Redis): user → gateway |
| Online recipient | Through the queue to their gateway, then down their socket |
| Offline recipient | A push notification with no text, then sync from the last message ID |
| Order | By message ID within one conversation; no global order |
| Guarantee | At least once; apps drop a message ID they already have |
| Groups | Stored once, delivered once per member; size is capped |
| Presence ("online") | From heartbeats with a time limit; may be a little stale |
| Scale in the example | 20 billion messages a day, 100 million open connections, 2k gateways |

## What a chat system needs, and what a WebSocket is

A chat app must deliver a message within about a second when both people are online, keep it safe if they aren't, show it on every device, and keep each conversation in order. Ordinary web requests are a poor fit: the phone would have to ask "anything new?" every few seconds (**polling**), wasting requests and adding delay.

A **WebSocket** is a connection that starts as a normal HTTP request, then stays open in both directions. The server can push a message down it the instant it arrives. Each phone keeps one open to a **WebSocket Gateway**, a server whose only job is holding connections.

Holding connections makes a gateway **stateful**: a message for Priya can only go out through the one gateway holding Priya's connection. The design is mostly about finding that gateway.

## Follow one message all the way through

Asha sends "On my way" to Priya at 18:30. Both are online; Asha is on gateway-0091, Priya on gateway-0412.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Asha's app sends the message with its own client ID (so a resend can be spotted) | Sender App → WebSocket Gateway |
| 2 | The gateway passes it to the Chat Service, which gives it a time-sortable message ID | Chat Service |
| 3 | It's written to the Message Store **before** anything else | Message Store (Cassandra) |
| 4 | Asha's app gets an ack: one tick, "saved" | Chat Service → WebSocket Gateway → Sender App |
| 5 | The Chat Service asks Redis where Priya is: `GET session:priya` → `gateway-0412` | Session Registry (Redis) |
| 6 | It puts the message on gateway-0412's queue | Message Queue |
| 7 | gateway-0412 writes it down Priya's socket | WebSocket Gateway → Recipient App |
| 8 | Priya's app confirms; Asha sees two ticks, "delivered" | Recipient App → … → Sender App |
| 9 | If Priya had been offline: a push with no message text wakes her phone | Push Notification Service |
| 10 | When her app opens, it asks for every message after its last ID | Recipient App → Message Store (Cassandra) |

## Store first, then deliver

The Chat Service writes the message to the store before it tries to deliver it. That makes the store the **source of truth**: if a gateway crashes mid-delivery, or Priya's phone loses signal, nothing is lost. Delivery is just a side effect that can be retried, and the sync in step 10 catches anything that didn't arrive.

The other order (deliver, then store) loses the message if the server crashes in between.

## Finding the recipient's gateway

Gateways only hold connections; they don't know about each other. When a phone connects, its gateway writes an entry in the **Session Registry**, a Redis store mapping each online user to their gateway, with a short time limit renewed by heartbeats.

```text
SET session:priya gateway-0412 EX 60     (renewed every 30 s while connected)
GET session:priya                        → "gateway-0412"
```

The Chat Service reads it and puts the message on that gateway's queue. If there's no entry, Priya is offline: send a push instead.

Each gateway reads its own queue. The queue buffers bursts and means the Chat Service never waits for a slow gateway.

## Offline users: push, then sync

For offline users, the **Push Notification Service** sends a push through APNs (Apple Push Notification service) or FCM (Firebase Cloud Messaging). The push carries no message text, just "you have new messages". That keeps private text out of Apple's and Google's systems, and the real content always comes from your store.

When the app opens, it reconnects and asks: "everything after message ID 7184…". Message IDs sort by time, so "after" is a simple range read in the store.

## Duplicates and order

- **Duplicates**: the network can fail after the server stored a message but before the sender heard back, so the app resends. Each message carries a **client message ID**; the server spots the repeat. Delivery can also repeat after a reconnect, so receiving apps drop any message ID they already have. This is **at least once** delivery with de-duplication; exactly once isn't possible over a network.
- **Order**: messages are ordered by their time-sortable ID **within one conversation**. Nobody needs a single order across all of WhatsApp, which would be impossibly slow.

## How messages are stored

The store is **Cassandra**, a database built for very many writes, spread over many servers. Messages are grouped by `(conversation_id, bucket)`, where a bucket is a time period such as a month:

```sql
CREATE TABLE messages (
  conversation_id text,
  bucket          text,      -- '2026-11': one month of one chat
  message_id      bigint,    -- time-sortable, so newest first is a simple read
  sender_id       text,
  body            text,
  PRIMARY KEY ((conversation_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

`(conversation_id, bucket)` is the **partition key**: one month of one conversation lives together, so opening a chat reads one place. The bucket stops a very busy chat from growing one partition for ever. Within it, messages are kept newest first.

## Groups and presence

- **Groups**: a message to a 200-member group is stored once and delivered 200 times. The **Group Service** gives the member list (cached, since it's read on every message). Groups have a size cap so one message can't flood the system.
- **Presence** ("online", "last seen") comes from gateway heartbeats with a short time limit. It's **soft state**: if it's a few seconds stale, nobody minds. Never make message delivery wait on presence, and don't broadcast every status change to every contact.

## The numbers, worked out

Assumptions: 500 million daily users, 40 messages each a day, about 100 bytes a message, 20% online at once, 50k connections per gateway.

- **Messages**: 500 million × 40 = **20 billion a day**. ÷ 86,400 s ≈ **231k a second**; about 700k a second at a 3× peak.
- **Storage**: 20 billion × 100 bytes = **2 TB a day**, about 2.2 PB over three years, before copies.
- **Connections**: 20% of 500 million = **100 million** open at once. ÷ 50k per gateway = **2k gateways**.

Writes dominate and are only ever appended, which is exactly what Cassandra is good at.

## What it costs and where it stops

- **A gateway dies**: its 50k phones reconnect elsewhere, re-register and sync from their last message ID. They must wait a random time first, or 50k reconnects land in the same second.
- **Read receipts in big groups** cost a message per member per read; many apps limit them in large groups.
- **Several devices per user**: the registry must hold all of a user's connections, and each device syncs on its own.
- **End-to-end encryption** means the server only stores and forwards scrambled bytes; it can't read, search or filter messages.

## How to choose

- **Real-time two-way messages?** WebSockets to stateless-ish gateways, a session registry, store-then-deliver.
- **Updates only from server to user** (scores, prices)? Server-sent events or plain push may be enough.
- **Very write-heavy, append-only history?** A wide-column store like Cassandra, partitioned by conversation and time.
- **Huge broadcast channels** (100k members)? Treat them like a feed: readers fetch, instead of pushing to everyone.

## ⚠️ Critical Mistakes

- **Delivering before storing.** A crash loses the message. Store first.
- **Keeping who-is-where only in gateway memory.** Other servers can't find the recipient. Use a shared session registry.
- **Putting message text in push notifications.** Private content goes through Apple's and Google's servers. Send a wake-up only.
- **No client message ID.** Every network retry becomes a duplicate message.
- **One partition per conversation for ever.** A busy chat grows one partition without limit. Add a time bucket.
- **Blocking delivery on presence.** Presence is soft; messages must not wait for it.

## Interview Q&As

**Q: How does a message reach a user connected to a different server?**

A: A session registry in Redis maps each online user to their gateway. The Chat Service looks the user up and puts the message on that gateway's queue; the gateway writes it down the user's socket. No entry means offline, so a push is sent.

**Q: Why store the message before delivering it?**

A: So the store is the source of truth. If delivery fails at any point, the message is still safe, and the recipient's next sync picks it up. Delivering first loses messages when a server crashes in between.

**Q: How do you keep messages in order?**

A: Order only within a conversation, by a time-sortable message ID. Apps sort by ID and drop IDs they already have. No global order is needed.

**Q: What happens when a gateway with 50k connections dies?**

A: Its phones notice the dropped connection and reconnect to other gateways after a random wait, re-register in the session registry, and sync everything after their last message ID. Nothing is lost because messages were stored first.

**Q: How would you support a phone and a laptop on one account?**

A: Register every connection of a user, deliver to each, and let each device sync from its own last message ID. Read state is synced as its own small event.

## Related topics

- [Scaling WebSockets vs HTTP](/?topic=websocket-scaling&read): connections, heartbeats and reconnect storms in depth.
- [Notification System](/?topic=notification-system&read): the push path for offline users.
- [Unique ID Generator (Snowflake)](/?topic=unique-id-generator&read): time-sortable message IDs.
- [Message Queue](/?topic=message-queue&read): how the per-gateway queues behave.
- [Redis Basics](/?topic=redis-basics&read): keys with time limits for the session registry.

## Sources

- IETF: [RFC 6455, The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- Apache Cassandra: [Data modeling](https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html)
- Discord Engineering: [How Discord stores trillions of messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) (2023)

## Why This Matters

"Design WhatsApp" is one of the most common system design questions. It tests long-lived connections, routing to the right server, durability, ordering, offline users and huge write volumes, all at once. Store-then-deliver, a session registry, message IDs for order and de-duplication, and sync on reconnect are the answers interviewers look for.
