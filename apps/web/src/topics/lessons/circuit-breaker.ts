import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One slow service, whole shop down',
      text: 'Checkout calls the Payment Service. One day Payment Service stops answering. Every checkout waits for it, and every waiting checkout holds one thread. A server has a fixed number of threads, so soon none are left, and even product pages stop working.',
      focus: ['Checkout Service', 'Payment Service', 'Browse Thread Pool'],
      remember: 'A slow service is worse than a dead one: it keeps your threads busy.',
    },
    {
      title: 'The maths of running out',
      text: 'Threads in use = calls per second × seconds per call. This is called Little\'s law. A healthy call takes 0.05 seconds, a hanging one takes for ever.',
      focus: ['Checkout Service', 'Payment Service'],
      example: '200 calls/s × 0.05 s = 10 threads\n200 calls/s × 8 s = 1,600 threads',
    },
    {
      title: 'Step 1: a timeout',
      text: 'A timeout is the longest you will wait. After 1 second you give up and free the thread. It is the cheapest protection, and every other pattern needs it.',
      focus: ['Timeout and Retry'],
      example: 'timeout = 1 s\n200 calls/s × 1 s = 200 threads (not 1,600)',
      remember: 'No timeout means you will wait for ever.',
    },
    {
      title: 'Step 2: retry, but carefully',
      text: 'Many failures last only a moment, so one retry often works. But each retry is more load on a service that is already struggling. Retry only safe calls, a few times, and wait a little longer each time (backoff).',
      focus: ['Timeout and Retry', 'Payment Service'],
      example: 'try 1 fails → wait 200 ms\ntry 2 fails → wait 400 ms\ntry 3',
    },
    {
      title: 'Jitter stops a retry storm',
      text: 'If 1k clients fail together and all retry after exactly 200 ms, 1k calls arrive at once. Jitter means each client waits a random time between 0 and 200 ms. The retries then spread out.',
      focus: ['Timeout and Retry'],
      example: '1k retries at once\nvs about 5 every millisecond (1k ÷ 200 ms)',
      remember: 'Backoff makes retries slower. Jitter makes them different.',
    },
    {
      title: 'Step 3: the circuit breaker',
      text: 'A circuit breaker counts failures. After 5 in a row it opens, and the next calls fail in about a millisecond without touching Payment Service. This saves your threads and gives the service room to recover.',
      focus: ['Circuit Breaker', 'Pay Later Queue'],
      example: 'closed → 5 failures → OPEN\nOPEN for 3 s: refuse calls at once',
    },
    {
      title: 'Closed, open, half-open',
      text: 'After the open time, the breaker goes half-open and lets one probe call through. If the probe works, the breaker closes and traffic flows again. If it fails, the breaker opens again for another round.',
      focus: ['Circuit Breaker', 'Metrics & Alerts'],
      remember: 'Closed = normal. Open = fail fast. Half-open = test with one call.',
    },
    {
      title: 'Step 4: a bulkhead',
      text: 'A ship has watertight compartments so one leak does not sink it. A bulkhead gives payments their own small pool of threads, for example 10. If payments hang, only those 10 threads are stuck, and product pages keep their own 20.',
      focus: ['Payment Bulkhead (own thread pool)', 'Browse Thread Pool', 'Product Pages'],
      example: 'payments hang for 10 s at 10 orders/s:\nshared pool: 10 of 50 pages served\nwith a bulkhead: 50 of 50',
    },
    {
      title: 'Always have a fallback',
      text: 'When the breaker is open, something must still answer. For a payment, save the order as payment_pending and put a job on a queue, then charge it when the service is back. Never say "paid" when it was not.',
      focus: ['Pay Later Queue', 'Order Database'],
      remember: 'Decide the fallback before the outage.',
    },
  ],
  quiz: [
    {
      question: 'Why can a slow service take your whole app down?',
      options: ['It sends bad data', 'Each waiting call holds a thread, and threads run out', 'It makes the network slower', 'It deletes your cache'],
      answer: 1,
      why: 'A server has a fixed number of threads. If calls wait for ever, soon none are left for anything else.',
    },
    {
      question: 'Why add jitter to retry delays?',
      options: ['To make retries faster', 'To use less memory', 'So clients do not all retry at the same moment', 'To avoid the timeout'],
      answer: 2,
      why: 'A random wait spreads the retries out, so a thousand clients do not hit the service together.',
    },
    {
      question: 'The breaker is half-open. What happens next?',
      options: ['Every call goes through again', 'One probe call goes through: success closes it, failure opens it again', 'The breaker is removed', 'All calls are refused for an hour'],
      answer: 1,
      why: 'Half-open is a test. One call tries the service, and its result decides the next state.',
    },
  ],
}

export default lesson
