import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One front door',
      text: 'An API gateway is one address that sits in front of all your services. The mobile app talks only to the gateway. It does not need to know how many services are behind it.',
      focus: ['Mobile App', 'API Gateway'],
    },
    {
      title: 'Why not let each service do it?',
      text: 'Every service needs to check who is calling, count requests and write logs. If each team builds this alone, you get many copies of the same code, and each one works a little differently. The gateway does it once.',
      focus: ['API Gateway', 'Token Check', 'Rate Limiter', 'Metrics & Logs'],
    },
    {
      title: 'Check the token first',
      text: 'The caller sends a JWT, a signed token that says who they are. The gateway checks the signature with a public key it keeps in memory. It also checks the expiry time. This takes about a millisecond and needs no database.',
      focus: ['API Gateway', 'Token Check'],
      example: 'exp=1794998200  now=1795001800\n→ expired by 3,600 s → 401 Unauthorized',
      remember: 'Cheap checks go first. A bad token never reaches a service.',
    },
    {
      title: 'Then count the request',
      text: 'The rate limiter allows each user a fixed number of requests a minute. If the plan allows 100 and 37 are used, this request is fine and 62 are left. The 101st gets 429 Too Many Requests.',
      focus: ['API Gateway', 'Rate Limiter'],
      example: '100 - 37 - 1 = 62 left\nX-RateLimit-Remaining: 62',
    },
    {
      title: 'Pick the right service',
      text: 'The route table maps a path to a service. When two paths match, the longest one wins. So /v1/orders/export can go to a reports service while /v1/orders/42 goes to the orders service.',
      focus: ['Route Table', 'Orders Service', 'Catalog Service'],
      example: '/v1/orders/42        → orders.internal:8080\n/v1/orders/export/7  → reports.internal:8080',
    },
    {
      title: 'Cache what is safe to cache',
      text: 'A product page is the same for everyone, so the gateway can keep a copy for 60 seconds. If the catalog service later breaks, the gateway can still show an older copy. That is called serving stale data on error.',
      focus: ['Response Cache', 'Catalog Service', 'Fallback Response'],
    },
    {
      title: 'A circuit breaker protects you',
      text: 'When a service stops answering, every request waits for the timeout and uses up a connection. A circuit breaker counts failures. After 5 in a row it opens and fails at once for 20 seconds. Then it lets one probe through to test the service.',
      focus: ['Circuit Breaker', 'Orders Service', 'Fallback Response'],
      example: '10k requests/s × 0.8 s timeout = 8k connections stuck\nBreaker open → almost none',
      remember: 'Closed means normal. Open means blocked. Half-open means one test request.',
    },
    {
      title: 'Retry only safe requests',
      text: 'A GET only reads data, so repeating it does no harm. A POST can create an order, so a repeat could create two. The gateway retries GET once, and does not retry POST.',
      focus: ['Circuit Breaker', 'Orders Service'],
    },
    {
      title: 'Keep it thin',
      text: 'Every request passes through the gateway, so it must stay fast and simple. Run several copies behind a load balancer. Keep business rules in the services, not in the gateway.',
      focus: ['API Gateway', 'Metrics & Logs'],
      example: '30k requests/s ÷ 8k per copy = 3.75 → 4 copies, +1 spare = 5',
    },
  ],
  quiz: [
    {
      question: 'A request arrives with an expired token. What does the gateway do?',
      options: ['Sends it to the service anyway', 'Returns 401 and calls no service', 'Retries it twice', 'Returns 503 from the cache'],
      answer: 1,
      why: 'The token check runs first. A bad token is refused in about a millisecond, so no service does any work.',
    },
    {
      question: 'The Orders Service has failed 5 times in a row. What happens to the next request?',
      options: ['It waits for the 800 ms timeout', 'It is retried until it works', 'The breaker is open, so it fails at once', 'The gateway restarts the service'],
      answer: 2,
      why: 'An open circuit blocks the call. This saves connections and gives the service time to recover.',
    },
    {
      question: 'Why does the gateway retry a GET but not a POST?',
      options: ['GET is faster', 'POST cannot be sent twice by the network', 'A repeated POST might create a second order', 'The cache only stores POST'],
      answer: 2,
      why: 'A GET only reads, so repeating it is safe. A POST changes data, and a repeat could do the change twice.',
    },
  ],
}

export default lesson
