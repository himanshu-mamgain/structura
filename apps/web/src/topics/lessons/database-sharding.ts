import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One database has limits',
      text: 'One server can only hold so much data and take so many writes. A bigger server helps for a while. Read-only copies help with reads, but not with writes or storage.',
      focus: ['API Server', 'Shard 1'],
    },
    {
      title: 'Split the rows: shards',
      text: 'Sharding splits one big table into pieces, called shards, and puts each one on its own database server. Every shard has the same tables, but a different slice of the rows.',
      focus: ['Shard 1', 'Shard 2', 'Shard 3', 'Shard 4'],
      example: '5 billion orders a year × 500 B = 2.5 TB a year\n12.5 TB over 5 years → 16 shards of about 0.8 TB',
    },
    {
      title: 'The shard key picks the shard',
      text: 'One column, the shard key, decides which shard owns a row, for example the user\'s ID. Choose it carefully: almost everything else follows from it.',
      focus: ['Shard Router (key → shard)', 'Shard Map (config store)'],
      example: 'shard = hash(user_id) % 16\nAll of user 1001\'s orders live on one shard',
    },
    {
      title: 'With the key, one shard answers',
      text: 'If a query includes the shard key, like "orders for user 1001", the router sends it to exactly one shard. That is fast and cheap.',
      focus: ['API Server', 'Shard Router (key → shard)', 'Shard 2'],
    },
    {
      title: 'Without it, ask every shard',
      text: 'A query without the shard key, like "all orders over ₹10k today", must go to every shard, and the results are merged. The more shards, the more likely one of them is slow.',
      focus: ['Shard Router (key → shard)', 'Shard 1', 'Shard 2', 'Shard 3', 'Shard 4', 'Result Merger'],
      example: 'Each shard slow 1% of the time\nAsk 4 shards → 3.9% of queries wait on a slow one\nAsk 16 → 14.9%',
    },
    {
      title: 'Hot shards',
      text: 'If the key is lopsided, one shard gets far more work than the others, like a celebrity\'s user ID or every order on today\'s date. Pick a key that spreads the load evenly.',
      focus: ['Shard 3'],
      remember: 'Never shard by date: every new write would land on the same shard.',
    },
    {
      title: 'Adding a shard while running',
      text: 'When space runs low, the rebalancer copies a slice of rows to a new shard while writes continue. Then it changes the shard map, the routers pick up the new map, and the old copies are deleted.',
      focus: ['Rebalancer', 'Shard 5', 'Shard Map (config store)'],
    },
    {
      title: 'Shard last',
      text: 'Joins and transactions across shards are hard, and moving data is painful. Try a bigger server, caching, read-only copies and splitting by feature first.',
      remember: 'Shard when writes or storage outgrow one server, not before.',
    },
  ],
  quiz: [
    {
      question: 'A query includes the shard key. How many shards does it go to?',
      options: ['Every shard', 'Exactly one', 'Half of them', 'None: it goes to a cache'],
      answer: 1,
      why: 'The key tells the router which shard owns the row.',
    },
    {
      question: 'Why is the order date a bad shard key?',
      options: ['Dates are too long', 'Dates can\'t be hashed', 'Queries by date are rare', 'Every new order lands on the same shard'],
      answer: 3,
      why: 'Today\'s shard takes all the writes while the others sit idle: a hot shard.',
    },
    {
      question: 'What do read-only copies (replicas) not help with?',
      options: ['Too many writes, or too much data for one server', 'Too many reads', 'Slow reports', 'Popular pages'],
      answer: 0,
      why: 'Every replica holds all the data, and every write still goes to the one primary.',
    },
  ],
}

export default lesson
