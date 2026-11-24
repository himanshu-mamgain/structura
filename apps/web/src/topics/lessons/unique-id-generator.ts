import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Every row needs a new id',
      text: 'Many servers create orders at the same time. Each order needs an id nobody else will ever use. Asking one database for every id makes it a bottleneck.',
      focus: ['Client (Order Service)', 'Orders DB (sharded by id)'],
    },
    {
      title: 'Snowflake: three parts in 64 bits',
      text: 'A Snowflake id packs the time, the machine number and a counter into one 64-bit number. Each worker makes ids alone, with no database and no talking to the others.',
      focus: ['ID Worker · DC1/W1', 'ID Worker · DC1/W2', 'ID Worker · DC2/W3'],
      example: '1 sign bit | 41 bits time | 10 bits machine | 12 bits sequence',
    },
    {
      title: '41 bits of time',
      text: 'The time is counted in milliseconds from your own start date, called the custom epoch. 2^41 milliseconds is about 69.7 years. Because time is in the top bits, ids sort by when they were made.',
      remember: 'Time first, so new ids go to the end of the index.',
    },
    {
      title: '12 bits of sequence',
      text: 'Inside one millisecond, a counter goes 0, 1, 2… up to 4,095. So one worker makes 4,096 ids a millisecond, about 4 million a second. If it runs out, it waits for the next millisecond.',
      focus: ['Sequence Counter (12 bits)'],
      example: '4,096 ids × 1k ms = about 4.1 million ids a second',
    },
    {
      title: 'Unique machine numbers',
      text: '10 machine bits allow 1,024 workers. Two workers must never share a number, or they could make the same id. So each worker leases its number from a registry like etcd.',
      focus: ['Worker Registry (etcd)'],
    },
    {
      title: 'The clock is the weak spot',
      text: 'If a server\'s clock jumps backwards, it could repeat old ids. The Clock Check never lets time go back: for a small jump it waits, for a big one it refuses and raises an alert.',
      focus: ['Clock Check (never go back)', 'NTP Time Source', 'Clock Drift Alert'],
    },
    {
      title: 'Why not a UUID?',
      text: 'A random UUID needs no setup, but it is 128 bits and random. Random ids land all over the index, which slows inserts. A Snowflake id is half the size and in time order.',
    },
    {
      title: 'Send ids as strings',
      text: 'JavaScript numbers lose precision above 2^53. A 64-bit id can be bigger than that. So the API returns ids as text, like "7181862645415329792".',
      remember: '64-bit ids travel as strings in JSON.',
    },
  ],
  quiz: [
    {
      question: 'Why do Snowflake ids sort by creation time?',
      options: ['The sequence is random', 'The time is in the top bits', 'A database sorts them', 'The machine number grows'],
      answer: 1,
      why: 'The highest bits hold the time, so a later id is a bigger number.',
    },
    {
      question: 'A worker needs 5k ids in the same millisecond. What happens?',
      options: ['It makes duplicates', 'It uses another machine\'s number', 'After 4,096 it waits for the next millisecond', 'It crashes'],
      answer: 2,
      why: 'The 12-bit sequence holds 4,096 values; then the worker waits for the clock to tick.',
    },
    {
      question: 'What is the biggest risk to uniqueness?',
      options: ['Too many orders', 'A clock that goes backwards, or two workers sharing a number', 'Sending ids as strings', 'A sharded database'],
      answer: 1,
      why: 'Both can make the same time-machine-sequence combination twice. The clock check and the registry prevent them.',
    },
  ],
}

export default lesson
