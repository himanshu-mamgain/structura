# Ad Click Aggregator

> 💡 **TL;DR**: An **ad click aggregator** counts every click on every ad and tells each advertiser how many they got. It exists because advertisers pay per click, so the count is money. At a billion clicks a day you can't update one database row per click, so you **log every click first** (in an append-only stream and in cheap storage), **count in one-minute windows** on a stream, **skip duplicates** with a unique `click_id`, and **recount exactly every night** from the saved log. The live number is fast and nearly right. The nightly number is slow and exact, and it is the one that becomes the bill.

## At a glance

The example is one ad with 200 real clicks a minute. The advertiser pays $0.50 a click, so one minute should cost $100.

| Problem | What goes wrong | What fixes it | What it costs |
|---|---|---|---|
| Too many clicks for one database row | The database can't take thousands of writes a second to the same row | Write clicks to a stream, then add them up in memory and save one row a minute | The count shows up up to a minute later |
| A phone sends the click twice (a retry) | The advertiser pays $0.50 for a click that happened once | A unique `click_id` on every click, and a "seen it" check | About 1.7 GB of memory for the "seen" list |
| A slow phone's click arrives 90 s late | It lands in the wrong minute, or is dropped | Count by when the click happened, and wait a little before closing each minute | A longer wait means the final number is later |
| The counter crashes halfway | Some clicks are lost or counted twice | Save counts as overwrites, and keep every raw click | Extra storage for the raw log |
| Bots and made-up links | The advertiser pays for fake clicks | Sign every click link, drop known bots | Some real work to keep the rules fresh |

## What an ad click aggregator is

An **ad network** shows ads on many websites and apps. An **advertiser** is a company that pays for those ads. A common price model is **cost per click** (CPC): the advertiser pays a fixed amount, here $0.50, each time a viewer clicks.

So the network has one job it can't get wrong: **count the clicks**. Count too few and the network loses money. Count too many and it overcharges a customer, who stops trusting the numbers.

An **aggregator** is the part that turns millions of single events ("viewer 7 clicked ad 77 at 10:00:03") into a few totals ("ad 77 got 200 clicks between 10:00 and 10:01"). The advertiser sees the totals on a dashboard.

Without one, you'd store a row per click and run `COUNT(*)` every time someone opens the dashboard. That works for 1,000 clicks. At a billion a day (11,574 a second on average) it is far too slow.

## The numbers

| Quantity | Working | Result | What it means |
|---|---|---|---|
| Average rate | 1,000,000,000 clicks ÷ 86,400 seconds in a day | 11,574 clicks a second | The steady load |
| Peak rate | 11,574 × 5 (a busy hour is about 5 times the average; this is an assumption) | about 57,870 a second | The load the system must survive |
| Raw data a day | 1,000,000,000 × 200 bytes an event | 200 GB | Goes to cheap object storage |
| Raw data a year | 200 GB × 365 | 73 TB | Why you use object storage and not a database |
| Kafka partitions | 57,870 ÷ 10,000 events a second for one partition (a rough figure) = 5.8, round up to 6, then double for room | 12 partitions | A **partition** is one ordered slice of the stream. More partitions mean more readers in parallel |
| "Seen" list in Redis | 57,870 a second × 600 seconds (we remember each id for 10 minutes) | 34.7 million ids | About 1.7 GB at 50 bytes each |
| Minute rows a day | At most one row per click, 1,000,000,000 × 40 bytes | at most 40 GB | In practice far fewer, because many clicks share one row |

## How it works underneath

**1. The click link.** The ad is not linked straight to the advertiser. It is linked to the network's own **click redirect service** and carries three things: the ad id, a fresh `click_id` (a random unique id made when the ad was shown) and a signature. The service checks the signature, then answers with an **HTTP 302 redirect** (a reply that says "go to this other address") so the viewer lands on the advertiser's page without waiting.

**2. The log.** In the same moment the service publishes one **click event** to **Kafka**, a distributed log: an append-only list that many programs can read, each at its own pace. The event holds `click_id`, `ad_id` and the **event time**, the moment the viewer tapped. The service does no counting, so it stays fast. A second reader copies every event unchanged into **S3** (Simple Storage Service, Amazon's object storage), the permanent archive.

**3. Windows and event time.** The **stream aggregator** reads the log and counts clicks in **tumbling windows**: fixed, non-overlapping blocks of time, here one minute each (10:00:00 to 10:00:59, then 10:01:00 to 10:01:59, and so on). A click goes into the window that holds its **event time**, not the time it reached the aggregator. If it used arrival time, every slow phone would put its click in the wrong minute.

**4. Late events.** Some clicks arrive late: a phone in a tunnel sends its click 90 seconds after the tap. The aggregator can't know whether a window is complete, so it uses a rule: close each window at its end plus a **wait**. A click that arrives after the window closed is **too late** for the live count. Stream tools call this clock a **watermark**: "I believe nothing older than this will still arrive."

**5. Duplicates.** A phone that gets no reply may send the click again. Kafka can also deliver one message twice after a crash. Before counting, the aggregator asks **Redis** (an in-memory key-value store): "have I seen this `click_id`?" The first time, Redis says no and remembers the id. The retry finds it and is skipped.

**6. The store.** Closed windows are written to an **OLAP** store (online analytical processing: a database built to add up billions of rows quickly, such as ClickHouse, Druid or Pinot), as one row per ad per minute. The dashboard sums those rows.

**7. The nightly fix.** The **reconciliation job** is a batch job: it reads the whole day from S3 with no deadline, counts each `click_id` once, and overwrites the minute rows with exact numbers. Putting a fast approximate path next to a slow exact one is called a **lambda architecture**.

## One click, followed all the way

One ad, three minutes, 600 real clicks (one every 0.3 s, so 200 a minute). The right bill is 600 × $0.50 = $300. The simulator in Structura uses these numbers. By default, 10% of clicks arrive 90 s late, 8% are sent twice, deduplication is off, and each window waits 30 s.

| Step | What happens | Number |
|---|---|---|
| Real clicks | One per 300 ms for 180 s | 600 |
| Retried copies | 8% of clicks are sent a second time, 2 s later | 45 extra events |
| Events on the stream | 600 + 45 | 645 |
| Late clicks | 10% of the 600 arrive 90 s late | 62 |
| Window closes | End of minute + 30 s wait | e.g. minute 1 closes at 90 s |
| Counted | Late clicks that arrived after the close are left out, copies are counted twice | 192 + 194 + 193 = 579 |
| Live bill | 579 × $0.50 | $289.50 |
| Error | 579 − 600 = −21 clicks | $10.50 too low |
| After the nightly job | Recounts all 645 events, each `click_id` once | 600, $300.00 |

Now turn deduplication on and widen the wait to 2 minutes: every window counts exactly 200. Both fixes were needed. Dedupe alone removes the extras but still loses the late clicks. A longer wait alone catches the late clicks but counts the copies twice.

## What it costs, and where it stops

- **Delay or accuracy.** A longer wait for late clicks is more exact but later. Show a live number early and mark it "not final".
- **Memory for dedupe.** The "seen" list must outlive the longest retry and the wait. Longer is safer but costs more memory.
- **Duplicates beyond the list.** If a click is retried after the id expired, it is counted twice. The nightly job catches it, because it counts distinct ids over the whole day.
- **Hot ads.** If Kafka puts all clicks for one ad on one partition, a viral ad overloads it. Add a random suffix to the key (`ad_77#0` to `ad_77#7`) and add the eight partial counts when you read.
- **One more system.** Two paths (stream and batch) mean two codebases that must agree. Test that they produce the same numbers on the same day.
- **It does not stop fraud alone.** Signed links stop invented clicks, but a real bot that really clicks needs separate detection.

## What goes wrong

- Clicks counted by arrival time: during a network slowdown, one minute shows a spike and the next a dip.
- A crash replays events and the counter adds them again, because writes were increments rather than overwrites.
- The "seen" list expires before a retry arrives.
- The bill is made from the live number and never reconciled.
- Raw events are deleted after counting, so a bug in the counter can never be repaired.

## How to choose

| Situation | Choose |
|---|---|
| Advertisers need totals within a minute, and you also bill them | Both paths: stream for live, nightly batch for billing |
| Only a rough dashboard, no billing | The stream path alone, with a short wait |
| Billing only, a day's delay is fine | The batch path alone: simpler and exact |
| A few thousand clicks a day | One Postgres table with an index on `(ad_id, clicked_at)`. No stream needed |
| One very popular ad | Split its key with a random suffix and add the parts |

## Code

First, the window counter. It puts a click in a minute by event time and refuses clicks that are too late. `WAIT_MS` is how long a window stays open after it ends.

```javascript
const WINDOW_MS = 60_000
const WAIT_MS = 30_000
const windows = new Map() // 'adId:windowStart' -> count

export function onClick({ adId, clickedAt }, now = Date.now()) {
  const start = Math.floor(clickedAt / WINDOW_MS) * WINDOW_MS
  if (now > start + WINDOW_MS + WAIT_MS) return 'too late'
  const key = adId + ':' + start
  windows.set(key, (windows.get(key) ?? 0) + 1)
  return 'counted'
}
```

`Math.floor(clickedAt / 60000) * 60000` rounds a time down to the start of its minute. A click at 10:00:59.9 and one at 10:00:00.1 share a window.

Next, the duplicate check. `SET … NX` succeeds only if the key doesn't exist yet, so exactly one caller wins. `EX 600` makes the key disappear after 600 seconds (10 minutes).

```javascript
export async function isFirstTime(clickId) {
  const reply = await redis.set('seen:' + clickId, '1', { NX: true, EX: 600 })
  return reply === 'OK'
}
```

Last, the signature. `createHmac` makes an **HMAC** (hash-based message authentication code): a short code that only someone with the secret can produce. Without the secret, nobody can build a valid link.

```javascript
import { createHmac } from 'node:crypto'
const sign = (adId, clickId) =>
  createHmac('sha256', process.env.CLICK_SECRET).update(adId + '.' + clickId).digest('hex')
```

## ⚠️ Critical Mistakes

- **Counting by arrival time.** A slow network moves clicks into the wrong minute. Always carry the event time.
- **Increment-only counters.** `clicks = clicks + 1` run twice after a replay gives a wrong total. Write whole minute rows as overwrites, so a replay writes the same value again.
- **No `click_id`.** Without a unique id you can't tell a retry from a second real click.
- **Deleting raw events.** The archive is what lets you fix a counting bug. Keep it.
- **Billing from the live number.** The live number is allowed to be a little wrong. Bill from the reconciled one.
- **Trusting the client.** Anyone can call an unsigned link in a loop. Sign it, and limit clicks per user in a minute.

## Interview Q&As

**Q: Why count by event time and not arrival time?**

A: Arrival time depends on the network, so the same click lands in different minutes on different days. Event time is the moment the viewer tapped, so the count means the same thing every time, even if you replay the log.

**Q: A phone retries a click. How do you avoid charging twice?**

A: Give each click a unique `click_id` when the ad is shown. The aggregator runs `SET seen:<id> 1 NX EX 600` in Redis. Only the first call succeeds, so the retry is skipped. The nightly batch also counts distinct ids, so it catches any copy that slipped past an expired entry.

**Q: Why run a nightly batch if the stream already counts?**

A: The stream makes trade-offs to be fast: it closes windows after a short wait and relies on a memory-limited "seen" list. The batch has no deadline and sees the full day, so it can be exact. You get a live number and a correct bill.

**Q: One ad gets 100 times more clicks than the rest. What breaks?**

A: If Kafka keys by `ad_id`, all its clicks go to one partition, which becomes the bottleneck. Add a random suffix to the key to spread them over several partitions, count each part, and add the parts when you read.

**Q: How do you stop fake clicks?**

A: Sign each click link with an HMAC so links can't be invented. Drop clicks from known bot addresses, and flag any user who clicks many times in a minute. Keep the flag on the raw row (`is_bot`) instead of deleting it, so the rules can be changed and the day recounted.

## Related topics

- [Kafka: Event Streaming](/?topic=kafka&read): the log that carries every click.
- [Idempotent Payments](/?topic=payment-idempotency&read): the same "don't do it twice" idea for money.
- [Retries: Backoff and Jitter](/?topic=retry-backoff&read): why clients send the same click twice.
- [Metrics & Monitoring System](/?topic=metrics-monitoring&read): another pipeline that rolls events up into time buckets.
- [Distributed Cache](/?topic=distributed-cache&read): the Redis side of deduplication.
- [Sales Rank by Category](/?topic=sales-rank&read): a batch aggregation of the same kind.

## Sources

- Apache Kafka: [Documentation](https://kafka.apache.org/documentation/) (partitions, consumer offsets, delivery semantics)
- Apache Flink: [Timely stream processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/) (event time and watermarks)
- Akidau and others: [The Dataflow Model](https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf) (VLDB 2015: windows, late data)
- Nathan Marz: [Lambda architecture](http://lambda-architecture.net/)
- Redis: [SET command](https://redis.io/docs/latest/commands/set/) (`NX` and `EX` options)
- ClickHouse: [Documentation](https://clickhouse.com/docs) (a column store for aggregations)

## Why This Matters

"Design an ad click aggregator" is a popular system design question because it mixes every hard part of data pipelines: huge volume, late and duplicate events, exact numbers where money is involved, and a fast path next to a slow one. If you can explain event time, windows, a `click_id` for deduplication and a nightly reconciliation, you can handle most streaming design questions.
