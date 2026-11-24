import type { Trace } from '@structura/shared'
import { defaultTrace, json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A ticket booking system (BookMyShow / Ticketmaster style). The hard part is not
// the website: it is that 600,000 fans want 18,000 seats in the same minute, and
// no seat may be sold twice. The simulator works out the prices, the hold time and
// the queue wait from the inputs, so the numbers on screen are the ones the design gives.

const PRICE = 4500 // INR per seat
const FEE_PCT = 10 // service fee
const HOLD_SECONDS = 600 // a seat is held for 10 minutes
const ADMIT_PER_MIN = 2000 // fans let in from the waiting room each minute
const QUEUE_POSITION = 4000 // this fan's place in the queue in the flash-sale example
const SALE_START = Date.parse('2026-12-05T10:00:00Z')

const FAN = 'Fan (Browser)'
const QUEUE = 'Waiting Room (Queue)'
const GATEWAY = 'API Gateway'
const MAP = 'Seat Map Service'
const BOOKING = 'Booking Service'
const HOLDS = 'Seat Hold Store (Redis)'
const SEATS = 'Seats DB (Postgres)'
const PAYMENT = 'Payment Service'
const PROVIDER = 'Payment Provider'
const EXPIRY = 'Hold Expiry Worker'
const EVENTS = 'Order Events (Queue)'
const TICKETS = 'Ticket & Email Worker'

const SEAT_IDS = ['A-14', 'A-15', 'A-16', 'A-17']
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`

const simulator: Simulator = {
  fields: [
    { id: 'crowd', label: 'The sale', options: ['Quiet day (40 fans a minute)', 'Flash sale (600,000 fans)'] },
    { id: 'seats', label: 'Seats the fan wants', options: ['1 seat', '2 seats', '4 seats'] },
    { id: 'seat', label: 'State of the first seat when the fan taps it', options: ['Free', 'Held by another fan', 'Already sold'] },
    { id: 'payment', label: 'What the fan does next', options: ['Pays, card approved', 'Pays, card declined', 'Walks away without paying'] },
  ],
  defaults: { crowd: 'Flash sale (600,000 fans)', seats: '2 seats', seat: 'Free', payment: 'Pays, card approved' },
  run({ crowd, seats, seat, payment }) {
    const flash = crowd.startsWith('Flash')
    const n = Number(seats.replace(/\D/g, '')) || 1
    const ids = SEAT_IDS.slice(0, n)
    const subtotal = PRICE * n
    const fee = Math.round((subtotal * FEE_PCT) / 100)
    const total = subtotal + fee
    const orderId = `ord_${stableHash(`${n}${seat}${payment}`).toString(16).slice(0, 8)}`
    const key = (id: string) => `hold:evt_2291:${id}`
    const input = `${flash ? 'Flash sale' : 'Quiet day'}, ${n} seat${n > 1 ? 's' : ''}, first seat ${seat.toLowerCase()}, ${payment.toLowerCase()}`
    const steps: Trace['steps'] = []

    // 1. Getting in.
    if (flash) {
      const waitSec = Math.round((QUEUE_POSITION / ADMIT_PER_MIN) * 60)
      steps.push({
        text: `At 10:00 sharp, 600,000 fans open the sale for an 18,000-seat arena. Letting them all in would flatten the booking servers, so each fan joins a waiting room first. This fan is number ${QUEUE_POSITION.toLocaleString()}; the room lets in ${ADMIT_PER_MIN.toLocaleString()} fans a minute, so the wait is ${waitSec} seconds.`,
        nodes: [FAN, QUEUE],
        data: `POST /queue/join  {"event":"evt_2291"}\n→ {"position":${QUEUE_POSITION},"admitRate":"${ADMIT_PER_MIN}/min","etaSeconds":${waitSec}}\nwait = ${QUEUE_POSITION} ÷ ${ADMIT_PER_MIN} per min × 60 = ${waitSec} s`,
      })
      steps.push({
        text: 'When the fan reaches the front, the waiting room gives them a signed pass that is valid for 10 minutes. The API Gateway checks the pass on every call, so nobody can skip the line by calling the API directly.',
        nodes: [QUEUE, GATEWAY],
        data: `pass = HMAC-signed {"fan":"u_5521","event":"evt_2291","exp":"${clock(SALE_START + (waitSec + 600) * 1000)}Z"}\nGET /events/evt_2291/seats  Authorization: Pass …`,
      })
    } else {
      steps.push({
        text: 'On a normal day only about 40 fans a minute arrive, so there is no queue. The fan goes straight to the API Gateway, which still checks login and rate limits.',
        nodes: [FAN, GATEWAY],
        data: 'GET /events/evt_2291/seats  (40 fans a minute: no waiting room needed)',
      })
    }

    // 2. The seat map.
    steps.push({
      text: 'The seat map shows which seats are free, held or sold. The Seat Map Service builds it from two places: sold seats from the database and live holds from Redis. The result is cached for 2 seconds, so thousands of fans share one read.',
      nodes: [GATEWAY, MAP, HOLDS, SEATS],
      data: json({ event: 'evt_2291', cachedForSeconds: 2, seats: { 'A-14': seat === 'Free' ? 'free' : seat === 'Already sold' ? 'sold' : 'held', 'A-15': 'free', 'A-16': 'free', 'A-17': 'free', 'A-18': 'sold' } }),
    })

    // 3. Taking the seat.
    steps.push({
      text: `The fan taps ${ids.join(' and ')}. The map can be 2 seconds old, so it is only a hint. The Booking Service must decide for real, and it asks the database first whether the seat is already sold.`,
      nodes: [FAN, GATEWAY, BOOKING, SEATS],
      data: `POST /holds  {"event":"evt_2291","seats":${JSON.stringify(ids)}}\nSELECT seat_id, status FROM seats\n WHERE event_id = 'evt_2291' AND seat_id IN (${ids.map((i) => `'${i}'`).join(', ')});`,
    })

    if (seat === 'Already sold') {
      steps.push({
        text: `The database says ${ids[0]} is sold. The Booking Service stops here and answers 409 Conflict. The fan's map was stale, so the page refreshes and shows ${ids[0]} in grey. Nothing was written, so there is nothing to undo.`,
        nodes: [SEATS, BOOKING, FAN],
        data: `${ids[0]} | sold | order ord_77f1a0c2\nHTTP 409 {"error":"SEAT_SOLD","seat":"${ids[0]}"}`,
      })
      return { input, steps }
    }

    // 4. The hold.
    if (seat === 'Held by another fan') {
      const left = 412
      steps.push({
        text: `The seat is not sold, so the Booking Service tries to hold it with SET … NX. NX means "only if the key does not exist". Another fan already holds ${ids[0]} and has ${left} seconds left to pay, so Redis answers nil. The fan gets a clear message and can choose another seat.`,
        nodes: [BOOKING, HOLDS, FAN],
        data: `SET ${key(ids[0])} u_5521 NX EX ${HOLD_SECONDS}\n→ (nil)   key exists, TTL ${left} s\nHTTP 409 {"error":"SEAT_HELD","retryAfterSeconds":${left}}`,
      })
      steps.push({
        text: `If the other fan does not pay in ${left} seconds, the key expires by itself and ${ids[0]} goes back on the map. If they do pay, the seat is gone for good. The fan can wait, or pick one of the free seats next to it.`,
        nodes: [HOLDS, MAP],
        data: `TTL ${key(ids[0])} → ${left}\n${left} s later, with no payment: key expires, seat shows "free"`,
      })
      return { input, steps }
    }

    const luaLine = n > 1 ? `EVAL hold-all 0 ${ids.map(key).join(' ')} u_5521 ${HOLD_SECONDS}` : `SET ${key(ids[0])} u_5521 NX EX ${HOLD_SECONDS}`
    steps.push({
      text:
        n > 1
          ? `All ${n} seats are free, so the Booking Service holds them in one Redis script. The script is all or nothing: if even one seat were taken, it would hold none, so the fan never ends up with half of a pair. Each key expires in ${HOLD_SECONDS} seconds (10 minutes).`
          : `The seat is free, so the Booking Service holds it with SET … NX EX ${HOLD_SECONDS}. Redis runs one command at a time, so if two fans tap at once, exactly one gets OK. The key expires on its own after 10 minutes.`,
      nodes: [BOOKING, HOLDS],
      data: `${luaLine}\n→ OK${n > 1 ? ` (${n} keys set)` : ''}\nExpires at ${clock(SALE_START + (HOLD_SECONDS + 120) * 1000)}`,
    })

    const holdsAt = SALE_START + 120_000
    steps.push({
      text: `The Booking Service writes a pending order. It stores when the hold ends, ${clock(holdsAt + HOLD_SECONDS * 1000)}, so a worker can clean up even if Redis loses the key. The price is worked out on the server: ${n} × ${inr(PRICE)} + ${FEE_PCT}% fee = ${inr(total)}.`,
      nodes: [BOOKING, SEATS],
      data: `INSERT INTO orders (id, user_id, status, total_inr, hold_expires_at)\nVALUES ('${orderId}', 'u_5521', 'pending', ${total}, '${new Date(holdsAt + HOLD_SECONDS * 1000).toISOString()}');\nsubtotal ${n} × ${PRICE} = ${subtotal}; fee ${FEE_PCT}% = ${fee}; total ${total}`,
    })

    // 5. Paying.
    if (payment === 'Walks away without paying') {
      steps.push({
        text: `The fan gets distracted and closes the tab. Nothing happens for ${HOLD_SECONDS} seconds, which is the point of a hold: it is a short reservation, not a sale.`,
        nodes: [FAN, HOLDS],
        data: `${HOLD_SECONDS} s pass with no payment\nTTL ${key(ids[0])} → 0`,
      })
      steps.push({
        text: `Redis deletes the expired keys, so the seat map shows ${ids.join(' and ')} as free again. The Hold Expiry Worker also finds orders that are still pending after their hold time and marks them expired, so the database matches Redis. Another fan can now buy these seats.`,
        nodes: [HOLDS, EXPIRY, SEATS],
        data: `UPDATE orders SET status = 'expired'\n WHERE status = 'pending' AND hold_expires_at < now();\n→ 1 row (${orderId})\nseats ${ids.join(', ')} are free again`,
      })
      steps.push({
        text: 'If this fan comes back at minute 11 and their card is charged late, the guarded update in the next step would still protect the seat. If someone else already bought it, the Payment Service refunds the charge automatically.',
        nodes: [PAYMENT, EXPIRY],
        data: `late payment for ${orderId} → seat already sold to another order → refund`,
      })
      return { input, steps }
    }

    steps.push({
      text: `The fan pays. The Payment Service sends the charge to the Payment Provider, using the order id as the idempotency key. If the network drops and the call is retried, the provider charges the card once, not twice.`,
      nodes: [BOOKING, PAYMENT, PROVIDER],
      data: `POST /v1/charges\nIdempotency-Key: ${orderId}\n{"amount":${total * 100},"currency":"INR","source":"tok_…"}`,
    })

    if (payment === 'Pays, card declined') {
      steps.push({
        text: `The bank says no. The order becomes failed and the Booking Service deletes the hold keys right away, so ${ids.join(' and ')} go back on sale at once instead of waiting out the other ${HOLD_SECONDS - 95} seconds of the hold (the card was tried 95 seconds after the hold started).`,
        nodes: [PROVIDER, PAYMENT, BOOKING, HOLDS],
        data: `charge → {"status":"declined","code":"insufficient_funds"}\nUPDATE orders SET status = 'failed' WHERE id = '${orderId}';\nDEL ${ids.map(key).join(' ')}\n→ ${n}`,
      })
      steps.push({
        text: 'The fan sees "Payment failed" and can try another card. Their seats are no longer reserved, so they have to take them again; another fan may have grabbed them by then.',
        nodes: [BOOKING, FAN],
        data: 'HTTP 402 {"error":"PAYMENT_DECLINED","canRetry":true,"seatsStillHeld":false}',
      })
      return { input, steps }
    }

    steps.push({
      text: 'The card is approved. Now comes the step that makes the system safe: the database update that turns seats into sold. It only changes a seat that is still available, so even if Redis lost a hold, one seat can never be sold twice.',
      nodes: [PROVIDER, PAYMENT, BOOKING],
      data: `charge → {"status":"succeeded","id":"ch_8a31f","amount":${total * 100}}`,
    })
    steps.push({
      text: `The Booking Service runs one transaction. Each seat is updated with WHERE status = 'available'. If the count of changed rows equals ${n}, every seat is ours. If it is lower, someone else got a seat, and the whole transaction rolls back and the charge is refunded.`,
      nodes: [BOOKING, SEATS],
      data: `BEGIN;\nUPDATE seats SET status = 'sold', order_id = '${orderId}'\n WHERE event_id = 'evt_2291' AND seat_id IN (${ids.map((i) => `'${i}'`).join(', ')})\n   AND status = 'available';\n→ ${n} row${n > 1 ? 's' : ''} (needed ${n}) ✓\nUPDATE orders SET status = 'paid' WHERE id = '${orderId}';\nCOMMIT;`,
    })
    steps.push({
      text: 'The Booking Service deletes the hold keys and publishes an order.paid event. It does not email the fan itself: a slow email server must never slow down a sale, and the queue keeps the event if the worker is down.',
      nodes: [BOOKING, HOLDS, EVENTS],
      data: `DEL ${ids.map(key).join(' ')}\nPUBLISH order.paid ${json({ order: orderId, seats: ids, total })}`,
    })
    steps.push({
      text: `The Ticket & Email Worker reads the event, makes one QR code per seat and emails the fan. Each QR holds a signed ticket id, so the gate can check it offline. The worker may see the same event twice, so it checks "ticket already sent?" first.`,
      nodes: [EVENTS, TICKETS, FAN],
      data: `tickets: ${ids.map((i) => `tkt_${stableHash(orderId + i).toString(36)}`).join(', ')}\nemail → fan@example.com  "${n} ticket${n > 1 ? 's' : ''}, ${inr(total)}"`,
    })
    return { input, steps }
  },
}

export const ticketBooking: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'ticket-booking',
  title: 'Ticket Booking System (BookMyShow-style)',
  blurb: 'Sell 18k seats to 600k fans in minutes: waiting room, timed seat holds and no double booking',
  guides: [
    'design-stock-exchange',
    'how-to-avoid-double-payment',
    'payment-system',
    'shortlong-polling-sse-websocket',
    'how-do-we-retry-on-failures',
  ],
  takeaways: [
    'A seat has three states: available, held (for a short time) and sold. The hold is what lets a fan pay without losing the seat.',
    'Hold with Redis SET NX EX: only one fan gets the key, and it expires by itself after 10 minutes.',
    'Redis decides who may pay; the database decides who owns the seat. Update the seat only WHERE status = \'available\' and count the changed rows.',
    'A waiting room lets in a fixed number of fans a minute, so a flash sale slows down the line, not the servers.',
    'Charge with an idempotency key, and send tickets from a queue so a retry or a slow email never causes a double charge or a stuck sale.',
    'Free the seats at once when payment fails, and sweep expired pending orders, so seats do not stay locked.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'core', label: 'Booking core' }],
    nodes: [
      { id: 'fan', label: FAN, shape: 'ellipse', color: 'blue', group: null },
      { id: 'queue', label: QUEUE, shape: 'rectangle', color: 'yellow', group: null },
      { id: 'gw', label: GATEWAY, shape: 'rectangle', color: 'violet', group: null },
      { id: 'map', label: MAP, shape: 'rectangle', color: 'violet', group: null },
      { id: 'booking', label: BOOKING, shape: 'rectangle', color: 'violet', group: 'core' },
      { id: 'holds', label: HOLDS, shape: 'rectangle', color: 'red', group: 'core' },
      { id: 'db', label: SEATS, shape: 'rectangle', color: 'green', group: 'core' },
      { id: 'expiry', label: EXPIRY, shape: 'rectangle', color: 'orange', group: 'core' },
      { id: 'pay', label: PAYMENT, shape: 'rectangle', color: 'violet', group: null },
      { id: 'provider', label: PROVIDER, shape: 'cloud', color: 'blue', group: null },
      { id: 'events', label: EVENTS, shape: 'rectangle', color: 'yellow', group: null },
      { id: 'tickets', label: TICKETS, shape: 'rectangle', color: 'orange', group: null },
    ],
    edges: [
      { from: 'fan', to: 'queue', label: 'join the sale', dashed: false },
      { from: 'queue', to: 'gw', label: 'admit with pass', dashed: false },
      { from: 'gw', to: 'map', label: 'GET seats', dashed: false },
      { from: 'map', to: 'holds', label: 'read holds', dashed: false },
      { from: 'map', to: 'db', label: 'read sold', dashed: false },
      { from: 'gw', to: 'booking', label: 'POST /holds', dashed: false },
      { from: 'booking', to: 'holds', label: 'SET NX EX 600', dashed: false },
      { from: 'booking', to: 'db', label: 'guarded UPDATE', dashed: false },
      { from: 'booking', to: 'pay', label: 'charge', dashed: false },
      { from: 'pay', to: 'provider', label: 'idempotency key', dashed: false },
      { from: 'holds', to: 'expiry', label: 'expired holds', dashed: true },
      { from: 'expiry', to: 'db', label: 'expire pending orders', dashed: true },
      { from: 'booking', to: 'events', label: 'order.paid', dashed: false },
      { from: 'events', to: 'tickets', label: 'consume', dashed: false },
      { from: 'tickets', to: 'fan', label: 'e-tickets', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'events',
        name: 'events',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'starts_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'sale_opens_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'seats',
        name: 'seats',
        columns: [
          { name: 'event_id', type: 'text', pk: true, fk: 'events.id', nullable: false, unique: false },
          { name: 'seat_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'section', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'price_inr', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: "text ('available','sold')", pk: false, fk: null, nullable: false, unique: false },
          { name: 'order_id', type: 'text', pk: false, fk: 'orders.id', nullable: true, unique: true },
        ],
        indexes: ['(event_id, status) — the seat map counts available seats'],
      },
      {
        id: 'orders',
        name: 'orders',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'event_id', type: 'text', pk: false, fk: 'events.id', nullable: false, unique: false },
          { name: 'user_id', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: "text ('pending','paid','failed','expired')", pk: false, fk: null, nullable: false, unique: false },
          { name: 'total_inr', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'hold_expires_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'charge_id', type: 'text', pk: false, fk: null, nullable: true, unique: true },
        ],
        indexes: ['(status, hold_expires_at) — the expiry worker finds old pending orders'],
      },
    ],
    relations: [
      { from: 'seats', to: 'events', kind: 'one-to-many', label: 'belong to' },
      { from: 'seats', to: 'orders', kind: 'one-to-many', label: 'sold by' },
      { from: 'orders', to: 'events', kind: 'one-to-many', label: 'for' },
    ],
  },
  explanation: {
    title: 'Ticket Booking System (BookMyShow-style)',
    summary:
      'Selling tickets looks like a shop, but for a popular show many thousands of fans want the same few seats at the same second. A good design lets fans in at a safe speed, holds a seat for a short time while they pay, and makes it impossible to sell one seat twice.',
    sections: [
      {
        heading: 'Overview',
        body: 'A seat is different from a normal product. There is exactly one A-14 for each show, and two fans cannot both get it. So the system has to answer "who gets this seat?" correctly, even when thousands of requests arrive in the same second.\n\nThe design has three ideas. First, a waiting room slows the crowd down to a speed the servers can handle. Second, a hold reserves a seat for 10 minutes while the fan pays. Third, the database has the final say: a seat only becomes sold with an update that checks it is still available.\n\nA seat has three states: available, held and sold. Held lives in Redis with a timer, because it is temporary. Sold lives in the database, because it must never be lost.',
      },
      {
        heading: 'Requirements',
        body: '- Never sell the same seat twice. This is the one rule that cannot break.\n- A fan who starts paying keeps the seat for a fixed time (10 minutes).\n- A seat that is not paid for returns to sale by itself.\n- Fans who book 2 or 4 seats together get all of them or none.\n- The site stays up when 600k fans arrive at 10:00.\n- A fan is charged once, even if the network retries the payment.\n- Tickets arrive by email within seconds, and the system works if the email service is slow.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Crowd: 600k fans want 18k seats, which is 33 fans for each seat. Most fans will not get a ticket, so the design must make "sold out" fast and clear.\n- Admission rate: the waiting room lets in 2k fans a minute. With each fan shopping for about 5 minutes, there are 2k × 5 = 10k fans in the booking pages at once.\n- Seat map reads: if each of those fans refreshes the map every 5 seconds, that is 10k ÷ 5 = 2k reads a second. A 2-second cache turns this into about 1 database read per event per 2 seconds.\n- Orders: with 2.5 seats per order, 18k seats make 7,200 orders. If 4 in 10 admitted fans buy, 18k fans must be admitted, which is 9 minutes at 2k a minute. So the show sells out in about 9 minutes and the other 582k fans (97%) see "sold out".\n- Payments: 7,200 orders in 540 seconds is about 13 orders a second on average; plan for 3 times that at the peak, about 40 a second.\n- Storage: a seat row is about 64 bytes, so one show is 18k × 64 B = 1.15 MB. 5k shows a year is 90 million rows, about 5.8 GB. Small. The hard part is contention (many people wanting the same row), not size.',
      },
      {
        heading: 'Step by step',
        body: '1. The Fan (Browser) joins the sale in the Waiting Room (Queue) and gets a place in line.\n2. When it is their turn, the Waiting Room (Queue) gives a signed pass and the API Gateway checks it on every call.\n3. The Seat Map Service builds the map from sold seats in the Seats DB (Postgres) and live holds in the Seat Hold Store (Redis), and caches it for 2 seconds.\n4. The fan taps seats. The Booking Service checks the Seats DB (Postgres) that they are not sold.\n5. The Booking Service holds the seats in the Seat Hold Store (Redis) with SET NX EX 600. If a seat is already held, the fan gets a "seat held" message.\n6. The Booking Service writes a pending order with the time the hold ends.\n7. The Payment Service charges the card through the Payment Provider, using the order id as the idempotency key.\n8. If payment works, the Booking Service marks the seats sold with a guarded UPDATE and removes the hold. If it fails, it removes the hold at once.\n9. The Hold Expiry Worker expires pending orders whose hold time has passed.\n10. The Booking Service publishes order.paid to Order Events (Queue), and the Ticket & Email Worker sends the tickets.',
      },
      {
        heading: 'Components',
        body: '- Fan (Browser): shows the seat map and sends hold and pay requests.\n- Waiting Room (Queue): lets in a fixed number of fans a minute and gives each a signed pass.\n- API Gateway: checks the pass, login and rate limits before any booking call.\n- Seat Map Service: builds the seat map from the database and Redis, and caches it for 2 seconds.\n- Booking Service: holds seats, creates orders and marks seats sold. It owns the booking rules.\n- Seat Hold Store (Redis): keeps a key per held seat with a 10-minute timer. SET NX makes sure only one fan gets a seat.\n- Seats DB (Postgres): the source of truth for sold seats and orders. A guarded UPDATE makes a double sale impossible.\n- Payment Service: talks to the card provider, retries safely and refunds if needed.\n- Payment Provider: the outside company that charges the card. It accepts an idempotency key.\n- Hold Expiry Worker: finds pending orders past their hold time and expires them, so the database matches Redis.\n- Order Events (Queue): keeps order.paid events until a worker handles them.\n- Ticket & Email Worker: makes QR codes and emails the tickets, once per ticket.',
      },
      {
        heading: 'Key decisions',
        body: '- Hold in Redis, sell in the database. Redis is fast and its keys expire by themselves, which is exactly a hold. But Redis can lose data in a failover, so the database update has the last word.\n- Guard the update: UPDATE … WHERE status = \'available\' and compare the changed row count with the seats wanted. This is optimistic: no long locks, and a lost race just returns 0 rows.\n- All or nothing for groups. Use one Redis script or one transaction for all seats, so nobody holds only A-14 of a pair.\n- Hold time: 10 minutes is a balance. Longer is kinder to slow payers but keeps seats off sale; shorter is faster but fans lose seats mid-payment. Some sites show a countdown.\n- Waiting room vs a faster server: scaling servers helps, but the database row for a hot seat is still one row. Limiting how many fans act at once is cheaper and fairer than buying capacity for one minute a year.\n- Reserved seats vs general admission: with general admission there are no seat ids, only a counter of tickets left. A single atomic decrement (UPDATE … SET left = left - 2 WHERE left >= 2) is enough.\n- Send tickets from a queue, so a slow email provider can never block or break a sale.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Hot show: shard the database by event id, so one big sale does not slow the others. Put the hold keys for one event on one Redis shard, so a multi-seat script stays atomic.\n- Redis fails over and loses holds: two fans may both think they hold a seat. The guarded UPDATE lets the first payer win. The second payer is refunded and offered other seats. It is rare, but it is safe.\n- The booking service crashes after charging but before marking seats sold: the pending order and the provider\'s charge id let a recovery job finish the order or refund it. Never leave a paid order without seats.\n- Payment is slow: the hold timer keeps running. Extend the hold once when a payment is known to be in flight, so a card approved at minute 10 is not lost.\n- Bots: the waiting room, a login, a limit of 4 seats per fan and a CAPTCHA at the front slow scalpers. Rate limits help, but the strongest tool is limiting what one account can buy.\n- Cache stampede on the seat map: the 2-second cache and a single refresh per event stop 2k fans from each hitting the database.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Two fans tap the last seat in the same millisecond. Walk through exactly what each request does.\n- What if Redis loses the holds during a failover?\n- How do you hold 4 seats together without ever holding only 2?\n- How would you design the waiting room, and how do you stop fans from skipping it?\n- How do you handle a card that is approved after the hold has expired?\n- How would the design change for general admission, with no seat numbers?\n- How do you stop bots buying everything?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Hold seats all or nothing (Redis)',
        language: 'javascript',
        source: `// Hold every seat or none. EVAL runs as one step, so no other fan can slip in between.
const HOLD_ALL = \`
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then return 0 end   -- someone holds it
end
for i, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'EX', ARGV[2])         -- fan id, ttl in seconds
end
return 1\`

export async function holdSeats(redis, eventId, seatIds, fanId) {
  const keys = seatIds.map((id) => \`hold:\${eventId}:\${id}\`)
  const ok = await redis.eval(HOLD_ALL, keys.length, ...keys, fanId, 600)
  return ok === 1 // false → "seat held", the fan picks other seats
}`,
        versions: [
          {
            language: 'python',
            source: `HOLD_ALL = """
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then return 0 end
end
for i, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'EX', ARGV[2])
end
return 1"""

def hold_seats(r, event_id, seat_ids, fan_id):
    keys = [f"hold:{event_id}:{s}" for s in seat_ids]
    # EVAL is atomic: all seats are held, or none.
    return r.eval(HOLD_ALL, len(keys), *keys, fan_id, 600) == 1`,
          },
        ],
      },
      {
        title: 'Sell the seats (guarded UPDATE)',
        language: 'javascript',
        source: `// The database has the last word: only seats that are still available can be sold.
export async function sellSeats(db, eventId, seatIds, orderId) {
  const tx = await db.begin()
  try {
    const { rowCount } = await tx.query(
      \`UPDATE seats SET status = 'sold', order_id = $1
        WHERE event_id = $2 AND seat_id = ANY($3) AND status = 'available'\`,
      [orderId, eventId, seatIds],
    )
    if (rowCount !== seatIds.length) throw new Error('SEAT_TAKEN') // roll back, refund
    await tx.query(\`UPDATE orders SET status = 'paid' WHERE id = $1\`, [orderId])
    await tx.commit()
  } catch (err) {
    await tx.rollback()
    throw err
  }
}`,
        versions: [
          {
            language: 'java',
            source: `void sellSeats(Connection db, String eventId, String[] seatIds, String orderId) throws SQLException {
  db.setAutoCommit(false);
  try (var up = db.prepareStatement(
      "UPDATE seats SET status = 'sold', order_id = ? "
          + "WHERE event_id = ? AND seat_id = ANY(?) AND status = 'available'")) {
    up.setString(1, orderId);
    up.setString(2, eventId);
    up.setArray(3, db.createArrayOf("text", seatIds));
    // Fewer rows than seats means another order got one first.
    if (up.executeUpdate() != seatIds.length) throw new IllegalStateException("SEAT_TAKEN");
    try (var paid = db.prepareStatement("UPDATE orders SET status = 'paid' WHERE id = ?")) {
      paid.setString(1, orderId);
      paid.executeUpdate();
    }
    db.commit();
  } catch (Exception e) {
    db.rollback(); // the caller refunds the charge
    throw e;
  }
}`,
          },
        ],
      },
      {
        title: 'Waiting room: how long is the wait?',
        language: 'javascript',
        source: `// Admit a fixed number of fans a minute, in the order they joined.
const ADMIT_PER_MIN = 2000

export function waitSeconds(position) {
  return Math.ceil((position / ADMIT_PER_MIN) * 60)
}

console.log(waitSeconds(4000)) // 120 seconds
console.log(waitSeconds(18000)) // 540 seconds (9 minutes): the show is likely sold out`,
        versions: [
          {
            language: 'python',
            source: `import math

ADMIT_PER_MIN = 2000

def wait_seconds(position):
    return math.ceil(position / ADMIT_PER_MIN * 60)

print(wait_seconds(4000))   # 120 seconds
print(wait_seconds(18000))  # 540 seconds (9 minutes): the show is likely sold out`,
          },
        ],
      },
      {
        title: 'Expire pending orders',
        language: 'sql',
        source: `-- Runs every 30 seconds. Seats were never marked sold for these orders,
-- so expiring the order is all the database needs.
UPDATE orders
   SET status = 'expired'
 WHERE status = 'pending'
   AND hold_expires_at < now();

-- If a charge for an expired order arrives late, the guarded UPDATE decides:
-- seat still available → sell it; already sold → refund the charge.`,
      },
    ],
    related: ['Locking', 'Rate limiter', 'Idempotent payments', 'Message queue', 'Distributed cache'],
  },
  simulator,
}
