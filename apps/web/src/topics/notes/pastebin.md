# Pastebin

> 💡 **TL;DR**: **Pastebin** lets you paste some text, get a short link, and share it; anyone with the link can read the text until it **expires**. It's built like a URL shortener, with one difference: the thing behind the link can be kilobytes or megabytes of text. So each paste is split in two: a small **metadata row** in a SQL database (the key, the expiry and where the text lives) and the **text itself** in an **object store**, a service built for storing large files cheaply. The key is made by hashing the user's IP address plus the time, a **cache** serves popular pastes, the **expiry is checked on every read**, and background jobs clean up and count visits.

## At a glance

| Question | Answer |
|---|---|
| What goes in | Some text and an expiry time (for example 1 day) |
| What comes out | A link like `https://paste.example/43bdPeY` |
| Where the text lives | The Object Store, one file (an "object") per paste |
| Where the details live | One small row per paste in the SQL Database |
| How the key is made | MD5 (message digest 5) hash of IP address + time, written in base62, first 7 characters |
| Possible keys | 62⁷ ≈ 3.5 trillion |
| Reads per write | About 10 |
| Load | About 0.4 writes and 4 reads a second: small, the lesson is the structure |
| Expired pastes | Refused on every read at once; deleted later by a cleanup job |
| Visit counts | From the access logs, by a separate job |

## What Pastebin is, and what an object store is

**Pastebin** is a service for sharing plain text: a log file, a piece of code, an error message. You paste the text, choose how long it should live, and get a link. You don't need an account. Without it you'd attach a file or paste a wall of text into a chat, where formatting breaks and it can't expire.

An **object store**, such as Amazon S3 (Simple Storage Service), keeps files, called objects, under a name, like a huge, very reliable folder. It's cheap per gigabyte, copies every object to several disks for safety, and grows without you having to split anything across servers. It's slower than a database for small lookups and can't search inside files, which is fine here: we always know exactly which object we want.

A **SQL database** is good at the opposite: small rows you can look up, index and filter quickly. So the design puts each kind of data where it fits.

## Follow one paste all the way through

A developer at IP address 203.0.113.42 pastes a 2 KB error log on 14 March 2026 at 09:41:07 UTC and picks "expires after 1 day".

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The browser sends the text and "1 day" | Client → Web Server → Write API |
| 2 | The Write API joins IP and time: `203.0.113.42` + `1773481267000` (the time in milliseconds since 1970) | Write API |
| 3 | It takes the MD5 hash of that string: `8556c65c817ea0ae794fd587c03fa02e` | Write API |
| 4 | It writes that 128-bit number in base62 and keeps the first 7 characters: `43bdPeY` | Write API |
| 5 | It saves the text as the object `pastes/43bdPeY` | Object Store |
| 6 | It inserts the row: key `43bdPeY`, expires `2026-03-15 09:41:07`, path `pastes/43bdPeY` | SQL Database |
| 7 | It answers with the link `https://paste.example/43bdPeY` | Write API → Client |
| 8 | A teammate opens the link; the Read API asks Redis, which doesn't have it yet (a miss) | Read API → Memory Cache (Redis) |
| 9 | It reads the row (path and expiry), checks the paste hasn't expired, and fetches the text | SQL Database, Object Store |
| 10 | It saves the text in Redis for the time left (about 24 hours), and returns it | Memory Cache (Redis) |
| 11 | The next readers get it straight from Redis | Memory Cache (Redis) |
| 12 | On 15 March at 09:41:07 the paste expires; a read after that gets "not found" at once | Read API |
| 13 | Later, the cleanup job deletes the row and the object | Expiry Cleanup Job |

## How the key is made

### Hash the IP address and the time

A **hash function** turns any input into a fixed-size number that looks random; the same input always gives the same number. **MD5** is an old hash function that gives a 128-bit number, written as 32 hexadecimal characters. MD5 is no longer safe for security uses like passwords, but it's fine for spreading keys around, which is all we need here.

The input is the client's **IP address** (its network address) plus the creation time in milliseconds. Two pastes from the same address in the same millisecond are very unlikely, so inputs are almost always different.

### Write it in base62 and keep 7 characters

**Base62** writes a number with 62 symbols: `0–9`, `A–Z` and `a–z` (this topic's code puts capitals before small letters). Each character is worth 62 times the one to its right. A 128-bit MD5 number is 22 base62 characters long, far more than a link needs, so we keep the first 7.

```javascript
import { createHash } from 'node:crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// MD5 of ip + timestamp, written in base 62, first 7 characters.
function pasteKey(ip, timestamp, salt = '') {
  let n = BigInt('0x' + createHash('md5').update(ip + timestamp + salt).digest('hex'))
  let code = ''
  while (n > 0n) {
    code = BASE62[Number(n % 62n)] + code // the last character first
    n /= 62n
  }
  return code.slice(0, 7)
}

pasteKey('203.0.113.42', 1773481267000) // "43bdPeY"
```

`BigInt` holds whole numbers of any size; a 128-bit hash is far too big for a normal JavaScript number, which is exact only up to 2⁵³. `n % 62n` is the remainder after dividing by 62, the value of the last character.

### Seven characters: how many keys, and how many needed

- 62⁷ = 3,521,614,606,208, about **3.5 trillion** possible keys.
- At 1 million pastes a month, 3 years is 36 million pastes.
- 3.5 trillion ÷ 36 million ≈ 98k: there are about 98k times more keys than pastes.

### Collisions are caught by the database

Keeping only 7 characters means two different inputs can, rarely, give the same key: a **collision**. The fix is simple. The key is the table's **primary key**, so the database refuses a second row with the same key. When that insert fails, the Write API adds a **salt**, a bit of extra text, to the input and tries again.

```sql
INSERT INTO pastes (shortlink, expires_at, paste_path, created_at)
VALUES ('43bdPeY', '2026-03-15 09:41:07', 'pastes/43bdPeY', '2026-03-14 09:41:07');
-- if 43bdPeY is taken, this fails; retry with salt "1": pasteKey(ip, time, '1') → "3tzo3Rr"
```

Don't check first and then insert: two requests at the same moment could both see "free" and both insert. Let the primary key decide; only one insert can win.

## Why the text goes to an object store

Imagine a 5 MB log pasted into a database table. Every backup copies it, every replica stores it, and the table grows by gigabytes for data you never search. An object store keeps large blobs cheaply, copies them for safety on its own, and grows without sharding (splitting data across servers).

The row in SQL stays tiny: a key, two dates and a path. That's what you look up and filter.

| | SQL Database | Object Store |
|---|---|---|
| Holds | key, expiry, creation time, path to the text | the text |
| Size per paste | a few dozen bytes | 1 KB on average, up to megabytes |
| Good at | fast lookups by key, filtering by expiry | cheap, safe storage of big files |
| Grows by | sharding by key, if ever needed | itself |

## Expiry: checked on every read

A paste must stop working exactly at its deadline. If you relied on a cleanup job alone, a paste could stay readable until the job next runs, maybe an hour late. So the Read API compares the current time with `expires_at` on **every** read, and answers "not found" once it's past.

The **Expiry Cleanup Job** only frees space. It deletes expired rows and objects in small batches, so it never locks the table for long, and it's safe to run again if it stops halfway.

The cache follows the same rule. When the Read API saves a paste in Redis, it sets the cache's **TTL** (time to live: how long Redis keeps the entry) to the paste's time left. A paste with 3 hours left is cached for 3 hours at most, so the cache can never hand out a dead paste.

```javascript
const left = Math.floor((expiresAt - Date.now()) / 1000) // seconds left
if (left <= 0) return { status: 404 } // expired: refuse at once
await redis.set(`paste:${key}`, text, { EX: left }) // never outlive the paste
```

## The numbers, worked out

These assumptions come from the System Design Primer.

- **Writes:** 1 million pastes a month ÷ about 2.59 million seconds in a month (30 × 86,400) ≈ **0.4 a second**.
- **Reads:** 10 million a month ≈ **4 a second**: 10 reads per write.
- **Storage:** about 1 KB per paste. 1 million × 1 KB = **1 GB a month**, 36 GB in 3 years.
- **Handy rule:** 400 requests a second is about 1 billion a month (400 × 2.59 million ≈ 1.04 billion).

This is a small system. One SQL server with a replica copes easily; the cache absorbs most reads. The point of the exercise is the structure, which still holds at 1,000 times the size.

## Counting visits off the read path

The **Web Server** in front writes an access log line for every request. The **Analytics Job** reads those logs later, for example with MapReduce (map each line to its key, then add up per key per month), and writes the monthly counts. Nothing about counting slows down a read.

## What it costs and where it stops

- **Hash collisions** cost a retry. At 36 million keys out of 3.5 trillion, they're rare, but the code must handle them.
- **Hashed keys can't be guessed** from one another, unlike a counter, which suits private pastes. But anyone who gets the link can read the paste: a link isn't a password.
- **A viral paste** sends every read to one cache key and, on misses, to one object. Put a content delivery network (CDN), a set of caching servers around the world, in front of popular pastes.
- **If Redis fails**, reads fall back to SQL and the object store: slower, but nothing breaks.
- **Abuse:** without accounts, one client can create millions of pastes. Rate-limit creation per IP address.

## How to choose

- **Text could be large?** Store it in an object store and keep only metadata in SQL.
- **No shared counter wanted?** Hash something unique (IP + time) and let the primary key catch collisions.
- **Keys must never collide and you can run a counter?** Use a counter in base62, as in the URL shortener.
- **Things expire?** Check the deadline on every read; use a background job only to reclaim space; match cache TTLs to the time left.
- **Need counts?** Take them from access logs with a batch job, never in the request.

## ⚠️ Critical Mistakes

- **Storing big text in the database row.** Backups, replicas and the table all bloat. Put the text in an object store.
- **"Check, then insert" for the key.** Two requests can both pass the check. Let the primary key reject the duplicate and retry with a salt.
- **Relying on the cleanup job for expiry.** The paste stays readable until the job runs. Check the expiry on every read.
- **Caching longer than the paste lives.** The cache keeps serving a dead paste. Set the TTL to the time left.
- **Deleting all expired pastes in one huge query.** It locks the table. Delete in small batches.
- **No rate limit on creation.** One script can fill your storage.

## Interview Q&As

**Q: Two pastes get the same key. What happens, and where is it caught?**

A: The key is the primary key, so the second insert fails in the database. The Write API catches that error, adds a salt to the hash input and tries again, which gives a different key. Checking first and inserting second would leave a race between two simultaneous requests.

**Q: Why enforce expiry on every read as well as in a cleanup job?**

A: The cleanup job runs on a schedule, so on its own a paste would stay readable until the next run. Checking the time on every read makes the paste stop working exactly at its deadline. The job only reclaims space, so it can run slowly and in batches.

**Q: Why not store the text in the SQL table?**

A: Pastes can be megabytes. Large values bloat the table, its indexes, backups and replicas, for data you never search. An object store keeps big blobs cheaply and safely and grows on its own; the SQL row keeps just the key, dates and path.

**Q: A paste goes viral. What protects the system?**

A: The cache serves repeat reads, so the database and object store see only misses. For very popular pastes, a CDN in front serves the text from servers near readers. The TTL still never exceeds the paste's time left.

## Related topics

- [URL Shortener](/?topic=url-shortener&read): the same short-key idea with a counter instead of a hash.
- [Distributed Cache](/?topic=distributed-cache&read): cache-aside and TTLs in depth.
- [CDN](/?topic=cdn&read): serving popular content from servers near the reader.
- [Rate Limiter](/?topic=rate-limiter&read): stopping one client from creating millions of pastes.
- [Amazon's Sales Rank by Category](/?topic=sales-rank&read): counting from logs with MapReduce.

## Sources

- System Design Primer: [Design Pastebin.com (or Bit.ly)](https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/pastebin/README.md) (CC BY 4.0), the source of this topic's requirements and estimates
- IETF: [RFC 1321, The MD5 Message-Digest Algorithm](https://www.rfc-editor.org/rfc/rfc1321)
- Redis: [EXPIRE command](https://redis.io/docs/latest/commands/expire/)
- Amazon S3: [What is Amazon S3?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)

## Why This Matters

Pastebin teaches one habit that appears in almost every real system: put each kind of data where it fits. Small, searchable details go in a database; large blobs go in an object store. It also teaches two careful details that interviewers like to probe: let the database catch key collisions instead of checking first, and enforce deadlines when data is read, not only when a cleanup job gets around to it.
