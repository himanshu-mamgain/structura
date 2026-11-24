import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge (queue semantics as in Amazon SQS and
// RabbitMQ), not adapted from a source. The simulator replays one message through the
// queue's rules, so every time, receive count and charge count it shows is computed.

const MSG = 'm-7f3a21'
const ORDER = 'order-1042'
const AMOUNT = 49
const MAX_RECEIVES = 3

const CONSUMERS = ['Healthy worker', 'Crashes after the work, before the ack (first try)', 'Poison message: throws every time']
const JOBS = ['5 s', '25 s', '70 s']
const TIMEOUTS = ['10 s', '30 s', '60 s']
const HANDLERS = ['Not idempotent', 'Idempotent (dedupe on message id)']

const secs = (label: string) => parseInt(label, 10)

interface Attempt {
  n: number
  start: number
  kind: 'worked' | 'crashed' | 'threw' | 'skipped' | 'backed-off'
  /** Second at which the work committed (the charge happened). */
  workAt: number | null
  /** Second at which the message was deleted, or null. */
  ackAt: number | null
  /** The next time the message reappears if it was not deleted. */
  reappearAt: number
}

function play(consumer: string, job: number, timeout: number, idempotent: boolean) {
  const attempts: Attempt[] = []
  let committedAt: number | null = null // idempotent mode: when the first real charge committed
  let start = 0
  let done = false
  for (let n = 1; n <= MAX_RECEIVES && !done; n++) {
    let kind: Attempt['kind']
    let workAt: number | null = null
    let ackAt: number | null = null
    if (consumer === CONSUMERS[2]) {
      kind = 'threw'
    } else if (idempotent && n > 1 && committedAt !== null && committedAt <= start) {
      kind = 'skipped' // the key is already recorded: skip the work, ack at once
      ackAt = start
    } else if (idempotent && n > 1 && committedAt !== null) {
      kind = 'backed-off' // another attempt still holds the key: leave the message alone
    } else if (consumer === CONSUMERS[1] && n === 1) {
      kind = 'crashed'
      workAt = start + job
    } else {
      kind = 'worked'
      workAt = start + job
      if (job <= timeout) ackAt = workAt // a delete after the timeout carries a stale receipt handle
    }
    if (workAt !== null && committedAt === null) committedAt = workAt
    attempts.push({ n, start, kind, workAt, ackAt, reappearAt: start + timeout })
    if (ackAt !== null) done = true
    else start += timeout
  }
  const acked = attempts.find((a) => a.ackAt !== null)
  return { attempts, acked, dlqAt: acked ? null : start }
}

const simulator: Simulator = {
  fields: [
    { id: 'consumer', label: 'Consumer', options: CONSUMERS },
    { id: 'job', label: 'The job takes', options: JOBS },
    { id: 'timeout', label: 'Visibility timeout', options: TIMEOUTS },
    { id: 'handler', label: 'Handler', options: HANDLERS },
  ],
  defaults: { consumer: CONSUMERS[1], job: JOBS[0], timeout: TIMEOUTS[1], handler: HANDLERS[0] },
  run(values) {
    const consumer = CONSUMERS.includes(values.consumer) ? values.consumer : CONSUMERS[0]
    const jobLabel = JOBS.includes(values.job) ? values.job : JOBS[0]
    const timeoutLabel = TIMEOUTS.includes(values.timeout) ? values.timeout : TIMEOUTS[1]
    const idempotent = values.handler === HANDLERS[1]
    const job = secs(jobLabel)
    const V = secs(timeoutLabel)
    const { attempts, acked, dlqAt } = play(consumer, job, V, idempotent)

    const runs = attempts.filter((a) => a.workAt !== null).length
    const charged = idempotent ? Math.min(1, runs) : runs
    const config = { visibility_timeout_s: V, max_receive_count: MAX_RECEIVES, dead_letter_queue: 'orders-dlq', retention_days: 4 }

    const steps: Trace['steps'] = [
      {
        text: `The Order API takes payment for ${ORDER} and sends a message instead of charging the card inside the web request. The call returns as soon as the queue has stored the message, so the shopper never waits for the slow part.`,
        nodes: ['Producer (Order API)', 'Queue Service'],
        data: `SendMessage(queue=orders)\n${json({ MessageId: MSG, Body: { order: ORDER, action: 'charge_card', amount_usd: AMOUNT } })}`,
      },
      {
        text: `The Queue Service reads the queue's settings from the Metadata Store, then appends the message to the Message Store. The write is only acknowledged once the Replica Store also has a copy, so a crashed node can't lose an accepted message.`,
        nodes: ['Queue Service', 'Metadata Store', 'Message Store', 'Replica Store'],
        data: `queue settings: ${json(config)}\nappend ${MSG} → Message Store ✓, Replica Store ✓\nreceive_count=0, visible_at=t=0s`,
      },
    ]

    for (const a of attempts) {
      const handle = `rh-${a.n}`
      const handlerText: Record<Attempt['kind'], string> = {
        worked: `The worker charges the card ($${AMOUNT}.00) and it takes ${job} s${idempotent ? ', recording the message id in the Idempotency Table in the same transaction' : ''}.`,
        crashed: `The worker charges the card ($${AMOUNT}.00) in ${job} s, then the process dies before it can delete the message. The money moved; the queue doesn't know.`,
        threw: `The worker reads the body and throws at once (the order has no card on file). Nothing was charged, and a retry will fail the same way.`,
        skipped: `The worker checks the Idempotency Table first and finds ${MSG} already recorded. It skips the charge and goes straight to the ack.`,
        'backed-off': `The worker tries to claim ${MSG} in the Idempotency Table and finds an earlier attempt still holding it. It skips the charge and does not ack, leaving the message to return later.`,
      }
      steps.push({
        text: `Attempt ${a.n}: a worker long-polls and receives the message at t=${a.start}s. The Visibility Timer hides it from every other worker for ${V} s and the receive count becomes ${a.n}. ${handlerText[a.kind]}`,
        nodes: a.kind === 'skipped' || a.kind === 'backed-off' || (idempotent && a.kind === 'worked')
          ? ['Consumer Workers', 'Queue Service', 'Visibility Timer', 'Idempotency Table']
          : ['Consumer Workers', 'Queue Service', 'Visibility Timer'],
        data: `ReceiveMessage(wait=20s) at t=${a.start}s\n→ MessageId ${MSG}, ReceiptHandle ${handle}, ApproximateReceiveCount ${a.n}\ninvisible until t=${a.start + V}s${a.workAt !== null ? `\ncharge committed at t=${a.workAt}s` : ''}`,
      })
      if (a.ackAt !== null) {
        steps.push({
          text: `At t=${a.ackAt}s the worker calls DeleteMessage with its receipt handle, and the Queue Service removes the message from the Message Store and its replica. This is the only thing that ends the message's life: finishing the work is not enough.`,
          nodes: ['Consumer Workers', 'Queue Service', 'Message Store'],
          data: `DeleteMessage(ReceiptHandle=${handle}) at t=${a.ackAt}s\n→ 200 OK, ${MSG} deleted`,
        })
      } else {
        const stale =
          a.kind === 'worked'
            ? `The worker is still busy until t=${a.workAt}s; when it finally deletes with ${handle}, that handle is stale because the message has been re-received, so the delete does nothing.`
            : a.kind === 'crashed'
              ? 'Nobody deletes it.'
              : a.kind === 'threw'
                ? 'The error is not an ack, so nothing is deleted.'
                : 'Nothing was deleted.'
        steps.push({
          text: `The timeout runs out at t=${a.reappearAt}s with no delete. ${stale} The Visibility Timer makes the message visible again in the Message Store${a.n < MAX_RECEIVES ? ', so another worker can take it' : ''}.`,
          nodes: ['Visibility Timer', 'Message Store'],
          data: `t=${a.reappearAt}s: visibility timeout expired for ${handle}\n${MSG}: visible_at=${a.reappearAt}s, receive_count=${a.n}`,
        })
      }
    }

    if (dlqAt !== null) {
      steps.push({
        text: `Receive count has hit the limit of ${MAX_RECEIVES}. Instead of a fourth delivery at t=${dlqAt}s, the Queue Service moves ${MSG} to the Dead-Letter Queue, so one bad message can't loop forever and block good ones.${consumer === CONSUMERS[2] ? ' The failure was in the message itself, so a person has to look at it.' : ` The work ran ${runs} time${runs === 1 ? '' : 's'} though, so the queue's verdict ("failed") is wrong about the world.`}`,
        nodes: ['Queue Service', 'Dead-Letter Queue'],
        data: `t=${dlqAt}s: ApproximateReceiveCount ${MAX_RECEIVES} ≥ maxReceiveCount ${MAX_RECEIVES}\nmove ${MSG} → orders-dlq (original enqueue time kept)`,
      })
    }

    const outcome = acked ? `deleted at t=${acked.ackAt}s` : `in the dead-letter queue at t=${dlqAt}s`
    steps.push({
      text:
        charged > 1
          ? `Result: the message is ${outcome}, but the card was charged ${charged} times ($${charged * AMOUNT}.00). A queue delivers at least once, never exactly once, so the handler has to be safe to run twice.`
          : charged === 1
            ? `Result: the message is ${outcome} and the card was charged exactly once ($${AMOUNT}.00)${idempotent && runs >= 1 && attempts.length > 1 ? ', even though the queue delivered it more than once, because the handler remembered the message id' : ''}.`
            : `Result: the message is ${outcome} and nothing was charged. Queue depth and the dead-letter count feed Metrics & Alerts, and the Autoscaler adds workers when the backlog grows.`,
      nodes: ['Metrics & Alerts', 'Autoscaler'],
      data: `orders_receives_total ${attempts.length}\norders_work_executed_total ${runs}\ncard_charges ${charged} × $${AMOUNT}.00 = $${charged * AMOUNT}.00\norders_dlq_depth ${dlqAt !== null ? 1 : 0}`,
    })

    return {
      input: `${consumer.split(' (')[0].split(':')[0]}, job ${jobLabel}, timeout ${timeoutLabel}, ${idempotent ? 'idempotent' : 'not idempotent'}`,
      steps,
    }
  },
}

export const messageQueue: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'message-queue',
  title: 'Distributed Message Queue',
  blurb: 'Visibility timeouts, acks, retries and dead-letter queues, and why delivery is at least once',
  guides: ['primer-asynchronism', 'types-of-message-queue', 'how-do-message-queue-architectures-evolve', 'scale-delaying-asynchronous-message-processing-with-rabbitmq-at-indeed', 'scale-reprocessing-and-dead-letter-queues-with-kafka-at-uber'],
  takeaways: [
    'A queue lets the fast part of a request return now and the slow part run later, at the workers\' own pace.',
    'A received message is hidden, not removed: only an explicit delete (the ack) ends it, so a crashed worker\'s message comes back.',
    'The visibility timeout must be longer than the job, or the same message is handed to a second worker while the first is still working.',
    'Delivery is at least once, so every handler must be idempotent: record the message id in the same transaction as the work.',
    'A dead-letter queue after a few receives stops a poison message from looping forever; alarm on its depth and keep the messages to replay.',
    'Scale workers on queue depth and the age of the oldest message, and shard the queue when one node can no longer take the writes.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'broker', label: 'Queue cluster' },
      { id: 'workers', label: 'Workers' },
    ],
    nodes: [
      { id: 'producer', label: 'Producer (Order API)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'service', label: 'Queue Service', shape: 'rectangle', color: 'violet', group: 'broker' },
      { id: 'meta', label: 'Metadata Store', shape: 'rectangle', color: 'green', group: 'broker' },
      { id: 'store', label: 'Message Store', shape: 'rectangle', color: 'green', group: 'broker' },
      { id: 'replica', label: 'Replica Store', shape: 'rectangle', color: 'green', group: 'broker' },
      { id: 'timer', label: 'Visibility Timer', shape: 'rectangle', color: 'orange', group: 'broker' },
      { id: 'workers', label: 'Consumer Workers', shape: 'rectangle', color: 'orange', group: 'workers' },
      { id: 'idem', label: 'Idempotency Table', shape: 'rectangle', color: 'green', group: 'workers' },
      { id: 'dlq', label: 'Dead-Letter Queue', shape: 'rectangle', color: 'yellow', group: null },
      { id: 'metrics', label: 'Metrics & Alerts', shape: 'rectangle', color: 'yellow', group: null },
      { id: 'autoscaler', label: 'Autoscaler', shape: 'rectangle', color: 'orange', group: 'workers' },
    ],
    edges: [
      { from: 'producer', to: 'service', label: 'SendMessage', dashed: false },
      { from: 'service', to: 'meta', label: 'queue settings', dashed: true },
      { from: 'service', to: 'store', label: 'append', dashed: false },
      { from: 'store', to: 'replica', label: 'replicate', dashed: true },
      { from: 'workers', to: 'service', label: 'ReceiveMessage (long poll)', dashed: false },
      { from: 'service', to: 'timer', label: 'hide for V seconds', dashed: false },
      { from: 'timer', to: 'store', label: 'visible again', dashed: true },
      { from: 'workers', to: 'idem', label: 'claim message id', dashed: false },
      { from: 'workers', to: 'service', label: 'DeleteMessage (ack)', dashed: false },
      { from: 'service', to: 'dlq', label: 'after N receives', dashed: true },
      { from: 'service', to: 'metrics', label: 'depth, age', dashed: true },
      { from: 'metrics', to: 'autoscaler', label: 'backlog', dashed: true },
      { from: 'autoscaler', to: 'workers', label: 'add workers', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'queues',
        name: 'queues',
        columns: [
          { name: 'queue_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'visibility_timeout_s', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'max_receive_count', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'retention_s', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'dlq_queue_id', type: 'bigint', pk: false, fk: 'queues.queue_id', nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'messages',
        name: 'messages',
        columns: [
          { name: 'message_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'queue_id', type: 'bigint', pk: false, fk: 'queues.queue_id', nullable: false, unique: false },
          { name: 'body', type: 'bytea', pk: false, fk: null, nullable: false, unique: false },
          { name: 'enqueued_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'visible_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'receive_count', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'receipt_handle', type: 'text', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(queue_id, visible_at)'],
      },
      {
        id: 'processed_messages',
        name: 'processed_messages',
        columns: [
          { name: 'message_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'processed_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'result', type: 'jsonb', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'messages', to: 'queues', kind: 'one-to-many', label: 'waits in' },
      { from: 'processed_messages', to: 'messages', kind: 'one-to-one', label: 'remembers' },
    ],
  },
  explanation: {
    title: 'Distributed Message Queue',
    summary:
      'A message queue sits between a producer that has work and the workers that do it. The producer drops a message and moves on; workers take messages at their own pace. The interesting part is failure: a worker that crashes must not lose the message, and one bad message must not block the rest. Queues solve this with acknowledgements, a visibility timeout, retries and a dead-letter queue, and the price is that a message can be delivered more than once.',
    sections: [
      {
        heading: 'Overview',
        body: 'Charging a card, resizing an image or sending an email can be slow or fail. If the web request does it inline, the shopper waits and a failure loses the order. With a queue, the Order API writes a small message ("charge order-1042") and replies at once. Workers read messages and do the job later, and the queue holds them safely until then.\n\nThis is a queue, not a log. Kafka keeps every record and lets many readers replay it by offset. A queue like SQS or RabbitMQ gives each message to one worker, then deletes it once that worker says it is done. Pick a queue for jobs (work to be done once), a log for events (facts many systems read).',
      },
      {
        heading: 'Requirements',
        body: '- Accept a message durably: once SendMessage returns, it must survive a node failure.\n- Deliver each message to one worker at a time, and hand it to another if that worker fails.\n- Never lose a message that was not acknowledged; accept that it may be delivered more than once.\n- Stop a message that keeps failing (a poison message) from looping forever.\n- Absorb bursts: let the backlog grow while workers catch up, and show how big and how old it is.\n- Scale writes and readers by adding machines, with ordering only where the app asks for it (a FIFO group).',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example: 50k messages a second at peak, 2 KB each, kept for 4 days at an average of 10k a second. Peak is 5 times the average.\n- Ingress at peak: 50k × 2 KB = about 98 MiB/s. With 3 copies the cluster writes about 293 MiB/s.\n- One shard takes about 5k sends a second, so peak needs about 10 shards.\n- A backlog of one hour at peak is 50k × 3,600 × 2 KB = about 369 GB, or 1.1 TB with 3 copies. A 4-day retention at the 10k a second average is about 21 TB with 3 copies.\n- Messages in flight (hidden, being worked on) = rate × job time. If a job takes 200 ms, 50k × 0.2 = 10k messages are in flight. At 20 jobs per worker that is 500 workers.\n- If 0.1% of attempts fail and retry, that is 50 redeliveries a second: small, but each one is a duplicate side effect unless the handler is idempotent.',
      },
      {
        heading: 'Step by step',
        body: '1. The Producer (Order API) calls SendMessage on the Queue Service with the job as the body.\n2. The Queue Service reads the queue\'s settings from the Metadata Store (visibility timeout, max receives, dead-letter queue).\n3. The Queue Service appends the message to the Message Store, which copies it to the Replica Store before the send is acknowledged.\n4. A worker in Consumer Workers long-polls ReceiveMessage on the Queue Service and gets the message and a receipt handle.\n5. The Queue Service tells the Visibility Timer to hide the message for V seconds and increments its receive count.\n6. The Consumer Workers claim the message id in the Idempotency Table, then do the work in the same transaction.\n7. On success the worker calls DeleteMessage, and the Queue Service removes the message from the Message Store.\n8. If no delete arrives in time, the Visibility Timer makes the message visible again and another worker receives it.\n9. When the receive count reaches the limit, the Queue Service moves the message to the Dead-Letter Queue.\n10. The Queue Service reports depth and age to Metrics & Alerts, and the Autoscaler adds workers when the backlog grows.',
      },
      {
        heading: 'Components',
        body: '- Producer (Order API): the app that has work to hand off; it only needs the message stored, not done.\n- Queue Service: the front door; accepts sends, hands out messages, tracks receipt handles and enforces the retry limit.\n- Metadata Store: holds each queue\'s settings, such as visibility timeout, max receives and dead-letter target.\n- Message Store: the durable log of messages, indexed by when each becomes visible.\n- Replica Store: a copy of every message on another node, so a node failure loses nothing that was acknowledged.\n- Visibility Timer: hides a received message for V seconds and brings it back if it was not deleted.\n- Consumer Workers: the processes that receive, do the job and delete; they are stateless and scale out.\n- Idempotency Table: records which message ids were already handled, so a redelivery does not repeat the side effect.\n- Dead-Letter Queue: where a message goes after too many failed receives, kept for a person to inspect and replay.\n- Metrics & Alerts: queue depth, age of the oldest message, receive counts and dead-letter depth, with alarms.\n- Autoscaler: adds or removes workers based on backlog per worker.',
      },
      {
        heading: 'Key decisions',
        body: '- At least once vs at most once: deleting before the work risks losing it on a crash; deleting after risks doing it twice. Almost every queue picks at least once and asks the handler to be idempotent. True exactly-once only exists inside one system (for example Kafka transactions into Kafka).\n- Visibility timeout: set it to a little above the longest normal job (for example p99 plus a margin). Too short gives duplicates while the first worker is still busy; too long makes a crashed worker\'s message wait. For long jobs, extend the timeout while working (a heartbeat).\n- Retries: retry with a growing delay (a visibility timeout that doubles) rather than instantly, and cap the receives at 3 to 5 before the dead-letter queue.\n- Ordering: a standard queue gives no order. A FIFO queue orders per message group and only lets one worker hold a group at a time, which limits throughput to the number of groups.\n- Long polling: a worker waits up to 20 s for a message instead of asking in a loop, which cuts empty responses and cost.\n- Queue or log: use a queue when each job is done once by one worker; use a log (Kafka) when many consumers read the same events or need replay.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Shard the queue (by queue name, or by message group id) across nodes so one node is not the write bottleneck; each shard has its own replicas.\n- A worker crash is the normal case: its message reappears after the timeout. Make that cheap with short jobs and a sensible timeout.\n- A poison message is handled by the receive limit and the dead-letter queue. Alarm when the dead-letter depth is above zero, and keep messages long enough (14 days is a common maximum) to fix the bug and redrive them.\n- A slow downstream (a payment API) makes jobs slow, in-flight messages pile up and timeouts start expiring. Cap worker concurrency and back off instead of adding workers.\n- A backlog is not an outage: watch the age of the oldest message, which is what the user actually feels, more than depth.\n- Losing a queue node: replicas take over; unacknowledged sends fail and the producer retries with the same dedupe id, so the retry is not a second message.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why can a worker finish the job and the message still be delivered again?\n- How do you pick a visibility timeout, and what happens when the job is slower than it?\n- A message fails every time. What stops it from blocking the queue, and how do you recover it?\n- How would you get exactly-once behaviour on top of an at-least-once queue?\n- When would you choose Kafka over SQS or RabbitMQ, and the reverse?\n- How would you keep per-user ordering while still scaling to many workers?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'A queue with a visibility timeout (in memory)',
        language: 'javascript',
        source: `export class Queue {
  msgs = new Map()
  dlq = []
  constructor(visibilityMs = 30_000, maxReceives = 3) {
    this.visibilityMs = visibilityMs
    this.maxReceives = maxReceives
  }

  send(id, body) {
    this.msgs.set(id, { id, body, receives: 0, visibleAt: 0 })
  }

  receive(now = Date.now()) {
    for (const m of this.msgs.values()) {
      if (m.visibleAt > now) continue                    // hidden: someone is working on it
      if (m.receives >= this.maxReceives) {              // tried enough: park it
        this.msgs.delete(m.id)
        this.dlq.push(m)
        continue
      }
      m.receives++
      m.visibleAt = now + this.visibilityMs              // hide it, don't delete it
      return { id: m.id, body: m.body, receipt: \`\${m.id}:\${m.receives}\` }
    }
  }

  delete(receipt) {
    const [id, n] = receipt.split(':')
    const m = this.msgs.get(id)
    if (m && m.receives === Number(n)) this.msgs.delete(id) // a stale receipt does nothing
  }
}

const q = new Queue(30_000)
q.send('m-7f3a21', 'charge order-1042')
console.log(q.receive(0))        // worker A gets it at t=0
console.log(q.receive(10_000))   // undefined: still hidden
console.log(q.receive(30_000))   // worker B gets it: A never deleted it`,
        versions: [
          {
            language: 'java',
            source: `import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class VisibilityQueue {
  private static final class Msg {
    final String id;
    final String body;
    int receives = 0;
    long visibleAt = 0;

    Msg(String id, String body) {
      this.id = id;
      this.body = body;
    }
  }

  public record Received(String id, String body, String receipt) {}

  private final Map<String, Msg> msgs = new LinkedHashMap<>();
  private final List<Msg> dlq = new ArrayList<>();
  private final long visibilityMs;
  private final int maxReceives;

  public VisibilityQueue(long visibilityMs, int maxReceives) {
    this.visibilityMs = visibilityMs;
    this.maxReceives = maxReceives;
  }

  public void send(String id, String body) {
    msgs.put(id, new Msg(id, body));
  }

  public Received receive(long now) {
    for (Iterator<Msg> it = msgs.values().iterator(); it.hasNext(); ) {
      Msg m = it.next();
      if (m.visibleAt > now) continue; // hidden: someone is working on it
      if (m.receives >= maxReceives) { // tried enough: park it
        it.remove();
        dlq.add(m);
        continue;
      }
      m.receives++;
      m.visibleAt = now + visibilityMs; // hide it, don't delete it
      return new Received(m.id, m.body, m.id + ":" + m.receives);
    }
    return null;
  }

  public void delete(String receipt) {
    String[] parts = receipt.split(":");
    Msg m = msgs.get(parts[0]);
    if (m != null && m.receives == Integer.parseInt(parts[1])) msgs.remove(parts[0]); // a stale receipt does nothing
  }

  public static void main(String[] args) {
    VisibilityQueue q = new VisibilityQueue(30_000, 3);
    q.send("m-7f3a21", "charge order-1042");
    System.out.println(q.receive(0)); // worker A gets it at t=0
    System.out.println(q.receive(10_000)); // null: still hidden
    System.out.println(q.receive(30_000)); // worker B gets it: A never deleted it
  }
}`,
          },
          {
            language: 'typescript',
            source: `type Msg = { id: string; body: string; receives: number; visibleAt: number }

export class Queue {
  private msgs = new Map<string, Msg>()
  dlq: Msg[] = []
  constructor(private visibilityMs = 30_000, private maxReceives = 3) {}

  send(id: string, body: string) {
    this.msgs.set(id, { id, body, receives: 0, visibleAt: 0 })
  }

  receive(now = Date.now()) {
    for (const m of this.msgs.values()) {
      if (m.visibleAt > now) continue                    // hidden: someone is working on it
      if (m.receives >= this.maxReceives) {              // tried enough: park it
        this.msgs.delete(m.id)
        this.dlq.push(m)
        continue
      }
      m.receives++
      m.visibleAt = now + this.visibilityMs              // hide it, don't delete it
      return { id: m.id, body: m.body, receipt: \`\${m.id}:\${m.receives}\` }
    }
  }

  delete(receipt: string) {
    const [id, n] = receipt.split(':')
    const m = this.msgs.get(id)
    if (m && m.receives === Number(n)) this.msgs.delete(id) // a stale receipt does nothing
  }
}

const q = new Queue(30_000)
q.send('m-7f3a21', 'charge order-1042')
console.log(q.receive(0))        // worker A gets it at t=0
console.log(q.receive(10_000))   // undefined: still hidden
console.log(q.receive(30_000))   // worker B gets it: A never deleted it`,
          },
        ],
      },
      {
        title: 'An idempotent handler (message id in the same transaction)',
        language: 'javascript',
        source: `import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(':memory:')
db.exec(\`
CREATE TABLE processed_messages (message_id TEXT PRIMARY KEY);
CREATE TABLE charges (order_id TEXT, amount_cents INT);
\`)

export function handle(messageId, orderId, amountCents) {
  db.exec('BEGIN') // one transaction: both rows commit or neither does
  try {
    db.prepare('INSERT INTO processed_messages VALUES (?)').run(messageId)
    db.prepare('INSERT INTO charges VALUES (?, ?)').run(orderId, amountCents)
    db.exec('COMMIT')
    return 'charged'
  } catch (err) {
    db.exec('ROLLBACK')
    if (err.errstr === 'constraint failed') return 'duplicate, skipped' // already done: safe to ack
    throw err
  }
}

console.log(handle('m-7f3a21', 'order-1042', 4900)) // charged
console.log(handle('m-7f3a21', 'order-1042', 4900)) // duplicate, skipped (redelivery)
console.log(db.prepare('SELECT COUNT(*) AS n FROM charges').get().n) // 1`,
        versions: [
          {
            language: 'java',
            source: `import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

// In-memory H2 database (com.h2database:h2), so it runs as is.
public class IdempotentHandler {
  private final Connection db;

  IdempotentHandler(Connection db) throws SQLException {
    this.db = db;
    try (Statement st = db.createStatement()) {
      st.execute("CREATE TABLE processed_messages (message_id VARCHAR(64) PRIMARY KEY)");
      st.execute("CREATE TABLE charges (order_id VARCHAR(64), amount_cents INT)");
    }
    db.setAutoCommit(false); // one transaction per message: both rows commit or neither does
  }

  String handle(String messageId, String orderId, int amountCents) throws SQLException {
    try (PreparedStatement seen = db.prepareStatement("INSERT INTO processed_messages VALUES (?)");
        PreparedStatement charge = db.prepareStatement("INSERT INTO charges VALUES (?, ?)")) {
      seen.setString(1, messageId);
      seen.executeUpdate();
      charge.setString(1, orderId);
      charge.setInt(2, amountCents);
      charge.executeUpdate();
      db.commit();
      return "charged";
    } catch (SQLException e) {
      db.rollback();
      if ("23505".equals(e.getSQLState())) return "duplicate, skipped"; // already done: safe to ack
      throw e;
    }
  }

  public static void main(String[] args) throws SQLException {
    IdempotentHandler h = new IdempotentHandler(DriverManager.getConnection("jdbc:h2:mem:queue"));
    System.out.println(h.handle("m-7f3a21", "order-1042", 4900)); // charged
    System.out.println(h.handle("m-7f3a21", "order-1042", 4900)); // duplicate, skipped (redelivery)
    try (ResultSet rs = h.db.createStatement().executeQuery("SELECT COUNT(*) FROM charges")) {
      rs.next();
      System.out.println(rs.getInt(1)); // 1
    }
  }
}`,
          },
          {
            language: 'python',
            source: `import sqlite3

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE processed_messages (message_id TEXT PRIMARY KEY);
CREATE TABLE charges (order_id TEXT, amount_cents INT);
""")

def handle(message_id: str, order_id: str, amount_cents: int) -> str:
    try:
        with db:  # one transaction: both rows commit or neither does
            db.execute("INSERT INTO processed_messages VALUES (?)", (message_id,))
            db.execute("INSERT INTO charges VALUES (?, ?)", (order_id, amount_cents))
        return "charged"
    except sqlite3.IntegrityError:
        return "duplicate, skipped"  # already done: safe to ack

print(handle("m-7f3a21", "order-1042", 4900))  # charged
print(handle("m-7f3a21", "order-1042", 4900))  # duplicate, skipped (redelivery)
print(db.execute("SELECT COUNT(*) FROM charges").fetchone()[0])  # 1`,
          },
        ],
      },
      {
        title: 'Taking the next message in SQL',
        language: 'sql',
        source: `-- Many workers can run this at once: SKIP LOCKED makes each one pass over
-- rows another worker holds, so no two get the same message.
WITH next AS (
  SELECT message_id
  FROM messages
  WHERE queue_id = 1 AND visible_at <= now() AND receive_count < 3
  ORDER BY visible_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE messages m
SET receive_count  = receive_count + 1,
    visible_at     = now() + interval '30 seconds',   -- the visibility timeout
    receipt_handle = gen_random_uuid()::text
FROM next
WHERE m.message_id = next.message_id
RETURNING m.message_id, m.body, m.receipt_handle;`,
      },
      {
        title: 'A queue with a dead-letter queue (AWS CLI)',
        language: 'bash',
        source: `# The dead-letter queue first, then the main queue pointing at it.
DLQ_URL=$(aws sqs create-queue --queue-name orders-dlq \\
  --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)   # 14 days
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \\
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

aws sqs create-queue --queue-name orders --attributes "{
  \\"VisibilityTimeout\\": \\"30\\",
  \\"ReceiveMessageWaitTimeSeconds\\": \\"20\\",
  \\"RedrivePolicy\\": \\"{\\\\\\"deadLetterTargetArn\\\\\\":\\\\\\"$DLQ_ARN\\\\\\",\\\\\\"maxReceiveCount\\\\\\":3}\\"
}"`,
      },
    ],
    related: ['Visibility timeout', 'Dead-letter queue', 'At-least-once delivery', 'Idempotency', 'Long polling', 'Backpressure'],
  },
  simulator,
}
