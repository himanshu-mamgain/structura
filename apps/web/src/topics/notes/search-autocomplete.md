# Search Autocomplete (Typeahead)

> 💡 **TL;DR**: **Autocomplete** (also called typeahead) shows likely searches as you type: after "mon", it offers "monsoon sale", "monday motivation", and so on. Each keystroke is a **prefix lookup** that must answer in about **100 ms**, billions of times a day. The design has two halves. The **serving path** answers fast: the browser waits for a short pause in typing (**debounce**), caches answer most requests, and the rest go to an in-memory **trie** whose every node already stores its **top 10** suggestions. The **learning path** is slow and offline: every search goes into a log, a daily job counts them and builds a new trie, and servers swap it in. A small **trending layer** lets breaking news appear within minutes.

## At a glance

| Question | Answer |
|---|---|
| What it does | Suggests whole searches from the letters typed so far |
| Time budget | About 100 ms per keystroke, end to end |
| Debounce | The browser waits about 150 ms after the last key before asking |
| Caches | Browser and edge, then Redis: most prefixes repeat |
| Trie | A tree with one letter per step; each node stores its top 10 suggestions |
| A lookup | As many steps as letters typed, then read the stored list |
| Learning | Search log → daily counts → new trie → swapped in as a snapshot |
| Breaking news | A trending layer that counts the last hour |
| Banned phrases | Filtered when serving, with spare suggestions to refill the list |
| Load in the example | About 4,630 requests a second, 13.9k at peak; the trie is 14.4 GB |

## What autocomplete is, and what a trie is

**Autocomplete** saves typing and steers people to searches that work. It must feel instant: if suggestions arrive after the next keystroke, they're useless. So every answer must come back in roughly 100 ms, including the network.

A **trie** (from "retrieval", also called a prefix tree) is a tree in which each step down is one letter. The path from the top spells a prefix: root → `m` → `o` → `n` is the node for "mon". Every search that starts with "mon" lives somewhere below that node.

```text
(root)
 └─ m
     └─ o
         └─ n   top: monsoon sale, monday motivation, monsoon 2026, money plant …
             ├─ s ─ o ─ o ─ n   top: monsoon sale, monsoon 2026, monsoon session …
             └─ d ─ a ─ y       top: monday motivation, monday quotes …
```

Finding the node for a prefix takes one step per letter, however many queries the trie holds.

## The key trick: store the answer on every node

Finding the "mon" node is quick, but below it could be millions of queries. Searching all of them for the 10 most popular on every keystroke would be far too slow.

So when the trie is **built**, each node stores its **top 10** suggestions (plus a few spares) already worked out. A lookup becomes: walk 3 steps, read the stored list. Done.

The price is memory: every node carries a list. That's the trade, and it's worth it.

## Follow one keystroke all the way through

Asha types "mon" in the search box.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | She types `m`, `o`, `n` quickly; the box waits 150 ms after `n`, then asks for "mon" only | Search box |
| 2 | The browser and the edge cache don't have "mon" from the last minute | Edge Cache |
| 3 | The request reaches the Suggestion API, which checks Redis: a miss | Suggestion API → Prefix Cache (Redis) |
| 4 | It asks the trie shard for prefixes starting with `m` | Trie Servers |
| 5 | The trie walks `m` → `o` → `n` and reads the stored top 10 plus spares | Trie Servers |
| 6 | A banned phrase is removed; a spare fills its place | Blocklist Filter |
| 7 | "monsoon session parliament" is spiking this hour, so it's boosted in | Trending Layer |
| 8 | The list is saved in Redis for 60 seconds and at the edge, then shown | Prefix Cache (Redis), Edge Cache → Search box |
| 9 | Asha picks "monsoon sale"; the search is written to the log | Query Log (Kafka) |
| 10 | Tonight, that search adds 1 to the count used for tomorrow's trie | Aggregator → Query Counts DB → Trie Builder |

## The serving path: most requests never reach the trie

- **Debounce**: the browser waits about 150 ms after the last key. A fast typist typing "monsoon" sends one request, not seven. The browser also ignores late answers for prefixes the user has already typed past.
- **Caches**: many people type the same prefixes ("how to", "wea"). The browser, the edge (servers near the user) and Redis each keep recent answers for a minute or two, so the trie only sees the long tail.
- **Sharding**: the trie is split across servers by the first letter(s) of the prefix. Splitting by first letter alone is uneven (far more searches start with "s" than "x"), so real systems split by measured load.

```javascript
let timer
input.addEventListener('input', () => {
  clearTimeout(timer)
  const prefix = input.value
  timer = setTimeout(async () => {
    const res = await fetch(`/suggest?q=${encodeURIComponent(prefix)}`)
    const list = await res.json()
    if (input.value === prefix) show(list) // ignore answers for an older prefix
  }, 150) // debounce: wait 150 ms after the last key
})
```

## The learning path: build offline, swap in

Updating counts in the trie on every search would lock the busiest nodes and make suggestions jump around. Instead:

1. Every submitted search goes into the **Query Log**, a Kafka stream.
2. The **Aggregator** counts searches per query and stores weekly totals in the **Query Counts DB**.
3. Once a day the **Trie Builder** builds a fresh trie with the top 10 on every node, and saves it as a **snapshot** in object storage.
4. Trie servers download the snapshot and switch to it without downtime. If a build is bad, they load the previous one.

### Trending: news in minutes, not a day

A daily trie can't show a story that broke an hour ago. A small **Trending Layer** counts the last hour, and suggestions are scored as:

score = weekly count + 100 × count in the last hour

"monsoon session parliament" with 300 searches this week but 120 in the last hour scores 300 + 100 × 120 = **12,300**, enough to jump into the list today.

## The numbers, worked out

An example: 10 million daily users, 10 searches each, and (thanks to debounce) about 4 suggestion requests per search.

- **Searches**: 10 million × 10 = **100 million a day**.
- **Suggestion requests**: 100 million × 4 = 400 million a day ÷ 86,400 s ≈ **4,630 a second**; at about 3 times that at peak, **13.9k a second**.
- **Distinct queries kept**: about 50 million after dropping rare ones; at 25 bytes each, 1.25 GB of text.
- **Trie size**: about 300 million nodes. A node holds 8 bytes of links plus 10 suggestion IDs at 4 bytes each: 8 + 40 = **48 bytes**. 300 million × 48 bytes = **14.4 GB**: fits in memory, split over 4 shards of about 3.6 GB each, plus copies.

## What it costs and where it stops

- **Memory** for the stored top-k on every node: 14.4 GB here. Worth it for instant lookups.
- **Up to a day old**: the main trie changes daily; only the trending layer is fresh.
- **Exact prefixes only**: a plain trie can't fix "monsooon". Typo-tolerant suggestions need an extra fuzzy-matching step or index.
- **Personal suggestions** (your own past searches) mean merging a small per-user list with the global one.
- **Never block the search**: if suggestions are slow, show none.

## How to choose

- **A small, fixed list** (countries, your product names)? Filter it in the browser; no server needed.
- **Millions of queries, ranked by popularity?** A trie with top-k on every node, built offline, behind caches.
- **Need typo tolerance or full-text matching?** A search engine with an n-gram or fuzzy index.
- **News matters?** Add a short-window trending layer.

## ⚠️ Critical Mistakes

- **A request on every keystroke.** Debounce, and cancel outdated requests.
- **Searching the subtree on each request.** Store the top-k on every node at build time.
- **Updating the trie live on every search.** It locks hot nodes and suggestions flicker. Rebuild offline and swap.
- **No blocklist at serving time.** Offensive suggestions appear until the next build.
- **Showing late answers.** An answer for "mo" arriving after "mon" overwrites the right one.

## Interview Q&As

**Q: Why store the top suggestions on every trie node?**

A: Because the subtree under a short prefix like "a" holds millions of queries. Finding the top 10 at request time would be far too slow; storing them at build time makes each lookup one step per letter plus one read.

**Q: How do you keep suggestions fresh?**

A: Rebuild the trie daily from the search log and swap in the snapshot, and add a trending layer that counts the last hour, so breaking news appears in minutes.

**Q: How do you handle 14k requests a second?**

A: Debounce in the browser, cache answers in the browser, at the edge and in Redis, and serve only the remaining misses from in-memory trie shards with replicas.

**Q: How do you remove a bad suggestion right now?**

A: Filter it at serving time with a blocklist and refill from the spare suggestions stored on each node, then clear caches by bumping a version in the cache key. The next build drops it for good.

## Related topics

- [Web Crawler & Search](/?topic=web-crawler&read): what happens after the user presses Enter.
- [Distributed Cache](/?topic=distributed-cache&read): the Redis cache in front of the trie.
- [CDN](/?topic=cdn&read): edge caching of popular prefixes.
- [Kafka Basics](/?topic=kafka-basics&read): the search log.

## Sources

- MDN: [Debouncing](https://developer.mozilla.org/en-US/docs/Glossary/Debounce)
- Wikipedia: [Trie](https://en.wikipedia.org/wiki/Trie)
- Redis: [EXPIRE command](https://redis.io/docs/latest/commands/expire/)

## Why This Matters

"Design search autocomplete" is a common question because it mixes data structures with systems: you need the trie and the top-k-per-node trick, and then caching, sharding and offline builds to make it fast at scale. It's a clean example of splitting a fast serving path from a slow learning path, a pattern you'll reuse for recommendations, rankings and feeds.
