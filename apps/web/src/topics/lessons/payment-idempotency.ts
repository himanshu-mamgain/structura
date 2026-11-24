import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: '"Payment failed", but money left',
      text: 'The bank took the money, but the reply was lost on a weak 4G signal. The app shows "failed". If it simply tries again, the customer pays twice.',
      focus: ['Mobile App', 'Internet (4G / Wi-Fi)', 'Bank / Payment Network'],
    },
    {
      title: 'A timeout means "unknown"',
      text: 'A timeout is not a failure. The payment may have gone through. The honest state is unknown, so the system must find out before acting again.',
      remember: 'Timeout = unknown, not failed.',
    },
    {
      title: 'One key per checkout',
      text: 'The app makes an idempotency key, a unique id for this checkout, and sends it with every retry. Idempotent means doing it twice has the same effect as doing it once.',
      focus: ['Mobile App', 'API Gateway', 'Payment Service'],
      example: 'POST /payments\nIdempotency-Key: 6f1c-checkout-81',
    },
    {
      title: 'Seen this key before?',
      text: 'The Payment Service inserts the key into Postgres, with the key as the primary key. If the insert fails, the key was used, and the saved first response is sent again.',
      focus: ['Key Seen Before?', 'Payments DB (Postgres)'],
      remember: 'Let the database enforce uniqueness, not "check, then insert".',
    },
    {
      title: 'Same key, different amount: refuse',
      text: 'The server also stores a hash of the request. If a retry has the same key but a different amount, it\'s a bug, and the answer is 422.',
      focus: ['Payment Service'],
    },
    {
      title: 'Pending until the bank says',
      text: 'If the bank call times out on the server, the payment is marked PENDING and the app gets 202. Webhooks from the bank settle it, deduplicated by event id.',
      focus: ['Bank / Payment Network', 'Webhook Handler', 'Payment Events Queue'],
    },
    {
      title: 'Reconciliation catches the rest',
      text: 'A Reconciliation Job compares your records with the bank\'s report. It settles every leftover PENDING payment and refunds debits that should not have happened.',
      focus: ['Reconciliation Job', 'Notification Service'],
    },
    {
      title: 'Why it matters',
      text: '10 million payments a day with 100k retries: if half of the first attempts had gone through, that is 50k double debits a day without keys.',
      example: '50k × ₹500 = ₹2.5 crore charged twice, every day',
    },
  ],
  quiz: [
    {
      question: 'The app times out after paying. What should the server do with the retry that has the same key?',
      options: ['Charge again', 'Return the saved first response', 'Reject it with 500', 'Ask the user to wait a day'],
      answer: 1,
      why: 'Same key means same checkout, so the server replays the first result instead of charging again.',
    },
    {
      question: 'Why use a primary key on the idempotency key instead of checking first?',
      options: ['It is faster to type', 'Two requests at the same moment can both pass a check, but only one insert can win', 'Postgres has no SELECT', 'Keys are secret'],
      answer: 1,
      why: 'The unique constraint makes the race impossible.',
    },
    {
      question: 'The bank call times out on the server. What is the right status?',
      options: ['FAILED', 'SUCCEEDED', 'PENDING, settled later by webhooks and reconciliation', 'DELETED'],
      answer: 2,
      why: 'Nobody knows yet, so it stays pending until the bank reports the outcome.',
    },
  ],
}

export default lesson
