import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Guarantees come from settings',
      text: 'Kafka can be very safe or very fast, depending on how you set it up. For payments you want the safe settings. For logs and metrics, speed may matter more than the odd lost message.',
      focus: ['Payments Service', 'Broker 1 (Leader)'],
    },
    {
      title: 'The ISR: copies that are keeping up',
      text: 'Each partition has a leader and followers that copy it. The ISR (in-sync replicas) is the leader plus every follower that has kept up recently. A follower that falls behind leaves the ISR until it catches up.',
      focus: ['Broker 1 (Leader)', 'Broker 2', 'Broker 3'],
    },
    {
      title: 'acks=all needs a minimum',
      text: 'acks=all means "answer once every copy in the ISR has the write". But if the ISR shrinks to just the leader, that is only one copy. min.insync.replicas=2 makes the leader refuse writes unless at least two copies will have them.',
      focus: ['Payments Service', 'Broker 1 (Leader)', 'Broker 2', 'Broker 3'],
      example: 'replication.factor=3\nmin.insync.replicas=2\nacks=all',
      remember: 'acks=all on its own isn\'t enough. It needs the minimum too.',
    },
    {
      title: 'Unclean election: data or uptime',
      text: 'If every in-sync copy is lost, Kafka can wait for one to come back, or make an out-of-date copy the leader and lose the newest messages. For payments, keep unclean.leader.election.enable=false, and wait.',
      focus: ['Controller', 'Broker 2'],
    },
    {
      title: 'Idempotent producers stop repeats',
      text: 'If an answer gets lost, the producer sends the message again. With idempotence on, which is the default, each message carries the producer\'s ID and a sequence number, so the broker spots the repeat and keeps one copy.',
      focus: ['Payments Service', 'Broker 1 (Leader)'],
      remember: 'Keep enable.idempotence=true. Don\'t turn it off.',
    },
    {
      title: 'Transactions: read, process, write as one',
      text: 'The Invoicer reads a payment and writes an invoice. A transaction saves the new invoice and the Invoicer\'s offset together: both happen, or neither does. So a crash can\'t create a second invoice inside Kafka.',
      focus: ['Payments Topic', 'Invoicer', 'Invoices Topic'],
    },
    {
      title: 'Readers see only finished transactions',
      text: 'The Ledger Consumer reads with isolation.level=read_committed, so it never sees invoices from a transaction that was cancelled.',
      focus: ['Invoices Topic', 'Ledger Consumer'],
    },
    {
      title: 'Rebalances when a consumer dies',
      text: 'The group coordinator expects regular heartbeats from each consumer. If one stops, its partitions move to another member, which carries on from the last committed offset.',
      focus: ['Invoicer', 'Group Coordinator', 'Standby Invoicer'],
      example: 'session.timeout.ms = 45 s at 1,000 messages/s\n→ 45,000 messages wait before the standby takes over',
      remember: 'Exactly-once covers Kafka only. A payment API or an email outside Kafka still needs an idempotency key.',
    },
  ],
  quiz: [
    {
      question: 'What does min.insync.replicas=2 add to acks=all?',
      options: ['The leader refuses writes unless at least two copies will have them', 'It makes writes faster', 'It doubles the number of partitions', 'It lets out-of-date copies become leader'],
      answer: 0,
      why: 'Without it, acks=all could be satisfied by the leader alone after the ISR shrinks.',
    },
    {
      question: 'A producer resends a message after a timeout. With idempotence on, what happens?',
      options: ['The message is stored twice', 'The broker spots the repeat by its sequence number and keeps one', 'The producer crashes', 'The consumer deletes one copy'],
      answer: 1,
      why: 'The producer ID and sequence number let the broker recognise a message it already has.',
    },
    {
      question: 'Which setting chooses uptime over data when every in-sync copy is lost?',
      options: ['acks=all', 'read_committed', 'Unclean leader election', 'enable.idempotence'],
      answer: 2,
      why: 'It lets an out-of-date copy lead, so the partition comes back sooner, minus its newest messages.',
    },
  ],
}

export default lesson
