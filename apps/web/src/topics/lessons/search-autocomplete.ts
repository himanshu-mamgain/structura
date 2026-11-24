import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Suggestions as you type',
      text: 'Autocomplete shows likely searches after each letter you type. Each keystroke is a prefix lookup that must answer in about 100 ms.',
      focus: ['Search box', 'Suggestion API'],
    },
    {
      title: 'The numbers',
      text: '10 million users make 10 searches each: 100 million searches a day. With about 4 suggestion requests per search, that is about 4,630 requests a second, and about 13.9k at peak.',
      example: '400 million ÷ 86,400 s ≈ 4,630 a second',
    },
    {
      title: 'Wait a moment before asking',
      text: 'The search box waits about 150 ms after the last key before it asks. This is called debounce. Fast typists send far fewer requests.',
      focus: ['Search box'],
    },
    {
      title: 'Caches answer most requests',
      text: 'Many people type the same prefixes. The Edge Cache near the user and the Prefix Cache in Redis answer most of them. Only misses reach the Trie Servers.',
      focus: ['Edge Cache', 'Prefix Cache (Redis)', 'Trie Servers'],
    },
    {
      title: 'A trie with the answers ready',
      text: 'A trie is a tree where each step is one letter. Each node already stores its top 10 suggestions. So "syst" takes 4 steps and the answer is waiting there.',
      focus: ['Trie Servers'],
      example: 's → y → s → t: ["system design", "systemctl", …]',
      remember: 'Top-k stored on each node: no searching at request time.',
    },
    {
      title: 'Build the trie offline',
      text: 'Every search goes into a Kafka log. Each day the Aggregator counts queries and the Trie Builder makes a new trie. Servers swap in the new snapshot.',
      focus: ['Query Log (Kafka)', 'Aggregator', 'Query Counts DB', 'Trie Builder', 'Trie Snapshot Store'],
    },
    {
      title: 'News appears in minutes',
      text: 'A daily trie is too slow for breaking news. A small Trending Layer counts the last hour and boosts those queries on top of the big trie.',
      focus: ['Trending Layer'],
    },
    {
      title: 'Filter what must not show',
      text: 'The Blocklist Filter removes banned phrases when serving. Each node keeps a few spare suggestions, so the list stays full after filtering.',
      focus: ['Blocklist Filter'],
    },
  ],
  quiz: [
    {
      question: 'Why store the top suggestions on every trie node?',
      options: ['To save memory', 'So a lookup needs no search through the subtree', 'To make the trie smaller', 'To skip caching'],
      answer: 1,
      why: 'For a short prefix like "a", the subtree holds millions of queries; precomputing avoids scanning them.',
    },
    {
      question: 'Why rebuild the trie daily instead of updating it on every search?',
      options: ['Updates on every search would lock hot nodes and make results jump', 'Tries cannot change', 'Searches are rare', 'Kafka requires it'],
      answer: 0,
      why: 'Offline builds keep serving simple and fast; the trending layer handles fresh news.',
    },
    {
      question: 'What does debounce do?',
      options: ['Caches results', 'Waits briefly after the last key before sending a request', 'Filters banned words', 'Sorts suggestions'],
      answer: 1,
      why: 'Waiting about 150 ms means a fast typist sends one request, not one per letter.',
    },
  ],
}

export default lesson
