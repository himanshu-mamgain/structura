import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Distance is slow',
      text: 'Light in fibre covers about 200 km each millisecond, and cables are never straight. A visitor in Mumbai talking to a server in Virginia waits about 180 ms for every round trip, and a secure connection plus the request takes three of them.',
      focus: ['Browser', 'Origin Server'],
      example: '3 round trips × (12 + 180) ms ≈ 576 ms\nbefore the first byte arrives',
    },
    {
      title: 'A CDN brings copies closer',
      text: 'A CDN (content delivery network) has caches in hundreds of cities, called points of presence (PoPs). Each visitor is sent to the nearest one, just a few milliseconds away.',
      focus: ['Browser', 'GeoDNS / Anycast', 'Edge Cache (nearest PoP)'],
      example: 'Mumbai visitor to a Mumbai PoP: 3 × 12 ms = 36 ms',
    },
    {
      title: 'Hit or miss',
      text: 'The PoP looks the file up by its cache key, mostly the host and the path. If it has a fresh copy, that\'s a hit: it answers at once, and your server never hears about it. If not, that\'s a miss: it fetches the file and keeps a copy.',
      focus: ['Edge Cache (nearest PoP)', 'Cache Lookup: hit or miss?'],
    },
    {
      title: 'A shield in the middle',
      text: 'On a miss, the PoP first asks a regional shield cache. Only the shield talks to your origin server, so a file that\'s missing from many PoPs at once is fetched from the origin once, not hundreds of times.',
      focus: ['Cache Lookup: hit or miss?', 'Regional Shield Cache', 'Origin Server'],
    },
    {
      title: 'Your server sets the rules',
      text: 'The origin sends headers with each file. Cache-Control says whether the file may be stored, and for how long. An ETag is a fingerprint of the file, so a cache can ask "has it changed?" instead of downloading it again.',
      focus: ['Origin Server', 'Object Storage', 'Regional Shield Cache'],
      example: 'Cache-Control: public, max-age=31536000, immutable\nETag: "5d8c72a5"',
    },
    {
      title: 'Never cache private pages',
      text: 'A page showing someone\'s account or basket must not be stored at the edge, or the next visitor might see it. Mark such pages Cache-Control: private, or no-store.',
      focus: ['Edge Cache (nearest PoP)'],
      remember: 'Cache what is the same for everyone.',
    },
    {
      title: 'The hit ratio is what matters',
      text: 'The share of requests answered from the cache decides how many reach your server. A few points make a big difference.',
      focus: ['Edge Cache (nearest PoP)', 'Origin Server'],
      example: '50k requests/s at peak\n95% hits → 2,500/s reach the origin\n99% hits → 500/s: 80% less',
    },
    {
      title: 'Changing a file right now: purge',
      text: 'When a file must change at once, the purge API removes it from the caches, and the next request fetches the new one. Even better, put a version in the file name, like app.3f9a1c.js, so each new version is simply a new file.',
      focus: ['Purge API', 'Edge Cache (nearest PoP)', 'Regional Shield Cache'],
    },
  ],
  quiz: [
    {
      question: 'What happens on a cache hit?',
      options: ['The PoP answers from its copy, and the origin never hears about it', 'The PoP asks the origin whether the file changed', 'The browser waits for the shield', 'The file is purged'],
      answer: 0,
      why: 'That\'s the point of a CDN: a close, fast answer with no work for your server.',
    },
    {
      question: 'Which of these must not be cached at the edge?',
      options: ['A product photo', 'The site\'s logo', 'A visitor\'s account page', 'A script with a version in its name'],
      answer: 2,
      why: 'It\'s different for every visitor, so a shared copy could show one person\'s page to another.',
    },
    {
      question: 'The hit ratio goes from 95% to 99%. What happens to the origin\'s load?',
      options: ['It goes up', 'It drops by 80%', 'It drops by 4%', 'It stays the same'],
      answer: 1,
      why: 'Misses fall from 5% to 1% of requests: from 2,500 a second to 500.',
    },
  ],
}

export default lesson
