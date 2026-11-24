import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Cap requests per caller',
      text: 'A rate limiter caps how many requests a caller can make in a period. It stops abuse, keeps one noisy client from starving the rest, and enforces paid plans.',
      focus: ['Client app', 'API Gateway', 'Rate Limiter'],
    },
    {
      title: 'Reject early: 429',
      text: 'The check happens at the gateway, before your app servers do any work. Over the limit, the caller gets 429 Too Many Requests and a Retry-After header saying when to try again.',
      focus: ['Allowed?', 'Reject with 429 and Retry-After', 'App Servers'],
      example: 'HTTP/1.1 429 Too Many Requests\nRetry-After: 6',
    },
    {
      title: 'Token bucket',
      text: 'Each caller has a bucket of tokens. Each request takes one. Tokens refill at a steady rate. At 10 a minute, one token returns every 6 seconds.',
      example: '60 s ÷ 10 = one token every 6 s',
      remember: 'Bursts up to the bucket size, then the steady rate.',
    },
    {
      title: 'Fixed window has an edge problem',
      text: 'A fixed window counts per minute. A client can send 10 at 12:00:59 and 10 more at 12:01:00: 20 requests in two seconds.',
    },
    {
      title: 'Sliding window fixes it',
      text: 'A sliding window counter adds the current minute\'s count to part of the previous minute\'s. Two counters, no spike at the edge.',
      example: '40% into the minute: current + previous × 0.6',
    },
    {
      title: 'Count in one place',
      text: 'Many gateways must share one count. Redis holds the counters, and one Lua script or INCR updates them atomically. Reading, then writing, would let two gateways both say yes.',
      focus: ['Rate Limiter', 'Redis Primary (counters)', 'Redis Replica', 'Rules Store'],
    },
    {
      title: 'How many Redis shards?',
      text: '200k requests a second need 200k counter checks. One Redis node does about 60k scripted operations a second, so you need at least 4 shards.',
      example: '200k ÷ 60k ≈ 3.3 → 4 shards',
    },
    {
      title: 'When Redis is down',
      text: 'Decide per route: fail open (allow, with a rough local limit) or fail closed (refuse). The Local Fallback Limiter counts in each gateway\'s memory until Redis returns.',
      focus: ['Local Fallback Limiter', 'Metrics & Alerts'],
    },
  ],
  quiz: [
    {
      question: 'A limit of 10 a minute uses a fixed window. What is the most a client can send in 2 seconds?',
      options: ['10', '20, across a window edge', '5', '1'],
      answer: 1,
      why: '10 at the end of one minute and 10 at the start of the next both count as allowed.',
    },
    {
      question: 'Why update counters with one atomic Redis operation?',
      options: ['It uses less memory', 'Read-then-write lets two gateways both allow the last slot', 'Redis can\'t read', 'It sets Retry-After'],
      answer: 1,
      why: 'Both could read 9 and both write 10, letting 11 requests through.',
    },
    {
      question: 'With 10 tokens a minute, how often does a token come back?',
      options: ['Every 10 s', 'Every 6 s', 'Every 60 s', 'Every 1 s'],
      answer: 1,
      why: '60 seconds ÷ 10 tokens = one token every 6 seconds.',
    },
  ],
}

export default lesson
