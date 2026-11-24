import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Fetch pages, then search them',
      text: 'A crawler downloads pages from the web and follows their links. Search then answers questions from what the crawler saved, never from the live web.',
      focus: ['Crawler Service', 'The Web', 'Query API'],
    },
    {
      title: 'The scale',
      text: '1 billion links refreshed about weekly is 4 billion crawls a month, about 1,600 pages a second. At 500 KB a page, that is 2 PB of pages a month.',
      example: '4 billion × 500 KB = 2 PB a month',
    },
    {
      title: 'A priority queue of links',
      text: 'links_to_crawl is the frontier: a queue of links ordered by importance. Popular sites come first. The Crawler Service always takes the most important link next.',
      focus: ['links_to_crawl', 'Crawler Service'],
    },
    {
      title: 'Skip near-copies',
      text: 'Many pages are almost the same. The crawler makes a signature of each page and compares it with ones already crawled. A near-copy gets a lower priority instead of being crawled again.',
      focus: ['Similar page crawled?', 'crawled_links'],
      remember: 'Without duplicate checks, the crawler loops and wastes work.',
    },
    {
      title: 'Indexing waits in queues',
      text: 'A new page goes on two queues: one for the reverse index, one for titles and snippets. The crawler moves on at once; other services do the slow work.',
      focus: ['Reverse Index Queue', 'Document Queue', 'Reverse Index Service', 'Document Service'],
    },
    {
      title: 'The reverse index',
      text: 'A reverse index maps each word to the pages that contain it. To answer "system design", search looks up both words and keeps the pages in both lists.',
      focus: ['Reverse Index'],
      example: 'system → [p12, p88, p301]\ndesign → [p88, p301, p990]\nboth → [p88, p301]',
    },
    {
      title: 'Search reads only the index',
      text: 'The Query API reads the reverse index and the stored titles and snippets. It never opens page content, so 40k searches a second stay fast.',
      focus: ['User', 'Web Server', 'Query API', 'Titles & Snippets'],
    },
    {
      title: 'Be polite, stay fresh',
      text: 'Obey each site\'s robots.txt and limit requests per site, or you will be blocked. Re-crawl about weekly, and more often for pages that change often.',
    },
  ],
  quiz: [
    {
      question: 'What does a reverse index store?',
      options: ['Each page\'s full text', 'For each word, the pages that contain it', 'Links to crawl', 'User searches'],
      answer: 1,
      why: 'Word → pages is what lets a search find matching pages without reading them.',
    },
    {
      question: 'Why check for near-duplicate pages?',
      options: ['To save crawls and avoid loops', 'To make pages load faster', 'To obey robots.txt', 'To build snippets'],
      answer: 0,
      why: 'Mirrors and copies would otherwise be crawled again and again.',
    },
    {
      question: 'Why do indexing and snippets go through queues?',
      options: ['Queues are cheaper than disks', 'So the crawler never waits for that slow work', 'To sort pages by date', 'To delete old pages'],
      answer: 1,
      why: 'The crawler hands the page off and fetches the next one; services index at their own pace.',
    },
  ],
}

export default lesson
