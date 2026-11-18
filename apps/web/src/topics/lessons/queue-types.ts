import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Every queue makes a promise',
      text: 'A queue holds messages until a worker takes them, so the sender doesn\'t have to wait. But queues promise different things: about order, about urgency, about timing and about copies. In a food-delivery app, you often need several kinds at once.',
      focus: ['Order Service', 'Order Events Topic'],
      remember: 'Pick a queue by what it promises, not by its name.',
    },
    {
      title: 'Standard: fast, rough order',
      text: 'A standard queue spreads messages over many servers, so it handles almost any load. The price: order is only best effort, and now and then a message comes twice. That is fine for receipt emails, if the worker skips an email it already sent.',
      focus: ['Email Queue', 'Email Workers'],
      remember: 'At least once means every handler must be safe to run twice.',
    },
    {
      title: 'FIFO: in order, per group',
      text: 'A FIFO queue keeps order within a group. Use the order id as the group id: each order\'s updates come out one at a time, in order, while different orders run in parallel. The tracking screen never goes from "ready" back to "cooking".',
      focus: ['Order Updates Queue', 'Tracking Workers'],
      example: 'MessageGroupId: "order-101"\nMessageDeduplicationId: "order-101-2"',
    },
    {
      title: 'Priority: urgent first',
      text: 'A priority queue hands out the highest priority first. Gold members\' orders get 9, the rest get 1, so couriers go to Gold orders first. If urgent work never stops, low-priority messages can wait forever. This is called starvation.',
      focus: ['Courier Queue', 'Courier Dispatcher'],
      example: "assertQueue('courier-jobs', { maxPriority: 10 })\nsendToQueue('courier-jobs', job, { priority: 9 })",
    },
    {
      title: 'Delay: do it later',
      text: 'A delay queue hides a message for a while after it is sent. Send "check payment" with a 15-minute delay; then the Timeout Worker cancels the order if it is still unpaid. SQS delays go up to 15 minutes; for longer, use a scheduler or a table with a run_at time.',
      focus: ['Payment Timeout Queue', 'Timeout Worker'],
      example: 'DelaySeconds: 900   // 15 minutes',
    },
    {
      title: 'Pub/sub: a copy for everyone',
      text: 'In a plain queue, each message goes to one worker. With pub/sub, the Order Service publishes "order placed" once to a topic, and the topic copies it into each subscriber\'s queue. Adding a new consumer needs no change to the sender.',
      focus: ['Order Events Topic', 'Order Updates Queue', 'Email Queue', 'Courier Queue'],
      remember: 'Point-to-point: one worker gets it. Pub/sub: every subscriber gets a copy.',
    },
    {
      title: 'Request/reply: an answer comes back',
      text: 'To get the delivery fee, the Order Service sends a request with two extra fields: reply-to (where to answer) and a correlation id (which question this is). The Pricing Service answers there with the same id. Always set a timeout.',
      focus: ['Quote Requests', 'Pricing Service', 'Quote Replies'],
      example: '{ "km": 4.2 }  replyTo: "amq.gen-x7Q", correlationId: "c-91"\n→ { "fee": 50 }  correlationId: "c-91"',
    },
    {
      title: 'In memory: fast, but fragile',
      text: 'A Redis list is a very fast queue: LPUSH adds a job, BRPOP takes one. But it lives in memory, so a crash can lose jobs. Use it for work you can redo, like resizing a photo, not for payments.',
      focus: ['Photo Jobs (Redis)', 'Photo Worker'],
      example: 'LPUSH photo-jobs \'{"photoId":"p_77"}\'\nBRPOP photo-jobs 0',
    },
    {
      title: 'When a queue is full',
      text: 'A queue with no limit just grows until memory runs out. Give it a limit, and choose what happens when it is full: the sender waits (backpressure), the sender is refused (a 429), or the oldest message is dropped. Order updates must arrive, so dropping is wrong for them.',
      focus: ['Order Updates Queue', 'Order Service'],
      remember: 'Wait or refuse for things that must arrive. Drop the oldest only when the latest value is all that matters.',
    },
  ],
  quiz: [
    {
      question: 'A customer\'s tracking screen jumps from "ready" back to "cooking". Which queue fixes this?',
      options: ['A priority queue', 'A delay queue', 'A FIFO queue with the order id as the group id', 'A bigger standard queue'],
      answer: 2,
      why: 'A FIFO queue keeps each group\'s messages in order and hands them out one at a time. With the order id as the group id, one order\'s updates can\'t overtake each other.',
    },
    {
      question: 'Tracking, email and couriers all need the same "order placed" event. What do you use?',
      options: ['Pub/sub: a topic that copies it to one queue for each', 'One queue that all three read from', 'A priority queue', 'Request/reply'],
      answer: 0,
      why: 'In one shared queue, each message goes to only one worker. A topic gives every subscriber its own copy, in its own queue.',
    },
    {
      question: 'A queue of order updates is full during a rush. Which choice is wrong for these messages?',
      options: ['Make the sender wait', 'Refuse and let the sender retry', 'Add more workers', 'Silently drop the oldest updates'],
      answer: 3,
      why: 'Dropping the oldest loses updates without telling anyone, so customers miss them. That suits latest-value data, like a courier\'s location, not order updates.',
    },
  ],
}

export default lesson
