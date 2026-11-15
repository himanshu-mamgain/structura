import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Events, not calls',
      text: 'An event is a small record of something that happened, like "order 4101 was paid". Instead of calling every service that cares, the Order Service writes the event once to Kafka, and any service that cares reads it.',
      focus: ['Order Service'],
      example: 'key:   order-4101\nvalue: {"type": "paid", "amount": 499}',
    },
    {
      title: 'A topic is a log you only add to',
      text: 'Kafka keeps events in topics, such as orders. A topic is an append-only log: new events go on the end, and nothing is changed. Events stay until their retention time, often 7 days, runs out.',
      focus: ['Partition 0', 'Partition 1', 'Partition 2'],
    },
    {
      title: 'Partitions split a topic',
      text: 'One log can only be read so fast, so a topic is split into partitions. Each partition is its own log, numbered from 0. Each event in it gets a position number called an offset.',
      focus: ['Partition 0', 'Partition 1', 'Partition 2', 'Partitions 3 to 5'],
    },
    {
      title: 'The key picks the partition',
      text: 'Kafka hashes each event\'s key and divides by the number of partitions; the remainder is the partition. The same key always lands in the same partition, so one order\'s events stay in order.',
      focus: ['Order Service', 'Partitioner'],
      example: 'partition = hash("order-4101") % 3\n→ every event for order-4101 goes to the same partition',
      remember: 'Order is kept within a partition, not across the whole topic.',
    },
    {
      title: 'A consumer group shares the work',
      text: 'Consumers with the same group name split the partitions between them. Each partition goes to exactly one consumer in the group, so each event is handled once in that group.',
      focus: ['Partition 0', 'Partition 1', 'Partition 2', 'Consumer A', 'Consumer B', 'Consumer C'],
    },
    {
      title: 'Partitions set the limit',
      text: 'A group can\'t use more consumers than there are partitions: the extra ones sit idle. So choose enough partitions for your busiest day.',
      focus: ['Partitions 3 to 5', 'Consumer D'],
      example: 'Peak: 120 events/s; one consumer handles 50\n120 ÷ 50 = 2.4 → 3 consumers → at least 3 partitions',
    },
    {
      title: 'Offsets remember where you were',
      text: 'Each consumer saves the offset it has reached; this is called committing. After a restart, it carries on from the last commit. Commit after you process an event, not before, and make processing safe to repeat.',
      focus: ['Consumer A', 'Consumer B', 'Committed Offsets'],
      remember: 'A crash before a commit means the last few events are read again.',
    },
    {
      title: 'Many groups, the same events',
      text: 'Another group, like analytics, reads the same events with offsets of its own. Because events stay for days, a new group can even start from the beginning. That\'s the big difference from a queue, where each job goes to one worker and is gone.',
      focus: ['Analytics Consumer', 'Committed Offsets', 'Partition 0'],
    },
  ],
  quiz: [
    {
      question: 'Why use the order ID as each event\'s key?',
      options: ['It makes events smaller', 'All of one order\'s events go to one partition, so they stay in order', 'Kafka can\'t store events without a key', 'It chooses the consumer group'],
      answer: 1,
      why: 'Same key, same partition, and a partition keeps its events in order.',
    },
    {
      question: 'A topic has 3 partitions and a group has 4 consumers. What happens?',
      options: ['All 4 share every partition', 'Kafka adds a partition', 'One consumer sits idle', 'The group stops'],
      answer: 2,
      why: 'Each partition goes to one consumer in the group, so the fourth has nothing to read.',
    },
    {
      question: 'Billing and analytics both need every order event. How?',
      options: ['Put them in different consumer groups', 'Put them in the same group', 'Write every event twice', 'Use a single partition'],
      answer: 0,
      why: 'Each group reads every event, with its own offsets.',
    },
  ],
}

export default lesson
