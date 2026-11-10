import type { Trace } from '@structura/shared'
import type { Simulator } from './simulator'
import type { StaticTopic } from './types'

// Two buyers race for the last seat. The simulator plays the race under each
// locking strategy, with or without a garbage-collection pause on the first
// server, so the learner sees which strategies double-book and why. Times are
// computed from the constants below, not canned.

type Buyer = 'Asha' | 'Ben'

const SEAT = { id: 9041, show: 311, seat: '14A' }
const PEOPLE: Record<Buyer, { id: number; server: string; label: string; lockValue: string }> = {
  Asha: { id: 1201, server: 'API Server 1', label: 'Buyer Asha', lockValue: 'srv1-7f3a' },
  Ben: { id: 1388, server: 'API Server 2', label: 'Buyer Ben', lockValue: 'srv2-c91e' },
}
const LOCK_KEY = `lock:seat:${SEAT.show}:${SEAT.seat}`
const FENCE_KEY = `fence:seat:${SEAT.show}:${SEAT.seat}`
const PAUSE_MS = 12_000 // a long garbage-collection pause on API Server 1
const RETRY_MS = 200 // API Server 2 retries SET NX this often…
const GIVE_UP_MS = 2_000 // …for this long, then tells Ben to try again
const BEN_AGAIN_MS = 10_500 // when Ben taps Book a second time
const START_VERSION = 7
const START_FENCE = 40

const STRATEGIES = [
  'No lock (read, then write)',
  'Pessimistic: SELECT … FOR UPDATE',
  'Optimistic: version check',
  "Atomic UPDATE … WHERE status = 'free'",
  'Redis lock (SET NX PX)',
  'Redis lock + fencing token',
] as const

const ms = (t: number) => `t=${t.toLocaleString('en-US')} ms`
const row = (status: string, user: Buyer | null, version: number, fence = START_FENCE) =>
  `seats ${SEAT.id} (${SEAT.seat}): status='${status}', user_id=${user ? PEOPLE[user].id : 'null'}, version=${version}, fence=${fence}`

type Step = Trace['steps'][number]

/** Who believes they booked, in the order they write their booking, plus the steps that got there. */
interface Race {
  steps: Step[]
  winners: Buyer[]
}

function noLock(pause: boolean): Race {
  const first: Buyer = pause ? 'Ben' : 'Asha'
  const second: Buyer = pause ? 'Asha' : 'Ben'
  const steps: Step[] = [
    {
      text: "API Server 1 reads the seat: it's free. Nothing is locked, so the read only tells it what the row looked like a moment ago.",
      nodes: ['API Server 1', 'Seats Table', 'Seat Free?'],
      data: `${ms(1)}  SELECT status, version FROM seats WHERE id = ${SEAT.id}\n→ ${row('free', null, START_VERSION)}`,
    },
  ]
  if (pause) steps.push({ text: `API Server 1 freezes in a ${PAUSE_MS / 1000} s garbage-collection pause, right between its read and its write.`, nodes: ['API Server 1'], data: `${ms(2)} → ${ms(2 + PAUSE_MS)}  paused` })
  steps.push({
    text: "API Server 2 reads the same row. Asha's server hasn't written yet, so it is still free.",
    nodes: ['API Server 2', 'Seats Table', 'Seat Free?'],
    data: `${ms(3)}  SELECT status, version FROM seats WHERE id = ${SEAT.id}\n→ ${row('free', null, START_VERSION)}`,
  })
  const t1 = pause ? 5 : 4
  const t2 = pause ? 2 + PAUSE_MS + 2 : 6
  steps.push({
    text: `Both servers write. Neither UPDATE checks anything, so both succeed, and ${second}'s write silently replaces ${first}'s. This is a lost update: each server thinks its buyer got the seat.`,
    nodes: ['API Server 1', 'API Server 2', 'Seats Table'],
    data: `${ms(t1)}  ${PEOPLE[first].server}: UPDATE seats SET status='booked', user_id=${PEOPLE[first].id}, version=8 WHERE id=${SEAT.id}  → 1 row\n${ms(t2)}  ${PEOPLE[second].server}: UPDATE seats SET status='booked', user_id=${PEOPLE[second].id}, version=8 WHERE id=${SEAT.id}  → 1 row\n→ ${row('booked', second, 8)}`,
  })
  return { steps, winners: [first, second] }
}

function pessimistic(pause: boolean): Race {
  const granted = 5 + (pause ? PAUSE_MS : 0)
  const wait = granted - 3 // Ben asked at t=3
  return {
    steps: [
      {
        text: 'API Server 1 opens a transaction and reads the seat with FOR UPDATE. That takes an exclusive row lock: until it commits, no one else can lock or change this row.',
        nodes: ['API Server 1', 'Row Lock Queue', 'Seats Table', 'Seat Free?'],
        data: `${ms(1)}  BEGIN; SELECT status FROM seats WHERE id = ${SEAT.id} FOR UPDATE\n→ ${row('free', null, START_VERSION)}   (X lock held by API Server 1)`,
      },
      {
        text: `API Server 2 asks for the same lock and is put in the Row Lock Queue. ${pause ? `API Server 1 then freezes for ${PAUSE_MS / 1000} s while holding the lock, so Ben's request (and a database connection) waits all that time.` : 'It waits only a few milliseconds.'}`,
        nodes: ['API Server 2', 'Row Lock Queue'],
        data: `${ms(3)}  SELECT … FOR UPDATE  → waiting for API Server 1${pause ? `\n${ms(2)} → ${ms(2 + PAUSE_MS)}  API Server 1 paused, lock still held` : ''}`,
      },
      {
        text: 'API Server 1 books the seat and commits, which releases the row lock.',
        nodes: ['API Server 1', 'Seats Table', 'Row Lock Queue'],
        data: `${ms(4 + (pause ? PAUSE_MS : 0))}  UPDATE seats SET status='booked', user_id=${PEOPLE.Asha.id}, version=8 WHERE id=${SEAT.id}; COMMIT\n→ ${row('booked', 'Asha', 8)}`,
      },
      {
        text: `API Server 2 gets the lock at last and reads the committed row: booked. The check fails, so it rolls back and tells Ben the seat is gone. Correct, but Ben waited about ${wait.toLocaleString('en-US')} ms.`,
        nodes: ['API Server 2', 'Seat Free?', 'Buyer Ben'],
        data: `${ms(granted)}  lock granted → status='booked' → ROLLBACK\n→ 409 "Seat ${SEAT.seat} was just booked"`,
      },
    ],
    winners: ['Asha'],
  }
}

function optimistic(pause: boolean): Race {
  const first: Buyer = pause ? 'Ben' : 'Asha'
  const second: Buyer = pause ? 'Asha' : 'Ben'
  return {
    steps: [
      {
        text: `Both servers read the seat without locking. They see the same row, including its version number, ${START_VERSION}.`,
        nodes: ['API Server 1', 'API Server 2', 'Seats Table'],
        data: `${ms(1)}  API Server 1: SELECT status, version → free, version ${START_VERSION}\n${ms(3)}  API Server 2: SELECT status, version → free, version ${START_VERSION}${pause ? `\n${ms(2)} → ${ms(2 + PAUSE_MS)}  API Server 1 paused` : ''}`,
      },
      {
        text: `${PEOPLE[first].server} writes first, and only if the version is still ${START_VERSION}. It is, so the update succeeds and bumps the version to 8.`,
        nodes: [PEOPLE[first].server, 'Seats Table', 'Seat Free?'],
        data: `${ms(pause ? 5 : 4)}  UPDATE seats SET status='booked', user_id=${PEOPLE[first].id}, version=8\n         WHERE id=${SEAT.id} AND version=${START_VERSION}  → 1 row\n→ ${row('booked', first, 8)}`,
      },
      {
        text: `${PEOPLE[second].server} tries the same conditional write. The version is now 8, so it matches no row. It re-reads, sees the seat is booked, and tells ${second} it's gone. Nobody waited; the loser just retried and lost.`,
        nodes: [PEOPLE[second].server, 'Seats Table', PEOPLE[second].label],
        data: `${ms(pause ? 2 + PAUSE_MS + 2 : 6)}  UPDATE … WHERE id=${SEAT.id} AND version=${START_VERSION}  → 0 rows\nre-read → status='booked', version=8 → 409`,
      },
    ],
    winners: [first],
  }
}

function atomic(pause: boolean): Race {
  const first: Buyer = pause ? 'Ben' : 'Asha'
  const second: Buyer = pause ? 'Asha' : 'Ben'
  return {
    steps: [
      {
        text: `There's no separate read: the check and the write are one statement. ${pause ? `API Server 1 freezes for ${PAUSE_MS / 1000} s before sending it, so API Server 2's statement arrives first.` : "API Server 1's statement arrives first."} The database briefly locks the row while it applies it.`,
        nodes: [PEOPLE[first].server, 'Seats Table', 'Seat Free?'],
        data: `${ms(pause ? 3 : 1)}  UPDATE seats SET status='booked', user_id=${PEOPLE[first].id}\n         WHERE id=${SEAT.id} AND status='free'  → 1 row\n→ ${row('booked', first, START_VERSION)}`,
      },
      {
        text: `${PEOPLE[second].server} sends the same statement. If it arrived while the first was still running, it waited for the row lock and then re-checked the WHERE clause on the new row. Either way, status is no longer 'free', so it changes nothing.`,
        nodes: [PEOPLE[second].server, 'Seats Table', PEOPLE[second].label],
        data: `${ms(pause ? 2 + PAUSE_MS + 1 : 3)}  UPDATE … WHERE id=${SEAT.id} AND status='free'  → 0 rows → 409`,
      },
    ],
    winners: [first],
  }
}

/** Both Redis strategies: the same lock, with or without a fencing token checked by the database. */
function redis(pause: boolean, ttlMs: number, fenced: boolean): Race {
  const steps: Step[] = []
  let fence = START_FENCE
  const tokenFor: Partial<Record<Buyer, number>> = {}
  const acquire = (who: Buyer, t: number): Step => {
    if (fenced) tokenFor[who] = ++fence
    return {
      text: fenced
        ? `${PEOPLE[who].server} runs one Lua script: SET the lock only if nobody holds it (NX), with a ${ttlMs / 1000} s expiry (PX), and in the same step INCR the Fencing Counter. It gets the lock and token ${fence}.`
        : `${PEOPLE[who].server} takes the Redis Lock: SET only if nobody holds it (NX), expiring after ${ttlMs / 1000} s (PX), with its own random value so only it can release it.`,
      nodes: fenced ? [PEOPLE[who].server, 'Redis Lock', 'Fencing Counter'] : [PEOPLE[who].server, 'Redis Lock'],
      data: `${ms(t)}  SET ${LOCK_KEY} ${PEOPLE[who].lockValue} NX PX ${ttlMs}  → OK${fenced ? `\n${ms(t)}  INCR ${FENCE_KEY}  → ${fence}` : ''}`,
    }
  }
  const write = (who: Buyer, t: number, current: { fence: number }): { step: Step; ok: boolean } => {
    if (!fenced) {
      return {
        ok: true,
        step: {
          text: `${PEOPLE[who].server} writes the seat with a plain UPDATE. The database knows nothing about the Redis lock, so it checks nothing.`,
          nodes: [PEOPLE[who].server, 'Seats Table', 'Redis Lock'],
          data: `${ms(t)}  UPDATE seats SET status='booked', user_id=${PEOPLE[who].id} WHERE id=${SEAT.id}  → 1 row\n${ms(t + 1)}  release: delete ${LOCK_KEY} only if it still holds ${PEOPLE[who].lockValue}`,
        },
      }
    }
    const token = tokenFor[who]!
    const before = current.fence
    const ok = before < token
    if (ok) current.fence = token
    return {
      ok,
      step: {
        text: ok
          ? `${PEOPLE[who].server} writes with its token. The database accepts a write only from a token bigger than any it has seen (${before} < ${token}), so the update goes through and the row now remembers ${token}.`
          : `${PEOPLE[who].server} writes with its old token ${token}. The row has already seen ${before}, so fence < ${token} matches nothing. The stale write is rejected and ${who} is told the seat is gone, before any charge.`,
        nodes: [PEOPLE[who].server, 'Seats Table', 'Seat Free?'],
        data: `${ms(t)}  UPDATE seats SET status='booked', user_id=${PEOPLE[who].id}, fence=${token}\n         WHERE id=${SEAT.id} AND fence < ${token}  → ${ok ? '1 row' : '0 rows'}${ok ? `\n→ ${row('booked', who, START_VERSION, token)}` : ' → 409'}`,
      },
    }
  }

  steps.push(acquire('Asha', 1))
  steps.push({
    text: `API Server 2's SET NX finds the key taken, so it retries every ${RETRY_MS} ms. ${pause ? `After ${GIVE_UP_MS / 1000} s it gives up and tells Ben the seat is being booked.` : 'Its next try comes after Asha is done.'}`,
    nodes: ['API Server 2', 'Redis Lock', ...(pause ? ['Buyer Ben'] : [])],
    data: `${ms(3)}  SET ${LOCK_KEY} ${PEOPLE.Ben.lockValue} NX PX ${ttlMs}  → (nil), held by ${PEOPLE.Asha.lockValue}${pause ? `\n${ms(3 + GIVE_UP_MS)}  → 409 "Someone is booking ${SEAT.seat}, try again"` : ''}`,
  })
  steps.push({
    text: `API Server 1 reads the seat: free.${pause ? ` Then it freezes in a ${PAUSE_MS / 1000} s garbage-collection pause, still sure it holds the lock.` : ''}`,
    nodes: ['API Server 1', 'Seats Table', 'Seat Free?'],
    data: `${ms(2)}  SELECT status, fence FROM seats WHERE id=${SEAT.id} → ${row('free', null, START_VERSION)}${pause ? `\n${ms(3)} → ${ms(3 + PAUSE_MS)}  API Server 1 paused` : ''}`,
  })

  const current = { fence: START_FENCE }
  if (!pause) {
    steps.push(write('Asha', 4, current).step)
    const t = 3 + RETRY_MS
    if (fenced) tokenFor.Ben = ++fence
    steps.push({
      text: `API Server 2's next retry gets the lock${fenced ? ` (token ${fence})` : ''}, reads the seat, sees it's booked, releases the lock and tells Ben. One booking, and Ben waited about ${RETRY_MS} ms.`,
      nodes: ['API Server 2', 'Redis Lock', 'Seat Free?', 'Buyer Ben'],
      data: `${ms(t)}  SET ${LOCK_KEY} ${PEOPLE.Ben.lockValue} NX PX ${ttlMs} → OK\n${ms(t + 1)}  status='booked' → release → 409`,
    })
    return { steps, winners: ['Asha'] }
  }

  const expires = 1 + ttlMs
  const wakes = 3 + PAUSE_MS
  if (expires < BEN_AGAIN_MS) {
    // The lock runs out while API Server 1 is still paused.
    const again = acquire('Ben', BEN_AGAIN_MS)
    steps.push({
      text: `At ${(expires / 1000).toFixed(1)} s the ${ttlMs / 1000} s TTL runs out and Redis deletes the key, even though API Server 1 isn't finished. When Ben taps Book again, API Server 2 gets the lock.`,
      nodes: ['Redis Lock', 'Buyer Ben', 'API Server 2', ...(fenced ? ['Fencing Counter'] : [])],
      data: `${ms(expires)}  ${LOCK_KEY} expired\n${again.data}`,
    })
    const benWrite = write('Ben', BEN_AGAIN_MS + 3, current)
    steps.push({
      ...benWrite.step,
      text: `API Server 2 reads the seat (still free, because Asha's server never wrote) and books it for Ben. ${fenced ? benWrite.step.text.replace(/^API Server 2 writes with its token\. /, '') : 'Then it releases its lock.'}`,
    })
    const ashaWrite = write('Asha', wakes, current)
    steps.push({
      ...ashaWrite.step,
      text: `${ms(wakes).replace('t=', 'At ')}, API Server 1 wakes up, still sure it holds the lock. ${ashaWrite.step.text}${fenced ? '' : ` Its update overwrites Ben's booking, and its release finds the key is no longer ${PEOPLE.Asha.lockValue}, so it deletes nothing.`}`,
    })
    return { steps, winners: fenced ? ['Ben'] : ['Ben', 'Asha'] }
  }

  // The TTL outlasts the pause: the lock is still Asha's when Ben taps again.
  steps.push({
    text: `Ben taps Book again at ${(BEN_AGAIN_MS / 1000).toFixed(1)} s. The ${ttlMs / 1000} s TTL hasn't run out, so the key is still held and he's told to wait again.`,
    nodes: ['Buyer Ben', 'API Server 2', 'Redis Lock'],
    data: `${ms(BEN_AGAIN_MS)}  SET ${LOCK_KEY} ${PEOPLE.Ben.lockValue} NX PX ${ttlMs} → (nil)\nTTL left: ${((expires - BEN_AGAIN_MS) / 1000).toFixed(1)} s → 409`,
  })
  const ashaWrite = write('Asha', wakes, current)
  steps.push({ ...ashaWrite.step, text: `API Server 1 wakes up with the lock still its own. ${ashaWrite.step.text} It then releases the lock, and Ben's next try sees the seat is booked.` })
  return { steps, winners: ['Asha'] }
}

const simulator: Simulator = {
  fields: [
    { id: 'strategy', label: 'Locking strategy', options: [...STRATEGIES] },
    { id: 'pause', label: 'API Server 1', options: ['Runs normally', `Pauses ${PAUSE_MS / 1000} s mid-booking (GC)`] },
    { id: 'ttl', label: 'Redis lock TTL', options: ['10 s', '30 s'] },
    { id: 'unique', label: 'UNIQUE (show_id, seat_no) on bookings', options: ['Off', 'On'] },
  ],
  defaults: { strategy: 'Redis lock + fencing token', pause: `Pauses ${PAUSE_MS / 1000} s mid-booking (GC)`, ttl: '10 s', unique: 'Off' },
  run({ strategy, pause, ttl, unique }) {
    const paused = pause.startsWith('Pauses')
    const ttlMs = Number.parseInt(ttl, 10) * 1000
    const uniqueOn = unique === 'On'
    const s = STRATEGIES.find((x) => x === strategy) ?? STRATEGIES[5]
    const race =
      s === STRATEGIES[0]
        ? noLock(paused)
        : s === STRATEGIES[1]
          ? pessimistic(paused)
          : s === STRATEGIES[2]
            ? optimistic(paused)
            : s === STRATEGIES[3]
              ? atomic(paused)
              : redis(paused, ttlMs, s === STRATEGIES[5])

    const steps: Step[] = [
      {
        text: `Asha and Ben tap Book on the last seat, ${SEAT.seat}, within 3 ms of each other. Asha's request lands on API Server 1 and Ben's on API Server 2.`,
        nodes: ['Buyer Asha', 'Buyer Ben', 'API Server 1', 'API Server 2'],
        data: `${ms(0)}  POST /shows/${SEAT.show}/seats/${SEAT.seat}/book  {"user_id": ${PEOPLE.Asha.id}}  → API Server 1\n${ms(3)}  POST /shows/${SEAT.show}/seats/${SEAT.seat}/book  {"user_id": ${PEOPLE.Ben.id}}  → API Server 2\n${row('free', null, START_VERSION)}`,
      },
      ...race.steps,
    ]

    // Each server that thinks it won now records the booking and charges the card.
    const [first, second] = race.winners
    let verdict: string
    if (!second) {
      steps.push({
        text: `${first}'s server inserts the booking and charges the card. One seat, one booking, one charge.`,
        nodes: ['Bookings Table', PEOPLE[first].server, PEOPLE[first].label],
        data: `INSERT INTO bookings (show_id, seat_no, user_id) VALUES (${SEAT.show}, '${SEAT.seat}', ${PEOPLE[first].id})  → ok\n✓ ${SEAT.seat} → ${first}`,
      })
      verdict = `✓ ${first} gets ${SEAT.seat}`
    } else if (uniqueOn) {
      steps.push({
        text: `Both servers try to insert a booking. The UNIQUE (show_id, seat_no) index accepts the first and rejects the second, so ${second}'s whole transaction rolls back (its seat update too) before any charge. The constraint caught what the lock missed.`,
        nodes: ['Bookings Table', PEOPLE[first].server, PEOPLE[second].server],
        data: `INSERT … (${SEAT.show}, '${SEAT.seat}', ${PEOPLE[first].id})  → ok\nINSERT … (${SEAT.show}, '${SEAT.seat}', ${PEOPLE[second].id})  → ERROR 23505 duplicate key value violates unique constraint\n✓ ${SEAT.seat} → ${first}; ${second} gets 409, no charge`,
      })
      verdict = `✓ ${first} gets ${SEAT.seat} (the UNIQUE index stopped ${second})`
    } else {
      steps.push({
        text: `Both servers insert a booking and charge a card. Two people now hold tickets for ${SEAT.seat}. Turn on the UNIQUE index, or choose a strategy where the database checks the write, to stop this.`,
        nodes: ['Bookings Table', 'Buyer Asha', 'Buyer Ben'],
        data: `INSERT … (${SEAT.show}, '${SEAT.seat}', ${PEOPLE[first].id})  → ok, charged ₹450\nINSERT … (${SEAT.show}, '${SEAT.seat}', ${PEOPLE[second].id})  → ok, charged ₹450\n✗ double booking: Asha and Ben both paid for ${SEAT.seat}`,
      })
      verdict = '✗ double booking'
    }
    const short = s.split(/[:(]/)[0].trim()
    return { input: `${short}, ${paused ? `server 1 pauses ${PAUSE_MS / 1000} s` : 'no pause'}${s.startsWith('Redis') ? `, TTL ${ttl}` : ''}, unique index ${unique.toLowerCase()} → ${verdict}`, steps }
  },
}

export const locking: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'locking',
  title: 'Locking: Redis & Database',
  blurb: 'Shared, exclusive, update and intent locks, Redis locks with fencing, and when to use which',
  guides: [
    'what-are-the-differences-among-database-locks',
    'pessimistic-vs-optimistic-locking',
    'what-are-database-isolation-levels',
    'what-is-a-deadlock',
    'why-do-we-need-to-use-a-distributed-lock',
    'scale-how-to-do-distributed-locking',
    'scale-distributed-locking-at-uber',
    'scale-database-isolation-levels-and-effects-on-performance-and-scalability',
  ],
  takeaways: [
    'A lock turns check-then-act into one step: without it, two buyers both see "free" and both book.',
    'Shared locks allow many readers and exclusive locks allow one holder; update and intent locks exist to avoid upgrade deadlocks and row-by-row checks.',
    'When the data lives in one database, let the database decide: an atomic UPDATE … WHERE, a UNIQUE index, FOR UPDATE or a version check.',
    'Pessimistic locking makes others wait, optimistic locking makes the loser retry, and an atomic update does neither; pick by how often conflicts happen.',
    'A Redis lock coordinates what the database cannot see, but its TTL means a paused holder can lose the lock without knowing.',
    'Fencing tokens make that safe: every grant gets a bigger number, and the database rejects writes that carry an older one.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'app', label: 'API servers' },
      { id: 'redis', label: 'Redis' },
      { id: 'pg', label: 'Postgres' },
    ],
    nodes: [
      { id: 'asha', label: 'Buyer Asha', shape: 'ellipse', color: 'blue', group: null },
      { id: 'ben', label: 'Buyer Ben', shape: 'ellipse', color: 'blue', group: null },
      { id: 'api1', label: 'API Server 1', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'api2', label: 'API Server 2', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'lock', label: 'Redis Lock', shape: 'rectangle', color: 'red', group: 'redis' },
      { id: 'fence', label: 'Fencing Counter', shape: 'rectangle', color: 'red', group: 'redis' },
      { id: 'free', label: 'Seat Free?', shape: 'diamond', color: 'orange', group: 'pg' },
      { id: 'queue', label: 'Row Lock Queue', shape: 'rectangle', color: 'yellow', group: 'pg' },
      { id: 'seats', label: 'Seats Table', shape: 'rectangle', color: 'green', group: 'pg' },
      { id: 'bookings', label: 'Bookings Table', shape: 'rectangle', color: 'green', group: 'pg' },
    ],
    edges: [
      { from: 'asha', to: 'api1', label: 'book 14A', dashed: false },
      { from: 'ben', to: 'api2', label: 'book 14A', dashed: false },
      { from: 'api1', to: 'lock', label: 'SET NX PX', dashed: false },
      { from: 'api2', to: 'lock', label: 'retry', dashed: true },
      { from: 'lock', to: 'fence', label: 'INCR in same script', dashed: true },
      { from: 'api1', to: 'queue', label: 'SELECT … FOR UPDATE', dashed: false },
      { from: 'api2', to: 'queue', label: 'waits', dashed: true },
      { from: 'queue', to: 'seats', label: 'X lock on row 14A', dashed: false },
      { from: 'api1', to: 'free', label: 'check, then act', dashed: false },
      { from: 'api2', to: 'free', label: null, dashed: false },
      { from: 'free', to: 'seats', label: 'UPDATE … WHERE', dashed: false },
      { from: 'free', to: 'bookings', label: 'INSERT booking', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'shows',
        name: 'shows',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'starts_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'seats',
        name: 'seats',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'show_id', type: 'bigint', pk: false, fk: 'shows.id', nullable: false, unique: false },
          { name: 'seat_no', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: null, nullable: true, unique: false },
          { name: 'version', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'fence', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['UNIQUE (show_id, seat_no)'],
      },
      {
        id: 'bookings',
        name: 'bookings',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'show_id', type: 'bigint', pk: false, fk: 'shows.id', nullable: false, unique: false },
          { name: 'seat_no', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'payment_id', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['UNIQUE (show_id, seat_no)'],
      },
    ],
    relations: [
      { from: 'shows', to: 'seats', kind: 'one-to-many', label: 'has' },
      { from: 'shows', to: 'bookings', kind: 'one-to-many', label: 'sells' },
    ],
  },
  explanation: {
    title: 'Locking: Redis & Database',
    summary:
      'When two requests read the same thing and then change it, both can act on a value that is already out of date. A lock makes them take turns. Databases lock rows and tables for you; Redis can lock anything by name across many servers, but only for a limited time.',
    sections: [
      {
        heading: 'Overview',
        body: 'Two buyers tap Book on the last seat at the same moment. Each server checks "is it free?" and then writes "booked". If nothing stops them, both checks pass before either write lands, and the seat is sold twice. This is a race condition, and the gap between the check and the write is where it lives.\n\nA lock closes that gap. A shared lock lets many readers in but no writer. An exclusive lock gives one holder mutual exclusion: everyone else waits. The question in every design is where that lock lives: in the database next to the data, or in Redis, where many servers can use it for anything.\n\nThe simulator replays the race under six strategies. Try a Redis lock with a 12 second pause on API Server 1 and a 10 second TTL to watch a double booking happen, then add a fencing token.',
      },
      {
        heading: 'Requirements',
        body: '- A seat is sold at most once, even when thousands of people tap Book at the same time.\n- The loser hears "sold out" quickly, and is never charged.\n- A seat can be held for 10 minutes while the buyer pays.\n- A server that pauses or crashes mid-booking can never cause a double booking.\n- Survive the loss of one Redis node: the worst case is a slower booking, never a wrong one.\n- No request waits more than about 2 seconds for a lock.',
      },
      {
        heading: 'Capacity estimates',
        body: '- A big release: 200,000 buyers in the first 60 seconds → 200,000 ÷ 60 ≈ 3,333 booking attempts a second.\n- 5,000 seats → 200,000 ÷ 5,000 = 40 attempts per seat on average.\n- With FOR UPDATE held for 5 ms, one seat row can serve 1,000 ÷ 5 = 200 attempts a second; the 40th buyer on a hot seat waits about 40 × 5 = 200 ms.\n- Waiting holds a database connection. By Little\'s law, 3,333 requests a second × 0.1 s average wait ≈ 333 connections busy at once, more than a typical pool of 100. That is why hot paths use an atomic update (no waiting) or a Redis gate in front.\n- Redis handles around 100,000 simple commands a second on one node, so 3,333 SET NX a second is about 3% of one node.',
      },
      {
        heading: 'Step by step',
        body: '1. Buyer Asha and Buyer Ben tap Book on seat 14A within 3 ms. API Server 1 and API Server 2 receive the requests.\n2. API Server 1 runs one Lua script on the Redis Lock: SET NX PX with a 10 s TTL, and in the same step INCR the Fencing Counter. It gets token 41.\n3. API Server 2\'s SET NX fails. It retries for 2 s, then tells Buyer Ben the seat is being booked.\n4. API Server 1 reads the Seats Table, Seat Free? says yes, and then it freezes in a 12 s garbage-collection pause.\n5. At 10 s the Redis Lock key expires. Ben taps again, and API Server 2 gets the lock with token 42.\n6. API Server 2 writes the Seats Table with fence 42 (WHERE fence < 42), inserts into the Bookings Table, and Ben has the seat.\n7. API Server 1 wakes at 12 s and writes with token 41. WHERE fence < 41 matches nothing, so the stale write is rejected, and Buyer Asha is told the seat is gone without being charged.',
      },
      {
        heading: 'Components',
        body: '- Buyer Asha: taps Book on seat 14A; her request lands on API Server 1.\n- Buyer Ben: taps Book on the same seat 3 ms later; his request lands on API Server 2.\n- API Server 1: books the seat for Asha with the chosen strategy; in the simulator it can pause mid-booking.\n- API Server 2: books the seat for Ben; it retries the Redis lock every 200 ms for up to 2 s.\n- Redis Lock: the key lock:seat:311:14A, set with SET NX PX and a random value; whoever sets it may book, until the TTL runs out.\n- Fencing Counter: a Redis counter increased in the same Lua script that grants the lock, so every new holder gets a bigger token.\n- Seat Free?: the check-then-act decision; the race lives here unless the check and the write are protected together.\n- Row Lock Queue: transactions waiting for a row lock taken by SELECT … FOR UPDATE; each one holds a database connection while it waits.\n- Seats Table: one row per seat with status, user_id, version and fence; the row everyone fights over.\n- Bookings Table: one row per confirmed booking; a UNIQUE (show_id, seat_no) index makes a second booking impossible.',
      },
      {
        heading: 'Lock modes',
        body: '- Shared (S): many readers at once, no writer. SELECT … FOR SHARE.\n- Exclusive (X): mutual exclusion, one holder only. SELECT … FOR UPDATE, every UPDATE and DELETE, a Redis SET NX lock.\n- Update (U): "reading now, will probably write". It works alongside S but not alongside another U, so two readers can\'t deadlock while both upgrade to X. SQL Server has it (WITH (UPDLOCK)); in Postgres and MySQL you take X up front with FOR UPDATE.\n- Intent shared (IS) and intent exclusive (IX): a mark on the table saying "I hold S (or X) locks on rows inside". A request to lock the whole table checks these marks in one step instead of scanning every row lock.\n- Shared with intent exclusive (SIX): reading the whole table while changing some rows.\n\nWhich can be held together:\n- IS works with IS, S, U, IX and SIX; it conflicts only with X.\n- S works with IS, S and U; it conflicts with IX, SIX and X.\n- U works with IS and S; it conflicts with U, IX, SIX and X.\n- IX works with IS and IX; it conflicts with S, U, SIX and X.\n- SIX works only with IS.\n- X conflicts with everything.\n\nIn Postgres and MySQL InnoDB, a plain SELECT takes no row lock at all: it reads a snapshot (MVCC). So FOR UPDATE blocks other locking reads and writes, but not ordinary reads. Postgres row locks come in four strengths: FOR KEY SHARE (taken by foreign-key checks), FOR SHARE, FOR NO KEY UPDATE (a normal UPDATE) and FOR UPDATE (a DELETE, or a change to a key column). InnoDB also takes gap and next-key locks, which lock the space between index entries so no phantom rows can be inserted under REPEATABLE READ.',
      },
      {
        heading: 'Key decisions',
        body: '- Let the database decide when the data lives there. An atomic UPDATE … WHERE status = \'free\', a UNIQUE index, FOR UPDATE or a version check all run in the same transaction as the data, and their locks are released automatically if the server dies.\n- Pessimistic (FOR UPDATE): best when conflicts are common or the logic has several steps. Lock late, commit early, and never call another service while holding the lock. NOWAIT fails fast; SKIP LOCKED lets job workers take different rows.\n- Optimistic (WHERE version = ?): best when conflicts are rare, like profile or document edits. Nobody waits, but the loser must retry, which is wasteful under heavy contention.\n- Atomic update: the check and the write are one statement, so there is nothing to race. Use it whenever the rule fits in one WHERE clause.\n- Redis lock: use it for work the database can\'t see, like running a cron job once across 10 pods, calling a payment provider once, rebuilding a cache entry once, or holding a seat for 10 minutes. Set it with SET key random-value NX PX ttl, and release it only if the value is still yours (a Lua script, DELEX … IFEQ in Redis 8.4+, or DELIFEQ in Valkey 9).\n- TTL: long enough for the work, and renewed by a watchdog while the work runs (Redisson renews every 10 s with a 30 s lease). A pause can always outlast it, which is why correctness needs fencing.\n- Fencing token: grant it in the same atomic step as the lock, store the highest one seen next to the data, and reject writes with WHERE fence < token. etcd revisions and ZooKeeper zxids are natural fencing tokens.\n- Efficiency or correctness: if a lock failure only means some work is done twice, a single Redis node is fine. If it means wrong data, the database (constraint, conditional write, fence) must have the final word.\n- Isolation levels: Read Committed, the default in Postgres, SQL Server and Oracle, allows lost updates when you read a value and write it back. Postgres Repeatable Read raises a serialization error instead. MySQL\'s default Repeatable Read still allows it unless you use FOR UPDATE or SET x = x - 1. Write skew (two transactions change different rows and together break a rule) needs SERIALIZABLE, or FOR UPDATE on every row the rule reads.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Hot rows: one row can take only so many lock hand-offs a second. Put a gate in front (Redis DECR for a flash-sale count, or a hold) so most losers never reach the database, and keep the final atomic UPDATE or UNIQUE index as the guarantee.\n- Deadlocks: two transactions lock the same rows in opposite orders. InnoDB detects this at once and rolls one back; Postgres checks after deadlock_timeout (1 s by default). Always lock rows in key order, and retry the victim.\n- A paused or crashed holder: a database lock is released when its connection ends; a Redis lock only when its TTL runs out. Either way, a holder that wakes up late must be fenced.\n- Redis failover: replication is asynchronous, so a primary can grant a lock and die before the replica hears of it. The promoted replica then grants it again. Redlock (a majority of 5 nodes) narrows the window but depends on timing and gives no fencing token.\n- Redis down: fall back to the database-only path (the atomic update is still correct, just slower), and don\'t silently skip the lock.\n- Lock escalation: SQL Server turns about 5,000 row locks on one table, in one statement, into a single table lock; batch big updates. Postgres and InnoDB don\'t escalate.\n- Schema changes: ALTER TABLE needs Postgres\'s strongest table lock, waits behind long queries, and blocks everything queued after it. Set lock_timeout and retry.\n- Connection pools: a session-level advisory lock behind a transaction-pooling proxy stays on a connection someone else gets next; use pg_advisory_xact_lock.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why do databases need intent locks, and what would a whole-table lock cost without them?\n- What deadlock does an update (U) lock prevent?\n- Does SELECT … FOR UPDATE block a plain SELECT in Postgres? Why not?\n- You use a Redis lock to stop double booking. A server pauses longer than the TTL. What happens, and how do fencing tokens fix it?\n- When is Redlock good enough, and when would you use etcd, ZooKeeper or the database instead?\n- 200,000 buyers and 5,000 seats in one minute: where do you lock, and how many database connections would waiting cost?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Redis lock with a fencing token (Node.js)',
        language: 'javascript',
        source: `import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'

const redis = new Redis()

// Grant the lock and the token in one atomic step, or a late INCR could
// hand an old holder a bigger number than the new one.
const ACQUIRE = \`
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  return redis.call('INCR', KEYS[2])
end
return 0\`

// Delete the lock only if it is still ours (it may have expired and moved on).
const RELEASE = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0\`

export async function withSeatLock(seatKey, ttlMs, work) {
  const owner = randomUUID()
  const token = await redis.eval(ACQUIRE, 2, \`lock:\${seatKey}\`, \`fence:\${seatKey}\`, owner, ttlMs)
  if (token === 0) return { busy: true }
  try {
    return await work(token) // pass the token to every write
  } finally {
    await redis.eval(RELEASE, 1, \`lock:\${seatKey}\`, owner)
  }
}`,
      },
      {
        title: 'Let the database have the final word (SQL)',
        language: 'sql',
        source: `-- 1. Atomic: the check and the write are one statement.
UPDATE seats SET status = 'booked', user_id = 1201
WHERE id = 9041 AND status = 'free';           -- 0 rows = sold out

-- 2. Fenced: an older lock holder's write changes nothing.
UPDATE seats SET status = 'booked', user_id = 1388, fence = 42
WHERE id = 9041 AND fence < 42;

-- 3. The constraint no race can get past.
CREATE UNIQUE INDEX bookings_one_per_seat ON bookings (show_id, seat_no);
INSERT INTO bookings (show_id, seat_no, user_id, payment_id)
VALUES (311, '14A', 1388, 'pay_9Qx2');          -- a second one fails: 23505`,
      },
      {
        title: 'Pessimistic and optimistic (SQL)',
        language: 'sql',
        source: `-- Pessimistic: take the row's exclusive lock first; others queue.
BEGIN;
SELECT status FROM seats WHERE id = 9041 FOR UPDATE;   -- or FOR UPDATE NOWAIT
UPDATE seats SET status = 'booked', user_id = 1201, version = version + 1
WHERE id = 9041;
COMMIT;                                               -- releases the lock

-- Optimistic: no lock; the write only lands if nobody changed the row.
SELECT status, version FROM seats WHERE id = 9041;      -- free, version 7
UPDATE seats SET status = 'booked', user_id = 1388, version = 8
WHERE id = 9041 AND version = 7;                        -- 0 rows → re-read, retry

-- Job queues: each worker takes a different row instead of waiting.
SELECT id FROM jobs WHERE state = 'ready'
ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;`,
      },
      {
        title: 'Lock modes you can ask for (SQL)',
        language: 'sql',
        source: `-- Postgres row locks, weakest to strongest
SELECT * FROM seats WHERE id = 9041 FOR KEY SHARE;     -- what a foreign key check takes
SELECT * FROM seats WHERE id = 9041 FOR SHARE;         -- shared (S): readers only
SELECT * FROM seats WHERE id = 9041 FOR NO KEY UPDATE; -- what a normal UPDATE takes
SELECT * FROM seats WHERE id = 9041 FOR UPDATE;        -- exclusive (X)

-- SQL Server: update (U) lock, so two readers can't deadlock upgrading
SELECT status FROM seats WITH (UPDLOCK, ROWLOCK) WHERE id = 9041;

-- Whole table (needs no intent locks held by others)
LOCK TABLE seats IN SHARE MODE;

-- A named lock for "run this job once" (Postgres, released at COMMIT)
SELECT pg_try_advisory_xact_lock(hashtext('job:nightly-report'));

-- Don't let a schema change stall the table
SET lock_timeout = '3s';`,
      },
    ],
    related: ['MVCC', 'Isolation levels', 'Deadlocks', 'Fencing tokens', 'Redlock', 'Idempotency keys'],
  },
  simulator,
}
