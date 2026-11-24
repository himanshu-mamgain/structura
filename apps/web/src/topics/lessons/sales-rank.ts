import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Bestsellers per category',
      text: 'Each category shows its bestsellers for the past week. A ranking is a report, not part of checkout, so it can be built away from the live order path.',
      focus: ['Client', 'Read API'],
    },
    {
      title: 'The numbers',
      text: '1 billion purchases a month is about 400 a second. 100 billion page reads a month is about 40k a second: 100 reads per purchase.',
      example: '1 billion ÷ 2.5 million s ≈ 400 a second',
    },
    {
      title: 'Sales go to log files',
      text: 'The Purchase API saves the order and appends a line to the Transaction Log Files. Each line is about 40 bytes: product, category, seller, buyer, quantity, price, time.',
      focus: ['Purchase API', 'Orders Database', 'Transaction Log Files'],
    },
    {
      title: 'Count with MapReduce',
      text: 'On a schedule, the Sales Rank Service runs MapReduce. Map turns each sale into (category, product) → quantity. Reduce adds them up. Then each category is sorted.',
      focus: ['Batch Scheduler', 'Sales Rank Service', 'Transaction Log Files'],
      example: '(books, p-12) → 1\n(books, p-12) → 2\nreduce → (books, p-12) = 3',
    },
    {
      title: 'Logs, not the orders table',
      text: 'Scanning a week of orders would slow checkout. The log files can be read in parallel without touching the Orders Database.',
      remember: 'Build reports from logs, away from checkout.',
    },
    {
      title: 'Swap the whole table',
      text: 'The new ranking is written to the Analytics Database next to the old one, then swapped in. Readers never see a half-sorted list.',
      focus: ['Analytics Database'],
    },
    {
      title: 'Serve from the cache',
      text: 'Reads win 100 to 1, so the top products of each category sit in Redis. The Read API rarely touches the database.',
      focus: ['Read API', 'Memory Cache (Redis)'],
    },
    {
      title: 'How fresh?',
      text: 'Hourly runs show a list at most an hour old but cost 24 times more runs than daily. Pick by how much the business cares about freshness.',
    },
  ],
  quiz: [
    {
      question: 'Why build the ranking from log files instead of the orders table?',
      options: ['Logs are prettier', 'Scanning orders would compete with checkout', 'The orders table has no prices', 'Logs are encrypted'],
      answer: 1,
      why: 'Reading logs in parallel leaves the live order database alone.',
    },
    {
      question: 'In MapReduce here, what does the reduce step do?',
      options: ['Deletes old sales', 'Adds up quantities per (category, product)', 'Sends emails', 'Caches pages'],
      answer: 1,
      why: 'Map emits (category, product) → quantity; reduce sums them.',
    },
    {
      question: 'Why write the new table beside the old one and swap?',
      options: ['So readers never see a half-finished ranking', 'To save disk', 'MapReduce needs it', 'To speed up checkout'],
      answer: 0,
      why: 'The swap is instant, so readers see either the old or the new list, never a mix.',
    },
  ],
}

export default lesson
