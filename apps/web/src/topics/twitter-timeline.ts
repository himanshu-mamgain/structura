import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design the Twitter timeline and search" in the System Design
// Primer by Donne Martin (CC BY 4.0). Requirements, estimates and the core
// design follow the primer; the walkthrough, simulator, code and the celebrity
// read-time merge detail are Structura's.

/** Above this many followers, fanning out on write costs more than merging at read time. */
const CELEBRITY = 1_000_000
/** Home timelines keep only the newest few hundred entries in memory. */
const TIMELINE_LENGTH = 800

const AUTHORS: Record<string, { name: string; id: string; followers: number }> = {
  'Regular user (150 followers)': { name: 'maya', id: '123', followers: 150 },
  'Popular account (12,000 followers)': { name: 'devnews', id: '204', followers: 12_000 },
  'Celebrity (40 million followers)': { name: 'popstar', id: '9', followers: 40_000_000 },
}

const fmt = (n: number) => n.toLocaleString('en-US')

const simulator: Simulator = {
  fields: [
    { id: 'author', label: 'Who tweets', options: Object.keys(AUTHORS) },
    { id: 'action', label: 'What happens', options: ['Post a tweet', 'A follower opens their home timeline'] },
  ],
  defaults: { author: 'Popular account (12,000 followers)', action: 'Post a tweet' },
  run({ author, action }) {
    const a = AUTHORS[author] ?? AUTHORS['Regular user (150 followers)']
    const celebrity = a.followers >= CELEBRITY
    const tweetId = '1849302284'
    const steps: Trace['steps'] = []

    if (action === 'Post a tweet') {
      steps.push(
        { text: `@${a.name} posts a tweet. The Client sends it to the Web Server (a reverse proxy), which forwards it to the Write API.`, nodes: ['Client', 'Web Server', 'Write API'], data: `POST /api/v1/tweet\n${json({ user_id: a.id, status: 'hello world!', media_ids: 'ABC987' })}` },
        { text: 'The Write API saves the tweet to the author\'s own timeline in the SQL Database. That is the user timeline: the author\'s own tweets, in order.', nodes: ['Write API', 'SQL Database'], data: `INSERT INTO tweets (tweet_id, user_id, text, created_at)\nVALUES (${tweetId}, ${a.id}, 'hello world!', now());` },
        { text: 'Media goes to the Object Store, not the database: a tweet row stays small, and photos and videos are served from cheap blob storage (usually behind a CDN).', nodes: ['Object Store'], data: 'PUT s3://tweet-media/ABC987.jpg  (≈ 10 KB average per tweet incl. media)' },
        { text: 'The Write API hands the tweet to the Fan Out Service, which asks the User Graph Service who follows the author. The follower lists live in the Memory Cache.', nodes: ['Write API', 'Fan Out Service', 'User Graph Service'], data: `followers(${a.id}) → ${fmt(a.followers)} user ids` },
      )
      if (celebrity) {
        steps.push({
          text: `${fmt(a.followers)} followers is too many to fan out: it would take minutes and flood the cache. So the tweet is not pushed to anyone's home timeline. Followers' timelines pull it in when they are read (see "A follower opens their home timeline").`,
          nodes: ['Fan Out Service'],
          data: `followers ${fmt(a.followers)} ≥ ${fmt(CELEBRITY)} → skip fan-out\nfanout cost avoided: ${fmt(a.followers)} cache writes`,
        })
      } else {
        steps.push({
          text: `Fan-out on write: the tweet id is pushed onto the home timeline of each of the ${fmt(a.followers)} followers in the Memory Cache. It is O(n): ${fmt(a.followers)} followers means ${fmt(a.followers)} inserts, and each list is trimmed to its newest ${TIMELINE_LENGTH}.`,
          nodes: ['Fan Out Service', 'Memory Cache (Redis)'],
          data: `# for each follower f (pipelined, batched)\nLPUSH home:<f> "${tweetId}:${a.id}:0"\nLTRIM home:<f> 0 ${TIMELINE_LENGTH - 1}\n\n→ ${fmt(a.followers)} list writes`,
        })
      }
      steps.push(
        { text: 'The tweet is added to the Search Cluster so keyword searches can find it within seconds.', nodes: ['Fan Out Service', 'Search Cluster'], data: `index tweets/${tweetId} { "text": "hello world!", "user_id": ${a.id} }` },
        { text: 'Notifications go out through the Notification Service, which works off a queue so a slow push or email provider never delays the post.', nodes: ['Fan Out Service', 'Notification Service'], data: json({ type: 'new_tweet', tweet_id: tweetId, to: 'followers with notifications on' }) },
        { text: 'The author gets a response as soon as the tweet is saved; fan-out, indexing and notifications carry on in the background.', nodes: ['Write API', 'Client'], data: `HTTP/1.1 201 Created\n${json({ tweet_id: tweetId, user_id: a.id, status: 'hello world!' })}` },
      )
      return { input: `@${a.name} (${fmt(a.followers)} followers) posts a tweet`, steps }
    }

    steps.push(
      { text: 'A follower (user 456) opens their home timeline. The Web Server forwards it to the Read API, which asks the Timeline Service.', nodes: ['Client', 'Web Server', 'Read API', 'Timeline Service'], data: 'GET /api/v1/home_timeline?user_id=456' },
      { text: 'The Timeline Service reads the precomputed home timeline from the Memory Cache: just tweet ids and user ids, newest first. One list read, O(1).', nodes: ['Timeline Service', 'Memory Cache (Redis)'], data: `LRANGE home:456 0 19\n→ ["${celebrity ? '1849301102' : tweetId}:${celebrity ? '204' : a.id}:0", …]` },
    )
    if (celebrity) {
      steps.push({
        text: `456 also follows @${a.name}, whose tweets were never fanned out. The Timeline Service fetches @${a.name}'s recent tweets at read time and merges them in, re-ordering by time.`,
        nodes: ['Timeline Service', 'SQL Database'],
        data: `SELECT tweet_id, user_id, created_at FROM tweets\nWHERE user_id IN (9) AND created_at > now() - interval '2 days'\nORDER BY created_at DESC LIMIT 20;\n\nmerge(cached ids, celebrity ids) by created_at`,
      })
    }
    steps.push(
      { text: 'The ids are turned into full tweets with one multiget to the Tweet Info Service, and authors with one multiget to the User Info Service: O(n), but each is a single round trip.', nodes: ['Tweet Info Service', 'User Info Service'], data: `MGET tweet:${tweetId} tweet:1849301102 …\nMGET user:${a.id} user:204 …` },
      { text: 'The Read API returns the timeline.', nodes: ['Read API', 'Client'], data: json([{ user_id: a.id, tweet_id: tweetId, status: 'hello world!' }, { user_id: '204', tweet_id: '1849301102', status: 'release notes are up' }]) },
    )
    return { input: `A follower of @${a.name} opens their home timeline`, steps }
  },
}

export const twitterTimeline: StaticTopic = {
  difficulty: 'Intermediate',
  kind: 'static',
  id: 'twitter-timeline',
  title: 'Twitter Timeline & Search',
  blurb: 'Fan-out on write, celebrity merge at read time, caching and search',
  adaptedFrom: {
    title: 'Design the Twitter timeline and search',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/twitter/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: [
    'primer-design-the-twitter-timeline-and-search-or-facebook-feed-and-search',
    'primer-cache',
    'primer-asynchronism',
    'twitter-architecture-2022-vs-2012',
    'how-does-twitter-recommend-tweets',
  ],
  takeaways: [
    'The home timeline is read far more than tweets are written, so build it ahead of time: fan out on write.',
    'Fan-out is O(followers): fine for most users, far too slow for celebrities.',
    'Skip fan-out for accounts with millions of followers and merge their tweets in at read time.',
    'Keep timelines in memory, only the newest few hundred tweets, and only for active users.',
    'Store tweets in SQL for the user timeline; serve home timelines from the cache.',
    'Push notifications and indexing through queues so posting stays fast.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'api', label: 'API servers' },
      { id: 'services', label: 'Services' },
      { id: 'data', label: 'Storage' },
    ],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'web', label: 'Web Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'write', label: 'Write API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'read', label: 'Read API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'searchapi', label: 'Search API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'fanout', label: 'Fan Out Service', shape: 'rectangle', color: 'orange', group: 'services' },
      { id: 'graph', label: 'User Graph Service', shape: 'rectangle', color: 'light-violet', group: 'services' },
      { id: 'timeline', label: 'Timeline Service', shape: 'rectangle', color: 'light-violet', group: 'services' },
      { id: 'tweetinfo', label: 'Tweet Info Service', shape: 'rectangle', color: 'light-violet', group: 'services' },
      { id: 'userinfo', label: 'User Info Service', shape: 'rectangle', color: 'light-violet', group: 'services' },
      { id: 'notify', label: 'Notification Service', shape: 'rectangle', color: 'yellow', group: 'services' },
      { id: 'cache', label: 'Memory Cache (Redis)', shape: 'rectangle', color: 'red', group: 'data' },
      { id: 'sql', label: 'SQL Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'objects', label: 'Object Store', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'search', label: 'Search Cluster', shape: 'rectangle', color: 'green', group: 'data' },
    ],
    edges: [
      { from: 'client', to: 'web', label: 'HTTPS', dashed: false },
      { from: 'web', to: 'write', label: 'POST /tweet', dashed: false },
      { from: 'web', to: 'read', label: 'GET /home_timeline', dashed: false },
      { from: 'web', to: 'searchapi', label: 'GET /search', dashed: false },
      { from: 'write', to: 'sql', label: 'user timeline', dashed: false },
      { from: 'write', to: 'fanout', label: 'fan out', dashed: false },
      { from: 'fanout', to: 'graph', label: 'who follows?', dashed: false },
      { from: 'graph', to: 'cache', label: 'follower lists', dashed: true },
      { from: 'fanout', to: 'cache', label: 'push to home timelines', dashed: false },
      { from: 'fanout', to: 'search', label: 'index tweet', dashed: false },
      { from: 'fanout', to: 'objects', label: 'media', dashed: true },
      { from: 'fanout', to: 'notify', label: 'notify followers', dashed: true },
      { from: 'read', to: 'timeline', label: 'home timeline', dashed: false },
      { from: 'timeline', to: 'cache', label: 'tweet + user ids', dashed: false },
      { from: 'timeline', to: 'tweetinfo', label: 'multiget tweets', dashed: false },
      { from: 'timeline', to: 'userinfo', label: 'multiget users', dashed: false },
      { from: 'read', to: 'sql', label: 'user timeline', dashed: true },
      { from: 'searchapi', to: 'search', label: 'scatter-gather', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'handle', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'follower_count', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'tweets',
        name: 'tweets',
        columns: [
          { name: 'tweet_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'text', type: 'varchar(280)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'media_key', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id, created_at DESC) — user timeline'],
      },
      {
        id: 'follows',
        name: 'follows',
        columns: [
          { name: 'follower_id', type: 'bigint', pk: true, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'followee_id', type: 'bigint', pk: true, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(followee_id) — who to fan out to'],
      },
    ],
    relations: [
      { from: 'tweets', to: 'users', kind: 'one-to-many', label: 'posts' },
      { from: 'follows', to: 'users', kind: 'many-to-many', label: 'follows' },
    ],
  },
  explanation: {
    title: 'Twitter Timeline & Search',
    summary:
      'Users post tweets, read a home timeline built from everyone they follow, and search. Reads dwarf writes, so the home timeline is precomputed: each new tweet is pushed into followers\' timelines in memory (fan-out on write), except for celebrities, whose tweets are merged in when a timeline is read.',
    sections: [
      {
        heading: 'Overview',
        body: 'Two timelines matter:\n- The user timeline: one person\'s own tweets. Easy: a query on tweets by user_id.\n- The home timeline: tweets from everyone you follow, newest first. Hard: it combines hundreds of people, and it is the most-read page in the product.\n\nComputing the home timeline on every read (fan-out on read) means querying everyone you follow each time. Instead, this design does the work once per tweet (fan-out on write) and keeps every active user\'s home timeline ready in memory.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A user posts a tweet; followers get push notifications and emails.\n- A user views their user timeline and their home timeline.\n- A user searches by keyword.\n- High availability.\n\nOut of scope: the firehose and other streams, visibility rules (hidden replies and retweets), analytics.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions from the System Design Primer:\n- 100 million active users; 500 million tweets a day (15 billion a month).\n- Each tweet fans out to 10 followers on average: 5 billion deliveries a day.\n- 250 billion timeline reads and 10 billion searches a month.\n\nWhich works out to:\n- About 6,000 tweets per second written, 60,000 fan-out deliveries per second.\n- About 100,000 timeline reads per second and 4,000 searches per second.\n- About 10 KB per tweet with media: 150 TB of new content a month, 5.4 PB in three years.\n\nHandy rule: 400 requests per second ≈ 1 billion requests per month.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client posts a tweet to the Web Server, which forwards it to the Write API.\n2. The Write API stores it in the SQL Database (the author\'s user timeline).\n3. The Fan Out Service asks the User Graph Service for the author\'s followers.\n4. It pushes the tweet id into each follower\'s home timeline in the Memory Cache (Redis).\n5. It indexes the tweet in the Search Cluster, stores media in the Object Store, and queues notifications with the Notification Service.\n6. To read, the Read API asks the Timeline Service, which reads ids from the Memory Cache (Redis).\n7. It fills in tweets and authors with multigets to the Tweet Info Service and the User Info Service.\n8. Searches go through the Search API to the Search Cluster, which scatter-gathers across its shards and ranks the results.',
      },
      {
        heading: 'Components',
        body: '- Web Server: a reverse proxy in front of the API servers (TLS, routing, compression).\n- Write API, Read API, Search API: stateless servers for the three paths, scaled separately.\n- Fan Out Service: turns one tweet into N home-timeline writes, in the background.\n- User Graph Service: who follows whom, cached in memory.\n- Timeline Service: builds the response from cached ids plus multigets.\n- Memory Cache (Redis): each home timeline is a list of (tweet_id, user_id, meta), 8 + 8 + 1 bytes per entry.\n- SQL Database: the source of truth for tweets and users.\n- Object Store: photos and video.\n- Search Cluster: an inverted index (Lucene-style), kept in memory for low latency.\n- Notification Service: sends pushes and emails off a queue.',
      },
      {
        heading: 'Key decisions',
        body: '- Fan-out on write vs on read. On write: reads are one cache lookup, but each tweet costs O(followers) writes. On read: tweets are cheap, every timeline read is expensive. Twitter-scale read traffic favours writing.\n- The celebrity problem. Fanning out a tweet to tens of millions of followers takes minutes and floods the cache. Skip fan-out above a threshold and merge those accounts\' recent tweets in at read time: a hybrid.\n- What to keep in memory. Only the newest few hundred entries per timeline, and only for users active in the last 30 days. An inactive user\'s timeline is rebuilt from SQL when they come back.\n- Ids, not tweets, in the timeline lists: tiny entries, and edits or deletes only touch the Tweet Info Service.\n- REST for public APIs, RPC between internal services.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The Fan Out Service is the obvious bottleneck. Slow fan-out can also make a reply appear before the tweet it answers; re-ordering by timestamp at serve time hides that.\n- The SQL Database will not keep up with 6,000 writes per second plus cache misses on one primary: add read replicas, then federation (split by function), sharding (split by user), and denormalization.\n- Some data fits NoSQL better, for example timelines and the social graph.\n- Keep the Search Cluster\'s index in memory; queries scatter to every shard, so one slow shard slows every search.\n- Benchmark, profile, fix the worst bottleneck, repeat: scaling is iterative.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Where exactly would you put the celebrity threshold, and how would you measure it?\n- A user unfollows someone. How do their tweets leave the home timeline?\n- How do you rebuild the timeline of a user who has been away for a year?\n- How would you rank the timeline instead of sorting it by time?\n- How would you make a tweet searchable within a few seconds of posting?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Fan-out worker (Redis)',
        language: 'typescript',
        source: `import Redis from 'ioredis'

const redis = new Redis()
const CELEBRITY = 1_000_000 // above this, followers merge at read time
const TIMELINE_LENGTH = 800 // keep only the newest entries in memory

export async function fanOut(tweet: { id: string; userId: string }, followers: string[]) {
  if (followers.length >= CELEBRITY) return // too many: skip, merged on read

  const entry = \`\${tweet.id}:\${tweet.userId}:0\` // tweet_id:user_id:meta
  // Batch the O(n) writes: one round trip per 1,000 followers.
  for (let i = 0; i < followers.length; i += 1000) {
    const batch = redis.pipeline()
    for (const follower of followers.slice(i, i + 1000)) {
      batch.lpush(\`home:\${follower}\`, entry)
      batch.ltrim(\`home:\${follower}\`, 0, TIMELINE_LENGTH - 1)
    }
    await batch.exec()
  }
}`,
      },
      {
        title: 'Reading the home timeline',
        language: 'typescript',
        source: `import Redis from 'ioredis'

const redis = new Redis()

/** Newest 20 tweet ids for a user, with followed celebrities merged in. */
export async function homeTimeline(userId: string, celebrityTweets: () => Promise<{ id: string; at: number }[]>) {
  const cached = await redis.lrange(\`home:\${userId}\`, 0, 19) // O(1) to find, O(20) to read
  const fromCache = cached.map((e) => {
    const [id] = e.split(':')
    return { id, at: snowflakeTime(id) }
  })
  const merged = [...fromCache, ...(await celebrityTweets())]
  merged.sort((a, b) => b.at - a.at) // re-order at serve time
  return merged.slice(0, 20).map((t) => t.id)
}

/** Snowflake-style ids carry their creation time in the top bits. */
const snowflakeTime = (id: string) => Number(BigInt(id) >> 22n)`,
      },
      {
        title: 'User timeline and fan-out targets',
        language: 'sql',
        source: `-- User timeline: one index range scan on (user_id, created_at DESC).
SELECT tweet_id, text, created_at
FROM tweets
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 20;

-- Who to fan out to: uses the index on follows(followee_id).
SELECT follower_id FROM follows WHERE followee_id = $1;`,
      },
    ],
    related: ['Fan-out on write vs read', 'Redis', 'Sharding', 'Inverted index', 'Message queues', 'Snowflake ids'],
  },
  simulator,
}
