import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Numbers from every server',
      text: 'A monitoring system collects numbers like CPU, requests, errors and latency from every server. It stores them, draws dashboards, and wakes someone when something breaks.',
      focus: ['Monitored Services', 'Dashboards', 'On-call Pager'],
    },
    {
      title: 'A metric is a time series',
      text: 'A time series is a name, some labels, and a stream of (time, value) points. Each different set of labels is a separate series.',
      example: 'http_requests_total{service="orders", code="500"}\n(12:00:00, 1832) (12:00:15, 1840) …',
    },
    {
      title: 'The scale',
      text: '10k servers with 200 metrics each make 2 million series. One sample every 15 seconds is about 133k samples a second, 11.52 billion a day.',
      example: '2 million ÷ 15 s ≈ 133k samples a second',
    },
    {
      title: 'Collectors pull',
      text: 'Service Discovery lists the servers. Collectors pull each one\'s numbers every 15 seconds. A dead server shows up as up=0 instead of just going quiet.',
      focus: ['Service Discovery', 'Metrics Collectors', 'Monitored Services'],
    },
    {
      title: 'A buffer protects the data',
      text: 'Samples go into Kafka before the database. If the database restarts or slows down, samples wait in the buffer instead of being lost.',
      focus: ['Kafka Buffer', 'Ingest Workers', 'Time-Series DB'],
    },
    {
      title: 'Compress and roll up',
      text: 'A time-series database packs each sample into about 1.4 bytes instead of 16. Old data is rolled up to 5-minute averages and moved to the archive.',
      focus: ['Time-Series DB', 'Long-term Archive'],
      example: '184 GB a day raw → about 15.8 GB compressed',
    },
    {
      title: 'Alert on symptoms, with a "for"',
      text: 'The Alert Rules Evaluator checks rules like "error rate above 5% for 5 minutes". The "for" part stops a short blip from waking anyone.',
      focus: ['Alert Rules Evaluator', 'Query Service'],
    },
    {
      title: 'One incident, one page',
      text: 'The Alert Manager groups and de-duplicates alerts. If 40 hosts fail for one reason, the on-call engineer gets one page, not 40.',
      focus: ['Alert Manager', 'On-call Pager'],
      remember: 'Group alerts so one incident is one page.',
    },
  ],
  quiz: [
    {
      question: 'Why pull metrics instead of waiting for servers to push them?',
      options: ['Pulling is cheaper', 'A dead server shows up as up=0 instead of silence', 'Pushing is not possible', 'It needs no database'],
      answer: 1,
      why: 'With push, silence could mean "fine" or "dead"; pull makes failure visible.',
    },
    {
      question: 'Why put Kafka between collectors and the database?',
      options: ['To draw dashboards', 'So a slow or restarting database doesn\'t lose samples', 'To compress data', 'To send pages'],
      answer: 1,
      why: 'The buffer holds samples until the database can take them.',
    },
    {
      question: 'What does a "for 5 minutes" clause on an alert do?',
      options: ['Delays every alert by 5 minutes forever', 'Stops a short blip from paging anyone', 'Deletes old data', 'Groups alerts'],
      answer: 1,
      why: 'The condition must hold the whole time before the alert fires.',
    },
  ],
}

export default lesson
