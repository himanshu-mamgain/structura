# Web Crawler & Search

> 💡 **TL;DR**: A **web crawler** downloads pages from the web and follows their links to find more pages; a **search engine** then answers questions from what the crawler saved, never from the live web. The crawler keeps a **priority queue** of links to visit (the **frontier**), always takes the most important one next, and skips pages that are **near-copies** of ones it already has. New pages go onto **queues** to be indexed, so crawling never waits. Search reads only a **reverse index** (each word → the pages that contain it) plus stored titles and snippets. The crawler must be **polite** (obey each site's `robots.txt` and limit its speed per site) and **re-crawl** pages about weekly to stay fresh.

## At a glance

| Question | Answer |
|---|---|
| Crawler | Fetches pages and follows their links |
| Frontier | `links_to_crawl`: a priority queue of URLs, most important first |
| Already crawled | `crawled_links`: each URL with its content signature and last crawl time |
| Near-copies | Found by comparing page signatures; they get a lower priority instead of a re-crawl |
| Indexing | Through queues, so the crawler never waits for it |
| Reverse index | Word → list of pages containing it |
| Search reads | Only the reverse index and stored titles and snippets |
| Politeness | Obey `robots.txt`, limit requests per site |
| Freshness | Re-crawl about weekly; more often for pages that change often |
| Scale in the example | 4 billion crawls a month, 2 PB of pages a month, 40k searches a second |

## What a crawler and a search engine are

A **web crawler** (also called a spider) is a program that downloads a page, finds the links in it, adds them to its list, and repeats. Starting from a few well-known sites, it gradually reaches billions of pages.

A **search engine** answers a query like "monsoon shoes sale" by looking things up in data the crawler collected earlier. It never fetches pages while you wait; that would take seconds per page.

They are two separate systems joined by queues: the crawler produces pages, indexing services turn pages into searchable data, and the search side reads that data.

## Follow one page all the way through

The crawler takes `https://shop.example/monsoon-sale` from the top of the frontier.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Take the highest-priority link from the frontier | links_to_crawl → Crawler Service |
| 2 | Check `shop.example/robots.txt` allows it, and that we haven't hit this site in the last second | Crawler Service |
| 3 | Fetch the page | Crawler Service → The Web |
| 4 | Compute a signature of its content | Crawler Service |
| 5 | Compare with signatures already crawled: no close match, so it's new | Similar page crawled? → crawled_links |
| 6 | Put the page on the index queue and the document queue | Reverse Index Queue, Document Queue |
| 7 | Record the URL, signature and crawl time; add the page's 40 links to the frontier | crawled_links, links_to_crawl |
| 8 | The index service adds each word of the page to that word's list | Reverse Index Service → Reverse Index |
| 9 | The document service saves the page's title and a short snippet | Document Service → Titles & Snippets |
| 10 | Later, someone searches "monsoon sale": the Query API reads the index and snippets | User → Web Server → Query API |

If step 5 had found a near-copy (the same sale page under another URL), the crawler would lower that link's priority and move on, without indexing it again.

## The frontier: what to crawl next

`links_to_crawl` is a **priority queue**: each URL has a score, and the crawler always takes the highest. The score starts from how popular or important the site is (links pointing to it, past traffic), and drops for pages that turned out to be duplicates or rarely change.

With a billion URLs, the same URL is found many times over. Before adding a URL, check whether it's already known. A **Bloom filter** (a compact bit array that answers "definitely new" or "probably seen") does this in memory with a small error rate; at batch scale, a MapReduce job can count URLs and keep those seen once.

## Spotting near-duplicate pages

Many pages are almost the same: a print version, a page with a different tracking parameter, mirrors of the same article. Crawling and indexing them all wastes work and fills results with copies.

The crawler computes a **signature** for each page and compares it with existing ones. One simple measure is **Jaccard similarity**: the share of words two pages have in common.

| Page | Words |
|---|---|
| A | monsoon, sale, today, shoes |
| B | monsoon, sale, today, sandals |
| In both | monsoon, sale, today (3) |
| In either | monsoon, sale, today, shoes, sandals (5) |
| Jaccard | 3 ÷ 5 = **0.6** |

Comparing every page with every other page is impossible at a billion pages, so real crawlers use **simhash**: a 64-bit fingerprint made so that similar pages get fingerprints that differ in only a few bits. Two pages whose fingerprints differ in, say, 3 bits or fewer are treated as near-copies, and that check is a quick lookup.

## The reverse index: how search finds pages

A **reverse index** (also called an inverted index) maps each word to the list of pages that contain it, called a **posting list**:

```text
monsoon → [p12, p88, p301, p990]
sale    → [p7, p88, p301]
shoes   → [p88, p415]
```

A search for "monsoon sale" reads two lists and keeps the pages in both: `[p88, p301]`. No page is opened. The results are then **ranked** (by how often and where the words appear, and how important the page is) and shown with the stored titles and snippets.

```javascript
function search(index, query) {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean)
  const lists = words.map((w) => new Set(index.get(w) ?? []))
  if (lists.length === 0) return []
  return [...lists[0]].filter((page) => lists.every((list) => list.has(page)))
}

search(index, 'Monsoon sale') // ["p88", "p301"]
```

The query is cleaned first: lower case, split into words, punctuation removed. Real engines also fix typos and drop very common words.

The index is far too big for one machine, so it's **sharded by word**: each server holds the posting lists for some of the words.

## Politeness and freshness

- **Politeness**: a crawler that fetches 1k pages a second from one small site takes it down. Read each site's `robots.txt` (a file that says which paths crawlers may visit) and limit requests to each site, for example one at a time with a delay. Ignore this and you'll be blocked, and you'll hurt small sites.
- **Freshness**: pages change. Keep each page's last crawl time and re-crawl about weekly; news pages hourly, rarely changing pages monthly. Over time, learn each page's change rate and crawl it accordingly.
- **Snippets** are made once, at crawl time, so search never touches page content.

## The numbers, worked out

These assumptions come from the System Design Primer.

- **Crawls**: 1 billion links, refreshed about weekly: about **4 billion crawls a month**.
- **Crawl rate**: 4 billion a month ≈ **1,600 pages a second** (using the rule that 400 a second ≈ 1 billion a month).
- **Storage**: 500 KB a page × 4 billion = **2 PB a month**, 72 PB in three years.
- **Searches**: 100 billion a month ≈ **40k a second**.

Crawling is write-heavy and steady; search is read-heavy and spiky. Keeping them apart, joined by queues, lets each scale on its own.

## What it costs and where it stops

- **Storage is enormous**: petabytes a month. Compress pages and keep only what indexing and snippets need.
- **Traps**: endless calendars or session IDs in URLs create infinite "new" pages. Cap pages per site and depth, and normalise URLs.
- **Freshness versus cost**: re-crawling more often costs bandwidth and goodwill. Prioritise pages that change.
- **Ranking is its own large topic**: links between pages, click data and spam detection go far beyond this design.

## How to choose

- **Small, known set of sites?** A simple crawler with a queue and a delay per site is enough.
- **The whole web?** Priority frontier, de-duplication by signature, queues to indexing, sharded reverse index.
- **Exact duplicates only?** A hash of the page content. **Near-duplicates?** Simhash or similar.
- **Search over your own app's data?** A search engine such as Elasticsearch builds the reverse index for you.

## ⚠️ Critical Mistakes

- **No politeness.** Hammering a site gets you blocked and can knock it offline.
- **Indexing inside the crawler.** Crawling slows to the speed of indexing. Use queues.
- **No duplicate detection.** The crawler loops on mirrors and URL variants.
- **Searching by scanning pages.** Far too slow. Search reads the reverse index only.
- **Never re-crawling.** Results go stale; dead pages stay in results.

## Interview Q&As

**Q: How do you avoid crawling the same page again and again?**

A: Normalise URLs and check a "seen" set (a Bloom filter in memory) before adding them to the frontier. For the same content under different URLs, compare content signatures such as simhash and lower the priority of near-copies.

**Q: What is a reverse index, and how does a search use it?**

A: A map from each word to the pages containing it. A search splits the query into words, reads each word's list, keeps the pages in all of them, ranks them and adds stored snippets, without opening any page.

**Q: How do you keep results fresh?**

A: Store each page's last crawl time and re-crawl on a schedule, more often for pages that change often. Learn each page's change rate from past crawls.

**Q: How do you avoid overloading websites?**

A: Obey `robots.txt`, limit requests per site (one at a time with a delay), and spread crawling across many sites at once instead of many pages of one site.

## Related topics

- [Search Autocomplete](/?topic=search-autocomplete&read): suggestions as you type, from past searches.
- [Message Queue](/?topic=message-queue&read): the queues between crawling and indexing.
- [Database Sharding](/?topic=database-sharding&read): splitting a huge index across servers.
- [Twitter Timeline & Search](/?topic=twitter-timeline&read): a reverse index for tweets.

## Sources

- System Design Primer: [Design a web crawler](https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/web_crawler/README.md) (CC BY 4.0), the source of this topic's requirements and estimates
- Google Search Central: [Introduction to robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
- Manku, Jain and Das Sarma (Google): [Detecting Near-Duplicates for Web Crawling](https://research.google/pubs/detecting-near-duplicates-for-web-crawling/) (WWW 2007, simhash)
- Manning, Raghavan and Schütze: [Introduction to Information Retrieval, chapter 1: the inverted index](https://nlp.stanford.edu/IR-book/html/htmledition/a-first-take-at-building-an-inverted-index-1.html)

## Why This Matters

"Design a web crawler" is a classic question that tests scale, politeness, de-duplication and decoupling with queues. And the reverse index behind search appears everywhere: product search, log search, tweet search. Knowing how a frontier, signatures and posting lists fit together lets you design both halves and explain why search never reads the live web.
