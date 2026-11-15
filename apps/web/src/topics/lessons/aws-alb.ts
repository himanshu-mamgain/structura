import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One address for many servers',
      text: 'An Application Load Balancer (ALB) is AWS\'s load balancer for web traffic. It understands HTTP, so it can look at each request\'s host name, path and headers before deciding where to send it.',
      focus: ['Shopper', 'HTTPS Listener (443)'],
    },
    {
      title: 'Listeners wait on a port',
      text: 'A listener waits for connections on one port. Here, port 80 (plain HTTP) has one job: tell the browser to come back on HTTPS. Port 443 does the real work.',
      focus: ['Shopper', 'HTTP Listener (80)', 'HTTPS Listener (443)'],
      example: 'GET http://shop.example.com/\n→ 301 Moved Permanently\n  Location: https://shop.example.com/',
    },
    {
      title: 'HTTPS ends at the load balancer',
      text: 'TLS is the encryption behind HTTPS. The HTTPS listener decrypts each request with a certificate from AWS Certificate Manager, which renews it for you. With several sites, the browser says which one it wants (this is called SNI), and the listener picks the right certificate.',
      focus: ['HTTPS Listener (443)', 'TLS Certificate'],
    },
    {
      title: 'Rules decide where each request goes',
      text: 'Rules are checked in order, lowest number first. Each has a condition, such as a host name or a path, and an action, such as "send to this target group". If no rule matches, the default action runs.',
      focus: ['Listener Rules', 'Admin Targets', 'API v2 Targets', 'Web Targets'],
      example: '1  host admin.shop.example.com      → Admin Targets\n2  path /api/* + header X-Canary: 1 → API v2 Targets\n3  path /api/*                     → API tasks\n   anything else                   → Web Targets',
    },
    {
      title: 'Target groups do the work',
      text: 'A target group is a set of servers, containers or functions that do the same job. Here the API runs as three tasks, one in each zone, so losing a zone loses only a third of them.',
      focus: ['API Task (zone a)', 'API Task (zone b)', 'API Task (zone c)'],
    },
    {
      title: 'Health checks keep broken targets out',
      text: 'The load balancer calls GET /status on each target every 30 seconds. After 2 failures in a row, that target gets no new requests. After 5 successes in a row, it comes back.',
      focus: ['Health Checks', 'API Task (zone a)', 'API Task (zone b)', 'API Task (zone c)'],
      example: 'Notice a dead target: 2 × 30 s = up to 60 s\nLet it back in:       5 × 30 s = 150 s',
      remember: 'Keep the check cheap. If it tests every dependency, one slow database can take every target out at once.',
    },
    {
      title: 'Picking a target',
      text: 'Round robin takes turns. "Least outstanding requests" picks the target with the fewest requests still in progress, which helps when some requests are much slower than others.',
      focus: ['Listener Rules', 'API Task (zone a)', 'API Task (zone b)', 'API Task (zone c)'],
    },
    {
      title: 'A log line for every request',
      text: 'The ALB can write one line per request to S3, with the target, the status code and the timings. When something is slow or failing, these logs show you which target it was.',
      focus: ['HTTPS Listener (443)', 'Access Logs'],
      example: '600 requests/s × 86,400 s × ~400 bytes ≈ 20.7 GB a day',
    },
  ],
  quiz: [
    {
      question: 'What does the listener on port 80 do here?',
      options: ['Sends requests to the API', 'Redirects the browser to HTTPS', 'Runs the health checks', 'Stores the access logs'],
      answer: 1,
      why: 'Its only action is a 301 redirect, so every visitor ends up on HTTPS.',
    },
    {
      question: 'A request for /api/orders arrives with no special header. Where does it go?',
      options: ['Admin Targets', 'API v2 Targets', 'The API tasks', 'Web Targets'],
      answer: 2,
      why: 'It doesn\'t match the admin host or the canary header, so the /api/* rule sends it to the API tasks.',
    },
    {
      question: 'Why keep the health check cheap?',
      options: ['A deep check that fails on one slow dependency can remove every target at once', 'AWS only allows simple checks', 'It makes HTTPS faster', 'It saves disk space'],
      answer: 0,
      why: 'The check should say "this process can serve", not test the whole system.',
    },
  ],
}

export default lesson
