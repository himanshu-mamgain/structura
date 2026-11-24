import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Events in, messages out',
      text: 'An event like "your order shipped" arrives from another service. The system turns it into a push, an email or an SMS. It must not lose important messages or annoy people.',
      focus: ['Upstream Service (Orders)', 'Notification API'],
    },
    {
      title: 'The numbers',
      text: '20 million daily users get 5 notifications each: 100 million a day. That is about 1,157 a second on average, and about 11.6k a second at a 10× peak.',
      example: '100 million ÷ 86,400 s ≈ 1,157 a second',
    },
    {
      title: 'Drop duplicates first',
      text: 'Upstream services retry, so the same event can arrive twice. Each event has an idempotency key, a unique id for that event. Redis remembers recent keys, and a repeat is dropped.',
      focus: ['Notification API', 'Dedup Store (Redis)'],
    },
    {
      title: 'Respect preferences',
      text: 'The Preference Service checks opt-outs and quiet hours on the server, in one place. A marketing message waits until morning. A login code goes now.',
      focus: ['Preference Service', 'Preferences DB'],
    },
    {
      title: 'One queue per channel',
      text: 'Push, email and SMS each get their own Kafka queue, with a high and a low priority. A slow email provider can\'t hold up push. A marketing blast can\'t delay a login code.',
      focus: ['Template Service', 'Channel Queues (Kafka)'],
      remember: 'Separate queues keep one slow channel from blocking the rest.',
    },
    {
      title: 'Workers send',
      text: 'Push workers call FCM and APNs; email workers call SES. If one worker sends 500 a second, the 11.6k peak needs about 24 workers.',
      focus: ['Push Worker', 'Email Worker', 'FCM / APNs', 'Email Provider (SES)'],
      example: '11.6k ÷ 500 ≈ 24 workers (run about 30)',
    },
    {
      title: 'Retry, then dead-letter',
      text: 'A failed send goes to a delayed retry queue and waits 2, 4, 8, 16, then 32 seconds, plus a little randomness called jitter. After the last try it goes to a dead letter queue, so it isn\'t lost.',
      focus: ['Retry Queue (delayed)', 'Dead Letter Queue'],
    },
    {
      title: 'Log every attempt',
      text: 'Delivery is at least once: rarely, a message arrives twice. Every attempt is written to the log, so support can answer "why didn\'t I get it?".',
      focus: ['Notification Log DB', 'User Device'],
    },
  ],
  quiz: [
    {
      question: 'A 5-million-user marketing campaign starts. Why do login codes still arrive at once?',
      options: ['Login codes skip the queue entirely', 'They use a separate, high-priority queue', 'Marketing is sent by SMS only', 'Workers ignore marketing'],
      answer: 1,
      why: 'Queues per channel and priority keep the blast in the low-priority lane.',
    },
    {
      question: 'The Orders service sends the same "shipped" event twice. What stops a double notification?',
      options: ['The dead letter queue', 'The idempotency key checked in the dedup store', 'Quiet hours', 'The email provider'],
      answer: 1,
      why: 'The second event has the same key, so the API drops it.',
    },
    {
      question: 'Why add jitter to retries?',
      options: ['To send faster', 'So thousands of failed messages don\'t all retry in the same second', 'To change the message', 'To skip preferences'],
      answer: 1,
      why: 'Random spread stops a retry storm hitting the provider all at once.',
    },
  ],
}

export default lesson
