import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A Snowflake-style ID service: 64 bits = 1 unused sign bit + 41 bits of
// milliseconds since a custom epoch + 5 bits datacenter + 5 bits worker + 12 bits
// sequence. The simulator builds the real IDs with BigInt, so the numbers on
// screen are the ones the formula produces.

const EPOCH = 1_735_689_600_000n // 2025-01-01T00:00:00Z, our custom epoch
const NOW = BigInt(Date.parse('2026-03-14T09:26:53.589Z')) // fixed so the example is stable
const SEQ_MAX = 4096 // 2^12 IDs per millisecond per worker

const WORKERS = {
  'DC1 · Worker 1': { label: 'ID Worker · DC1/W1', dc: 1n, worker: 1n },
  'DC1 · Worker 2': { label: 'ID Worker · DC1/W2', dc: 1n, worker: 2n },
  'DC2 · Worker 3': { label: 'ID Worker · DC2/W3', dc: 2n, worker: 3n },
} as const

const GUARD = 'Clock Check (never go back)'
const SEQ = 'Sequence Counter (12 bits)'

/** Builds an ID from its parts, exactly as the worker does. */
export const makeId = (ms: bigint, machine: bigint, seq: bigint) => ((ms - EPOCH) << 22n) | (machine << 12n) | seq

const bits = (id: bigint) => {
  const b = id.toString(2).padStart(64, '0')
  return `${b[0]} ${b.slice(1, 42)} ${b.slice(42, 47)} ${b.slice(47, 52)} ${b.slice(52)}`
}

const simulator: Simulator = {
  fields: [
    { id: 'worker', label: 'Worker that answers', options: Object.keys(WORKERS) },
    { id: 'burst', label: 'IDs asked for in one millisecond', options: ['1 ID', '3 IDs', '5,000 IDs'] },
    { id: 'clock', label: 'The server clock', options: ['Runs normally', 'Steps back 5 ms (NTP fix)', 'Steps back 2 seconds'] },
  ],
  defaults: { worker: 'DC1 · Worker 1', burst: '3 IDs', clock: 'Runs normally' },
  run({ worker, burst, clock }) {
    const w = WORKERS[worker as keyof typeof WORKERS] ?? WORKERS['DC1 · Worker 1']
    const label = w.label
    const machine = (w.dc << 5n) | w.worker
    const count = Number(burst.replace(/\D/g, '')) || 1
    const back = clock.includes('2 seconds') ? 2000n : clock.includes('5 ms') ? 5n : 0n
    const iso = (ms: bigint) => new Date(Number(ms)).toISOString().slice(11, 23)

    const steps: Trace['steps'] = [
      {
        text: `The Order Service needs ${count === 1 ? 'a new order id' : `${count.toLocaleString()} new order ids`}. It asks the ID service over the network, so no database has to hand out a counter.`,
        nodes: ['Client (Order Service)', 'Load Balancer'],
        data: `GET /ids?count=${count}`,
      },
      {
        text: `The load balancer picks ${label}. At boot, this worker leased its number from the registry, so no other worker can share it: datacenter ${w.dc}, worker ${w.worker}, which makes machine id ${machine}.`,
        nodes: ['Load Balancer', label, 'Worker Registry (etcd)'],
        data: `lease /id-workers/${machine} → ttl 30s, renewed every 10s\ndatacenter = ${w.dc} = ${w.dc.toString(2).padStart(5, '0')}\nworker     = ${w.worker} = ${w.worker.toString(2).padStart(5, '0')}\nmachine id = (${w.dc} << 5) | ${w.worker} = ${machine}`,
      },
    ]

    let ms = NOW
    let lastMs = NOW
    if (back > 0n) {
      // The worker last issued an ID at NOW; the clock now reads NOW - back.
      steps.push({
        text: `The worker reads its clock: ${back > 1000n ? '2 seconds' : '5 ms'} earlier than the last ID it issued. NTP just corrected the clock backwards. If the worker used this time, it could repeat an ID it already handed out.`,
        nodes: [label, GUARD],
        data: `last_ms  = ${iso(lastMs)}\nnow_ms   = ${iso(NOW - back)}   ← behind by ${back} ms`,
      })
      if (back > 100n) {
        steps.push(
          {
            text: 'A jump this big is too long to wait out, and nobody should trust a clock that jumped 2 seconds. The worker refuses to issue IDs and raises an alert; the load balancer sends traffic to the other workers.',
            nodes: [GUARD, 'Clock Drift Alert', 'NTP Time Source'],
            data: `if (lastMs - now > MAX_WAIT_MS /* 100 */) throw new ClockMovedBackwards(${back})\nalert: ${label} clock drift ${back} ms\nhealth check → 503, removed from rotation`,
          },
          {
            text: 'The client retries and a healthy worker answers. A few seconds of lost capacity is far better than a duplicate primary key.',
            nodes: ['Load Balancer', 'Client (Order Service)'],
            data: 'HTTP 503 → retry → another worker → 200 with ids',
          },
        )
        return { input: `${count} IDs from ${worker}, clock back 2 s`, steps }
      }
      steps.push({
        text: `A small step back can be waited out. The worker spins for ${back} ms until the clock passes the last timestamp it used, then goes on. IDs are never reused and still increase.`,
        nodes: [GUARD, 'NTP Time Source'],
        data: `wait ${back} ms until now_ms ≥ last_ms\nnow_ms = ${iso(lastMs)} ✓`,
      })
    } else {
      steps.push({
        text: 'The worker reads its clock. It is at or ahead of the last timestamp used, so it is safe to carry on.',
        nodes: [label, GUARD],
        data: `last_ms = ${iso(lastMs)}\nnow_ms  = ${iso(NOW)} ✓ (NTP keeps drift in the low milliseconds)`,
      })
    }

    // Sequence numbers: 4,096 fit in one millisecond, the rest spill into the next.
    const inFirst = Math.min(count, SEQ_MAX)
    const spill = count - inFirst
    const first = makeId(ms, machine, 0n)
    const lastInFirst = makeId(ms, machine, BigInt(inFirst - 1))
    steps.push({
      text:
        spill === 0
          ? `${count === 1 ? 'This is the first request in this millisecond' : `All ${count} requests land in the same millisecond`}, so the sequence counter gives ${count === 1 ? '0' : `0 to ${count - 1}`}. It resets to 0 whenever the millisecond changes.`
          : `Within one millisecond the 12-bit counter only has ${SEQ_MAX.toLocaleString()} values (0 to ${SEQ_MAX - 1}). The first ${SEQ_MAX.toLocaleString()} requests use them all; the other ${spill.toLocaleString()} must wait for the next millisecond.`,
      nodes: [label, SEQ],
      data:
        spill === 0
          ? `ms ${iso(ms)} → sequence 0 … ${count - 1}`
          : `ms ${iso(ms)} → sequence 0 … ${SEQ_MAX - 1}  (counter full)\nwait 1 ms → ms ${iso(ms + 1n)} → sequence 0 … ${spill - 1}`,
    })

    steps.push({
      text: `The worker packs the parts into one 64-bit number: time since our 2025-01-01 epoch, then machine id ${machine}, then the sequence. The time bits come first, so a later ID is always a bigger number.`,
      nodes: [label],
      data: `ms since epoch = ${ms - EPOCH}\n${bits(first)}\n0 | 41 bits time | 5 dc | 5 worker | 12 seq\n= ${first}`,
    })

    const secondMs = ms + 1n
    const ids = spill === 0 ? [first, count > 1 ? makeId(ms, machine, BigInt(count - 1)) : null] : [lastInFirst, makeId(secondMs, machine, 0n)]
    steps.push({
      text:
        spill === 0
          ? `The ids come back as strings. JavaScript numbers lose precision above 2^53, and these are about 2^57, so a JSON number would silently corrupt them.`
          : `The ${count.toLocaleString()} ids come back as strings, in increasing order: the last of the first millisecond is ${lastInFirst}, and the next one is ${ids[1]}. JavaScript numbers lose precision above 2^53, so they must be strings.`,
      nodes: [label, 'Client (Order Service)'],
      data: json({ ids: ids.filter((x) => x !== null).map(String), count }),
    })

    steps.push({
      text: 'The order is saved with its id as the primary key. Because ids grow with time, new rows go to the end of the B-tree index (no random page splits), and sorting by id is sorting by creation time.',
      nodes: ['Client (Order Service)', 'Orders DB (sharded by id)'],
      data: `INSERT INTO orders (id, user_id, amount_inr) VALUES (${first}, 8841, 1499);\ncreated at = ${new Date(Number((first >> 22n) + EPOCH)).toISOString()}  (decoded from the id)`,
    })
    return { input: `${count.toLocaleString()} ID${count > 1 ? 's' : ''} from ${worker}${back ? `, clock back ${back} ms` : ''}`, steps }
  },
}

export const uniqueIdGenerator: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'unique-id-generator',
  title: 'Unique ID Generator (Snowflake)',
  blurb: 'Time-sorted 64-bit ids from many machines, with no coordination and no duplicates',
  guides: [
    'unique-id-generator',
    'explaining-5-unique-id-generators-in-distributed-systems',
    'scale-sharding--ids-at-instagram',
    'top-4-data-sharding-algorithms-explained',
    'scale-clock-skew-when-syncing-password-payloads-at-drobbox',
  ],
  takeaways: [
    'A Snowflake id is 41 bits of time, 10 bits of machine and 12 bits of sequence, so no two machines can make the same id.',
    'Time sits in the top bits, so ids sort by creation time and inserts hit the end of the index.',
    'One worker can make 4,096 ids per millisecond (about 4 million a second); 1,024 workers give over 4 billion a second.',
    'The weak spot is the clock: if it goes backwards, wait it out when small and refuse when large.',
    'Worker numbers must be unique: lease them from a registry instead of setting them by hand.',
    'Return ids as strings, because JavaScript numbers lose precision above 2^53.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'ids', label: 'ID service' }],
    nodes: [
      { id: 'client', label: 'Client (Order Service)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'lb', label: 'Load Balancer', shape: 'rectangle', color: 'violet', group: null },
      { id: 'w1', label: 'ID Worker · DC1/W1', shape: 'rectangle', color: 'violet', group: 'ids' },
      { id: 'w2', label: 'ID Worker · DC1/W2', shape: 'rectangle', color: 'violet', group: 'ids' },
      { id: 'w3', label: 'ID Worker · DC2/W3', shape: 'rectangle', color: 'violet', group: 'ids' },
      { id: 'guard', label: GUARD, shape: 'diamond', color: 'violet', group: 'ids' },
      { id: 'seq', label: SEQ, shape: 'rectangle', color: 'orange', group: 'ids' },
      { id: 'registry', label: 'Worker Registry (etcd)', shape: 'rectangle', color: 'green', group: null },
      { id: 'ntp', label: 'NTP Time Source', shape: 'cloud', color: 'blue', group: null },
      { id: 'alert', label: 'Clock Drift Alert', shape: 'rectangle', color: 'red', group: null },
      { id: 'db', label: 'Orders DB (sharded by id)', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'client', to: 'lb', label: 'GET /ids', dashed: false },
      { from: 'lb', to: 'w1', label: 'round robin', dashed: false },
      { from: 'lb', to: 'w2', label: 'round robin', dashed: false },
      { from: 'lb', to: 'w3', label: 'round robin', dashed: false },
      { from: 'registry', to: 'w1', label: 'lease worker id', dashed: true },
      { from: 'registry', to: 'w2', label: 'lease worker id', dashed: true },
      { from: 'registry', to: 'w3', label: 'lease worker id', dashed: true },
      { from: 'w1', to: 'guard', label: 'read clock', dashed: false },
      { from: 'w2', to: 'guard', label: 'read clock', dashed: false },
      { from: 'w3', to: 'guard', label: 'read clock', dashed: false },
      { from: 'ntp', to: 'guard', label: 'sync time', dashed: true },
      { from: 'guard', to: 'seq', label: 'time is safe', dashed: false },
      { from: 'guard', to: 'alert', label: 'big jump back', dashed: true },
      { from: 'client', to: 'db', label: 'INSERT with id', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'orders',
        name: 'orders',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'amount_inr', type: 'numeric(12,2)', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'id_workers',
        name: 'id_workers (kept in etcd)',
        columns: [
          { name: 'machine_id', type: 'int (0–1023)', pk: true, fk: null, nullable: false, unique: false },
          { name: 'host', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'lease_expires_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'last_ms', type: 'bigint', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [],
  },
  explanation: {
    title: 'Unique ID Generator (Snowflake)',
    summary:
      'Every row needs an id that nobody else will ever use, even when many servers create rows at the same time. A Snowflake-style generator packs the time, the machine and a counter into one 64-bit number, so each machine can make ids alone, with no database and no talking to the others.',
    sections: [
      {
        heading: 'Overview',
        body: 'A single database can hand out ids with AUTO_INCREMENT. That stops working when you shard the data or run several databases: two shards would both create id 1001. Asking one central counter for every id makes that counter a bottleneck and a single point of failure.\n\nThe Snowflake idea (from Twitter) is to build the id from parts that cannot collide. The top bits are a timestamp, the middle bits say which machine made it, and the low bits count the ids made by that machine in the same millisecond. Two machines differ in the machine bits; one machine differs in the time or the counter.\n\nThe layout: 1 sign bit (always 0, so the id stays positive) + 41 bits of milliseconds since a custom epoch + 5 bits datacenter + 5 bits worker + 12 bits sequence = 64 bits.',
      },
      {
        heading: 'Requirements',
        body: '- Ids are unique across all machines and datacenters.\n- Ids fit in 64 bits, so they are small in indexes and work as a normal bigint column.\n- Ids roughly sort by time, so "newest first" needs no extra column.\n- Making an id is fast and needs no network call to a shared counter.\n- It keeps working when a datacenter or a worker is down.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Time: 41 bits is 2^41 = 2,199,023,255,552 ms, about 69.7 years from the custom epoch. Starting the epoch in 2025 means the ids run out in 2094.\n- One worker: 12 bits of sequence is 4,096 ids per millisecond, which is 4,096,000 per second.\n- All workers: 10 machine bits is 1,024 workers, so 4,194,304,000 ids per second in total, far more than any app needs.\n- Example load: 50,000 orders per second is 4.32 billion ids a day. One worker at 4,096,000 per second would be about 1.2% busy; three workers give redundancy, not speed.\n- Storage: 8 bytes per id. 50,000 per second for 5 years is about 7.9 × 10^12 ids, roughly 63 TB of ids alone, which is why a small id matters (a 16-byte UUID would double it).',
      },
      {
        heading: 'Step by step',
        body: '1. The Client (Order Service) asks for ids with GET /ids.\n2. The Load Balancer sends the call to one worker: ID Worker · DC1/W1, ID Worker · DC1/W2 or ID Worker · DC2/W3.\n3. Each worker leased its datacenter and worker numbers from the Worker Registry (etcd) when it started.\n4. The worker reads its clock and checks it with Clock Check (never go back): the time must not be earlier than the last id.\n5. A small step back is waited out; a big one makes the worker stop and raise a Clock Drift Alert.\n6. The Sequence Counter (12 bits) counts ids in the same millisecond and resets when the millisecond changes. If it hits 4,096 the worker waits for the next millisecond.\n7. The worker joins time, machine id and sequence into a 64-bit id and returns it as a string.\n8. The Client saves the row in Orders DB (sharded by id) with that id as the primary key.',
      },
      {
        heading: 'Components',
        body: '- Client (Order Service): asks for ids and writes rows that use them.\n- Load Balancer: spreads requests over the workers and removes a worker that fails its health check.\n- ID Worker · DC1/W1: makes ids with datacenter 1, worker 1 (machine id 33).\n- ID Worker · DC1/W2: same code with datacenter 1, worker 2 (machine id 34).\n- ID Worker · DC2/W3: same code in a second datacenter (machine id 67).\n- Clock Check (never go back): compares the clock to the last timestamp used and waits or refuses if time went backwards.\n- Sequence Counter (12 bits): counts 0 to 4,095 within one millisecond, then resets.\n- Worker Registry (etcd): gives each worker a unique machine id through a lease that expires if the worker dies.\n- NTP Time Source: keeps the servers\' clocks close to real time.\n- Clock Drift Alert: tells the team when a worker\'s clock jumped, before it causes trouble.\n- Orders DB (sharded by id): stores rows; ids that grow with time keep inserts at the end of the index.',
      },
      {
        heading: 'Key decisions',
        body: '- Snowflake vs UUID: a UUID v4 needs no setup but is 128 bits and random, so inserts scatter across the index. UUID v7 is time-ordered and a good choice when 128 bits is fine.\n- Snowflake vs a database ticket server: a ticket server (one table with AUTO_INCREMENT) is simple but every id costs a network call and the server is a bottleneck. Batching ranges helps but loses time order.\n- Custom epoch: counting from your launch date instead of 1970 gives you the full 69 years.\n- Bit split: 5 + 5 machine bits is 1,024 workers. A small company might use 3 machine bits and give 8 more bits to the sequence.\n- Order: ids are sorted by time only roughly. Two workers in the same millisecond order by machine id, not by real order, so don\'t rely on exact ordering across workers.\n- Returning ids: send them as strings in JSON.',
      },
      {
        heading: 'Scaling and failure',
        body: '- More ids: add workers (up to 1,024). Each one works alone, so throughput grows in a straight line.\n- Clock moves backwards: wait if it is a few milliseconds, refuse and alert if it is larger. Persisting the last timestamp lets a restarted worker avoid reusing time it already used.\n- Two workers with the same machine id would make duplicates. The registry lease prevents this; a new worker may only start once it holds a unique lease.\n- A worker dies: the lease expires and the number can be reused after the lease time passes (longer than any clock skew).\n- Leap seconds: smear them (spread over hours) so the clock never repeats a second.\n- The ids reveal when they were made and roughly how many exist. If that is sensitive, expose a different public id.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What happens if the system clock goes backwards, and how do you stop duplicate ids?\n- How would you hand out machine ids without setting them by hand?\n- Why can\'t you sort strictly by id across workers to get the real order of events?\n- How would you change the bit layout for a system that needs 100,000 workers, or one that needs 50,000 ids per millisecond?\n- When would you pick UUID v7 or a ticket server over Snowflake?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Snowflake generator (TypeScript, BigInt)',
        language: 'typescript',
        source: `const EPOCH = 1735689600000n // 2025-01-01, our own epoch
const MAX_WAIT_MS = 100n

export class Snowflake {
  private lastMs = -1n
  private seq = 0n
  constructor(private machineId: bigint) {} // 0..1023, leased from the registry

  next(): string {
    let now = BigInt(Date.now())
    if (now < this.lastMs) {
      // Clock went backwards: wait if small, refuse if large.
      if (this.lastMs - now > MAX_WAIT_MS) throw new Error('clock moved backwards')
      while (now < this.lastMs) now = BigInt(Date.now())
    }
    if (now === this.lastMs) {
      this.seq = (this.seq + 1n) & 0xfffn // 12 bits
      if (this.seq === 0n) while (now <= this.lastMs) now = BigInt(Date.now()) // full: next ms
    } else {
      this.seq = 0n
    }
    this.lastMs = now
    // Strings, not numbers: ids above 2^53 lose precision in JSON.
    return (((now - EPOCH) << 22n) | (this.machineId << 12n) | this.seq).toString()
  }
}`,
      },
      {
        title: 'Take a worker id with an etcd lease (Go)',
        language: 'go',
        source: `// Try each machine id until one is free; the lease frees it if we crash.
lease, _ := cli.Grant(ctx, 30) // 30 s, renewed with KeepAlive
cli.KeepAlive(ctx, lease.ID)
for id := 0; id < 1024; id++ {
\tkey := fmt.Sprintf("/id-workers/%d", id)
\tres, _ := cli.Txn(ctx).
\t\tIf(clientv3.Compare(clientv3.CreateRevision(key), "=", 0)). // only if nobody holds it
\t\tThen(clientv3.OpPut(key, hostname, clientv3.WithLease(lease.ID))).
\t\tCommit()
\tif res.Succeeded {
\t\treturn id
\t}
}`,
      },
      {
        title: 'Decode an id back into its parts (Python)',
        language: 'python',
        source: `EPOCH_MS = 1735689600000

def decode(id_: int):
    return {
        "created_ms": (id_ >> 22) + EPOCH_MS,   # top 41 bits
        "datacenter": (id_ >> 17) & 0x1F,       # next 5
        "worker": (id_ >> 12) & 0x1F,           # next 5
        "sequence": id_ & 0xFFF,                # last 12
    }

print(decode(158506160599736320))
# {'created_ms': 1773480413589, 'datacenter': 1, 'worker': 2, 'sequence': 0}`,
      },
      {
        title: 'Sorting by id is sorting by time',
        language: 'sql',
        source: `-- The newest 20 orders, with no created_at column needed.
SELECT id, user_id, amount_inr
FROM orders
ORDER BY id DESC
LIMIT 20;

-- Orders from one day: turn the time into an id range.
-- (ms since epoch) << 22 is the first possible id in that millisecond.
SELECT count(*) FROM orders
WHERE id >= ((1773446400000 - 1735689600000) << 22)
  AND id <  ((1773532800000 - 1735689600000) << 22);`,
      },
    ],
    related: ['UUID v7', 'Ticket server', 'Clock synchronisation', 'Database sharding', 'Lease'],
  },
  simulator,
}
