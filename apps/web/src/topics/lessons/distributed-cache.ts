import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Memory in front of the database',
      text: 'Reading from memory takes about a millisecond; a database query takes tens of milliseconds and uses up real capacity. A cache sits between the app and the database and remembers recent answers.',
      focus: ['App Servers', 'Cache Shard 1', 'Primary Database'],
    },
    {
      title: 'Cache-aside',
      text: 'The usual pattern: the app asks the cache first. On a miss, it reads the database, then saves the answer in the cache with a TTL (how long to keep it).',
      focus: ['App Servers', 'Cache hit?', 'Primary Database'],
      example: 'value = cache.get("product:42")\nif missing:\n  value = db.query(...)\n  cache.set("product:42", value, ttl=300)',
    },
    {
      title: 'Split keys across shards',
      text: 'One server can only hold and answer so much, so the cache is split into shards. Redis Cluster hashes each key to one of 16,384 slots, and each shard owns a range of slots.',
      focus: ['Hash Slot Router', 'Cache Shard 1', 'Cache Shard 2', 'Cache Shard 3'],
      example: 'slot = CRC16("product:42") % 16384\nShard 1: 0–5460 · Shard 2: 5461–10922 · Shard 3: 10923–16383',
    },
    {
      title: 'How big, how many',
      text: 'Work out the memory from the number of entries and their size, then how many servers that needs, with room to spare.',
      focus: ['Cache Shard 1', 'Cache Shard 2', 'Cache Shard 3'],
      example: '20 million products × 1,100 B = 22 GB\n12 GB usable per server → 2 needed, 3 for room\n50,000 reads/s ÷ 3 ≈ 16,700 per shard',
    },
    {
      title: 'The hit rate is everything',
      text: 'The share of reads answered by the cache decides how much work reaches the database. A cache with a falling hit rate is usually too small for what people read.',
      focus: ['Cache hit?', 'Primary Database'],
      example: '50,000 reads/s at 95% hits\n→ 2,500 queries/s reach the database, 20 times fewer',
    },
    {
      title: 'When memory is full',
      text: 'LRU throws out what was used longest ago and suits most apps. LFU throws out what is used least, which survives a bot reading every page once. Deleting a key when its row changes keeps the cache honest.',
      focus: ['Cache Shard 1'],
      remember: 'On a change, delete the key; don\'t update it. The next read fills it with fresh data.',
    },
    {
      title: 'A stampede on one key',
      text: 'When a popular key expires, hundreds of requests miss at once and all query the database. A single-flight lock lets one request rebuild the value while the rest wait for it.',
      focus: ['Cache hit?', 'Single-flight Lock', 'Primary Database'],
      remember: 'Add a little randomness to TTLs, so keys don\'t all expire at the same moment.',
    },
    {
      title: 'Expect the cache to fail',
      text: 'A replica takes over if a shard dies, but the database must survive a cold, empty cache too. Give cache calls a short timeout and treat a timeout as a miss, so a slow cache never makes the site slower than no cache.',
      focus: ['Cache Shard 1', 'Cache Replica', 'Local Cache (L1)'],
    },
  ],
  quiz: [
    {
      question: 'What happens on a miss with cache-aside?',
      options: ['The request fails', 'The app reads the database, then saves the answer in the cache', 'The cache reads the database by itself', 'The app waits for the TTL'],
      answer: 1,
      why: 'The app owns the logic: look in the cache, fall back to the database, then fill the cache.',
    },
    {
      question: 'A product\'s price changes. What\'s the safest thing to do with its cache key?',
      options: ['Update it with the new price', 'Leave it until the TTL runs out', 'Restart the cache', 'Delete it, so the next read fills it fresh'],
      answer: 3,
      why: 'Deleting avoids races where an old value is written back after the new one.',
    },
    {
      question: 'A hot key expires and 5,000 requests arrive at once. What stops them all hitting the database?',
      options: ['A single-flight lock: one request rebuilds, the rest wait', 'A longer timeout', 'More database servers', 'LFU eviction'],
      answer: 0,
      why: '5,000 identical queries become one.',
    },
  ],
}

export default lesson
