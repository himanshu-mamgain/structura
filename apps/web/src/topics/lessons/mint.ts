import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'All your bank accounts in one app',
      text: 'Mint connects to your bank accounts, pulls your transactions, sorts each into a category like "Food", and warns you when a monthly budget is nearly used.',
      focus: ['Client', 'Accounts API', 'Bank APIs'],
    },
    {
      title: 'Here, writes win',
      text: '5 billion transactions a month is about 2k writes a second. Users open the app rarely: about 200 reads a second. So the write path is the one to design for.',
      example: '5 billion ÷ 2.5 million s ≈ 2k writes a second',
    },
    {
      title: 'Pull banks in the background',
      text: 'Banks are slow and sometimes down. The Transaction Extraction Service talks to them, never the user\'s request. A slow bank delays only its own customers.',
      focus: ['Bank APIs', 'Transaction Extraction Service'],
    },
    {
      title: 'A queue absorbs bursts',
      text: 'Each new transaction goes on a message queue. The Category and Budget services take them at their own pace, so a burst from one bank doesn\'t overload anything.',
      focus: ['Transaction Extraction Service', 'Message Queue'],
    },
    {
      title: 'Banks resend old transactions',
      text: 'Each row has a unique (account_id, bank_ref). A repeat insert is ignored, and totals only change for rows that were really new.',
      focus: ['Transactions Database'],
      example: 'UNIQUE (account_id, bank_ref)  -- repeats are skipped',
      remember: 'Make saves idempotent: banks send the same transaction twice.',
    },
    {
      title: 'Sort by seller',
      text: 'The Category Service uses a seller-to-category table: "Swiggy" → Food. If you set your own rule, yours wins.',
      focus: ['Category Service'],
    },
    {
      title: 'Budgets as running totals',
      text: 'The Budget Service keeps this month\'s total per category in Redis. The dashboard is one cache read, not a month of sums. Near the limit, the Notification Service warns you.',
      focus: ['Budget Service', 'Memory Cache (Redis)', 'Notification Service'],
    },
    {
      title: 'Sync where it matters',
      text: 'Active users are synced every few minutes. Users away for 30 days are synced in a nightly batch. Bank rate limits are spent where people notice.',
    },
  ],
  quiz: [
    {
      question: 'Why does the extraction service, not the user\'s request, talk to banks?',
      options: ['Banks are slow and unreliable, so users would wait', 'Banks require it', 'It saves storage', 'It is more secure'],
      answer: 0,
      why: 'Keeping slow bank calls in the background keeps the app fast.',
    },
    {
      question: 'A bank sends yesterday\'s transactions again. What stops double counting?',
      options: ['The queue', 'A unique (account_id, bank_ref) on each row', 'Redis', 'The category table'],
      answer: 1,
      why: 'The repeat insert fails, and totals only change for new rows.',
    },
    {
      question: 'Which path matters most in this design?',
      options: ['Reads, about 200 a second', 'Writes, about 2k a second', 'Logins', 'Emails'],
      answer: 1,
      why: 'Transactions flow in all day while users open the app rarely.',
    },
  ],
}

export default lesson
