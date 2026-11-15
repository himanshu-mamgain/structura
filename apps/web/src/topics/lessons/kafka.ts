import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Why put Kafka in the middle',
      text: 'Without Kafka, the Order Service calls billing, analytics, email and search itself, and if one of them is slow or down, orders fail. With Kafka, it writes one event and moves on. Each service reads at its own pace.',
      focus: ['Producer (Order Service)'],
    },
    {
      title: 'Brokers store the partitions',
      text: 'A Kafka cluster is a group of servers called brokers. Each partition is kept on several brokers. One copy is the leader, which takes all the reads and writes; the others, the followers, copy it.',
      focus: ['Broker 1 · P0 leader', 'Broker 2 · P1 leader', 'Broker 3 · P2 leader'],
    },
    {
      title: 'The key picks a partition, the partition has a leader',
      text: 'The producer hashes each event\'s key to choose its partition, then sends the event to that partition\'s leader, which adds it to the end of its log.',
      focus: ['Producer (Order Service)', 'Partitioner (hash of key)', 'Broker 1 · P0 leader'],
    },
    {
      title: 'acks: when is a write safe?',
      text: 'With acks=all, the leader answers the producer only after the copies that are keeping up have the event. Losing one broker then loses nothing that was confirmed. acks=1 answers sooner, but can lose the newest events.',
      focus: ['Broker 1 · P0 leader', 'Broker 2 · P1 leader', 'Broker 3 · P2 leader'],
      example: 'replication factor 3, min.insync.replicas=2, acks=all\n→ one broker can die without losing a confirmed event',
    },
    {
      title: 'When a broker dies',
      text: 'The KRaft controller keeps track of the brokers. If a leader dies, it promotes a follower that was fully caught up, and producers and consumers switch to the new leader.',
      focus: ['KRaft Controller', 'Broker 1 · P0 leader'],
    },
    {
      title: 'Consumers read, write, then commit',
      text: 'In the billing group, each consumer reads the partitions it owns, writes to the billing database, then commits its offset. The write must be idempotent: doing it twice has the same effect as doing it once.',
      focus: ['Billing Consumer 1', 'Billing Consumer 2', 'Billing DB', '__consumer_offsets'],
      remember: 'By default, Kafka delivers at least once. Expect duplicates and make them harmless.',
    },
    {
      title: 'Poison messages go to a dead-letter topic',
      text: 'Some events fail every time, perhaps because of bad data. Retrying forever would block the whole partition. After a few tries, the consumer moves the event to a dead-letter topic for a person to look at, and carries on.',
      focus: ['Billing Consumer 1', 'orders.DLQ (dead letters)'],
    },
    {
      title: 'Watch the lag',
      text: 'Lag is how far a group is behind the newest event. If it keeps growing, add consumers, up to the number of partitions, or make processing faster.',
      focus: ['Billing Consumer 1', 'Billing Consumer 2', 'Analytics Consumer'],
      example: '50,000 events/s at peak; one consumer handles 5,000\n→ at least 10 partitions for one group to keep up',
    },
  ],
  quiz: [
    {
      question: 'With acks=all, when does the producer get its answer?',
      options: ['As soon as the leader has the event', 'Once the copies that are keeping up have it', 'When a consumer reads it', 'After an offset is committed'],
      answer: 1,
      why: 'Waiting for the in-sync copies is what lets a confirmed event survive a broker dying.',
    },
    {
      question: 'One event fails every time it\'s processed. What should the consumer do?',
      options: ['Retry it forever', 'Delete the topic', 'Move it to the dead-letter topic after a few tries and carry on', 'Stop the whole group'],
      answer: 2,
      why: 'Otherwise one bad event blocks every event behind it in that partition.',
    },
    {
      question: 'Why must the billing write be idempotent?',
      options: ['After a crash, events since the last commit are read again', 'Kafka sends every event twice on purpose', 'Databases require it', 'It makes producers faster'],
      answer: 0,
      why: 'The commit comes after the write, so a crash in between means the event is processed again.',
    },
  ],
}

export default lesson
