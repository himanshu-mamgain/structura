# Unique ID Generator (Snowflake)

> 💡 **TL;DR**: Every row needs an **ID** that no other row will ever have, even when hundreds of servers create rows at the same moment. Asking one database counter for every ID makes it a bottleneck and a single point of failure. A **Snowflake ID** packs three things into one 64-bit number: the **time** in milliseconds, the **machine** that made it, and a **sequence** counter for IDs made in the same millisecond. Each machine makes IDs on its own, with no database and no talking to the others, and the IDs come out roughly **in time order**. Its two weak spots are a **clock that goes backwards** and **two machines with the same number**; both have simple guards.

## At a glance

| Question | Answer |
|---|---|
| The problem | Unique IDs from many servers at once, fast, with no central counter |
| The layout | 1 unused bit, 41 bits time, 10 bits machine, 12 bits sequence: 64 bits |
| Time | Milliseconds since your own start date (the custom epoch): 2⁴¹ ms ≈ 69.7 years |
| Machines | 10 bits = 1,024 workers |
| Per machine | 12 bits = 4,096 IDs per millisecond, about 4.1 million a second |
| Order | Sorted by time, so new rows go to the end of the index |
| Size | 8 bytes, half a UUID (universally unique identifier, 16 bytes) |
| Weak spot 1 | The clock stepping back: wait if small, refuse if large |
| Weak spot 2 | Two workers with one number: lease numbers from a registry |
| In JSON | Send as a string; JavaScript numbers lose precision above 2⁵³ |

## What a unique ID generator is, and why not just use the database

Every order, message and user needs an **ID**: a number that identifies it and nothing else, for ever. The simplest way is a database counter (`AUTO_INCREMENT` in MySQL, `SERIAL` in Postgres): each new row gets the next number.

That works on one database. It stops working when:
- you **shard** (split rows across several databases): each has its own counter, and they'd hand out the same numbers;
- you need IDs before the row is saved, for example to put them on a queue;
- you create tens of thousands of rows a second: every insert waits on one counter.

A **unique ID generator** makes IDs without that one counter. Twitter's **Snowflake** design is the classic answer; Discord, Instagram and many others use variants.

The other common answer is a **UUID**: 128 random bits, made anywhere with no setup. It's fine for many systems, but it's twice the size, and because it's random, new rows land all over the index instead of at the end, which slows inserts on large tables. UUID version 7 fixes the ordering by putting the time first, at 128 bits.

## The layout: 64 bits in four parts

```text
0 | 41 bits: ms since epoch | 5 bits: data centre | 5 bits: worker | 12 bits: sequence
```

- **1 sign bit**, always 0, so the ID is a positive number in every language.
- **41 bits of time**: milliseconds since a **custom epoch**, a start date you choose. This topic uses 1 January 2025. 2⁴¹ milliseconds is 2,199,023,255,552 ms ≈ **69.7 years**, so these IDs run out in September 2094. Counting from your own start date instead of 1970 gives you all 69 years.
- **10 bits of machine**: here split as 5 bits for the data centre and 5 for the worker, so 32 × 32 = **1,024** workers.
- **12 bits of sequence**: a counter from 0 to 4,095 for IDs made by one worker in the same millisecond.

Time is in the top bits, so a later ID is a bigger number. That's why IDs sort by creation time, and why inserts go to the end of the index.

## Follow one ID all the way through

The Order Service asks for an ID at 09:26:53.589 UTC on 14 March 2026. The request reaches the worker in data centre 1 numbered worker 1 (in the diagram, ID Worker · DC1/W1, where DC1/W1 means data centre 1, worker 1).

| Step | What happens | Value |
|---|---|---|
| 1 | The load balancer sends the request to a worker | ID Worker · DC1/W1 |
| 2 | At start-up, the worker leased its number from etcd, a small, reliable store of settings | data centre 1, worker 1 |
| 3 | Its machine number is data centre × 32 + worker | 1 × 32 + 1 = **33** |
| 4 | The clock check: time hasn't gone back since the last ID | fine |
| 5 | Milliseconds since the epoch | 1773480413589 − 1735689600000 = **37,790,813,589** |
| 6 | First ID this millisecond, so the sequence is 0 | **0** |
| 7 | Pack the parts: time shifted left 22 bits, combined with machine shifted left 12, combined with the sequence | **158506160599732224** |
| 8 | A second ID in the same millisecond gets sequence 1 | 158506160599732225 |
| 9 | The Order Service saves the order with that ID | Orders DB (sharded by id) |

"Shifted left 22 bits" moves the time past the 10 machine bits and 12 sequence bits, which is the same as multiplying by 2²². The ID can be taken apart again to read when it was made: shift it right 22 bits and add the epoch, and you get 09:26:53.589 back.

## The code

```javascript
const EPOCH = 1735689600000n // 2025-01-01 00:00:00 UTC, our own epoch

let lastMs = -1n
let seq = 0n

function nextId(machine) {
  // machine: 0 to 1023, leased from the registry
  let ms = BigInt(Date.now())
  if (ms < lastMs) throw new Error('clock moved backwards') // see "The clock"
  if (ms === lastMs) {
    seq = (seq + 1n) & 4095n // 12 bits: 0..4095
    if (seq === 0n) while (ms <= lastMs) ms = BigInt(Date.now()) // used them all: wait for the next ms
  } else {
    seq = 0n
  }
  lastMs = ms
  return ((ms - EPOCH) << 22n) | (BigInt(machine) << 12n) | seq
}

String(nextId(33)) // send it as text
```

`BigInt` is needed because the ID is bigger than 2⁵³ = 9,007,199,254,740,992, the largest whole number a normal JavaScript number holds exactly. `& 4095n` keeps the last 12 bits, so the sequence wraps from 4,095 back to 0; when it wraps inside the same millisecond, the worker waits for the clock to tick.

## The two weak spots

### The clock

Servers keep their clocks right with **NTP** (Network Time Protocol), which sometimes nudges a clock back by a few milliseconds. If the clock goes back, the worker could produce times it already used, and so repeat IDs.

The **Clock Check** never lets time go back:
- **A small step** (a few milliseconds): wait until the clock passes the last time used, then carry on.
- **A big step** (seconds): refuse to make IDs, raise a **Clock Drift Alert**, and let the load balancer use other workers.

### The machine number

Two workers with the same number, in the same millisecond, with the same sequence, make the same ID. Setting numbers by hand in config files is how that happens.

Instead, each worker **leases** its number from a registry such as **etcd** when it starts: it claims a free number with a time limit (say 30 seconds) and renews it every 10 seconds. If the worker dies, the lease runs out and the number becomes free. Two live workers can never hold the same one.

## The numbers, worked out

- **Per worker**: 4,096 IDs per millisecond × 1k milliseconds = **4,096,000 a second**.
- **All workers**: 1,024 × 4,096,000 = **4,194,304,000 a second**, far more than any app needs.
- **Example load**: 50k orders a second is 50k × 86,400 = **4.32 billion IDs a day**. One worker would be about 1.2% busy (50k ÷ 4,096,000). Three workers are for safety, not speed.
- **Storage**: 8 bytes per ID. 50k a second for 5 years ≈ 7.9 × 10¹² IDs ≈ **63 TB** of IDs alone; 16-byte UUIDs would double that.

## What it costs and where it stops

- **Order is only rough across machines.** Two workers in the same millisecond order by machine number, not by which came first. Within one worker, IDs are strictly increasing.
- **IDs reveal the time** they were made, and roughly how many you make. If that's sensitive, don't show raw IDs publicly.
- **69.7 years from your epoch**, then the time bits run out. Pick an epoch near your launch.
- **You run a service**: workers, a registry and clock monitoring. A UUID needs none of that.

## How to choose

- **Small app, one database?** The database's own counter is fine.
- **IDs made anywhere, no setup, size doesn't matter?** UUID version 4 (random) or, better for indexes, version 7 (time first).
- **High volume, sharded database, 8-byte IDs that sort by time?** Snowflake.
- **Few machines, need more IDs per millisecond?** Use fewer machine bits (3 bits = 8 workers) and give the rest to the sequence.
- **A ticket server** (one table that hands out ranges of numbers) is simple too, but every range costs a network call and IDs don't sort by time.

## ⚠️ Critical Mistakes

- **Sending 64-bit IDs as JSON numbers.** JavaScript rounds them above 2⁵³, so `158506160599732225` can come back as a different number. Send them as strings.
- **Setting machine numbers by hand.** Sooner or later two workers share one. Lease them from a registry.
- **Ignoring the clock going backwards.** The worker repeats IDs. Wait for small steps, refuse big ones.
- **Using the 1970 epoch with 41 bits.** You lose 55 of your 69 years before you start.
- **Random UUIDs as the primary key of a huge, busy table.** Inserts scatter across the index and slow down. Use time-ordered IDs.

## Interview Q&As

**Q: How does a Snowflake ID guarantee uniqueness without a central counter?**

A: Each ID combines the time in milliseconds, a machine number no other live worker has, and a sequence that resets each millisecond. Two IDs can only match if the same machine made them in the same millisecond with the same sequence, which the sequence counter prevents.

**Q: What happens if the server's clock goes backwards?**

A: The worker could reuse past times and repeat IDs. It remembers the last time used; for a small step back it waits until the clock passes it, and for a large step it refuses and raises an alert, so other workers take the traffic.

**Q: Why not just use UUIDs?**

A: You can, if 16 bytes and no setup suit you. Random UUIDs scatter inserts across the index and double the storage of an 8-byte ID. Snowflake IDs are half the size and sort by time. UUID version 7 is a good middle ground.

**Q: How many IDs a second can it make?**

A: 4,096 per millisecond per worker, about 4.1 million a second each, and about 4.2 billion a second across 1,024 workers.

## Related topics

- [Database Sharding](/?topic=database-sharding&read): why one database counter stops working.
- [Leader Election](/?topic=leader-election&read): leases and registries like etcd.
- [URL Shortener](/?topic=url-shortener&read): turning a unique number into a short code.
- [Chat System](/?topic=chat-system&read): time-ordered message IDs in practice.

## Sources

- Twitter Engineering: [Announcing Snowflake](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake) (2010)
- IETF: [RFC 9562, Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562) (includes UUID version 7)
- etcd: [Leases](https://etcd.io/docs/v3.5/learning/api/#lease-api)
- MDN: [Number.MAX_SAFE_INTEGER](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER)

## Why This Matters

"Design a unique ID generator" is a common question on its own, and IDs come up in almost every other design: orders, messages, short links, sharded tables. Knowing the bit layout, the numbers (69.7 years, 4,096 per millisecond) and the two weak spots lets you answer quickly and show you've thought about what breaks: clocks, duplicate workers and JavaScript's number limit.
