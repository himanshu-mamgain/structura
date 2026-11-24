import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Many fans, few seats',
      text: 'A big concert has 18k seats and 600k fans who all open the sale at 10:00. That is 33 fans for every seat. The hard part is not showing a page. It is giving each seat to exactly one fan.',
      focus: ['Fan (Browser)'],
      remember: 'One seat, one owner. That rule can never break.',
    },
    {
      title: 'A waiting room slows the crowd',
      text: 'If all 600k fans hit the booking servers together, the servers fall over. So each fan joins a waiting room first. It lets in 2k fans a minute and gives each one a signed pass.',
      focus: ['Waiting Room (Queue)', 'API Gateway'],
      example: 'position 4k ÷ 2k per minute = 2 minutes of waiting',
    },
    {
      title: 'The seat map is a hint',
      text: 'The seat map shows free, held and sold seats. It is cached for 2 seconds so thousands of fans share one read. That means it can be a little old, so tapping a seat is a request, not a promise.',
      focus: ['Seat Map Service', 'Seat Hold Store (Redis)', 'Seats DB (Postgres)'],
    },
    {
      title: 'A hold is a short reservation',
      text: 'When a fan taps a seat, the Booking Service holds it for 10 minutes. The fan can pay without losing the seat. If they walk away, the hold ends by itself and the seat is free again.',
      focus: ['Booking Service', 'Seat Hold Store (Redis)'],
      example: 'SET hold:evt_2291:A-14 u_5521 NX EX 600',
      remember: 'NX means "only if nobody else has it".',
    },
    {
      title: 'Two fans, one seat',
      text: 'Redis runs one command at a time. If two fans tap A-14 in the same millisecond, one gets OK and the other gets nil. The second fan sees "seat held" and picks another seat.',
      focus: ['Seat Hold Store (Redis)', 'Booking Service'],
    },
    {
      title: 'Pairs: all or nothing',
      text: 'A family wants A-14 and A-15 together. The system holds both seats in one Redis script. If one is taken, it holds neither, so nobody is stuck with half a pair.',
      focus: ['Booking Service', 'Seat Hold Store (Redis)'],
    },
    {
      title: 'Pay once, even on retry',
      text: 'The Payment Service charges the card and sends the order id as an idempotency key. If the network drops and it retries, the provider sees the same key and charges only once.',
      focus: ['Payment Service', 'Payment Provider'],
      example: 'Idempotency-Key: ord_3f9a1c20\namount: 9,900 = 2 × 4,500 + 10% fee',
    },
    {
      title: 'The database has the last word',
      text: 'Redis can lose data if it fails over. So the seat only becomes sold with a guarded update in the database. It changes a seat only if it is still available, and the system checks that every seat changed.',
      focus: ['Booking Service', 'Seats DB (Postgres)'],
      example: "UPDATE seats SET status = 'sold'\nWHERE seat_id = 'A-14' AND status = 'available';\n-- 1 row: yours. 0 rows: too late.",
      remember: 'Redis decides who may pay. The database decides who owns the seat.',
    },
    {
      title: 'Clean up and send tickets',
      text: 'If the card is declined, the hold is deleted at once. A worker also expires pending orders that ran out of time. When an order is paid, an event goes into a queue and a worker emails the tickets, so a slow email service never slows a sale.',
      focus: ['Hold Expiry Worker', 'Order Events (Queue)', 'Ticket & Email Worker'],
    },
  ],
  quiz: [
    {
      question: 'Why does the system use a waiting room?',
      options: ['To make tickets cheaper', 'To let fans in at a speed the servers can handle', 'To hide the seat map', 'To store the tickets'],
      answer: 1,
      why: 'The waiting room admits a fixed number of fans a minute, so a flash sale makes the line longer, not the servers slower.',
    },
    {
      question: 'Two fans tap seat A-14 at the same moment. What does SET … NX do?',
      options: ['Gives the hold to both', 'Gives it to the fan with the faster phone', 'Gives it to one fan and tells the other it is already held', 'Deletes the seat'],
      answer: 2,
      why: 'Redis runs one command at a time, and NX only sets the key if it does not exist yet, so exactly one fan gets it.',
    },
    {
      question: 'Why update the seat with WHERE status = \'available\' in the database?',
      options: ['To make the query faster', 'So a seat can never be sold twice, even if Redis lost a hold', 'To save disk space', 'To send the email'],
      answer: 1,
      why: 'If another order already sold the seat, the update changes 0 rows and the system refuses the sale and refunds the card.',
    },
  ],
}

export default lesson
