import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Every big app starts with one server',
      text: 'At first, one server runs the website and the database, and that\'s fine. Don\'t build for millions on day one. Add a piece only when something you measure runs out.',
      focus: ['Users', 'Web Servers (Auto Scaling)'],
      remember: 'Measure, find the slowest part, fix only that, and repeat.',
    },
    {
      title: 'Users find you by name: DNS',
      text: 'DNS turns a name like shop.example.com into the address of your servers. Route 53 is AWS\'s DNS. Because people use the name, you can change the servers behind it and nobody notices.',
      focus: ['Users', 'DNS (Route 53)'],
    },
    {
      title: 'Give the database its own machine',
      text: 'The first move, at around 10k users: put the database on its own server, here a managed one called RDS. Now each can grow on its own, and you can replace a web server without losing data.',
      focus: ['API Servers (Auto Scaling)', 'SQL Primary (RDS)'],
    },
    {
      title: 'Many web servers behind a load balancer',
      text: 'One server handles about 400 requests a second here. A load balancer spreads requests over many servers and skips broken ones. Keep the servers stateless: nothing about a user lives on one server, so any server can answer anyone.',
      focus: ['Load Balancer (ELB)', 'Web Servers (Auto Scaling)'],
      example: '1 million users ≈ 3,473 requests a second at the peak\n3,473 ÷ 400 ≈ 8.7 → 9 web servers',
      remember: 'Keep sessions in the cache, not in one server\'s memory.',
    },
    {
      title: 'Answer popular reads from memory',
      text: 'Most requests read the same popular data. A memory cache (ElastiCache, running Redis) answers in under a millisecond. Only misses go to the database, and read replicas, which are read-only copies of it, share those.',
      focus: ['API Servers (Auto Scaling)', 'Memory Cache (ElastiCache)', 'SQL Read Replicas (RDS)'],
      example: '80% of reads hit the cache\n→ only 20% reach the database',
      remember: 'Writes still go to the one primary, which copies them to the replicas.',
    },
    {
      title: 'Static files from a CDN',
      text: 'Images, styles and scripts are the same for everyone. A CDN (content delivery network) keeps copies close to users. CloudFront fetches a file from S3 the first time someone asks for it, then serves copies from the location nearest each user.',
      focus: ['Users', 'CDN (CloudFront)', 'Object Store (S3)'],
    },
    {
      title: 'Slow jobs wait in a queue',
      text: 'Some work is slow, like resizing a photo or sending an email. Don\'t make the user wait. The API puts a job in a queue (SQS) and answers straight away; workers take jobs from the queue and do them in the background.',
      focus: ['API Servers (Auto Scaling)', 'Queue (SQS)', 'Workers (Auto Scaling)', 'Object Store (S3)'],
      remember: 'If the queue grows, add workers. The site stays fast either way.',
    },
    {
      title: 'Every tier grows on its own',
      text: 'Web servers, API servers and workers each sit in their own Auto Scaling group. Each group adds machines when it\'s busy and removes them when it\'s quiet.',
      focus: ['Web Servers (Auto Scaling)', 'API Servers (Auto Scaling)', 'Workers (Auto Scaling)'],
      example: '10 million users ≈ 34.7k requests a second at the peak\n34.7k ÷ 400 ≈ 86.8 → 87 web servers',
    },
    {
      title: 'When one database isn\'t enough: shards',
      text: 'Replicas help with reads, but every write still goes to the one primary. Past about 10 million users, you split the data across several databases by a key, such as the user\'s ID. Each part is called a shard.',
      focus: ['SQL Primary (RDS)', 'SQL Read Replicas (RDS)'],
      remember: 'Shard last. Queries across shards are hard, so try caching and replicas first.',
    },
  ],
  quiz: [
    {
      question: 'Why should web servers be stateless?',
      options: ['So they use less CPU', 'So any server can answer any request, and servers can come and go freely', 'So you don\'t need a database', 'So DNS can find them'],
      answer: 1,
      why: 'If a user\'s session lived on one server, losing or removing that server would log them out. Keep it in the cache instead.',
    },
    {
      question: 'Processing an uploaded photo takes 20 seconds. What keeps the site fast?',
      options: ['A bigger web server', 'A read replica', 'Putting the photo in DNS', 'A job in the queue, done by a worker in the background'],
      answer: 3,
      why: 'The API answers at once; the slow work happens later, and you add workers if the queue grows.',
    },
    {
      question: 'What can read replicas not help with?',
      options: ['Too many writes', 'Too many reads', 'A busy page that only reads', 'Reports that read a lot of data'],
      answer: 0,
      why: 'Every write still goes to the one primary. Past that limit you need shards.',
    },
  ],
}

export default lesson
