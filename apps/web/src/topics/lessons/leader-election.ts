import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One node in charge',
      text: 'Many systems need exactly one leader: the database primary, a shard\'s owner, a lock\'s holder. The leader decides the order of changes, and the others copy it. That\'s much simpler than many writers.',
      focus: ['Client', 'Node 1'],
    },
    {
      title: 'Heartbeats',
      text: 'The leader keeps sending small "I\'m here" messages, called heartbeats, to the others. Each one resets a timer on every follower.',
      focus: ['Node 1', 'Node 2', 'Node 3', 'Node 4', 'Node 5'],
      example: '4 followers × 20 heartbeats a second = 80 messages/s\nabout 8 KB/s: tiny',
    },
    {
      title: 'Silence starts an election',
      text: 'If a follower hears nothing before its timer runs out, it assumes the leader is gone and asks to become leader itself. Each timer is random, between 150 and 300 ms, so usually one node asks first.',
      focus: ['Election Timeout', 'Node 4'],
    },
    {
      title: 'Terms count elections',
      text: 'Each election has a number, called a term. The candidate adds 1 to the term, votes for itself, and saves both to disk, so a restart can\'t make it vote twice.',
      focus: ['Node 4', 'Term + Vote Store'],
      remember: 'The highest term always wins. An old leader that sees a higher term steps down.',
    },
    {
      title: 'A majority wins',
      text: 'The candidate needs votes from more than half the nodes. Each node gives at most one vote per term, and only to a candidate whose log is up to date. Any two majorities share a node, so two leaders can\'t win the same term.',
      focus: ['Node 4', 'Node 2', 'Node 3', 'Node 5'],
      example: '5 nodes → 3 votes needed\nUp to 2 nodes can fail and it still works',
    },
    {
      title: 'Writes need a majority too',
      text: 'The leader adds each write to its log and sends it to the followers. Once a majority has it on disk, the write is committed and the client gets its answer.',
      focus: ['Client', 'Node 1', 'Node 2', 'Node 3'],
    },
    {
      title: 'Split brain and fencing',
      text: 'An old leader that is only cut off may still think it\'s in charge, so two leaders exist. That\'s split brain. Storage that only accepts the newest leader\'s token rejects the old leader\'s writes.',
      focus: ['Node 1', 'Fenced Storage'],
    },
    {
      title: 'Fast failover or fewer false alarms',
      text: 'Short timeouts find a dead leader quickly, but also react to a slow network. That\'s why etcd waits 1 second by default instead of 150 ms.',
      focus: ['Election Timeout'],
      example: 'Failover here: 150 + 8 = 158 ms at best, 300 + 8 = 308 ms at worst\netcd defaults: 100 ms heartbeat, 1k ms timeout',
    },
  ],
  quiz: [
    {
      question: 'Why can\'t two leaders win the same term?',
      options: ['Leaders are picked alphabetically', 'Each needs a majority, and any two majorities share a node that votes only once', 'The client chooses', 'Terms are random'],
      answer: 1,
      why: 'That shared node can give its one vote per term to only one candidate.',
    },
    {
      question: 'Why is each election timer random?',
      options: ['To save power', 'To make elections slower', 'So nodes don\'t all ask at once and split the vote', 'Because clocks are wrong'],
      answer: 2,
      why: 'With random timers, usually one node asks first and wins before the others start.',
    },
    {
      question: 'An old leader was cut off and still writes. What stops it damaging data?',
      options: ['Fenced storage that only accepts the newest leader\'s token', 'Heartbeats', 'A longer timeout', 'More nodes'],
      answer: 0,
      why: 'Its token belongs to an old term, so its writes are rejected.',
    },
  ],
}

export default lesson
