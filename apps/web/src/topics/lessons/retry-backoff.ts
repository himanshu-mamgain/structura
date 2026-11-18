import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Trying again often works',
      text: 'A call to another service can fail for a moment: a lost packet, a server restarting, a busy second. A retry is a second try at the same call. Very often it works, so almost every client retries.',
      focus: ['Order Service', 'Payment Provider'],
      remember: 'Most failures are short. A retry turns many of them into successes.',
    },
    {
      title: 'Retry only what can pass',
      text: 'Some failures pass on their own: timeouts, 502, 503, 504 and 429. Others never will: a 400 or 401 means the request itself is wrong. Retrying those only adds load and delays the real error.',
      focus: ['Retryable?'],
      example: 'retry:  timeout, 502, 503, 504, 429\nfail now:  400, 401, 403, 404, 422',
    },
    {
      title: 'A retry storm',
      text: 'Say the Payment Provider is down for 10 seconds while 10,000 phones are paying. If every phone retries after exactly 1 second, all 10,000 come back in the same moment. The provider can take 200 in that tenth of a second, so the other 9,800 fail and come back together again.',
      focus: ['Client Apps', 'Payment Provider'],
      remember: 'Retries that arrive together can keep a server down that could have recovered.',
    },
    {
      title: 'Exponential backoff: wait longer each time',
      text: 'Exponential backoff doubles the wait after each failure, up to a cap. Each client asks less often while the service is down. But every phone uses the same numbers, so phones that failed together still retry together.',
      focus: ['Backoff + Jitter'],
      example: 'waits: 1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 32 s …',
    },
    {
      title: 'Jitter: a random wait',
      text: 'With full jitter, each phone picks a random wait between 0 and that doubling number. After the 5th try it is 0 to 16 seconds. 10,000 phones spread over 16 seconds is about 63 in each tenth of a second, well under 200.',
      focus: ['Backoff + Jitter'],
      example: 'wait = random() × min(32 s, 1 s × 2^(try − 1))',
      remember: 'Backoff makes each client gentler. Jitter stops them moving in step.',
    },
    {
      title: 'Use Retry-After when you get it',
      text: 'A 503 or 429 response can carry a Retry-After header, the number of seconds the server needs. When it is there, wait that long instead of your own guess. The API Gateway passes it on to the phones.',
      focus: ['API Gateway', 'Payment Provider'],
      example: 'HTTP/1.1 503 Service Unavailable\nRetry-After: 30',
    },
    {
      title: 'A retry budget limits the extra load',
      text: 'A retry budget allows retries only while they are under 10% of a client\'s requests. On a good day, retries are rare and always allowed. During an outage the budget runs out, and calls fail fast instead of adding load.',
      focus: ['Retry Budget'],
      remember: 'With a 10% budget, retries add at most 10% more traffic, however bad the outage.',
    },
    {
      title: 'Retry at one layer only',
      text: 'If the app, the API and the service each make 4 tries, one click can become 4 × 4 × 4 = 64 calls at the bottom. Retry only just above the part that failed. A circuit breaker also stops calling a provider that keeps failing, so retries fail at once for a while.',
      focus: ['Client Apps', 'Order Service', 'Circuit Breaker'],
      example: '4 tries × 4 tries × 4 tries = 64 calls',
    },
    {
      title: 'Same key, no double charge',
      text: 'The first try may have worked even if its answer was lost. So the phone makes one idempotency key per payment and sends it on every try. The provider sees the same key and returns the first result instead of charging again.',
      focus: ['Order Service', 'Payment Provider'],
      example: 'POST /v1/payments\nIdempotency-Key: pay_7f3a2c',
    },
    {
      title: 'When the tries run out',
      text: 'After the last try, the payment goes to a Dead-Letter Queue, a list of jobs to finish later. The app shows "Payment pending", not "failed", because it may still go through. Metrics & Alerts count retries and give-ups, so a storm shows up on a graph.',
      focus: ['Dead-Letter Queue', 'Metrics & Alerts'],
      remember: 'Out of tries means "pending", not "failed".',
    },
  ],
  quiz: [
    {
      question: '10,000 phones failed at the same moment. Each waits 1, 2, 4, 8 s between tries, with no jitter. What happens?',
      options: [
        'They spread out on their own after a few tries',
        'They keep retrying together, in big waves',
        'Only one phone retries at a time',
        'The provider queues them all and serves them later',
      ],
      answer: 1,
      why: 'They all use the same waits, so they all retry at 1, 3, 7 and 15 seconds. The waves come less often but are just as big. Jitter is what spreads them out.',
    },
    {
      question: 'Which response should you NOT retry?',
      options: ['503 Service Unavailable', 'A timeout', '429 Too Many Requests', '401 Unauthorized'],
      answer: 3,
      why: 'A 401 means the request has no valid login. It will fail every time until the request changes. The other three can pass on their own after a wait.',
    },
    {
      question: 'Why does a retried payment need the same idempotency key on every try?',
      options: [
        'So the first try that worked isn\'t charged again',
        'So the retry is faster',
        'So the Retry Budget can count it',
        'So the circuit breaker opens sooner',
      ],
      answer: 0,
      why: 'A timeout can hide a payment that went through. With the same key, the provider returns the stored result instead of charging a second time.',
    },
  ],
}

export default lesson
