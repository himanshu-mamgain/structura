# Notification System

> 💡 **TL;DR**: A **notification system** turns events from other services ("your order shipped") into messages on the right **channel**: a phone push, an email or an SMS (a text message). It must do three things at once: never lose an important message, never send the same one twice, and never annoy people. The design: accept each event fast and **deduplicate** it with an idempotency key, check the user's **preferences** in one place, put the message on a **queue per channel and priority**, and let **workers** send it through providers like Google's and Apple's push services, **retrying** with growing waits and parking failures in a **dead letter queue** instead of losing them.

## At a glance

| Question | Answer |
|---|---|
| What goes in | An event: user 1081's order 5521 shipped |
| What comes out | A push, an email or an SMS, worded for that channel and language |
| Duplicates | Stopped by an idempotency key, remembered for 24 hours |
| Preferences | Checked on the server, in one place: opt-outs, channels, quiet hours |
| Queues | One per channel and priority: login codes never wait behind marketing |
| Who sends | Push and email workers, calling the providers |
| Failures | Retried after 2, 4, 8, 16, 32 seconds (plus jitter), then a dead letter queue |
| Guarantee | At least once: rarely twice, never silently lost |
| Load in the example | 100 million a day: about 1,157 a second, 11.6k at peak |
| Record | Every attempt in a log table, to answer "why didn't I get it?" |

## What a notification system is, and the words it uses

Many parts of an app have something to tell users: orders, payments, chats, marketing. If each part called Google's push service and an email provider on its own, every team would rewrite the same retries and templates, and one team would forget that a user unsubscribed. A **notification system** is one shared service that does it properly for everyone.

- A **channel** is a way to reach someone: push (a pop-up on the phone), email, or SMS.
- **FCM** (Firebase Cloud Messaging) is Google's push service for Android; **APNs** (Apple Push Notification service) is Apple's. Each phone keeps a connection open to one of them, and you send pushes through them using a **device token**, the phone's push address.
- **SES** (Simple Email Service) is Amazon's email sending service; any email provider works the same way here.
- An **idempotency key** is a unique id for one event, so a repeat of the same event can be spotted and dropped.

## Follow one notification all the way through

On 25 November at 14:02, the Orders service tells user 1081 that order 5521 has shipped.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Orders sends the event with key `order-5521-shipped` | Upstream Service (Orders) → Notification API |
| 2 | The API claims the key in Redis: `SET dedup:order-5521-shipped 1 NX EX 86400` succeeds, so it's new | Dedup Store (Redis) |
| 3 | User 1081 wants order updates by push and email; it isn't quiet hours | Preference Service → Preferences DB |
| 4 | The push text and the email are filled in from templates, in Hindi, the user's language | Template Service |
| 5 | Two rows are logged as `QUEUED`, the messages go on the push and email queues, and Orders gets `202 Accepted` | Notification Log DB, Channel Queues (Kafka) |
| 6 | The push worker takes the message, looks up the user's device token and calls FCM | Push Worker → FCM / APNs |
| 7 | FCM delivers it to the phone; the log row becomes `SENT` | User Device, Notification Log DB |
| 8 | The email worker calls the email provider, which times out | Email Worker → Email Provider (SES) |
| 9 | The email waits in the retry queue for 2 seconds, then 4, and goes through on the third try | Retry Queue (delayed) |
| 10 | Orders retries the same event 3 seconds later (it didn't see the 202); the key is taken, so it's dropped | Dedup Store (Redis) |

`202 Accepted` means "received, will be done later". Orders doesn't wait for the push to arrive.

## Duplicates: the idempotency key

Upstream services retry when they don't hear back, so the same event can arrive twice. Without a check, the user gets two "your order shipped" pushes.

```text
SET dedup:order-5521-shipped 1 NX EX 86400
```

`NX` means "only set it if it doesn't exist yet"; `EX 86400` keeps it for 86,400 seconds, 24 hours. The first claim succeeds; any repeat within a day fails, and the API drops that event. A unique `dedup_key` column on the log table is a second guard if Redis is down.

## Preferences: checked in one place

The **Preference Service** decides whether and when someone may be contacted: which channels they turned off, whether they allowed marketing, and their **quiet hours** (say 22:00 to 08:00 in their own time zone).

Checking on the server, in one place, means no team can forget an unsubscribe. Urgent messages, like a login code or a payment alert, ignore quiet hours; marketing waits until morning.

## One queue per channel and priority

Messages go onto **Kafka** topics (Kafka is a durable log that many workers can read from): one per channel, each with a high and a low priority.

- If the email provider is slow, only email backs up; pushes keep flowing.
- A marketing campaign to 5 million users sits in the low-priority queue, so a login code in the high-priority queue still goes out in seconds.
- The queue absorbs spikes: if 11.6k messages a second arrive, workers drain them at their own pace and providers aren't flooded.

Big campaigns are expanded by a batch job and fed in at a limited rate, never all at once.

## Retries, jitter and the dead letter queue

A send can fail for a moment: a timeout, a provider limit. The worker puts the message in a **delayed retry queue** and tries again after 2, 4, 8, 16, then 32 seconds. That's **exponential backoff**: each wait doubles, giving a failing provider time to recover. In total it waits 2 + 4 + 8 + 16 + 32 = 62 seconds.

```javascript
const delays = [2, 4, 8, 16, 32] // seconds, before tries 2 to 6
function nextDelay(attempt) {
  const base = delays[attempt - 1]
  return base / 2 + Math.random() * base // random between half and 1.5 times the base
}
```

The random part is **jitter**. Without it, 10k messages that failed in the same second would all retry in the same second, and hit the provider together again.

After the last try, the message goes to the **dead letter queue**: a holding area for messages that couldn't be sent. An alert fires, and someone can fix the cause and replay them. Nothing is silently lost.

**Bad tokens**: when FCM says a device token is invalid (the app was uninstalled), delete it. Otherwise you keep paying to send to a dead phone.

## The numbers, worked out

An example: 20 million daily users, 5 notifications each.

- **Per day**: 20 million × 5 = **100 million** notifications.
- **Average**: 100 million ÷ 86,400 seconds ≈ **1,157 a second**.
- **Peak**: campaigns and sales bring about 10 times the average: about **11.6k a second**.
- **By channel** (60% push, 35% email, 5% SMS): 60 million, 35 million and 5 million a day.
- **Queue traffic** at peak: 11.6k × 1 KB ≈ 11.6 MB a second.
- **Log**: 100 million rows × about 500 bytes = **50 GB a day**, 1.5 TB for 30 days.
- **Workers**: if one sends 500 a second, the peak needs 11.6k ÷ 500 ≈ **24**; run about 30 for headroom.

## What it costs and where it stops

- **At least once, not exactly once.** A worker can send and crash before recording it, so a retry sends again. Exactly-once isn't possible across a third party like FCM; dedup keys keep duplicates rare.
- **Delivery is best effort.** A phone can be off for days, and push services drop old messages. For something that must be seen (a payment alert), also show it in the app and consider SMS.
- **Providers cost money**, SMS most of all. Rate-limit per user (for example, at most 3 marketing messages a day).
- **If Redis is down**, it's better to risk a rare duplicate than to drop a login code.

## How to choose

- **Urgent and short** (login code, payment alert)? Push or SMS, high-priority queue, ignore quiet hours.
- **Long or needs a record** (receipt, statement)? Email.
- **Marketing?** Low-priority queue, respect consent and quiet hours, throttle campaigns.
- **Must be seen?** Several channels plus an in-app inbox.
- **Small app?** A managed service may be enough; build this when many teams and channels share it.

## ⚠️ Critical Mistakes

- **Sending directly from the request.** A slow provider slows the order page. Queue it and answer `202`.
- **One queue for everything.** A marketing blast delays login codes. Separate by channel and priority.
- **Retrying instantly, all together.** A retry storm hits the provider. Back off and add jitter.
- **Dropping messages after the last retry.** Use a dead letter queue and alert on it.
- **Letting each team check preferences.** One team forgets, and a user who unsubscribed gets spammed. Check in one place.
- **Keeping dead device tokens.** You pay to send to uninstalled apps.

## Interview Q&As

**Q: How do you make sure a user never gets the same notification twice?**

A: Each event carries an idempotency key; the API claims it in Redis with `SET … NX` and drops any repeat for 24 hours, with a unique key in the log table as a backup. Workers can still send twice if they crash after sending, so delivery is at least once; this keeps duplicates rare, not impossible.

**Q: A campaign goes to 5 million users at 9 a.m. How do you avoid delaying login codes?**

A: Campaigns go on a separate low-priority queue, fed in at a throttled rate by a batch job. Login codes use the high-priority queue and their own workers, so they never wait behind the campaign.

**Q: The email provider is down for 10 minutes. What happens?**

A: Email workers fail and retry with backoff; messages wait in the queue. Push and SMS aren't affected, because they have their own queues. After the retries run out, messages go to the dead letter queue for replay. If allowed, fail over to a second provider.

**Q: How would you let a user say "no marketing at night" and enforce it everywhere?**

A: Store quiet hours and time zone in the Preferences DB, and check them in the Preference Service, the one place every message passes through. Marketing in quiet hours is scheduled for the morning; urgent messages pass.

## Related topics

- [Message Queue](/?topic=message-queue&read): acknowledgements, retries and dead letters in depth.
- [Retries: Backoff and Jitter](/?topic=retry-backoff&read): why waits double and why jitter matters.
- [Kafka Basics](/?topic=kafka-basics&read): topics, partitions and consumer groups.
- [Idempotent Payments](/?topic=payment-idempotency&read): the same idempotency-key idea for money.
- [Chat System](/?topic=chat-system&read): push for users who are offline.

## Sources

- Firebase: [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging)
- Apple: [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- Amazon SES: [What is Amazon SES?](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html)
- Redis: [SET command (NX and EX options)](https://redis.io/docs/latest/commands/set/)

## Why This Matters

"Design a notification system" is a common interview question, and notifications appear inside almost every other design. It tests whether you think about failure: duplicates from retries, a slow provider, a campaign that drowns urgent messages, and messages that can't be sent. Queues per priority, idempotency keys, backoff with jitter and a dead letter queue answer each of those.
