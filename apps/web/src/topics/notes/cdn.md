# CDN (Content Delivery Network)

> 💡 **TL;DR**: A **CDN** (content delivery network) is a set of caching servers in hundreds of cities. Each visitor is sent to the nearest one, which keeps copies of files that are the same for everyone: images, scripts, styles, video pieces. If it has a fresh copy, it answers at once (a **hit**); if not (a **miss**), it fetches the file from your own server, the **origin**, keeps a copy and passes it on. A CDN fixes **distance**, not server speed: a visitor in Mumbai talking to a server in Virginia waits about 180 ms per round trip, but about 12 ms to a CDN server in Mumbai. Your origin controls what may be cached, and for how long, with HTTP headers such as **Cache-Control**.

## At a glance

| Question | Answer |
|---|---|
| What it is | Caching servers in many cities, in front of your own server |
| What it fixes | Distance: every round trip to a far server costs time |
| A PoP | A point of presence: one city's group of CDN servers |
| Hit | The nearby server has a fresh copy and answers at once |
| Miss | It fetches from the origin (or a shield cache), keeps a copy, answers |
| Who decides what is cached | Your origin, with `Cache-Control` headers |
| Good for | Files that are the same for everyone: images, scripts, video segments |
| Never for | Private pages: someone's account, cart or messages |
| Updating a cached file | Put a version in the file name, or purge it |
| The number to watch | Hit ratio: the share of requests answered without the origin |

## What a CDN is, and why distance matters

Light in fibre covers about 200 km each millisecond, and cables never run straight; a factor of 1.4 for the detours is a common rule of thumb. So a **round trip** (a message there and the answer back) takes about:

round trip ≈ 2 × distance × 1.4 ÷ 200 km per ms

Mumbai to Virginia is 12,855 km: 2 × 12,855 × 1.4 ÷ 200 ≈ **180 ms**. Opening a secure connection and sending the request takes about 3 round trips, so a visitor in Mumbai waits over half a second before the first byte, however fast your server is.

A **CDN** (content delivery network) puts copies of your files close to visitors. Its servers are grouped into **PoPs** (points of presence), one per city, in hundreds of cities. Each visitor is sent to the nearest PoP. If it has the file, the long trip never happens.

Without a CDN, every visitor everywhere travels to your one server, and your server sends every byte itself.

## Follow one request all the way through

A shopper in Mumbai opens a product page. The page asks for `https://cdn.shop.example/img/product-1842.4f3a9c.jpg`, a 300 KB image. Your origin is in Virginia.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The browser looks up `cdn.shop.example` and gets the address of the Mumbai PoP | Browser → GeoDNS / Anycast |
| 2 | It opens an HTTPS connection to the Mumbai PoP (about 12 ms a round trip) and asks for the image | Browser → Edge Cache (nearest PoP) |
| 3 | The edge builds the **cache key** (method, host and path) and looks it up | Cache Lookup: hit or miss? |
| 4 | It's the first request today: a miss | Cache Lookup: hit or miss? |
| 5 | The edge asks the regional shield in Singapore (about 55 ms away), which also misses | Regional Shield Cache |
| 6 | The shield asks the origin in Virginia (about 217 ms away), which reads the file from storage | Origin Server → Object Storage |
| 7 | The origin answers with `Cache-Control: public, max-age=31536000, immutable` and an `ETag` | Origin Server |
| 8 | The shield and the edge both keep a copy; the browser gets the image | Regional Shield Cache → Edge Cache (nearest PoP) → Browser |
| 9 | The next Mumbai shopper asks for the same image: a hit, answered in about 12 ms | Edge Cache (nearest PoP) |
| 10 | Both requests are counted, one miss and one hit | Edge Metrics & Logs |

## Hit, miss and the headers that decide

Your origin tells every cache what it may do with each answer. The main header is **Cache-Control**:

```http
HTTP/1.1 200 OK
Content-Type: image/jpeg
Cache-Control: public, max-age=31536000, immutable
ETag: "4f3a9c"
```

- `public`: shared caches, like the CDN, may keep it.
- `max-age=31536000`: it stays fresh for 31,536,000 seconds, which is 365 days (365 × 86,400).
- `immutable`: it will never change, so browsers needn't even ask.
- `ETag`: an **ETag** (entity tag) is a fingerprint of this version of the file.

When a copy's time is up, a cache doesn't download the file again blindly. It asks the origin "is it still `4f3a9c`?" with `If-None-Match: "4f3a9c"`. If nothing changed, the origin answers `304 Not Modified` with no body, a few hundred bytes instead of 300 KB.

For anything personal, the origin sends `Cache-Control: private` (only the user's own browser may keep it) or `no-store` (nobody may keep it).

## The cache key: what makes two requests "the same"

The **cache key** is what the CDN looks up: usually the method, host and path, plus any request headers your origin lists in a `Vary` header. Two requests with the same key share one stored copy.

Include only what really changes the answer. If a cookie or a tracking setting like `?utm_source=whatsapp` goes into the key, one image becomes thousands of separate copies, almost every request is a miss, and the CDN stops helping. Strip tracking settings and ignore cookies for static files.

## Updating a file that's cached for a year

Two ways:

- **Version the file name.** Put a short fingerprint of the content in the name: `product-1842.4f3a9c.jpg`. When the image changes, the page points to `product-1842.b71e02.jpg`, a new key that nobody has cached. Old copies simply stop being asked for. This is the standard method, and you never need to purge.
- **Purge.** The **Purge API** tells every PoP to drop a file now: by URL, by folder, or by a tag such as `product-1842`. Use it when a page's address can't change, like a product page whose price changed. Purges are a tool for exceptions, not for every deploy.

## A shield in front of the origin

With 300 PoPs, a new file could cause 300 misses, one from each PoP, all reaching your origin. A **Regional Shield Cache** sits between the PoPs and the origin: PoPs ask the shield, and only the shield asks the origin. One file costs the origin one request per shield, not one per PoP.

Edges also do **request collapsing**: if 500 visitors in one city ask for the same missing file at the same moment, the edge sends one request upstream and the other 499 wait for its answer.

## The numbers, worked out

An example shop at its busiest serves 50k requests a second, 300 KB each on average.

- **Total traffic**: 50k × 300 KB = 15 GB a second, which is 120 Gbit a second (× 8 bits per byte). No single origin can send that.
- **At a 95% hit ratio** the origin sees 5%: 2,500 requests a second, 2,500 × 300 KB = 750 MB a second, 6 Gbit a second.
- **At 99%** it sees 500 requests a second, 1.2 Gbit a second. Four more points of hit ratio means **80% less work** for the origin (2,500 → 500).
- **For the shopper in Mumbai**: 3 round trips to Virginia ≈ 3 × (12 + 180) = **576 ms**; 3 round trips to the Mumbai PoP ≈ 3 × 12 = **36 ms**.

## What it costs and where it stops

- **Only shared content benefits.** A logged-in user's account page is different for every person; caching it would show one person's data to another. That stays on the origin.
- **Freshness is a trade-off.** A long `max-age` gives more hits but slower updates; versioned file names remove most of that tension.
- **A big purge or a too-short TTL** (time to live, how long a copy stays fresh) can send all traffic to the origin at once. The origin must be able to survive an empty cache.
- **The CDN is a bill.** You pay for data sent from the edge; it's usually far cheaper than sending it from your own servers, but measure it.
- **If the origin goes down**, `stale-if-error` in `Cache-Control` lets caches keep serving their old copies instead of errors.

## How to choose

- **Static files (images, scripts, styles, fonts)?** CDN, versioned file names, `max-age` of a year, `immutable`.
- **Pages that are the same for everyone but change sometimes?** CDN with a short `max-age` (seconds to minutes) and purge by tag when content changes.
- **Personal pages?** `Cache-Control: private` or `no-store`; never on a shared cache.
- **Paid or protected files (a course video)?** CDN with **signed URLs**: links that carry an expiry time and a signature, so only people you gave the link can fetch it.
- **Huge files released on a set date?** A push CDN, where you upload ahead of time, instead of fetching on the first miss.
- **Many PoPs or a costly origin?** Add a shield layer.

## ⚠️ Critical Mistakes

- **Caching personal pages on the CDN.** One user sees another's account. Send `private` or `no-store` for anything personal.
- **Cookies or tracking settings in the cache key.** The hit ratio collapses. Keep the key to what changes the answer.
- **Purging on every deploy instead of versioning file names.** Slow, error-prone, and each purge floods the origin.
- **Long `max-age` on a file whose name never changes.** Users keep the old version for a year.
- **An origin that can't survive a cold cache.** One bad purge takes the site down.
- **Not watching the hit ratio.** A bad rule can quietly drop it from 95% to 50%.

## Interview Q&As

**Q: How do you update a file that's cached for a year?**

A: Don't update it: give the new version a new name with a content fingerprint (`app.b71e02.js`) and point the page at it. The old name stops being requested. Purge only for addresses that can't change.

**Q: Why does a cookie in the cache key hurt?**

A: Every visitor has a different cookie, so every visitor gets a separate cache entry for the same file. Almost every request becomes a miss and goes to the origin. Ignore cookies and strip tracking settings for static files.

**Q: A product page is cached, but its price just changed. What can you do?**

A: Purge it by URL or, better, by a tag like `product-1842` that every page showing that product carries. Keep `max-age` short for pages with prices, or load the price separately from an uncached API.

**Q: What happens when a million people ask for a new file the moment it's released?**

A: Every PoP misses at once. Request collapsing at each edge sends one request upstream per file, and a shield layer turns hundreds of PoP misses into one request to the origin. Pre-warming the cache before release helps too.

**Q: How do you serve paid videos through a CDN?**

A: Signed URLs or signed cookies: the origin gives each paying user a link with an expiry and a signature, and the CDN checks the signature before serving.

## Related topics

- [Video Streaming](/?topic=video-streaming&read): video split into segments that CDNs cache for a year.
- [Global Load Balancing](/?topic=global-load-balancing&read): sending users to the nearest region, the same idea one level up.
- [Distributed Cache](/?topic=distributed-cache&read): caching data inside your own system.
- [Load Balancer](/?topic=load-balancer&read): spreading the misses across origin servers.

## Sources

- IETF: [RFC 9111, HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111) and [RFC 8246, HTTP Immutable Responses](https://www.rfc-editor.org/rfc/rfc8246)
- MDN: [Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control) and [ETag](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag)
- Cloudflare: [What is a CDN?](https://www.cloudflare.com/learning/cdn/what-is-a-cdn/)
- System Design Primer: [Content delivery network](https://github.com/donnemartin/system-design-primer#content-delivery-network)

## Why This Matters

Nearly every system with images, scripts or video puts a CDN in front, and interviewers expect you to draw it and then explain it: what may be cached, how long, how you update a cached file, and why personal data must never land there. The numbers here (180 ms versus 12 ms, 95% versus 99% hits) let you show why it matters instead of just saying it does.
