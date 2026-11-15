import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'The same searches, again and again',
      text: 'A few searches, like "weather" or a trending name, make up most of the traffic. Working out each answer from the search index is slow. So the Query API remembers recent answers in a cache, and only searches the index when the answer isn\'t there.',
      focus: ['Client', 'Query API', 'Memory Cache (Redis)'],
    },
    {
      title: 'Clean the query first',
      text: 'Before looking in the cache, the Query API cleans the query: lower case, no extra spaces or punctuation. Then "Weather in London" and "weather  in london!" share one cache entry, so more searches find an answer.',
      focus: ['Query API'],
      example: '"Weather  in London!" → "weather in london"',
    },
    {
      title: 'Split the cache into shards',
      text: 'The cache is too big for one machine, so it is split into shards. The router hashes each query and picks the shard that owns it, so any server can find any query.',
      focus: ['Cache Router', 'Memory Cache (Redis)'],
      example: '50 million popular queries × 2,650 bytes ≈ 133 GB\n÷ 16 shards ≈ 8 GB each',
    },
    {
      title: 'A hit is the whole job',
      text: 'If the answer is in the cache, it goes straight back to the user: one lookup in memory, and the index never hears about it.',
      focus: ['Query API', 'Memory Cache (Redis)', 'Client'],
      example: 'About 3,900 searches a second\n86% answered from the cache ≈ 3,300\nOnly ≈ 540 reach the index',
    },
    {
      title: 'A miss searches the index',
      text: 'On a miss, the index service finds the documents that contain every word of the query. The document service fetches their titles and snippets. Then the answer is saved in the cache for next time.',
      focus: ['Reverse Index Service', 'Inverted Index Store', 'Document Service', 'Document Store'],
    },
    {
      title: 'LRU: throw out what\'s gone quiet',
      text: 'When a shard is full, it removes the entry that was used least recently (LRU). A hash map finds entries instantly, and a linked list keeps them in order of use, so both steps are fast.',
      focus: ['Memory Cache (Redis)'],
      remember: 'A search that stops trending drifts to the back of the list and leaves on its own.',
    },
    {
      title: 'Keeping answers fresh',
      text: 'Every entry has a TTL, here 300 seconds, so nothing is out of date for longer than that. When the index changes, a worker can also delete the answers that changed, for news that must be fresh.',
      focus: ['Index Update Queue', 'Invalidation Worker', 'Memory Cache (Redis)'],
    },
    {
      title: 'When a popular entry expires',
      text: 'If a very popular entry expires, thousands of searches miss at the same moment and all hit the index. Let one request rebuild it while the others wait or get the old answer, and add a little randomness to TTLs so entries don\'t all expire together.',
      focus: ['Query API', 'Reverse Index Service'],
    },
  ],
  quiz: [
    {
      question: 'Why clean the query before using it as the cache key?',
      options: ['To make the index smaller', 'So searches that mean the same thing share one entry', 'Because Redis needs lower-case keys', 'To hide what users searched for'],
      answer: 1,
      why: 'More searches find the same entry, so the hit rate goes up for free.',
    },
    {
      question: 'The cache is full. Which entry does LRU remove?',
      options: ['The newest one', 'The biggest one', 'A random one', 'The one used least recently'],
      answer: 3,
      why: 'LRU means "least recently used": what nobody has asked for in the longest time goes first.',
    },
    {
      question: 'A hugely popular entry expires. What protects the index?',
      options: ['Letting one request rebuild it while the others wait or get the old answer', 'Deleting the whole cache', 'Making the TTL zero', 'Adding a shard'],
      answer: 0,
      why: 'Otherwise thousands of identical searches hit the index at once.',
    },
  ],
}

export default lesson
