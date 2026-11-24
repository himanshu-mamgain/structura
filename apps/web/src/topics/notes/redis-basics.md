# Redis Basics

> 💡 **TL;DR**: **Redis** is a database that keeps all its data in **memory** (RAM), so a read or write takes microseconds instead of milliseconds. It isn't a table of rows: each **key** holds one value of one **data type**: a string, a hash, a list, a set or a sorted set. You pick the type by the question you'll ask: "top 10?" is a sorted set, "seen before?" is a set, "next job?" is a list. Any key can get a **TTL** (time to live), after which Redis deletes it. Redis runs commands **one at a time** on a single thread, so a command like `INCR` can never be interrupted halfway, which is how you avoid lost updates. Use it for fast, temporary or derived data; keep the record you must never lose in a normal database.

## At a glance

| Question | Answer |
|---|---|
| What it is | An in-memory key-value database |
| Speed | Microseconds per command; around 100k simple commands a second on one server |
| String | Text or a number; `INCR` adds to a number |
| Hash | Field-value pairs under one key: a small object |
| List | An ordered sequence; push and pop at either end: a queue |
| Set | Unique members; fast "is this in it?" |
| Sorted set | Unique members ordered by a score: a ranking |
| TTL | Time to live: Redis deletes the key when it runs out |
| Why commands never clash | One thread runs them one after another |
| Not for | The only copy of data you must keep: orders, payments, users |

## What Redis is

**Redis** is a database that holds everything in memory. Memory is about a thousand times faster to read than an SSD, so Redis answers in microseconds. A normal database such as Postgres keeps its data on disk and answers in milliseconds.

It stores **keys** and **values**, like a giant dictionary. The key is a name you choose, like `session:a91f` or `leaderboard:2026-11`. The value isn't just text: it has a **type**, and each type has its own commands.

You'd use Redis for things that must be fast and are either temporary or can be rebuilt: login sessions, caches, counters, rankings, rate limits, job queues. Without it you'd put all of that on your main database, which would slow down under thousands of tiny reads and writes a second.

What Redis isn't: the only copy of something important. By default it can lose the last second or so of writes in a crash, and memory is far more expensive than disk.

## The five data types

| Type | Holds | Example key and value | Typical use | Main commands |
|---|---|---|---|---|
| String | Text, a number or bytes | `views:article:7` → `"42"` | counters, cached values | `GET`, `SET`, `INCR` |
| Hash | Field-value pairs | `session:a91f` → `{user: "1081", cart: "3"}` | sessions, small objects | `HSET`, `HGETALL`, `HINCRBY` |
| List | An ordered sequence | `queue:emails` → `[job3, job2, job1]` | queues, recent items | `LPUSH`, `LMOVE`, `LRANGE` |
| Set | Unique members | `visitors:2026-11-25` → `{u1, u7, u9}` | "seen before?", unique counts | `SADD`, `SISMEMBER`, `SCARD` |
| Sorted set | Unique members, each with a score | `leaderboard:2026-11` → `asha 920, ravi 870` | rankings, top-N | `ZADD`, `ZINCRBY`, `ZREVRANGE`, `ZREVRANK` |

Pick the type by the question you'll ask. "Top 10 players?" → a sorted set, already in order. "Has this user voted?" → a set. "Next email to send?" → a list.

## Follow one example: a leaderboard

A game ranks players by points this month. Each command below is shown with Redis's real reply.

| Step | Command | Reply | What happened |
|---|---|---|---|
| 1 | `ZADD leaderboard:2026-11 920 asha 870 ravi 640 meera` | `(integer) 3` | 3 players added with their scores |
| 2 | `ZINCRBY leaderboard:2026-11 100 meera` | `"740"` | Meera wins a match: 640 + 100 |
| 3 | `ZREVRANGE leaderboard:2026-11 0 2 WITHSCORES` | `asha 920, ravi 870, meera 740` | top 3, highest first |
| 4 | `ZREVRANK leaderboard:2026-11 meera` | `(integer) 2` | her position, counting from 0, so 3rd |
| 5 | `EXPIRE leaderboard:2026-11 5184000` | `(integer) 1` | delete it 60 days from now (60 × 86,400 s) |

A sorted set keeps members ordered by score as you add them, so steps 3 and 4 don't sort anything; they just read. Ranking 2 million players takes about 200 MB (about 100 bytes an entry).

## TTL: data that deletes itself

Any key can have a **TTL** (time to live), in seconds. When it runs out, Redis deletes the key.

```text
HSET session:a91f user 1081 cart 3
EXPIRE session:a91f 1800
TTL session:a91f        → (integer) 1800
```

1800 seconds is 30 minutes (30 × 60). Each time the user does something, the app runs `EXPIRE` again, so the session lasts 30 minutes after the **last** activity. Leave for 31 minutes, and the session is gone; the user signs in again.

Redis deletes expired keys in two ways: when you touch one (it checks before answering), and by checking a random sample of keys with TTLs in the background. So an expired key never comes back, and memory is freed even if nobody touches it.

Put a TTL on anything temporary. A key without one lives until you delete it or Redis runs out of memory.

## One thread: why commands never clash

Redis runs every command on one thread, one after another, in an **event loop** (a loop that takes the next waiting command and runs it to the end). No command ever sees another one half done. That's what makes single commands **atomic**: they happen completely or not at all.

That's also why a common mistake loses data:

| Time | Server A | Server B | Value in Redis |
|---|---|---|---|
| 1 | `GET views:article:7` → `41` | | 41 |
| 2 | | `GET views:article:7` → `41` | 41 |
| 3 | `SET views:article:7 42` | | 42 |
| 4 | | `SET views:article:7 42` | 42 (should be 43) |

Two views were counted as one. This is a **lost update**: each server read, added one, and wrote back, and the second write erased the first. The fix is to let Redis do the adding:

```text
INCR views:article:7   → (integer) 43
```

`INCR` reads, adds and writes inside one command, so two `INCR`s from two servers always give 43. `HINCRBY`, `ZINCRBY` and `LMOVE` work the same way. For several commands that must happen together, use `MULTI` … `EXEC` (a transaction) or a short Lua script, which Redis also runs without interruption.

## A job queue that doesn't lose jobs

The app pushes email jobs onto a list; a worker takes them off.

```javascript
// App: add a job to the left end of the list.
await redis.lPush('queue:emails', JSON.stringify({ to: 'asha@example.com', template: 'welcome' }))

// Worker: move the oldest job to a "processing" list, so a crash doesn't lose it.
const job = await redis.lMove('queue:emails', 'queue:emails:processing', 'RIGHT', 'LEFT')
await sendEmail(JSON.parse(job))
await redis.lRem('queue:emails:processing', 1, job) // done: remove it
```

If the worker just popped the job (`RPOP`) and crashed while sending, the job would be gone. `LMOVE` takes it off the queue and puts it on a processing list in one step. If the worker dies, the job is still on the processing list, and a checker can put it back.

## Counting unique visitors

A set counts each member once: `SADD visitors:2026-11-25 u1081` adds a visitor, and `SCARD` gives how many. 1 million visitors a day at about 60 bytes each is about 60 MB.

If an estimate is enough, a **HyperLogLog** (a counter that guesses the number of unique items, within about 1%) counts the same million in **12 KB**, with `PFADD` and `PFCOUNT`. It can't tell you who visited, only how many.

## The numbers, worked out

- **Sessions**: 50k active users × about 200 bytes each = **10 MB**.
- **Leaderboard**: 2 million players × about 100 bytes = **200 MB**.
- **Unique visitors**: 1 million a day × about 60 bytes = **60 MB** in a set, or 12 KB in a HyperLogLog.
- **Speed**: one Redis server commonly handles about **100k simple commands a second**.

Everything here fits easily on one server. Memory, not speed, is usually the first limit.

## What it costs and where it stops

- **Memory is the limit and it's expensive.** Set `maxmemory` and an eviction policy, such as LRU (least recently used: drop what nobody has touched for longest), so Redis drops old keys instead of failing writes.
- **One slow command blocks everyone.** Because there's one thread, `KEYS *` on a million keys freezes Redis for everyone. Use `SCAN` to walk keys a few at a time.
- **Crashes can lose recent writes** unless you turn on persistence and replicas (see Redis Persistence and Redis Replication).
- **One server has a ceiling.** Beyond it, split keys across servers with Redis Cluster (see Distributed Cache).
- **No joins or queries by value.** You find data by key. If you need "all orders over ₹1k", that's a job for a SQL database.

## How to choose

- **"Top N" or "what's my rank"?** Sorted set.
- **"Have I seen this?" or exact unique count?** Set. Approximate count of millions? HyperLogLog.
- **"Next job" or "latest 50 items"?** List (with `LMOVE` for safe queues).
- **An object with fields you update one at a time?** Hash, rather than many separate string keys.
- **A counter?** String with `INCR`.
- **Temporary?** Add a TTL. **Must never be lost?** Keep it in Postgres, and use Redis as a copy or a cache.

## ⚠️ Critical Mistakes

- **`GET` then `SET` to change a value.** Two servers lose an update. Use `INCR`, `HINCRBY`, `ZINCRBY`, or `MULTI`/`EXEC`.
- **Using `KEYS *` in production.** It blocks every other client. Use `SCAN`.
- **Forgetting TTLs on temporary keys.** Memory fills up with dead sessions.
- **Popping jobs with `RPOP` and crashing.** The job is lost. Use `LMOVE` to a processing list.
- **Treating Redis as the only copy of orders or payments.** A crash can lose recent writes.
- **Huge values in one key** (a list of 10 million items). Reading or deleting it blocks everyone.

## Interview Q&As

**Q: Why is Redis single-threaded, and why is it still fast?**

A: Everything is in memory, so each command takes microseconds and the thread is rarely waiting. One thread also means no locks and no half-done commands, which makes single commands atomic. Network handling can use extra threads in newer versions, but commands still run one at a time.

**Q: How would you build a leaderboard for 10 million players?**

A: A sorted set: `ZINCRBY` to add points, `ZREVRANGE 0 9` for the top 10, `ZREVRANK` for one player's position. At about 100 bytes an entry, 10 million players is about 1 GB, fine for one server. Use one key per month, with a TTL, and keep the scores also in the database if they matter.

**Q: Why is `GET`-then-`SET` a bug, and what replaces it?**

A: Two clients can both read the old value and both write the same new one, so one update is lost. Atomic commands like `INCR` do the read, change and write inside one command; for several steps, use `MULTI`/`EXEC` or a Lua script.

**Q: How do you make a Redis job queue not lose jobs when a worker crashes?**

A: Take jobs with `LMOVE` onto a processing list instead of popping them. Remove a job only after it's done. A checker puts jobs that sat on the processing list too long back on the queue. Make the job itself safe to run twice.

**Q: How do expired keys actually get deleted?**

A: Lazily, when a client touches the key and Redis sees it's expired, and actively, by sampling keys with TTLs several times a second and deleting the expired ones.

## Related topics

- [Distributed Cache](/?topic=distributed-cache&read): Redis as a cache, and splitting keys across servers.
- [Redis Persistence](/?topic=redis-persistence&read): how Redis saves to disk, and what it can lose.
- [Redis Replication](/?topic=redis-replication&read): copies, failover and Sentinel.
- [Rate Limiter](/?topic=rate-limiter&read): counters with `INCR` and TTLs in practice.
- [Locking](/?topic=locking&read): when one command isn't enough and you need a lock.

## Sources

- Redis: [Data types](https://redis.io/docs/latest/develop/data-types/)
- Redis: [EXPIRE command](https://redis.io/docs/latest/commands/expire/) (how keys expire)
- Redis: [LMOVE command](https://redis.io/docs/latest/commands/lmove/) (the reliable queue pattern)
- Redis: [Transactions](https://redis.io/docs/latest/develop/interact/transactions/)

## Why This Matters

Redis appears in almost every system design: as a cache, a session store, a rate limiter, a leaderboard or a queue. Interviewers ask which data type you'd use and why, how keys expire, and why two servers updating a counter can lose a count. Knowing the five types and the single-thread rule lets you answer all of them quickly, and spot the lost-update bug in real code.
