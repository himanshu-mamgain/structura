import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Every key needs a home',
      text: 'You have four cache servers and millions of keys. A key must always go to the same server, or the cache can never find it again. So you need a rule that turns a key into a server.',
      focus: ['User Request', 'Cache Router (client library)', 'Cache Node A', 'Cache Node B', 'Cache Node C', 'Cache Node D'],
    },
    {
      title: 'The obvious rule breaks',
      text: 'server = hash(key) mod 4 spreads keys evenly. But add a fifth server, and hash(key) mod 5 gives a different answer for most keys. Nearly the whole cache misses at once, and the database takes the full load.',
      focus: ['Cache Router (client library)', 'Database'],
      example: 'Going from 4 to 5 servers moves about 80% of keys\nMisses jump from 5% to about 80%\nThe database sees 16 times its normal load',
    },
    {
      title: 'Put everything on a ring',
      text: 'Hash both servers and keys onto the same circle of positions. A key belongs to the first server you meet walking clockwise from it.',
      focus: ['Cache Router (client library)', 'Hash Ring (key → node)'],
    },
    {
      title: 'Adding a server moves little',
      text: 'When a fifth server joins, it only takes the keys on the stretch of ring just before it. Everything else stays where it was.',
      focus: ['Hash Ring (key → node)', 'Cache Node E'],
      example: 'Adding the fifth server moves about 1 in 5 keys\n(18% in the 10k-key sample), not 80%',
    },
    {
      title: 'Losing a server moves little too',
      text: 'When a server dies, its keys pass to the next server clockwise. Only its keys miss once; the rest of the cache keeps working.',
      focus: ['Hash Ring (key → node)', 'Cache Node B', 'Cache Node C'],
    },
    {
      title: 'Many points per server',
      text: 'With one point each, some servers get far bigger stretches of ring than others. So each server gets many points (virtual nodes), which evens out the load, and a dead server\'s keys spread over all the others.',
      focus: ['Hash Ring (key → node)'],
      example: '4 servers × 100 points = 400 points\nabout 6 KB, found with about 9 comparisons',
    },
    {
      title: 'Everyone needs the same ring',
      text: 'A membership service watches which servers are healthy and sends the same list to every router. If two routers had different rings, they would look for the same key on different servers.',
      focus: ['Membership Service', 'Cache Router (client library)'],
    },
  ],
  quiz: [
    {
      question: 'Why does hash(key) mod N break when you add a server?',
      options: ['Hashes get slower', 'Changing N changes the answer for most keys, so most of the cache misses', 'The new server is empty forever', 'Keys get deleted'],
      answer: 1,
      why: 'Going from mod 4 to mod 5 moves about 4 in 5 keys.',
    },
    {
      question: 'On a ring, which server owns a key?',
      options: ['The closest server in any direction', 'A random server', 'The server with the most free memory', 'The first server clockwise from the key'],
      answer: 3,
      why: 'Walk clockwise from the key\'s position; the first server point you meet owns it.',
    },
    {
      question: 'What do many points per server (virtual nodes) fix?',
      options: ['Uneven load, and one neighbour taking all of a dead server\'s keys', 'Slow hashing', 'Data loss', 'Network delays'],
      answer: 0,
      why: 'Many small stretches average out, and a dead server\'s keys spread across everyone.',
    },
  ],
}

export default lesson
