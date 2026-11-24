import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'HTTP: ask, answer, done',
      text: 'With HTTP, the app asks and the server answers, and that\'s the end of it. Servers remember nothing between requests, so the Load Balancer can send each one to any HTTP API Server. You scale by requests a second.',
      focus: ['Fan App', 'Load Balancer', 'HTTP API Servers'],
    },
    {
      title: 'Polling wastes most asks',
      text: 'To show a live score over HTTP, the app asks again every 5 s. A ball comes every 30 s, so 5 of every 6 polls bring nothing new, and fans wait 2.5 s on average. For 1,000,000 fans that\'s 200,000 requests a second.',
      focus: ['HTTP API Servers', 'Score Cache'],
      example: '1,000,000 ÷ 5 s = 200,000 requests a second',
    },
    {
      title: 'A WebSocket stays open',
      text: 'A WebSocket starts as an HTTP request with "Upgrade: websocket". The server answers 101, and the connection stays open, so the server can push each ball at once. A small message adds just 2 bytes of framing.',
      focus: ['Load Balancer', 'WebSocket Servers', 'Fan App'],
      example: 'GET /live  Upgrade: websocket\n← 101 Switching Protocols',
    },
    {
      title: 'Scale by connections',
      text: 'Each connection lives on one server, often for hours. So you size WebSocket Servers by how many connections each can hold. At 50,000 each, 1,000,000 fans need 20 servers.',
      focus: ['WebSocket Servers'],
      remember: 'HTTP: requests a second. WebSocket: connections held.',
    },
    {
      title: 'Every server must hear it',
      text: 'A server only knows its own connections. If the ball goes to one server, only its fans see it. So every server subscribes to Redis Pub/Sub, and the Score Service publishes each ball once.',
      focus: ['Score Service', 'Redis Pub/Sub', 'WebSocket Servers'],
      example: 'PUBLISH match:IND-AUS {"score":"116/3"} → 20 servers',
    },
    {
      title: 'Ping, or be cut off',
      text: 'Load balancers close connections that stay silent too long: 60 s on an ALB by default. In a 20-minute innings break, every connection goes quiet. Servers send a tiny ping every 30 s to keep them open.',
      focus: ['Load Balancer', 'WebSocket Servers'],
    },
    {
      title: 'Restarts cause storms',
      text: 'Restarting one server drops its 50,000 connections, and they all reconnect. Done at once, that\'s 50,000 handshakes in a second. If each app waits a random time first (jitter), it\'s about 1,667 a second.',
      focus: ['WebSocket Servers', 'Fan App'],
      remember: 'Reconnect with backoff and random jitter.',
    },
    {
      title: 'Socket.IO is not plain WebSocket',
      text: 'Socket.IO adds rooms, replies and a fallback to long polling, with its own protocol on top. Plain WebSocket clients can\'t talk to it. With many servers it needs sticky sessions for the fallback, and an adapter such as Redis to broadcast.',
    },
  ],
  quiz: [
    {
      question: 'Your chat works with one WebSocket server. With three, users miss two thirds of the messages. What\'s missing?',
      options: ['A bigger server', 'Pub/sub between the servers', 'Shorter pings', 'HTTP polling'],
      answer: 1,
      why: 'Each server only knows its own connections. Every server must subscribe to a pub/sub channel so a message published once reaches all of them.',
    },
    {
      question: 'Every night at 2 a.m., when nobody chats, all WebSocket connections drop. Why?',
      options: ['The database restarts', 'The connections hit a message limit', 'The load balancer closes connections idle past its timeout', 'Redis runs out of memory'],
      answer: 2,
      why: 'Silent connections are closed by the load balancer\'s idle timeout. Server pings every 30 s keep them open.',
    },
    {
      question: 'What do you size WebSocket servers by?',
      options: ['Requests a second', 'Connections held at once', 'Database size', 'Number of rooms'],
      answer: 1,
      why: 'A WebSocket connection stays open on one server, so the limit is how many connections each server can hold: memory, file descriptors and CPU for handshakes and pushes.',
    },
  ],
}

export default lesson
