import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One server has a ceiling',
      text: 'A single server can only do so much: at some point its CPU, memory or network runs out. A bigger machine helps for a while, but it\'s still one machine, and if it fails, the site is down.',
      focus: ['App Server 1'],
    },
    {
      title: 'Scale out, and put someone at the door',
      text: 'Run several identical copies of the app instead. Now something has to decide which copy gets each request. That is the load balancer. Users see one address, never the servers behind it.',
      focus: ['Client (Browser)', 'Load Balancer (active)', 'App Server 1', 'App Server 2', 'App Server 3'],
    },
    {
      title: 'How it picks a server',
      text: 'Round robin takes turns. Least connections picks the least busy server. A hash of the client\'s address always sends the same user to the same server.',
      focus: ['Algorithm (picks a server)'],
      remember: 'Least connections helps when some requests take much longer than others.',
    },
    {
      title: 'Health checks remove broken servers',
      text: 'The health checker calls GET /healthz on every server every 5 seconds. After 3 failures in a row, that server gets no more requests. After 2 successes, it comes back.',
      focus: ['Health Checker', 'App Server 1', 'App Server 2', 'App Server 3'],
    },
    {
      title: 'Keep the servers stateless',
      text: 'If a user\'s login lived in one server\'s memory, their next request could land on another server and log them out. Keep sessions in a shared store such as Redis, and any server can answer any request.',
      focus: ['App Server 1', 'App Server 2', 'App Server 3', 'Session Store (Redis)'],
    },
    {
      title: 'Layer 4 or layer 7',
      text: 'A layer 4 balancer passes TCP connections along without reading them, so it\'s very fast. A layer 7 balancer reads HTTP, so it can route by path or header, and end TLS, the encryption behind HTTPS, in one place.',
      focus: ['Load Balancer (active)'],
    },
    {
      title: 'Plan for losing a server',
      text: 'Size the group so that the others can carry the load when one server dies. Running every server near its limit leaves no room for a failure.',
      focus: ['App Server 1', 'App Server 2', 'App Server 3'],
      example: '20,000 requests/s at peak; one server handles 2,500\n8 servers: just enough, and losing one overloads the rest\n11 servers at 73%: lose one, and the other 10 run at 80%',
    },
    {
      title: 'The load balancer can\'t be the weak spot',
      text: 'A standby load balancer listens for the active one\'s heartbeat, a signal it sends every moment. If the heartbeat stops, the standby takes over its address. DNS can also list several load balancers.',
      focus: ['Load Balancer (active)', 'Load Balancer (standby)', 'DNS (round-robin records)'],
    },
  ],
  quiz: [
    {
      question: 'A user logs in, and their next request goes to a different server. How do they stay logged in?',
      options: ['Their session is in a shared store like Redis', 'The load balancer copies memory between servers', 'DNS remembers them', 'They can\'t; they must log in again'],
      answer: 0,
      why: 'With sessions in a shared store, servers are stateless and any of them can serve the user.',
    },
    {
      question: 'Which job needs a layer 7 load balancer?',
      options: ['Passing TCP connections on as fast as possible', 'Sending /api/* to one group and everything else to another', 'Balancing a database\'s TCP port', 'Answering DNS lookups'],
      answer: 1,
      why: 'Routing by path means reading the HTTP request, which only layer 7 does.',
    },
    {
      question: 'Why run 11 servers when 8 can carry the peak?',
      options: ['11 costs less', 'DNS needs an odd number', 'So losing one server doesn\'t overload the rest', 'Health checks need spare servers'],
      answer: 2,
      why: 'With 8, losing one leaves too little. With 11, the remaining 10 run at 80%.',
    },
  ],
}

export default lesson
