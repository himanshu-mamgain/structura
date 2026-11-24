import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Three decisions per request',
      text: 'An app in two regions makes three choices for every request. Which region? Is this request allowed, and which service? Which server? Each is made by a different layer.',
      focus: ['User', 'Healthy Region?', 'API Gateway (Mumbai)', 'ALB (Mumbai)'],
      remember: 'Global layer: region. API gateway: request and service. Local load balancer: server.',
    },
    {
      title: 'Route 53 picks a region with DNS',
      text: 'Route 53 is AWS\'s DNS service. It has one record per region, all with the same name. With latency routing, it answers each user with the closest healthy region.',
      focus: ['User', 'Route 53'],
      example: 'Delhi → Mumbai (30 ms) rather than Frankfurt (130 ms)',
    },
    {
      title: 'Health checks decide "healthy"',
      text: 'Health Checkers in many places call each region\'s /health/deep every 30 s. After 3 failures in a row, the region is unhealthy and left out of the answers. That takes 90 s; checks every 10 s cut it to 30 s.',
      focus: ['Health Checkers', 'Healthy Region?'],
      example: '30 s × 3 failures = 90 s to notice',
    },
    {
      title: 'Cached answers slow DNS failover',
      text: 'A DNS answer comes with a TTL (time to live): how long devices may keep it. After Route 53 changes its answer, users with the old one keep using it until it expires. So failover takes the time to notice plus up to the TTL.',
      focus: ['Route 53'],
      example: '90 s + TTL 60 s = up to 150 s of failed requests',
    },
    {
      title: 'Global Accelerator: fixed anycast addresses',
      text: 'Global Accelerator gives the app two IP addresses that never change. They are announced from AWS edge locations everywhere, so users reach the nearest one. AWS then picks a healthy region, so failover needs no DNS change.',
      focus: ['Global Accelerator', 'Healthy Region?'],
      remember: 'Anycast: the same address in many places; the internet delivers you to the nearest.',
    },
    {
      title: 'API Gateway checks the request',
      text: 'In each region, API Gateway checks the user\'s token, applies rate limits and sends each path to the right service. By default an account may send 10k requests a second through it in each region. It doesn\'t pick between servers.',
      focus: ['API Gateway (Mumbai)'],
      example: 'POST /api/orders → token OK → VPC link → internal ALB',
    },
    {
      title: 'The ALB picks a server',
      text: 'The ALB matches a rule such as /api/orders/*, and sends the request to a healthy task in either zone. A task that fails 2 checks in a row is taken out: 60 s with checks every 30 s.',
      focus: ['ALB (Mumbai)', 'Orders Tasks (Mumbai)'],
    },
    {
      title: 'Each failure has its layer',
      text: 'A dead zone is the ALB\'s job: the region\'s other zone carries on. A dead region is the global layer\'s job. Making the global layer react to one bad server would move a whole region\'s users for nothing.',
      focus: ['ALB (Mumbai)', 'Healthy Region?'],
    },
    {
      title: 'Failover needs data and room',
      text: 'Moving Delhi\'s users to Frankfurt only works if Frankfurt has the orders and spare capacity. The databases replicate, usually a few seconds behind. Test it by switching a region off on purpose.',
      focus: ['Orders DB (Mumbai)', 'Orders DB (Frankfurt)'],
    },
  ],
  quiz: [
    {
      question: 'Health checks every 30 s, 3 failures to mark a region unhealthy, DNS TTL 60 s. Up to how long can users fail with Route 53?',
      options: ['30 s', '90 s', '150 s', '60 s'],
      answer: 2,
      why: '30 s × 3 = 90 s for Route 53 to notice, then up to 60 s for cached answers to expire: 150 s.',
    },
    {
      question: 'One availability zone in Mumbai goes down. Which layer should react?',
      options: ['Route 53, moving users to Frankfurt', 'The ALB, taking that zone\'s tasks out', 'API Gateway, refusing requests', 'Nothing should react'],
      answer: 1,
      why: 'The region is still healthy: its other zone can serve. The ALB\'s health checks take the dead zone\'s tasks out, in about a minute with defaults.',
    },
    {
      question: 'Why can Global Accelerator fail over faster than DNS?',
      options: ['Its health checks are free', 'It caches answers longer', 'Users keep the same two anycast IP addresses, so there is no cached DNS answer to wait for', 'It runs in only one region'],
      answer: 2,
      why: 'The addresses never change; AWS decides the region behind them. Once a region is unhealthy, new connections move at once.',
    },
  ],
}

export default lesson
