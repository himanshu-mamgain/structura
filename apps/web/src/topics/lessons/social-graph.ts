import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'People and friendships',
      text: 'A social network is a graph: people are nodes, friendships are the lines between them. The hard question is the shortest path between two people.',
      focus: ['Client', 'Search API', 'User Graph Service'],
    },
    {
      title: 'Too big for one machine',
      text: '100 million people with about 100 friends each make 10 billion friendships. Stored both ways, that is about 160 GB of friend lists.',
      example: '10 billion × 2 × 8 bytes = 160 GB',
    },
    {
      title: 'Spread people across servers',
      text: 'Friend lists are split across Person Servers. The Lookup Service says which server holds whom, so people can be moved when load shifts.',
      focus: ['Lookup Service', 'Person Server'],
    },
    {
      title: 'Breadth-first search',
      text: 'Breadth-first search visits everyone 1 hop away, then 2 hops, and so on. The first time it reaches the target, that path is the shortest.',
      focus: ['User Graph Service'],
      remember: 'BFS finds the shortest path; DFS may find a long one first.',
    },
    {
      title: 'Batch the lookups',
      text: 'Each level may have hundreds of people on many servers. The service groups their ids by server and asks each server once, instead of hundreds of separate calls.',
      focus: ['User Graph Service', 'Person Server'],
    },
    {
      title: 'Search from both ends',
      text: 'Search from both people and stop where the searches meet. With 100 friends each, one side going 4 hops may touch 100 million people; two sides going 2 hops touch about 20k.',
      example: '100^4 = 100 million\n2 × 100^2 = 20k',
    },
    {
      title: 'Cache what repeats',
      text: 'Friend lists and recent paths sit in Redis, because most searches repeat. Names and photos come from the User Info Service and SQL.',
      focus: ['Memory Cache (Redis)', 'User Info Service', 'SQL Database'],
    },
    {
      title: 'The scale',
      text: '100 million users making 50 friend searches a month is 5 billion searches, about 2k a second.',
      example: '5 billion ÷ 2.5 million s = 2k a second',
    },
  ],
  quiz: [
    {
      question: 'Why use breadth-first search for the shortest path?',
      options: ['It uses less memory', 'It reaches the target first by the shortest path', 'It is random', 'It needs no servers'],
      answer: 1,
      why: 'It explores hop by hop, so the first path found is the shortest.',
    },
    {
      question: 'Why search from both people at once?',
      options: ['It looks nicer', 'Two short searches touch far fewer people than one long one', 'It avoids caching', 'It finds longer paths'],
      answer: 1,
      why: '2 × 100^2 = 20k people instead of 100^4 = 100 million.',
    },
    {
      question: 'What does the Lookup Service do?',
      options: ['Stores photos', 'Says which Person Server holds each person', 'Sends messages', 'Runs searches'],
      answer: 1,
      why: 'It maps people to servers, so they can be moved when load changes.',
    },
  ],
}

export default lesson
