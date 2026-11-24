import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Paste text, share a link',
      text: 'You paste some text and get a short link. Anyone with the link can read the text until it expires. It looks like a URL shortener, but the thing behind the link is a block of text.',
      focus: ['Client', 'Write API', 'Read API'],
    },
    {
      title: 'Small numbers, clear structure',
      text: 'The plan: 1 million new pastes and 10 million reads a month. That is about 0.4 writes and 4 reads a second. The point is the structure, not the scale.',
      example: '1 million ÷ 2.59 million seconds a month ≈ 0.4 writes a second',
    },
    {
      title: 'Split each paste in two',
      text: 'A small row in the SQL Database keeps the key, the expiry time and where the text is. The text itself goes to the Object Store, which keeps big files cheaply.',
      focus: ['SQL Database', 'Object Store'],
      remember: 'Metadata in SQL, text in the object store.',
    },
    {
      title: 'A key from MD5',
      text: 'The Write API takes the MD5 hash of the IP address plus the time, writes it in base62 and keeps 7 characters. 7 characters give about 3.5 trillion keys, far more than the 36 million needed in 3 years.',
      focus: ['Write API'],
      example: '62^7 ≈ 3.5 trillion keys\n3 years ≈ 36 million pastes',
    },
    {
      title: 'Collisions are caught',
      text: 'Cutting a hash to 7 characters can, rarely, give two pastes the same key. The key is the primary key, so the second insert fails. The Write API adds a salt and tries again.',
      focus: ['Write API', 'SQL Database'],
    },
    {
      title: 'Cache the popular ones',
      text: 'Reads outnumber writes 10 to 1. Redis keeps hot pastes, so most reads never touch the database or the object store. The cache time is set to the paste\'s time left.',
      focus: ['Read API', 'Memory Cache (Redis)'],
    },
    {
      title: 'Check expiry on every read',
      text: 'A paste must stop working at its deadline. So the Read API compares the clock with the expiry on every read. The Expiry Cleanup Job deletes old pastes later, only to free space.',
      focus: ['Read API', 'Expiry Cleanup Job'],
      remember: 'Correctness on read; cleanup in the background.',
    },
    {
      title: 'Analytics from logs',
      text: 'Views are counted from the access logs by the Analytics Job. Nothing about counting slows down a read.',
      focus: ['Analytics Job'],
    },
  ],
  quiz: [
    {
      question: 'Why not keep the paste text in the SQL table?',
      options: ['SQL cannot store text', 'Big pastes would bloat the table and its backups', 'Object stores are faster to query', 'It would break the key'],
      answer: 1,
      why: 'A 5 MB paste in a table makes every backup and copy heavier. An object store keeps large blobs cheaply.',
    },
    {
      question: 'A paste expired at 10:00. The cleanup job runs at 11:00. What should a read at 10:30 return?',
      options: ['The paste, since it still exists', 'An error, because it has expired', 'The paste from the cache', 'A random paste'],
      answer: 1,
      why: 'The Read API checks the expiry on every read, so the paste stops working on time even before cleanup.',
    },
    {
      question: 'Two pastes get the same 7-character key. What happens?',
      options: ['The first paste is overwritten', 'Both share the key', 'The second insert fails and is retried with a salt', 'The paste is lost'],
      answer: 2,
      why: 'The key is the primary key, so the clash is rejected, and the Write API retries with a different input.',
    },
  ],
}

export default lesson
