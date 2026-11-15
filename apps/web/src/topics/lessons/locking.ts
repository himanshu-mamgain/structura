import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Two buyers, one seat',
      text: 'Asha and Ben tap Book on seat 14A at the same moment. Each server checks "is it free?" and then writes "booked". Both checks pass before either write lands, and the seat is sold twice. This is a race condition.',
      focus: ['Buyer Asha', 'Buyer Ben', 'API Server 1', 'API Server 2', 'Seat Free?'],
      remember: 'The bug lives in the gap between the check and the write.',
    },
    {
      title: 'A lock makes them take turns',
      text: 'A lock closes that gap: one holder at a time, everyone else waits. The question is where the lock lives: in the database, next to the data, or in Redis, where many servers can share it.',
      focus: ['Redis Lock', 'Row Lock Queue'],
    },
    {
      title: 'The database can lock the row',
      text: 'SELECT … FOR UPDATE locks the seat\'s row until the transaction ends. Ben\'s request waits in a queue until Asha\'s is done, then sees the seat is taken.',
      focus: ['Row Lock Queue', 'Seats Table'],
      example: 'BEGIN;\nSELECT status FROM seats WHERE id = \'14A\' FOR UPDATE;\nUPDATE seats SET status = \'booked\' WHERE id = \'14A\';\nCOMMIT;',
    },
    {
      title: 'Or one update that checks itself',
      text: 'Even simpler: one UPDATE that only succeeds if the seat is still free. If it changes 0 rows, someone else got there first. Nobody waits at all.',
      focus: ['Seats Table'],
      example: 'UPDATE seats SET status = \'booked\', buyer = \'asha\'\nWHERE id = \'14A\' AND status = \'free\';\n-- 1 row: yours. 0 rows: already taken.',
    },
    {
      title: 'A Redis lock across servers',
      text: 'SET with NX (only if it doesn\'t exist) and a TTL gives one server the lock by name. The TTL means a crashed server can\'t hold it forever.',
      focus: ['API Server 1', 'API Server 2', 'Redis Lock'],
      example: 'SET lock:seat:14A server-1 NX PX 10000\n→ OK for the first server, nil for everyone else',
    },
    {
      title: 'The TTL can run out under you',
      text: 'API Server 1 takes the lock, then freezes for 12 seconds. At 10 seconds the lock expires, and Server 2 takes it and books the seat for Ben. When Server 1 wakes, it still thinks it holds the lock.',
      focus: ['API Server 1', 'Redis Lock', 'API Server 2'],
    },
    {
      title: 'Fencing tokens stop the late writer',
      text: 'Each time the lock is given out, a counter goes up: token 41, then 42. The database only accepts a write with a token higher than the last one, so Server 1\'s late write with 41 is rejected.',
      focus: ['Fencing Counter', 'Seats Table', 'Bookings Table'],
      example: 'UPDATE seats SET buyer = \'asha\', fence = 41\nWHERE id = \'14A\' AND fence < 41;\n-- Ben already wrote fence 42: 0 rows, rejected',
    },
    {
      title: 'Which one to use',
      text: 'If the data is in one database, let the database lock it, or use one update that checks itself. Use a Redis lock to keep many servers from doing the same expensive work, and add fencing when correctness depends on it.',
      remember: 'A lock with a TTL is a lease: it can end while you still think you hold it.',
    },
  ],
  quiz: [
    {
      question: 'Where exactly does the double booking come from?',
      options: ['A slow database', 'The gap between checking the seat and writing to it', 'Too many users', 'Redis losing data'],
      answer: 1,
      why: 'Both servers check before either writes, so both checks say "free".',
    },
    {
      question: 'An UPDATE … WHERE status = \'free\' changes 0 rows. What does it mean?',
      options: ['The database is down', 'The seat doesn\'t exist', 'Retry until it works', 'Someone else booked the seat first'],
      answer: 3,
      why: 'The condition no longer matched, so another request got there first.',
    },
    {
      question: 'Why add a fencing token to a Redis lock?',
      options: ['So a late write from a server whose lock expired is rejected', 'To make the lock faster', 'So the lock never expires', 'To save memory'],
      answer: 0,
      why: 'The database only accepts writes with a newer token, so the old holder can\'t overwrite the new one.',
    },
  ],
}

export default lesson
