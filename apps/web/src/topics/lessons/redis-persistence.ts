import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Memory forgets when power goes',
      text: 'Redis keeps data in memory, so a crash wipes it unless something saved it. Two separate choices decide what survives: persistence (saving to disk) and replication (a copy on another machine).',
      focus: ['Primary', 'Dataset in Memory', 'Disk'],
    },
    {
      title: 'RDB: a snapshot now and then',
      text: 'With RDB, Redis writes a picture of all its data to disk every so often. It\'s compact and quick to load, but everything written since the last snapshot is lost in a crash.',
      focus: ['Primary', 'RDB Snapshot', 'Disk'],
      example: 'Crash 4 min 10 s after a snapshot\n250 s × 2,000 writes/s = 500,000 writes lost',
    },
    {
      title: 'AOF: a log of every write',
      text: 'With the AOF (append-only file), Redis adds every write command to a log, and replays it on start-up. With fsync every second, a crash loses about one second of writes.',
      focus: ['Primary', 'AOF Log', 'OS Page Cache', 'Disk'],
      remember: 'write() only reaches the operating system\'s memory; fsync is what puts it on the disk.',
    },
    {
      title: 'Fork: the child does the writing',
      text: 'To save a snapshot, Redis forks: it makes a child process that sees the same data and writes it out, while the parent keeps serving. The fork itself pauses Redis briefly.',
      focus: ['Primary', 'RDB Snapshot'],
      example: 'About 13 ms per GB of memory\n4 GB → about 50 ms pause per snapshot',
    },
    {
      title: 'Restarting from disk',
      text: 'If the Redis process dies, a supervisor restarts it, and it loads its data back from disk before answering again.',
      focus: ['Supervisor', 'Disk', 'Dataset in Memory'],
      example: 'Load a 1.6 GB RDB at 100 MB/s ≈ 16 s\nReplay the AOF\'s 2.4 million commands ≈ 6 s\n→ about 22 s before it answers',
    },
    {
      title: 'A replica on another machine',
      text: 'The primary sends every write to a replica, but only after it has already answered the app. So the replica runs a little behind, about 20 ms here.',
      focus: ['Primary', 'Replica'],
      example: '20 ms × 2,000 writes/s = about 40 writes behind',
    },
    {
      title: 'Sentinel picks a new primary',
      text: 'Sentinels ping the primary every second. If it stays silent for 5 seconds and enough Sentinels agree, they promote the replica and tell the apps where the new primary is.',
      focus: ['Sentinels', 'Primary', 'Replica', 'App Servers'],
      remember: 'Writes the replica hadn\'t received yet are lost in the switch.',
    },
    {
      title: 'Split brain',
      text: 'If the old primary is only cut off, an app server stuck with it keeps writing there, and those writes are thrown away when it rejoins. min-replicas-max-lag makes a cut-off primary stop accepting writes after a few seconds.',
      focus: ['App Servers', 'Primary', 'Sentinels'],
      example: '30 s × 500 writes/s = 15,000 writes lost\nWith min-replicas-max-lag 10: 10 s × 500 = 5,000',
    },
  ],
  quiz: [
    {
      question: 'Which choice loses at most about a second of writes when Redis crashes?',
      options: ['RDB snapshots every 5 minutes', 'The AOF with fsync every second', 'No persistence', 'A bigger server'],
      answer: 1,
      why: 'The AOF logs every write, and fsync puts the log on disk every second.',
    },
    {
      question: 'Why can a failover lose writes the app was told succeeded?',
      options: ['Sentinel deletes them', 'The disk was full', 'Fork pauses drop them', 'The primary answers before the replica has the write'],
      answer: 3,
      why: 'Replication runs after the reply, so the newest writes may not have reached the replica.',
    },
    {
      question: 'What does persistence do that replication doesn\'t?',
      options: ['Lets a restarted node load its data back from disk', 'Promotes a new primary', 'Makes reads faster', 'Prevents split brain'],
      answer: 0,
      why: 'Persistence is about the same node coming back; replication is about another node taking over.',
    },
  ],
}

export default lesson
