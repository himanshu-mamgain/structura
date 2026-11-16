import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One primary, many copies',
      text: 'A replica is a second Redis that copies a primary. The primary takes every write; replicas only serve reads. If the primary dies, a replica can take its place.',
      focus: ['Redis Primary', 'Replica 1', 'Replica 2'],
    },
    {
      title: 'First a full copy, then a stream',
      text: 'When a replica first connects, the primary sends a snapshot of all its data. After that it sends every write as it happens. A replication offset counts the bytes, so both sides know how far the replica has got.',
      focus: ['Redis Primary', 'Replica 1'],
      example: 'replica → PSYNC ? -1          (I have nothing)\nprimary → +FULLRESYNC 8371b4… 4820331607\n… the snapshot, then every write after it',
    },
    {
      title: 'Catching up after a short drop',
      text: 'The primary keeps its latest writes in a ring buffer, the replication backlog. A replica that drops off asks for "everything after byte X". If those bytes are still in the backlog, it gets just them; if not, it needs a full copy again.',
      focus: ['Replication Backlog', 'Redis Primary', 'Replica 1'],
      example: '30 s × 600 KB/s = 18 MB missed\nbacklog 1 MB  → full sync, 43 s\nbacklog 64 MB → partial resync, 0.1 s',
      remember: 'Size the backlog as write rate × the longest disconnect you expect.',
    },
    {
      title: 'Replies first, copies after',
      text: 'The primary answers the client before the replicas have the write. That keeps writes fast, but replicas run a little behind. If the primary dies, its last few writes can be lost.',
      focus: ['App Server', 'Redis Primary', 'Replica 1'],
      example: '20 ms behind × 6,000 writes/s = 120 writes at risk',
    },
    {
      title: 'Sentinels watch the primary',
      text: 'Sentinels are small processes that PING the primary every second. If it is silent for 5 s, each one marks it down. When enough of them agree, the quorum, it counts as really down.',
      focus: ['Sentinels', 'Redis Primary'],
      example: '+sdown master carts 10.0.1.11 6379\n+odown master carts 10.0.1.11 6379 #quorum 2/2',
    },
    {
      title: 'Sentinel promotes the best replica',
      text: 'A majority of Sentinels elect one leader. The leader promotes the replica that got furthest and tells the clients the new address. The whole failover takes about 6 seconds.',
      focus: ['Sentinels', 'Replica 1', 'App Server'],
      remember: 'Run at least three Sentinels, on different machines.',
    },
    {
      title: 'Cluster splits the keys',
      text: 'Redis Cluster has 16,384 hash slots. A key goes to slot CRC16(key) mod 16384, and each primary owns a range of slots. The client keeps a slot map and talks straight to the right shard.',
      focus: ['Slot Map', 'Shard A Primary', 'Shard B Primary', 'Shard C Primary'],
      example: 'CRC16("user:1001") = 22096\n22096 mod 16384 = 5712 → shard B',
    },
    {
      title: 'Keep related keys together',
      text: 'A command with several keys works only if they are in the same slot. Put the shared part of the name in braces, a hash tag, and only that part is hashed.',
      focus: ['Slot Map', 'Shard B Primary'],
      example: 'cart:{user:1001}     → slot 5712\nprofile:{user:1001}  → slot 5712\nMGET of both works',
    },
    {
      title: 'Each shard fails over by itself',
      text: 'Cluster nodes check each other over the cluster bus. If a primary stops answering, its replica asks the other primaries for votes and takes over its slots. No Sentinel is needed.',
      focus: ['Cluster Bus', 'Shard B Replica', 'Shard A Primary', 'Shard C Primary'],
      remember: 'Only the failed shard\'s keys fail, for about 6 seconds.',
    },
  ],
  quiz: [
    {
      question: 'A replica was cut off for 30 s while the primary wrote 600 KB/s. The backlog is 1 MB. What happens when it reconnects?',
      options: ['It gets the 18 MB it missed', 'It needs a full sync: the backlog only holds about 1.7 s', 'It stays out of date until someone restarts it', 'Sentinel removes it from the setup'],
      answer: 1,
      why: '30 s × 600 KB/s = 18 MB, far more than 1 MB, so the missed writes are gone from the backlog and the primary sends a full copy.',
    },
    {
      question: 'Why can a failover lose writes the client was told succeeded?',
      options: ['The primary replies before the replicas have the write', 'Sentinel deletes the last minute of data', 'Replicas copy only every 5 minutes', 'Redis never writes to the disk'],
      answer: 0,
      why: 'Replication is asynchronous: replicas run a few milliseconds behind, and those writes die with the primary.',
    },
    {
      question: 'MGET cart:user:7 profile:user:7 fails in Redis Cluster with CROSSSLOT. What fixes it?',
      options: ['Add more shards', 'Read from a replica instead', 'Turn off the slot map', 'Name the keys cart:{user:7} and profile:{user:7}'],
      answer: 3,
      why: 'With a hash tag only "user:7" is hashed, so both keys land in slot 2780 instead of slots 197 and 8736, and one node can answer.',
    },
  ],
}

export default lesson
