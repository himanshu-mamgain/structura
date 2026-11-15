import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Only get and put',
      text: 'A key-value store offers just two things: get(key) and put(key, value). No joins, no complex queries. In return, it can spread over many machines and keep working when some of them fail.',
      focus: ['Client App', 'Coordinator (any node)'],
    },
    {
      title: 'Any node can take the request',
      text: 'There is no single master. Whichever node receives a request becomes its coordinator, and finds the right nodes for the key on a hash ring.',
      focus: ['Coordinator (any node)', 'Hash Ring (token map)'],
    },
    {
      title: 'Every key on three nodes',
      text: 'Each key is copied to N nodes, here 3: the owner on the ring and the next two. If one node dies, two copies are still there.',
      focus: ['Hash Ring (token map)', 'Node A', 'Node B', 'Node C'],
      example: '2 billion keys × 1 KB = 2 TB\n× 3 copies = 6 TB',
    },
    {
      title: 'Quorums: W and R',
      text: 'A write is done when W copies say "saved". A read waits for R answers and returns the newest. If R + W is more than N, every read overlaps with the latest write.',
      focus: ['Coordinator (any node)', 'Node A', 'Node B', 'Node C'],
      example: 'N = 3, W = 2, R = 2 → 2 + 2 > 3: reads see the latest write\nW = 1, R = 1 → fastest, but reads can be stale',
    },
    {
      title: 'How a node saves a write',
      text: 'Each node first adds the write to its commit log on disk, so a crash can\'t lose it. Then it updates a sorted table in memory. When that fills up, it\'s written to disk as a file that never changes, an SSTable.',
      focus: ['Commit Log (WAL)', 'Memtable (in memory)', 'SSTables (on disk)'],
    },
    {
      title: 'Gossip: who\'s alive?',
      text: 'Every second or so, each node swaps notes with a few others about who is up. News of a dead node spreads through the whole cluster in a few rounds, with no central server.',
      focus: ['Gossip (membership)', 'Node A', 'Node D'],
    },
    {
      title: 'Hinted handoff',
      text: 'If one of a key\'s nodes is down, another node keeps the write for it, with a note saying who it\'s for. When the node comes back, the write is handed over.',
      focus: ['Hinted Handoff Store', 'Node D', 'Node C'],
    },
    {
      title: 'Read repair',
      text: 'When a read finds that some copies are out of date, it sends them the newest version. Over time, every copy catches up.',
      focus: ['Coordinator (any node)', 'Read Repair', 'Node B'],
      remember: 'This design chooses staying up over always being perfectly up to date (AP in CAP terms).',
    },
  ],
  quiz: [
    {
      question: 'With N = 3, which setting makes every read see the latest write?',
      options: ['W = 1, R = 1', 'W = 2, R = 2', 'W = 1, R = 2', 'W = 0, R = 3'],
      answer: 1,
      why: 'R + W = 4 is more than N = 3, so the read and write groups always share a node.',
    },
    {
      question: 'A key\'s node is down during a write. What keeps the write for it?',
      options: ['Read repair', 'The commit log', 'Gossip', 'Hinted handoff on another node'],
      answer: 3,
      why: 'Another node stores it with a hint and hands it over when the node returns.',
    },
    {
      question: 'Why does every node write to a commit log first?',
      options: ['So a crash can\'t lose a write it already confirmed', 'To make reads faster', 'To find other nodes', 'To pick the coordinator'],
      answer: 0,
      why: 'The memory table would be lost in a crash; the log on disk is replayed on restart.',
    },
  ],
}

export default lesson
