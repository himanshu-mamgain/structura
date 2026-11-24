import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Drop the work, move on',
      text: 'A message queue sits between a producer that has work and workers that do it. The Order API drops a message and answers the user at once. Workers take messages at their own pace.',
      focus: ['Producer (Order API)', 'Queue Service', 'Consumer Workers'],
    },
    {
      title: 'Messages are stored safely',
      text: 'The Queue Service writes each message to the Message Store and copies it to a replica. If one disk dies, the message is still there.',
      focus: ['Queue Service', 'Message Store', 'Replica Store'],
    },
    {
      title: 'Received means hidden, not gone',
      text: 'When a worker takes a message, the queue hides it for a while, called the visibility timeout. Only the worker\'s delete, the ack, removes it. If the worker crashes, the message comes back.',
      focus: ['Visibility Timer', 'Consumer Workers'],
      remember: 'No ack, no delete: a crashed worker loses nothing.',
    },
    {
      title: 'Set the timeout above the job',
      text: 'If the timeout is shorter than the job, a second worker gets the same message while the first is still busy. Set it a little above the slowest normal job.',
      focus: ['Visibility Timer'],
    },
    {
      title: 'At least once means duplicates',
      text: 'A worker might finish the work and crash before its ack. Then the message is done twice. So every handler must be idempotent: it records the message id with the work, and skips ids it has seen.',
      focus: ['Consumer Workers', 'Idempotency Table'],
      example: 'INSERT INTO processed (message_id) VALUES (\'m-81\')  -- fails if seen',
    },
    {
      title: 'Poison messages go aside',
      text: 'A broken message fails every time. After 3 to 5 tries, the queue moves it to a dead-letter queue. The rest keep flowing, and you can fix and replay it later.',
      focus: ['Dead-Letter Queue', 'Metrics & Alerts'],
    },
    {
      title: 'How many workers?',
      text: 'Messages in flight = rate × job time. At 50k a second and 200 ms a job, 10k messages are being worked on at once. At 20 jobs per worker, that is 500 workers.',
      example: '50k × 0.2 s = 10k in flight\n10k ÷ 20 = 500 workers',
    },
    {
      title: 'Scale on depth and age',
      text: 'The Autoscaler watches how many messages wait and how old the oldest one is. When either grows, it adds workers.',
      focus: ['Metrics & Alerts', 'Autoscaler'],
    },
  ],
  quiz: [
    {
      question: 'A worker crashes halfway through a job. What happens to its message?',
      options: ['It is lost', 'It reappears after the visibility timeout', 'It goes straight to the dead-letter queue', 'The producer sends it again'],
      answer: 1,
      why: 'It was only hidden. With no ack, it becomes visible again for another worker.',
    },
    {
      question: 'Customers are charged twice now and then. What is missing?',
      options: ['More workers', 'An idempotent handler that records message ids', 'A shorter queue', 'A bigger message store'],
      answer: 1,
      why: 'Delivery is at least once, so the handler must skip a message id it has already done.',
    },
    {
      question: 'Jobs take up to 40 s, and the visibility timeout is 30 s. What goes wrong?',
      options: ['Nothing', 'Messages are lost', 'A second worker gets the same message while the first is still busy', 'The queue stops'],
      answer: 2,
      why: 'The message reappears at 30 s, before the first worker acks it, so it runs twice.',
    },
  ],
}

export default lesson
