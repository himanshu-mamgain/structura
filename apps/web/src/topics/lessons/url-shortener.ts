import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Long link in, short code out',
      text: 'A URL shortener turns a long address into a short code, like sho.rt/4c92. Anyone who opens the code is sent on to the long address. A link is made once but opened many times.',
      focus: ['User / Browser', 'Shorten API', 'Redirect API'],
    },
    {
      title: 'Reads win, about 100 to 1',
      text: 'With 100 million new links a month, you write about 40 links a second. At 100 opens per link, that is about 4k redirects a second. So the design is mostly about fast redirects.',
      focus: ['Redirect API'],
      example: '100 million ÷ 2.59 million seconds a month ≈ 40 writes a second',
    },
    {
      title: 'A counter, written in base62',
      text: 'Each new link gets the next number from a counter. Base62 writes that number with 0–9, a–z and A–Z. A counter never repeats, so two links never get the same code.',
      focus: ['Key Generator (base62)'],
      example: 'id 125 → "21"   (2 × 62 + 1 = 125)\nid 1,000,000 → "4c92"',
    },
    {
      title: 'Seven characters is plenty',
      text: '62 to the power of 7 is about 3.5 trillion codes. Even at 100 million links a month, that lasts for thousands of years.',
      focus: ['Key Generator (base62)'],
      remember: '7 base62 characters ≈ 3.5 trillion codes.',
    },
    {
      title: 'Hand out blocks of IDs',
      text: 'If every server asked one counter for each new ID, the counter would become a bottleneck. Instead, each server takes a block, say 1k IDs at a time, and uses them up on its own.',
      focus: ['Shorten API', 'Key Generator (base62)'],
    },
    {
      title: 'Check the cache first',
      text: 'On a redirect, the Redirect API asks Redis for the code. On a hit it answers at once. On a miss it reads the URL Database, then saves the answer in Redis for next time.',
      focus: ['In cache?', 'Redis Cache', 'URL Database'],
      example: 'GET url:4c92 → "https://example.com/very/long/page"',
    },
    {
      title: '302, not 301',
      text: 'A 301 tells the browser "this never changes", so it skips your service next time, and you lose the click. A 302 is a temporary redirect, so every click comes back through you.',
      focus: ['Redirect API', 'User / Browser'],
      remember: 'Use 302 if you count clicks or may change the target.',
    },
    {
      title: 'Count clicks off the fast path',
      text: 'The redirect drops a small click event on a queue and moves on. A worker reads the queue later and adds up clicks per link. The redirect never waits for counting.',
      focus: ['Click Event Queue', 'Analytics Worker', 'Stats Store'],
    },
  ],
  quiz: [
    {
      question: 'Why use a counter written in base62 for the codes?',
      options: ['It never gives two links the same code', 'It makes codes impossible to guess', 'It needs no storage', 'It makes redirects faster'],
      answer: 0,
      why: 'Every counter value is different, so every code is different. Codes are guessable, which is the trade-off.',
    },
    {
      question: 'The marketing team says click counts dropped after a change. Which change most likely caused it?',
      options: ['Adding Redis', 'Switching the redirect from 302 to 301', 'Using 7 characters', 'Adding a load balancer'],
      answer: 1,
      why: 'Browsers remember a 301 and go straight to the target next time, so those clicks never reach the service to be counted.',
    },
    {
      question: 'Where should click counting happen?',
      options: ['Inside the redirect, before answering', 'In the browser', 'Through a queue and a worker, after the redirect', 'In the Key Generator'],
      answer: 2,
      why: 'A queue keeps the redirect fast; the Analytics Worker adds up clicks later.',
    },
  ],
}

export default lesson
