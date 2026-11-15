import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'A store that lives in memory',
      text: 'Redis keeps all its data in memory instead of on disk, so a read or a write takes microseconds. Apps use it for fast, temporary things: logins, counters, rankings and job queues. The data you must never lose stays in a real database.',
      focus: ['App Server', 'Keyspace', 'Postgres'],
    },
    {
      title: 'One command at a time',
      text: 'Redis runs commands one after another on a single thread, called the event loop. A command never sees another one half done, so every command is atomic: it happens completely, or not at all.',
      focus: ['App Server', 'Event Loop'],
      remember: 'Even with one thread, one Redis server handles about 100,000 simple commands a second.',
    },
    {
      title: 'Every key holds a type',
      text: 'A key doesn\'t just hold a value; it holds a data type with its own commands. Strings, hashes, lists, sets and sorted sets each answer a different kind of question.',
      focus: ['Keyspace', 'Strings', 'Hashes', 'Lists', 'Sets', 'Sorted Sets'],
    },
    {
      title: 'Strings and hashes',
      text: 'A string holds text or a number; INCR adds 1 to a number in one step. A hash holds fields under one key, like a small object, such as a user\'s session.',
      focus: ['Strings', 'Hashes'],
      example: 'INCR views:article:42\nHSET session:9f2c user 1001 cart 3\nEXPIRE session:9f2c 1800',
    },
    {
      title: 'Lists make queues',
      text: 'A list keeps items in order, and you can add or take from either end. The app pushes an email job; a worker moves it to a "processing" list with LMOVE, so the job isn\'t lost if the worker crashes.',
      focus: ['Lists', 'Email Worker'],
      example: 'LPUSH emails:queue "welcome:1001"\nLMOVE emails:queue emails:processing RIGHT LEFT',
    },
    {
      title: 'Sets and sorted sets',
      text: 'A set keeps unique members, so it answers "have we seen this before?". A sorted set orders its members by a score, so it answers "who is in the top 10?" and "what rank am I?".',
      focus: ['Sets', 'Sorted Sets'],
      example: 'ZINCRBY leaderboard:2026-11 50 "asha"\nZREVRANGE leaderboard:2026-11 0 9 WITHSCORES\nZREVRANK leaderboard:2026-11 "asha"',
    },
    {
      title: 'Keys that delete themselves',
      text: 'Give a key a TTL (time to live), and Redis deletes it when the time runs out. That suits logins, caches and anything else that should be temporary.',
      focus: ['Expiry', 'Keyspace'],
      remember: 'Keys without a TTL live until you delete them, or until memory runs out.',
    },
    {
      title: 'Read-then-write is a bug',
      text: 'If two servers each GET a counter, add 1 and SET it back, one update is lost. Use the single command that does both, such as INCR, HINCRBY or ZINCRBY, because Redis runs it in one step.',
      focus: ['App Server', 'Event Loop', 'Strings'],
      example: 'Two servers read 10, both write 11 → one view lost\nINCR on both → 12, nothing lost',
    },
  ],
  quiz: [
    {
      question: 'Which type fits "show the top 10 players this month"?',
      options: ['A list', 'A sorted set', 'A string', 'A hash'],
      answer: 1,
      why: 'A sorted set keeps members ordered by score, so the top 10 and any player\'s rank are one command each.',
    },
    {
      question: 'Why can\'t two INCR commands on the same key lose an update?',
      options: ['Redis saves every write to disk first', 'Redis locks the key for a second', 'Redis runs one command at a time, so each INCR finishes before the next starts', 'INCR is retried automatically'],
      answer: 2,
      why: 'One thread runs commands one after another, so every command is atomic.',
    },
    {
      question: 'Where should orders and user accounts live?',
      options: ['In a real database like Postgres', 'Only in Redis', 'In a Redis list', 'In keys with a TTL'],
      answer: 0,
      why: 'Redis is for fast, temporary or rebuildable data. The record you must keep belongs in the database.',
    },
  ],
}

export default lesson
