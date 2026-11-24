import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Why count clicks',
      text: 'An advertiser pays each time a viewer clicks their ad. So the click count is money. Count too few and you lose income. Count too many and you overcharge a customer.',
      focus: ['Viewer', 'Advertiser'],
      example: '200 clicks × $0.50 = $100 for one minute',
      remember: 'The count is the bill.',
    },
    {
      title: 'Do not count in the request',
      text: 'A big network gets about a billion clicks a day. That is 11,574 a second on average, and about 5 times more at the peak. One database row cannot take that many updates. So the redirect service only logs the click and sends the viewer on.',
      focus: ['Click Redirect Service', 'Advertiser Site'],
      example: '1,000,000,000 ÷ 86,400 = 11,574 clicks a second',
    },
    {
      title: 'Log first, count later',
      text: 'Each click is published to a Kafka stream, an append-only list that programs read at their own pace. A copy of every event is also saved in cheap storage. Counts can always be rebuilt from this log.',
      focus: ['Click Stream (Kafka)', 'Raw Click Archive (S3)'],
      remember: 'If you keep the raw clicks, any mistake can be fixed.',
    },
    {
      title: 'Count in windows',
      text: 'The Stream Aggregator adds clicks up in one-minute windows. It saves one row per ad per minute, not one row per click. A window uses event time: when the viewer tapped, not when the click arrived.',
      focus: ['Stream Aggregator', 'Aggregates Store (OLAP)'],
      example: 'ad_77, 10:00, 200 clicks\nad_77, 10:01, 200 clicks',
    },
    {
      title: 'Late clicks',
      text: 'A phone in a tunnel may send its click 90 seconds late. The aggregator waits a little after each minute ends before it closes the window. A click that comes after that is too late for the live count.',
      focus: ['Stream Aggregator'],
      example: 'wait 30 s: minute 1 closes at 90 s\n10% of clicks 90 s late → 21 clicks lost in minute 2',
      remember: 'A longer wait is more exact, but the number is final later.',
    },
    {
      title: 'Duplicates',
      text: 'A phone that gets no answer sends the click again. If you count both, the advertiser pays for one click twice. Every click has a unique click_id. Redis remembers the ids for 10 minutes, and a second copy is skipped.',
      focus: ['Dedup Cache (Redis)', 'Stream Aggregator'],
      example: 'SET seen:c_000007 1 NX EX 600  → OK  (count it)\nSET seen:c_000007 1 NX EX 600  → nil (skip it)',
    },
    {
      title: 'The nightly fix',
      text: 'The live count is fast but not perfect. Every night a batch job replays the whole day from the archive. It counts each click_id once, with no deadline, and overwrites the minute rows. The bill comes from this exact number.',
      focus: ['Reconciliation Job', 'Raw Click Archive (S3)', 'Aggregates Store (OLAP)'],
      example: 'live total: 579 clicks ($289.50)\nexact total: 600 clicks ($300.00)',
      remember: 'Fast path for the dashboard, exact path for the bill.',
    },
    {
      title: 'Fake clicks',
      text: 'Anyone can open a link again and again. So each click link is signed with a secret key. The redirect service checks the signature and drops links nobody signed. Known bots are marked and not billed.',
      focus: ['Click Redirect Service', 'Viewer'],
      remember: 'Mark bad clicks, never delete them: you may want to recount.',
    },
    {
      title: 'Reading the numbers',
      text: 'The Reporting API adds up the minute rows for the Advertiser. The last hour is 60 rows, and the last month is about 43,200 rows per ad. That is a small read, because the clicks were already added up.',
      focus: ['Reporting API', 'Advertiser', 'Aggregates Store (OLAP)'],
      example: '30 days × 24 hours × 60 minutes = 43,200 rows',
    },
  ],
  quiz: [
    {
      question: 'Why does a window use event time, not arrival time?',
      options: ['It is faster to compute', 'A slow network would move clicks into the wrong minute', 'Kafka needs it', 'It makes the data smaller'],
      answer: 1,
      why: 'Event time is when the viewer tapped. It means the same thing every day, even when a phone is slow or you replay the log.',
    },
    {
      question: 'A phone sends the same click twice. What stops a double charge?',
      options: ['Waiting longer for late clicks', 'A bigger Kafka cluster', 'A unique click_id that is checked before counting', 'Counting only once a day'],
      answer: 2,
      why: 'The first copy sets the id in Redis. The second finds it already there and is skipped.',
    },
    {
      question: 'Why run a nightly batch job when the stream already counts?',
      options: ['To make the bill exact from the full raw log', 'To delete old clicks', 'To sign the click links', 'To pick a new Kafka partition'],
      answer: 0,
      why: 'The stream is fast but closes windows early and forgets ids. The batch sees the whole day, so it can be exact.',
    },
  ],
}

export default lesson
