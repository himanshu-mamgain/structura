import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One folder, every device',
      text: 'A sync service keeps the same folder identical on your laptop, phone and desktop. Change a file on one, and the others update.',
      focus: ['Desktop Client', 'Other Device'],
    },
    {
      title: 'Files are cut into blocks',
      text: 'The client cuts each file into blocks of about 4 MB. A 100 MB file becomes 25 blocks. Change one paragraph, and usually only one block changes.',
      focus: ['Desktop Client'],
      example: '100 MB ÷ 4 MB = 25 blocks',
    },
    {
      title: 'Each block is named by its hash',
      text: 'A block\'s name is the SHA-256 hash of its bytes. Equal bytes give an equal name. So the server can tell at once which blocks it already has.',
      focus: ['Block Server', 'Block Store'],
      remember: 'Same hash, same bytes: send it once, store it once.',
    },
    {
      title: 'Send only the missing blocks',
      text: 'The client asks "which of these hashes do you lack?" and uploads only those. Thanks to this, an average change uploads about 2 MB, not the whole file.',
      focus: ['Desktop Client', 'Block Server'],
    },
    {
      title: 'Metadata says which blocks make a file',
      text: 'The Sync Service keeps a small record for each version: the file\'s path and its list of block hashes. Metadata and bytes travel separate paths, to separate stores.',
      focus: ['Sync Service', 'Metadata DB', 'Metadata Cache'],
      example: 'report.pdf v7 → [a1f3…, 9c2e…, 77b0…]',
    },
    {
      title: 'Commit last',
      text: 'Blocks are uploaded first; the new version is saved last. If the upload breaks halfway, other devices never see half a file.',
      focus: ['Sync Service'],
    },
    {
      title: 'Tell the other devices',
      text: 'After a commit, a message goes through the queue to the Notification Service, which tells your other devices "something changed". They then ask "what changed since my cursor?".',
      focus: ['Message Queue', 'Notification Service', 'Other Device'],
    },
    {
      title: 'The scale',
      text: '20 million active users make 10 changes a day: 200 million commits, about 2,300 a second. At 2 MB each, that is about 4.6 GB a second of uploads.',
      example: '200 million ÷ 86,400 s ≈ 2,300 a second',
    },
  ],
  quiz: [
    {
      question: 'You fix a typo in a 100 MB file. What is uploaded?',
      options: ['The whole 100 MB', 'Only the block or two that changed', 'Nothing', 'Every block again with a new name'],
      answer: 1,
      why: 'Unchanged blocks keep their hash, and the server already has them.',
    },
    {
      question: 'Why save the new version only after all its blocks are uploaded?',
      options: ['So other devices never see half a file', 'To save space', 'Hashes need it', 'It is faster'],
      answer: 0,
      why: 'Committing last means a version only exists once every block it needs is stored.',
    },
    {
      question: 'Two users store the same 4 MB block. How many copies does the server keep?',
      options: ['Two', 'One, because the hash is the same', 'None', 'Three for safety, each separate'],
      answer: 1,
      why: 'Equal hashes mean equal bytes, so the block is stored once (deduplication).',
    },
  ],
}

export default lesson
