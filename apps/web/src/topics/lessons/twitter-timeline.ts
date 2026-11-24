import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Post, read, search',
      text: 'People post tweets, read a home timeline of everyone they follow, and search. The home timeline is read far more often than tweets are written.',
      focus: ['Client', 'Write API', 'Read API', 'Search API'],
    },
    {
      title: 'The numbers',
      text: '500 million tweets a day is about 6k writes a second. 250 billion timeline reads a month is about 100k reads a second. Reads win by a lot.',
      example: '250 billion ÷ 2.59 million s a month ≈ 96k reads a second',
    },
    {
      title: 'Build timelines ahead: fan-out on write',
      text: 'When you tweet, the Fan Out Service puts the tweet id into each follower\'s timeline in Redis. Reading a timeline is then one quick cache lookup.',
      focus: ['Write API', 'Fan Out Service', 'User Graph Service', 'Memory Cache (Redis)'],
      remember: 'Do the work once at write time, not at every read.',
    },
    {
      title: 'The celebrity problem',
      text: 'Fan-out costs one write per follower. A star with 50 million followers would cause 50 million writes per tweet, taking minutes. So big accounts are skipped.',
      focus: ['Fan Out Service'],
    },
    {
      title: 'Merge celebrities at read time',
      text: 'When you open your timeline, the Timeline Service takes your precomputed list and merges in recent tweets from the stars you follow. This mix is called a hybrid.',
      focus: ['Read API', 'Timeline Service', 'Tweet Info Service'],
    },
    {
      title: 'Ids in memory, tweets elsewhere',
      text: 'Timelines in Redis hold only tweet ids, and only the newest few hundred, for users active lately. The tweets live in the SQL Database and media in the Object Store.',
      focus: ['Memory Cache (Redis)', 'SQL Database', 'Object Store'],
    },
    {
      title: 'Search has its own cluster',
      text: 'New tweets are indexed into the Search Cluster, which splits words and finds matching tweets fast. Search traffic never slows the timeline.',
      focus: ['Search API', 'Search Cluster'],
    },
    {
      title: 'Side work through queues',
      text: 'Notifications and indexing happen after the tweet is saved, through queues. Posting stays fast.',
      focus: ['Notification Service'],
    },
  ],
  quiz: [
    {
      question: 'Why build home timelines when a tweet is written?',
      options: ['Writes are rare and reads are many, so reads become one cache lookup', 'It saves storage', 'It stops celebrities', 'Search needs it'],
      answer: 0,
      why: 'About 100k reads a second against 6k writes: doing the work once per write is far cheaper.',
    },
    {
      question: 'A star with 50 million followers tweets. What does the hybrid design do?',
      options: ['Writes to all 50 million timelines', 'Skips fan-out and merges the tweet in when followers read', 'Drops the tweet', 'Sends it by email'],
      answer: 1,
      why: 'Fanning out to 50 million would take minutes, so stars are merged in at read time.',
    },
    {
      question: 'What does each Redis timeline hold?',
      options: ['Full tweets with images', 'Tweet ids for the newest few hundred tweets', 'Every tweet ever', 'Search results'],
      answer: 1,
      why: 'Small ids keep memory low; the tweet text comes from the Tweet Info Service.',
    },
  ],
}

export default lesson
