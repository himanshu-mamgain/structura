# Twitter Timeline & Search

> 💡 **TL;DR**: On Twitter, people post short **tweets**, read a **home timeline** made of tweets from everyone they follow, and **search**. Timelines are read far more often than tweets are written (about 100k reads a second against 6k tweets), so the home timeline is **built ahead of time**: when you tweet, your tweet's ID is pushed into every follower's timeline in memory. This is **fan-out on write**. It costs one write per follower, which is fine for most people but far too slow for a celebrity with 50 million followers, so celebrities are skipped and their tweets are **merged in when a timeline is read**. Search runs on its own index, and notifications go through queues, so posting stays fast.

## At a glance

| Question | Answer |
|---|---|
| Home timeline | Tweets from everyone you follow, newest first |
| User timeline | One person's own tweets |
| Load | About 6k tweets a second, 100k timeline reads a second, 4k searches a second |
| Fan-out on write | When you tweet, put its ID into each follower's timeline now |
| Fan-out on read | When someone opens their timeline, gather tweets from everyone they follow then |
| Main choice | Fan-out on write, because reads win about 17 to 1 |
| The celebrity problem | Fan-out costs one write per follower; 50 million writes per tweet is too slow |
| The fix | A hybrid: skip fan-out for huge accounts, merge their tweets in at read time |
| What timelines hold | Tweet IDs only, the newest few hundred, for active users |
| Search | A separate search cluster with a reverse index |

## What a timeline is, and fan-out

Two timelines matter:
- The **user timeline** is one person's own tweets, like a profile page. It's easy: read their tweets, newest first.
- The **home timeline** is what you see when you open the app: tweets from everyone **you follow**, merged and sorted. This is the hard one.

**Fan-out** means taking one item and sending it to many places. There are two ways to build home timelines:

- **Fan-out on read** (pull): when Asha opens the app, look up the 300 people she follows, fetch their recent tweets, merge and sort them. Tweeting is cheap; every read is expensive.
- **Fan-out on write** (push): when Ravi tweets, put the tweet's ID into each of his followers' timelines straight away. Tweeting costs one write per follower; reading is a single cache lookup.

With about 100k reads a second against 6k writes, it's far cheaper to do the work once when the tweet is written than every time a timeline is read. So Twitter-style systems mostly fan out on write.

## Follow one tweet all the way through

Ravi, who has 3 followers in this small example (Asha, Meera, Dev), tweets "Monsoon is here".

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Ravi's app posts the tweet | Client → Web Server → Write API |
| 2 | The tweet is saved with ID 9814, in Ravi's user timeline | Write API → SQL Database |
| 3 | The Fan Out Service asks who follows Ravi: Asha, Meera, Dev | Fan Out Service → User Graph Service |
| 4 | It pushes ID 9814 onto each follower's timeline list in Redis | Fan Out Service → Memory Cache (Redis) |
| 5 | It also sends the tweet to be indexed for search, and to notify anyone who turned on alerts | Search Cluster, Notification Service |
| 6 | Asha opens the app: her timeline is one Redis read, a list of tweet IDs | Client → Read API → Timeline Service → Memory Cache (Redis) |
| 7 | The IDs are turned into tweets and names | Tweet Info Service, User Info Service |
| 8 | Asha follows a cricket star; his recent tweets are fetched now and merged in by time | Timeline Service |
| 9 | She sees Ravi's tweet near the top | Read API → Client |

Each timeline is a Redis list of tweet IDs, newest first, cut to the latest 800:

```text
LPUSH timeline:asha 9814
LTRIM timeline:asha 0 799
LRANGE timeline:asha 0 19      → the 20 newest tweet IDs
```

`LPUSH` adds to the front; `LTRIM 0 799` keeps only positions 0 to 799, so a list never grows past 800; `LRANGE 0 19` reads the first page.

## The celebrity problem, and the hybrid

Fan-out on write costs **one write per follower**. For an account with 300 followers, that's nothing. For a star with 50 million followers, one tweet means 50 million writes, which takes minutes and floods the cache; their followers see the tweet late.

The fix is a **hybrid**:
- Accounts above a threshold (say 1 million followers) are **not** fanned out.
- When you open your timeline, the Timeline Service reads your precomputed list **and** the recent tweets of the few big accounts you follow, then merges them by time.

Most people follow only a handful of huge accounts, so the read-time merge is small. Everyone else's tweets arrive instantly through fan-out.

```javascript
async function homeTimeline(userId) {
  const ids = await redis.lRange(`timeline:${userId}`, 0, 199) // pushed at write time
  const stars = await graph.bigAccountsFollowedBy(userId) // usually a few
  const starTweets = (await Promise.all(stars.map((s) => tweets.recentIds(s, 50)))).flat()
  return [...ids, ...starTweets].map(BigInt).sort((a, b) => (a < b ? 1 : -1)).slice(0, 200)
}
```

Tweet IDs grow with time (see the Snowflake topic), so sorting by ID is sorting by time, newest first.

## What lives where

- **Memory Cache (Redis)**: home timelines, as lists of tweet IDs only, the newest few hundred, and only for users active in the last 30 days. An inactive user's timeline is rebuilt from the database when they return. Storing IDs instead of whole tweets keeps memory small, and an edit or delete only touches one place.
- **SQL Database**: tweets and users, the source of truth; it serves user timelines.
- **Object Store**: photos and videos.
- **Search Cluster**: a **reverse index** (each word → the tweets that contain it), so a search for "monsoon" reads one list instead of scanning every tweet.

## The numbers, worked out

These assumptions come from the System Design Primer.

- **Tweets**: 500 million a day ÷ 86,400 s ≈ **6k a second**.
- **Fan-out deliveries**: 10 followers on average × 500 million = 5 billion a day ≈ **60k a second**.
- **Timeline reads**: 250 billion a month ÷ about 2.59 million seconds in a month ≈ **100k a second**.
- **Searches**: 10 billion a month ≈ **4k a second**.
- **Storage**: about 10 KB a tweet with media × 15 billion a month = **150 TB a month**, about 5.4 PB in three years.

The ratio that drives the design: about 100k reads ÷ 6k writes ≈ **17 reads per tweet**, even before you count that each read shows many tweets.

## What it costs and where it stops

- **Memory**: precomputed timelines for every active user take a lot of RAM; that's why only IDs, only the newest few hundred, and only active users.
- **Write amplification**: one tweet becomes many writes. Fan-out runs in the background through queues, so the tweeter doesn't wait.
- **Delay**: a tweet reaches followers over a few seconds as fan-out proceeds, not all at once.
- **Unfollow and delete**: removing someone's tweets from timelines is extra work; filtering at read time is a simpler alternative.
- **Ranked feeds** ("for you") add scoring on top; the storage ideas stay the same.

## How to choose

- **Reads far outnumber writes, most accounts are small?** Fan-out on write.
- **Some accounts have millions of followers?** Hybrid: skip those, merge them at read time.
- **Few users or rare reads?** Fan-out on read is simpler and wastes no memory.
- **Need search?** A separate index, fed through a queue.

## ⚠️ Critical Mistakes

- **Fan-out on read at Twitter scale.** Every timeline open queries hundreds of accounts; reads become the bottleneck.
- **Fan-out on write for everyone.** A celebrity tweet triggers tens of millions of writes and arrives late. Use the hybrid.
- **Storing whole tweets in every timeline.** Memory explodes and edits must touch millions of copies. Store IDs.
- **Keeping timelines for every user ever.** Most never return. Keep only active users and rebuild on return.
- **Doing fan-out, indexing and notifications inside the tweet request.** Posting becomes slow. Use queues.

## Interview Q&As

**Q: Fan-out on write or fan-out on read?**

A: On write when reads far outnumber writes, as here: a read becomes one cache lookup. On read when there are few readers or memory is tight. Large systems use a hybrid.

**Q: How do you handle a user with 50 million followers?**

A: Don't fan out their tweets. When someone opens their timeline, fetch the recent tweets of the few huge accounts they follow and merge them with the precomputed list by time.

**Q: What exactly is stored in each home timeline?**

A: A list of tweet IDs, newest first, trimmed to a few hundred, only for recently active users. The tweets themselves come from the tweet service, usually cached.

**Q: How does search work?**

A: New tweets are sent through a queue to a search cluster, which keeps a reverse index from each word to the tweets containing it. A query reads the lists for its words and combines them, never scanning all tweets.

## Related topics

- [Unique ID Generator (Snowflake)](/?topic=unique-id-generator&read): time-sortable tweet IDs.
- [Redis Basics](/?topic=redis-basics&read): lists, `LPUSH` and `LTRIM`.
- [Web Crawler & Search](/?topic=web-crawler&read): reverse indexes in depth.
- [Notification System](/?topic=notification-system&read): telling followers about a tweet.
- [Social Network Graph](/?topic=social-graph&read): the follower graph itself.

## Sources

- System Design Primer: [Design the Twitter timeline and search](https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/twitter/README.md) (CC BY 4.0), the source of this topic's requirements and estimates
- Raffi Krikorian (Twitter): [Timelines at Scale](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/) (InfoQ, 2013)
- Redis: [Lists](https://redis.io/docs/latest/develop/data-types/lists/)

## Why This Matters

"Design Twitter" or "design a news feed" is one of the most asked system design questions. It tests whether you spot that reads dominate, choose fan-out on write, and then notice the celebrity case that breaks it. The hybrid answer, IDs in memory for active users, and queues for side work show that you can design for the common case and the extreme one.
