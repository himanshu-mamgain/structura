import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Two people, one document',
      text: 'In a shared document, Alice and Bob can type at the same moment. Every edit must still make sense after the other person\'s edit lands first.',
      focus: ['Alice (browser)', 'Bob (browser)'],
    },
    {
      title: 'Positions go stale',
      text: 'The text is "cat". Alice inserts "s" at position 3. At the same moment Bob inserts "the " at position 0. If Alice\'s edit is applied after Bob\'s, position 3 is now wrong.',
      example: 'start: "cat"\nBob: insert "the " at 0 → "the cat"\nAlice: insert "s" at 3 → "thes cat"  ✗',
    },
    {
      title: 'Transform the edit',
      text: 'Operational transformation, OT, rewrites an edit against the edits before it. Bob added 4 characters before position 3, so Alice\'s insert moves to position 7.',
      example: 'Alice: insert "s" at 3 → transformed to 7\n"the cat" → "the cats"  ✓',
      remember: 'OT shifts positions so every screen ends the same.',
    },
    {
      title: 'One server orders all edits',
      text: 'All edits for one document go through one Collaboration Server. It puts them in a single order and gives each a revision number.',
      focus: ['WebSocket Gateway', 'Collaboration Server'],
    },
    {
      title: 'Your typing shows at once',
      text: 'The browser applies your own typing immediately, then sends it. It keeps unconfirmed edits and transforms incoming edits against them, so the editor feels instant on a slow network.',
      focus: ['Alice (browser)', 'Collaboration Server'],
    },
    {
      title: 'The log is the truth',
      text: 'Every edit is appended to the Operation Log. Every 100 revisions, the Snapshot Worker saves the whole document, so opening it doesn\'t replay thousands of edits.',
      focus: ['Operation Log', 'Snapshot Worker', 'Snapshot Store'],
    },
    {
      title: 'Cursors and permissions',
      text: 'Presence shows where others\' cursors are; it can be a little late. The Permissions Service checks who may edit, comment or only read.',
      focus: ['Presence (cursors)', 'Permissions Service', 'Document Metadata DB'],
    },
    {
      title: 'The scale',
      text: '1 million people editing at once, one edit a second each, need about 20 gateways at 50k connections each, and about 50 collaboration servers at 20k edits a second.',
      example: '1 million ÷ 50k = 20 gateways\n1 million ÷ 20k = 50 servers',
    },
  ],
  quiz: [
    {
      question: 'What does operational transformation do?',
      options: ['Locks the document while one person types', 'Rewrites an edit\'s positions against earlier edits', 'Saves snapshots', 'Shows cursors'],
      answer: 1,
      why: 'It adjusts positions so both edits apply correctly in any order.',
    },
    {
      question: 'Why does one server handle all edits of a document?',
      options: ['To save money', 'So there is a single order of edits', 'Browsers need it for fonts', 'To store snapshots'],
      answer: 1,
      why: 'One owner gives one order and revision numbers, which makes OT simple.',
    },
    {
      question: 'Why save a snapshot every 100 revisions?',
      options: ['So opening a document doesn\'t replay every edit', 'To delete the log', 'To show cursors', 'For permissions'],
      answer: 0,
      why: 'Load the latest snapshot, then apply only the few edits after it.',
    },
  ],
}

export default lesson
