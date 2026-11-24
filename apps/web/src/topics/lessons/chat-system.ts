import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One open connection each',
      text: 'Each phone keeps one WebSocket open to a WebSocket Gateway. A WebSocket is a connection that stays open, so the server can push a message the moment it exists.',
      focus: ['Sender App', 'WebSocket Gateway', 'Recipient App'],
    },
    {
      title: 'The scale',
      text: '500 million daily users send 40 messages each: 20 billion a day, about 231k a second. With 20% online at once, that is 100 million open connections, about 2k gateways at 50k each.',
      example: '20 billion ÷ 86,400 s ≈ 231k a second\n100 million ÷ 50k = 2k gateways',
    },
    {
      title: 'Store first, then deliver',
      text: 'The Chat Service writes the message to the Message Store before anything else. If delivery fails, nothing is lost: the store is the truth, and delivery can be retried.',
      focus: ['Chat Service', 'Message Store (Cassandra)'],
      remember: 'Saved first, so a crash during delivery loses nothing.',
    },
    {
      title: 'Which gateway has the recipient?',
      text: 'Gateways only hold connections. The Session Registry in Redis says which gateway holds which user. The message goes through a queue to that gateway, which pushes it down the socket.',
      focus: ['Session Registry (Redis)', 'Message Queue', 'WebSocket Gateway'],
      example: 'GET session:user:priya → "gateway-0412"',
    },
    {
      title: 'Offline? Push, then sync',
      text: 'If the recipient is offline, the Push Notification Service sends a short alert with no message text. When the app opens, it asks for everything after its last message id.',
      focus: ['Push Notification Service', 'Recipient App'],
    },
    {
      title: 'Groups cost one delivery per member',
      text: 'A message to a group of 200 is delivered 200 times. The Group Service gives the member list, and groups have a size limit so one message can\'t flood the system.',
      focus: ['Group Service'],
    },
    {
      title: 'Presence can be a little stale',
      text: '"Online" comes from heartbeats with a short time limit. If they stop, the user shows offline soon after. Slightly stale presence is fine; slow messages are not.',
      focus: ['Presence Service'],
    },
    {
      title: 'Duplicates and order',
      text: 'Delivery is at least once, so apps drop a message id they already have. Messages are ordered by id within one chat; no global order is needed.',
    },
  ],
  quiz: [
    {
      question: 'Why does the Chat Service save the message before delivering it?',
      options: ['Saving is faster', 'So a failed delivery can be retried and nothing is lost', 'To find the gateway', 'To send the push'],
      answer: 1,
      why: 'The store is the source of truth; delivery is a side effect that can be retried.',
    },
    {
      question: 'How does a message reach the right gateway among 2k?',
      options: ['It is sent to all gateways', 'The Session Registry says which gateway holds the recipient', 'The phone polls every gateway', 'The load balancer guesses'],
      answer: 1,
      why: 'Redis maps each online user to their gateway, so the message goes to just that one.',
    },
    {
      question: 'Priya was offline all night. What happens when she opens the app?',
      options: ['Messages are lost', 'The app asks for everything after its last message id', 'The sender must resend', 'She only sees the last message'],
      answer: 1,
      why: 'The app syncs from its last message id, so it catches up on everything it missed.',
    },
  ],
}

export default lesson
