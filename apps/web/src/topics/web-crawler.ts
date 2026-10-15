import type { Trace } from '@structura/shared'
import { json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design a web crawler" in the System Design Primer by Donne
// Martin (CC BY 4.0). Requirements, estimates and the core design follow the
// primer; the walkthrough, simulator and code are Structura's.

const PAGES: Record<string, { url: string; title: string; words: string[]; similarTo?: string; lastCrawledDays?: number }> = {
  'A new page': { url: 'https://blog.example.org/raft-explained', title: 'Raft, explained', words: ['raft', 'consensus', 'leader', 'election', 'log'] },
  'A copy of a page we have (mirror site)': {
    url: 'https://mirror.example.net/raft-explained',
    title: 'Raft, explained',
    words: ['raft', 'consensus', 'leader', 'election', 'log'],
    similarTo: 'https://blog.example.org/raft-explained',
  },
  'A page crawled 9 days ago': { url: 'https://news.example.com/', title: 'Example News', words: ['news', 'world', 'markets'], lastCrawledDays: 9 },
}

/** A short hex signature of a page's content, like a simhash. */
const signature = (words: string[]) => stableHash(words.join(' ')).toString(16).padStart(8, '0')

const simulator: Simulator = {
  fields: [{ id: 'page', label: 'Next link in the queue', options: Object.keys(PAGES) }],
  defaults: { page: 'A new page' },
  run({ page }) {
    const p = PAGES[page] ?? PAGES['A new page']
    const sig = signature(p.words)
    const steps: Trace['steps'] = [
      {
        text: 'The Crawler Service takes the highest-priority link from links_to_crawl. Priorities start from site popularity, so important pages are crawled first.',
        nodes: ['Crawler Service', 'links_to_crawl'],
        data: `extract_max_priority_page()\n→ ${json({ url: p.url, priority: 0.82 })}`,
      },
      {
        text: 'It fetches the page from The Web (respecting robots.txt and a per-site rate limit), then computes a signature from its content.',
        nodes: ['Crawler Service', 'The Web'],
        data: `GET ${p.url}\n→ 200 OK, 512 KB\nsignature = simhash(words) = ${sig}`,
      },
    ]

    if (p.similarTo) {
      steps.push(
        {
          text: 'Similar page crawled? Yes: crawled_links already holds a page with a near-identical signature. Crawling it again would waste work, and following its links could send the crawler round a cycle.',
          nodes: ['Similar page crawled?', 'crawled_links'],
          data: `crawled_similar(${sig})\n→ match: ${p.similarTo} (similarity 0.97)`,
        },
        {
          text: 'So the link\'s priority is lowered instead, and the crawler moves on. Nothing is indexed.',
          nodes: ['links_to_crawl'],
          data: `reduce_priority_link_to_crawl("${p.url}")  0.82 → 0.10`,
        },
      )
      return { input: p.url, steps }
    }

    steps.push({
      text: p.lastCrawledDays
        ? `Similar page crawled? Only its own earlier copy, ${p.lastCrawledDays} days ago: older than the 7-day refresh window, so it is crawled again to stay fresh.`
        : 'Similar page crawled? No signature in crawled_links is close, so this is new content.',
      nodes: ['Similar page crawled?', 'crawled_links'],
      data: p.lastCrawledDays ? `last crawled ${p.lastCrawledDays} days ago > refresh window 7 days → re-crawl` : `crawled_similar(${sig}) → none`,
    })
    steps.push(
      {
        text: 'Two jobs are queued: one for the Reverse Index Service (which words appear on which pages) and one for the Document Service (a static title and snippet). Queues let crawling run at its own pace.',
        nodes: ['Crawler Service', 'Reverse Index Queue', 'Document Queue'],
        data: `reverse_index_queue.put(${json({ url: p.url, words: p.words })})\ndoc_queue.put(${json({ url: p.url, title: p.title })})`,
      },
      {
        text: 'The link moves from links_to_crawl to crawled_links with its signature, and the page\'s own links are added to links_to_crawl for later.',
        nodes: ['links_to_crawl', 'crawled_links'],
        data: `remove_link_to_crawl("${p.url}")\ninsert_crawled_link("${p.url}", "${sig}")\nadd_link_to_crawl(…14 child links)`,
      },
      {
        text: 'The Reverse Index Service adds the page to each word\'s posting list in the Reverse Index; the Document Service stores its title and snippet.',
        nodes: ['Reverse Index Service', 'Reverse Index', 'Document Service', 'Titles & Snippets'],
        data: p.words.map((w) => `${w.padEnd(10)} → [..., "${p.url}"]`).join('\n'),
      },
      {
        text: `Later, someone searches for "${p.words[0]} ${p.words[1]}". The Query API parses the query, finds matching pages in the Reverse Index, ranks them, and fetches titles and snippets.`,
        nodes: ['User', 'Web Server', 'Query API', 'Reverse Index', 'Titles & Snippets'],
        data: `GET /api/v1/search?query=${p.words[0]}+${p.words[1]}\n→ ${json([{ title: p.title, snippet: `…${p.words.join(' ')}…`, link: p.url }])}`,
      },
    )
    return { input: p.url, steps }
  },
}

export const webCrawler: StaticTopic = {
  difficulty: 'Intermediate',
  kind: 'static',
  id: 'web-crawler',
  title: 'Web Crawler & Search',
  blurb: 'Priority frontier, duplicate detection, reverse index, freshness',
  adaptedFrom: {
    title: 'Design a web crawler',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/web_crawler/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: ['primer-design-a-web-crawler', 'primer-asynchronism', 'how-do-search-engines-work', 'how-to-avoid-crawling-duplicate-urls-at-google-scale'],
  takeaways: [
    'Crawl from a priority queue (the frontier), seeded by site popularity.',
    'Detect duplicate content with page signatures, or the crawler loops and wastes work.',
    'Lower a duplicate\'s priority instead of crawling it again.',
    'Hand indexing and snippet generation to queues so crawling never waits on them.',
    'A reverse index maps each word to the pages containing it; search reads only that.',
    'Re-crawl on a schedule (about weekly), more often for pages that change often.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'crawl', label: 'Crawling' },
      { id: 'index', label: 'Indexing' },
      { id: 'serve', label: 'Search' },
    ],
    nodes: [
      { id: 'frontier', label: 'links_to_crawl', shape: 'rectangle', color: 'green', group: 'crawl' },
      { id: 'crawler', label: 'Crawler Service', shape: 'rectangle', color: 'orange', group: 'crawl' },
      { id: 'web', label: 'The Web', shape: 'cloud', color: 'light-blue', group: null },
      { id: 'similar', label: 'Similar page crawled?', shape: 'diamond', color: 'violet', group: 'crawl' },
      { id: 'crawled', label: 'crawled_links', shape: 'rectangle', color: 'green', group: 'crawl' },
      { id: 'riq', label: 'Reverse Index Queue', shape: 'rectangle', color: 'yellow', group: 'index' },
      { id: 'dq', label: 'Document Queue', shape: 'rectangle', color: 'yellow', group: 'index' },
      { id: 'ris', label: 'Reverse Index Service', shape: 'rectangle', color: 'violet', group: 'index' },
      { id: 'ds', label: 'Document Service', shape: 'rectangle', color: 'violet', group: 'index' },
      { id: 'index', label: 'Reverse Index', shape: 'rectangle', color: 'green', group: 'index' },
      { id: 'docs', label: 'Titles & Snippets', shape: 'rectangle', color: 'green', group: 'index' },
      { id: 'user', label: 'User', shape: 'ellipse', color: 'blue', group: null },
      { id: 'server', label: 'Web Server', shape: 'rectangle', color: 'violet', group: 'serve' },
      { id: 'query', label: 'Query API', shape: 'rectangle', color: 'violet', group: 'serve' },
    ],
    edges: [
      { from: 'frontier', to: 'crawler', label: 'top-priority link', dashed: false },
      { from: 'crawler', to: 'web', label: 'fetch page', dashed: false },
      { from: 'crawler', to: 'similar', label: 'page signature', dashed: false },
      { from: 'similar', to: 'crawled', label: 'compare', dashed: false },
      { from: 'similar', to: 'frontier', label: 'yes: lower priority', dashed: true },
      { from: 'crawler', to: 'riq', label: 'index job', dashed: false },
      { from: 'crawler', to: 'dq', label: 'snippet job', dashed: false },
      { from: 'crawler', to: 'frontier', label: 'add child links', dashed: true },
      { from: 'riq', to: 'ris', label: null, dashed: false },
      { from: 'dq', to: 'ds', label: null, dashed: false },
      { from: 'ris', to: 'index', label: 'word → pages', dashed: false },
      { from: 'ds', to: 'docs', label: 'title, snippet', dashed: false },
      { from: 'user', to: 'server', label: 'search', dashed: false },
      { from: 'server', to: 'query', label: null, dashed: false },
      { from: 'query', to: 'index', label: 'match terms', dashed: false },
      { from: 'query', to: 'docs', label: 'fetch snippets', dashed: false },
    ],
  },
  database: null,
  explanation: {
    title: 'Web Crawler & Search',
    summary:
      'A crawler keeps a priority queue of links, fetches the most important page, skips it if a near-identical page was already crawled, and otherwise queues it for indexing. Search reads only the reverse index (word → pages) and the stored titles and snippets.',
    sections: [
      {
        heading: 'Overview',
        body: 'Two systems share the data:\n- The crawler: runs all the time, turning links into indexed pages. It is write-heavy and must never get stuck in a loop.\n- Search: answers user queries from the index. It is read-heavy and must be fast.\n\nThe web is a graph full of cycles and copies (mirrors, URL parameters, printer-friendly pages), so most of the design is about deciding what not to crawl.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- Crawl a list of URLs, building a reverse index of words to pages and a static title and snippet per page.\n- A user searches and sees relevant pages with titles and snippets.\n- High availability.\n\nOut of scope: search analytics, personalized results, PageRank.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions from the System Design Primer:\n- 1 billion links, refreshed about weekly: 4 billion crawls a month.\n- 500 KB stored per page; 100 billion searches a month.\n\nWhich works out to:\n- 2 PB of page content a month, 72 PB in three years.\n- About 1,600 page writes per second.\n- About 40,000 searches per second.',
      },
      {
        heading: 'Step by step',
        body: '1. The Crawler Service takes the top-priority link from links_to_crawl.\n2. It fetches the page from The Web and computes a content signature.\n3. Similar page crawled? It checks crawled_links for a close signature.\n4. If yes, it lowers the link\'s priority in links_to_crawl and moves on.\n5. If no, it queues jobs on the Reverse Index Queue and the Document Queue.\n6. It moves the link to crawled_links and adds the page\'s links to links_to_crawl.\n7. The Reverse Index Service updates the Reverse Index; the Document Service stores Titles & Snippets.\n8. A User searches through the Web Server; the Query API reads the Reverse Index and Titles & Snippets.',
      },
      {
        heading: 'Components',
        body: '- links_to_crawl: the frontier, a priority queue of URLs (NoSQL, or a sorted set in Redis).\n- crawled_links: every crawled URL with its signature and last-crawl time.\n- Crawler Service: many workers pulling from the frontier, polite per site.\n- Reverse Index Queue and Document Queue: decouple crawling from indexing.\n- Reverse Index Service: maintains word → list of pages (posting lists), sharded by word.\n- Document Service: generates static titles and snippets.\n- Query API: parses the query (strip markup, split terms, fix typos, normalize case, build a boolean query), looks up the index, ranks, and adds snippets.',
      },
      {
        heading: 'Key decisions',
        body: '- Duplicate URLs: with a billion links, deduplicate with MapReduce (keep URLs whose count is 1) or a Bloom filter in front of the frontier.\n- Duplicate content: compare page signatures (simhash, or Jaccard and cosine similarity over word sets). Near-duplicates, not just exact copies, must match.\n- Freshness: store a last-crawled timestamp; refresh about weekly, more often for popular or frequently changing pages. Learn each page\'s change rate over time.\n- Politeness: obey robots.txt and limit requests per site, or you will be blocked (and you will hurt small sites).\n- Static snippets: generated once at crawl time, so search never touches page content.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Shard the frontier and assign each site to one worker group, which makes per-site rate limits easy.\n- DNS lookups add up at this scale: cache them in the crawler.\n- Popular queries repeat a lot: cache their results in front of the Query API.\n- Shard the Reverse Index by word or by document; a query fans out to shards and merges the results.\n- A crawler worker crashing mid-page just leaves the link in links_to_crawl; jobs on the queues retry.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you detect that two pages are the same article with different ads around it?\n- How do you avoid crawler traps, such as infinite calendar pages?\n- How would you decide which pages to re-crawl every hour?\n- How would you shard the reverse index, and what does a query cost in each case?\n- How would you add PageRank to the ranking?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Crawler loop',
        language: 'python',
        source: `class Crawler:
    """Pulls the most important link, skips near-duplicates, queues indexing."""

    def __init__(self, store, reverse_index_queue, doc_queue):
        self.store = store
        self.reverse_index_queue = reverse_index_queue
        self.doc_queue = doc_queue

    def crawl(self):
        while (page := self.store.extract_max_priority_page()) is not None:
            if self.store.crawled_similar(page.signature):
                # Seen this content: don't crawl it again (avoids cycles).
                self.store.reduce_priority_link_to_crawl(page.url)
                continue
            self.reverse_index_queue.put(page)
            self.doc_queue.put(page)
            for url in page.child_urls:
                self.store.add_link_to_crawl(url)
            self.store.remove_link_to_crawl(page.url)
            self.store.insert_crawled_link(page.url, page.signature)`,
      },
      {
        title: 'Near-duplicate check (simhash)',
        language: 'python',
        source: `import hashlib

def simhash(words: list[str], bits: int = 64) -> int:
    """Similar pages get signatures that differ in only a few bits."""
    weights = [0] * bits
    for word in words:
        h = int(hashlib.md5(word.encode()).hexdigest(), 16)
        for i in range(bits):
            weights[i] += 1 if h >> i & 1 else -1
    return sum(1 << i for i, w in enumerate(weights) if w > 0)

def similar(a: int, b: int, max_different_bits: int = 3) -> bool:
    return bin(a ^ b).count("1") <= max_different_bits`,
      },
    ],
    related: ['Bloom filter', 'MapReduce', 'Inverted index', 'Message queues', 'Consistent hashing'],
  },
  simulator,
}
