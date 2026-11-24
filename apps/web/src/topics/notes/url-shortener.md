# URL Shortener

> 💡 **TL;DR**: A **URL shortener** turns a long web address into a short code, like `sho.rt/aZ3k9Qx`, and sends anyone who opens the code on to the long address. A link is made once and opened many times (about 100 opens per link), so the design is mostly about making the **redirect** fast. Each new link gets the next number from a **counter**, written in **base62** (the digits 0–9, a–z and A–Z), so two links never get the same code. Redirects check a **cache** first, answer with a **302** so every click comes back to you, and count clicks later through a **queue**, never while the user waits.

## At a glance

| Question | Answer |
|---|---|
| What goes in | A long URL, such as `https://shop.example.com/sale/diwali?ref=whatsapp` |
| What comes out | A short link, such as `https://sho.rt/aZ3k9Qx` |
| Reads per write | About 100: a link is made once and opened many times |
| Writes a second | About 40 (100 million new links a month) |
| Redirects a second | About 4k on average, maybe 40k at peaks |
| Code length | 7 base62 characters: about 3.5 trillion codes |
| How codes are made | A counter, written in base62; each server takes a block of 1k numbers at a time |
| Where a redirect looks first | Redis, an in-memory store; the database only on a cache miss |
| Redirect status | 302 (temporary), so every click reaches the service |
| How clicks are counted | A click event on a queue; a worker adds them up later |

## What a URL shortener is

A **URL** (uniform resource locator) is a web address: it says which server to ask and which page to fetch. Some URLs are long, full of tracking settings, and break when pasted into a message. A **URL shortener** stores the long URL and hands out a short one that points to it.

The short link has two parts. `sho.rt` is the shortener's own domain. `aZ3k9Qx` is the **code**, a short name for one stored link. When someone opens `https://sho.rt/aZ3k9Qx`, the shortener looks up the code, finds the long URL, and tells the browser to go there. That "go there instead" answer is a **redirect**.

Without a shortener, you paste the long address, which wraps badly, looks untrustworthy and can't be counted or changed later. With one, you get a neat link, a count of clicks, and the option to change where it points.

The defining fact is the **read-to-write ratio**: how many times a link is opened compared with how many times one is created. Here it's about 100 to 1. So almost all the work, and all the design effort, goes into the redirect.

## URL, URI and URN

People mix these up, and interviewers sometimes ask.

- A **URI** (uniform resource identifier) is any string that identifies something.
- A **URL** is a URI that also says where the thing is and how to fetch it: `https://sho.rt/aZ3k9Qx`.
- A **URN** (uniform resource name) is a URI that names something for ever without saying where it is: `urn:isbn:9780134685991` names one book.

So every URL is a URI, but not every URI is a URL. `mailto:support@sho.rt` is a URI too, with no server to fetch from.

The parts of a URL, using `https://api.sho.rt:443/v1/links/aZ3k9Qx?ref=whatsapp#stats`:

| Part | Here | What it is |
|---|---|---|
| Scheme | `https` | how to fetch it |
| Host | `api.sho.rt` | the server's name, which DNS turns into an IP address |
| Port | `443` | the default for https, so usually left out |
| Path | `/v1/links/aZ3k9Qx` | which thing on that server |
| Query | `?ref=whatsapp` | extra `key=value` settings |
| Fragment | `#stats` | a place inside the page; the browser never sends it to the server |

## Follow one link all the way through

Meera's shop shares a Diwali sale link on WhatsApp. Here's that one link, from creation to its first two clicks.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Meera's app sends `POST /shorten` with the long URL | User / Browser → Load Balancer → Shorten API |
| 2 | The Shorten API checks the URL is valid and not on a blocklist of known scam sites | Shorten API |
| 3 | It takes the next number from its block of IDs: 56,800,235,584 | Key Generator (base62) |
| 4 | It writes that number in base62: `1000000` (7 characters) | Key Generator (base62) |
| 5 | It saves the row: code `1000000` → the long URL | URL Database |
| 6 | It answers with `https://sho.rt/1000000` | Shorten API → User / Browser |
| 7 | A customer taps the link: `GET /1000000` reaches the Redirect API | User / Browser → Load Balancer → Redirect API |
| 8 | Redis doesn't have the code yet (a **cache miss**) | In cache? → Redis Cache |
| 9 | The Redirect API reads the URL Database, then saves the answer in Redis for 24 hours | URL Database → Redis Cache |
| 10 | It answers `302 Found` with `Location:` the long URL; the browser follows it | Redirect API → User / Browser |
| 11 | It drops a small click event on the queue and is done | Click Event Queue |
| 12 | The next customer taps it: Redis answers in under a millisecond (a **cache hit**) | Redis Cache |
| 13 | Later, the worker adds up the clicks for the day | Analytics Worker → Stats Store |

Why does the first number look so big? Step 3 explains itself in the next section.

## How codes are made

### A counter, written in base62

Every new link takes the next number from a **counter**. Because a counter never repeats, two links can never get the same code. There's nothing to check and no **collision** (two links sharing one code) to handle.

**Base62** writes a number with 62 symbols instead of 10: the digits `0–9`, then `a–z`, then `A–Z`. Each character is worth 62 times the one to its right, the same way each decimal digit is worth 10 times the one to its right. All 62 symbols are safe in a URL, so no escaping is needed.

| Number | In base62 | How |
|---|---|---|
| 61 | `Z` | the last symbol |
| 62 | `10` | 1 × 62 + 0 |
| 125 | `21` | 2 × 62 + 1 |
| 1,000,000 | `4c92` | 4 × 62³ + 12 × 62² + 9 × 62 + 2 (`c` is the 12th symbol after the digits) |
| 56,800,235,584 | `1000000` | exactly 62⁶ |

### Why 7 characters

With 7 characters there are 62⁷ = 3,521,614,606,208 codes, about **3.5 trillion**. At 100 million new links a month (1.2 billion a year), that would last about 2,900 years.

Small numbers give short codes: link number 125 would be just `21`. If you want every code to be exactly 7 characters, start the counter at 62⁶ = 56,800,235,584, the smallest 7-character number. That still leaves about 3.46 trillion codes before you reach `ZZZZZZZ`. That's why the first link in the example got such a big number.

### Blocks of IDs, so the counter isn't a bottleneck

If every Shorten API server asked one central counter for every new link, that counter would be on the path of every write, and a single point of failure. Instead, each server reserves a **block** of numbers, say 1k at a time, and hands them out from memory. It only talks to the central counter once every 1k links.

If a server crashes, the unused part of its block is simply skipped. Codes don't have to be consecutive; they only have to be unique.

### The code

This turns a number into base62 and back. It's the same alphabet the topic's simulator uses.

```javascript
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

function toBase62(n) {
  let code = ''
  do {
    code = ALPHABET[n % 62] + code // the last digit first
    n = Math.floor(n / 62)
  } while (n > 0)
  return code
}

function fromBase62(code) {
  return [...code].reduce((n, ch) => n * 62 + ALPHABET.indexOf(ch), 0)
}

toBase62(1_000_000)   // "4c92"
toBase62(62 ** 6)     // "1000000"
fromBase62('4c92')    // 1000000
```

`n % 62` is the remainder after dividing by 62: the value of the last character. Dividing by 62 then moves on to the next character, until nothing is left. The numbers here stay well under 2⁵³, the largest whole number a JavaScript number holds exactly.

### The trade-off: codes can be guessed

A counter makes codes easy to guess: if `1000000` exists, `1000001` probably does too. For public marketing links that doesn't matter. For private links (a shared document, an invoice), add randomness: pick a random 7-character code and insert it, and if the database says the code is taken, pick another. With 3.5 trillion codes and a few billion used, a clash is rare.

## The redirect: 301 or 302

The browser asks for `/aZ3k9Qx` and the service answers "go to this other address instead". There are two common ways to say that, and the choice matters.

- **301 Moved Permanently** tells the browser "this will never change, remember it". The next time anyone on that browser taps the link, it skips your service and goes straight to the target. That saves traffic, but those clicks are never counted, and you can never change where the link points.
- **302 Found** is a temporary redirect. The browser asks your service every time. Every click is counted, and you can change the target or switch the link off.

```http
HTTP/1.1 302 Found
Location: https://shop.example.com/sale/diwali?ref=whatsapp
Cache-Control: private, max-age=0
```

`Location` is where the browser goes next. `Cache-Control: private, max-age=0` asks browsers and shared caches not to keep the answer, so the next click comes back to you too.

Most shorteners that offer click counts use 302 (or 307, which is the same idea but keeps the request method). Use 301 only when you'll never need counts or changes.

## The cache: most redirects never reach the database

Link traffic is very uneven: a small set of popular links gets most of the clicks. So a cache of popular codes answers most redirects.

The pattern is called **cache-aside**: the Redirect API asks Redis first; on a miss it reads the database and puts the answer in Redis itself.

```javascript
async function redirect(code) {
  let url = await redis.get(`url:${code}`)
  if (!url) {
    url = await db.findUrl(code) // the source of truth
    if (!url) return { status: 404 }
    await redis.set(`url:${code}`, url, { EX: 86_400 }) // keep it for 24 hours
  }
  queue.send({ code, at: Date.now() }) // count it later, don't wait
  return { status: 302, location: url }
}
```

`EX: 86_400` sets a **TTL** (time to live): Redis deletes the entry after 86,400 seconds, which is 24 hours (24 × 60 × 60). Links almost never change, so a day-old copy is fine. Rarely used codes drop out on their own and don't fill the cache.

`queue.send` doesn't wait for the count to be saved, so counting never slows a redirect.

## Counting clicks without slowing redirects

Writing to a database on every click would add milliseconds to every redirect and put 4k writes a second on the database. Instead, each redirect drops a tiny **click event** (code and time) on a queue and moves on. A queue is a list that one side adds to and the other side reads from, each at its own pace.

The Analytics Worker reads the events and adds them up per link per day, into one row per link per day in the Stats Store. If the worker falls behind during a viral spike, events just wait in the queue; redirects carry on at full speed.

## The numbers, worked out

These are interview-style round numbers, not any company's real figures.

- **Writes:** 100 million new links a month ÷ about 2.59 million seconds in a month (30 × 86,400) ≈ **40 writes a second**.
- **Reads:** 100 opens per link × 40 = about **4k redirects a second**, with peaks maybe 10 times higher (40k).
- **Storage:** about 500 bytes a row (code, long URL, owner, dates). Five years is 100 million × 12 × 5 = 6 billion rows. 6 billion × 500 bytes = **3 TB**. That's more than one comfortable database server, so you'd **shard** it: split the rows across several servers by code.
- **Codes:** 62⁷ ≈ 3.5 trillion, versus 6 billion needed in five years: plenty of room.

## What it costs and where it stops

- **The cache does the heavy lifting.** If Redis goes down, every redirect hits the database. Run Redis with a replica, and keep enough database capacity for a bad day.
- **A viral link can overload one cache server**, because every request for that code goes to the same place. Copy very hot codes to several servers, or keep a tiny cache inside each Redirect API server.
- **Cache stampede**: when a popular entry expires, thousands of requests miss at once and all hit the database. Let one request refill it while the others wait, or refresh popular entries before they expire.
- **Abuse**: scammers use shorteners to hide bad links. Rate-limit link creation and check target URLs against a blocklist.
- **Counter, not hash**: hashing the long URL (and cutting it to 7 characters) needs no counter but can produce the same code for two URLs, so every insert needs a collision check. The counter avoids that, at the price of guessable codes.

## How to choose

- **Public links, click counts wanted?** Counter in base62, blocks of IDs per server, 302 redirects, cache-aside in Redis, click events through a queue. This is the default answer.
- **Private links that must not be guessed?** Random 7- or 8-character codes, with the database's unique constraint catching the rare clash.
- **Same long URL should always give the same code?** Hash the URL and handle collisions, or look up the URL first.
- **You never need counts or changes?** A 301 is fine and saves traffic.
- **Custom names** (`sho.rt/diwali-sale`)? Store them in the same table; the unique constraint on the code rejects a name that's taken.

## ⚠️ Critical Mistakes

- **Using 301 and then wondering why click counts dropped.** Browsers remember a 301 and skip your service. Use 302 if you count clicks or may change the target.
- **Counting clicks inside the redirect.** A database write on every click slows every redirect. Put an event on a queue and count later.
- **One central counter on every request.** It becomes a bottleneck and a single point of failure. Give each server a block of IDs.
- **Truncating a hash without checking for collisions.** Two different URLs can end up with the same 7 characters, and one link silently points to the wrong page.
- **Caching without a TTL.** The cache fills with links nobody opens any more. Let entries expire.
- **No rate limit on link creation.** Spammers will create millions of links to scam sites.

## Interview Q&As

**Q: How long should the codes be, and why?**

A: 7 base62 characters give 62⁷ ≈ 3.5 trillion codes. At 100 million new links a month, that lasts thousands of years. 6 characters (about 56.8 billion) would run out in about 47 years at that rate, and less with growth, so 7 is the usual choice.

**Q: Counter, hash or random code?**

A: A counter in base62 never collides and needs no checks, but codes are guessable and the counter must not be a bottleneck, so servers take blocks of IDs. A hash of the URL needs no coordination and gives the same code for the same URL, but truncating it can collide, so every insert must check. A random code is unguessable and also needs a uniqueness check on insert. For public links, the counter is simplest.

**Q: 301 or 302?**

A: A 301 is permanent: browsers remember it and skip the service, so you lose click counts and can't change the target. A 302 is temporary: every click comes back, so you can count and change it. Most shorteners use 302.

**Q: How do you keep redirects fast at 40k a second?**

A: Keep the Redirect API stateless so you can add servers behind the load balancer. Put popular codes in Redis with a TTL, so most redirects never touch the database. Count clicks through a queue, not in the request. Add database read replicas and shard by code when one server isn't enough.

**Q: What happens when one link goes viral?**

A: All its requests go to the one cache server that holds its code. Copy hot codes to several cache servers or keep a small in-process cache on each Redirect API server, and make sure only one request refills the entry when it expires.

## Related topics

- [Pastebin](/?topic=pastebin&read): the same short-key idea, with big text stored in an object store.
- [Unique ID Generator (Snowflake)](/?topic=unique-id-generator&read): making unique numbers across many servers without one counter.
- [Distributed Cache](/?topic=distributed-cache&read): cache-aside, TTLs, hot keys and stampedes.
- [Message Queue](/?topic=message-queue&read): how the click events wait safely for the worker.
- [Rate Limiter](/?topic=rate-limiter&read): stopping spammers from creating millions of links.

## Sources

- IETF: [RFC 9110, HTTP Semantics, section 15.4 (Redirection 3xx)](https://www.rfc-editor.org/rfc/rfc9110#section-15.4)
- Redis: [EXPIRE command](https://redis.io/docs/latest/commands/expire/)
- System Design Primer: [Design Pastebin.com (or Bit.ly)](https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/pastebin/README.md)

## Why This Matters

The URL shortener is often the first system design question, because it fits in 45 minutes yet touches the core ideas: estimating reads and writes, generating unique keys, choosing the right HTTP status, caching a hot path, and moving slow work off it. Interviewers use it to see whether you notice that reads win 100 to 1, and design for that. The same patterns come back in almost every later topic.
