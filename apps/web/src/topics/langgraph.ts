import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator runs a LangGraph StateGraph for refund requests: classify → lookup_order →
// check_policy → (approve) → issue_refund → write_reply, or answer_faq for questions. It keeps
// the graph's state, applies each node's update (messages append, everything else replaces),
// and counts checkpoints the way LangGraph saves them: one for the input, one as the graph
// starts, then one after every super-step. The LLM nodes are rule-based stand-ins so it runs
// in the browser; the policy, the amounts, the interrupt, the resume and what a restart does
// with each checkpointer are worked out from the input.

interface Order {
  id: string
  fee: number
  food: number
  promised: string
  delivered: string
  complaint?: { kind: 'cold'; at: string; photo: boolean }
}

const ORDERS: Record<string, Order> = {
  '4101': { id: '4101', fee: 49, food: 412, promised: '19:40', delivered: '20:20' },
  '4102': { id: '4102', fee: 49, food: 640, promised: '20:10', delivered: '20:15', complaint: { kind: 'cold', at: '20:31', photo: true } },
  '4103': { id: '4103', fee: 39, food: 260, promised: '21:00', delivered: '21:10' },
}

const MESSAGES = [
  'Order 4101 was 40 minutes late. Refund the delivery fee.',
  'Order 4102 arrived cold. Refund it please.',
  'Order 4103 was 10 minutes late. Refund the delivery fee.',
  'What time do you stop delivering?',
]
const LEAD = ['The lead approves', 'The lead rejects']
const SERVER = ['Stays up', 'Restarts while waiting (PostgresSaver)', 'Restarts while waiting (MemorySaver)']

const APPROVAL_OVER = 200 // ₹: refunds above this wait for a person
const LATE_LIMIT = 30 // minutes
const PHOTO_WINDOW = 120 // minutes after delivery

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

interface State {
  messages: string[]
  intent?: 'refund' | 'question'
  order_id?: string
  reason?: 'late' | 'cold'
  order?: Order
  decision?: 'auto' | 'needs_approval' | 'not_eligible'
  amount_inr?: number
  why?: string
  approved?: boolean
  refund_id?: string
}

/** check_policy: plain code, no model. The same input always gives the same decision. */
function policy(order: Order, reason: 'late' | 'cold'): Pick<State, 'decision' | 'amount_inr' | 'why'> {
  if (reason === 'late') {
    const late = minutes(order.delivered) - minutes(order.promised)
    if (late <= LATE_LIMIT) return { decision: 'not_eligible', amount_inr: 0, why: `${late} min late; the fee is refunded only after ${LATE_LIMIT} min` }
    return { decision: order.fee > APPROVAL_OVER ? 'needs_approval' : 'auto', amount_inr: order.fee, why: `${late} min late (over ${LATE_LIMIT}): refund the ₹${order.fee} delivery fee` }
  }
  const c = order.complaint
  const after = c ? minutes(c.at) - minutes(order.delivered) : Infinity
  if (!c || !c.photo || after > PHOTO_WINDOW) return { decision: 'not_eligible', amount_inr: 0, why: 'cold food needs a photo within 2 hours of delivery' }
  return {
    decision: order.food > APPROVAL_OVER ? 'needs_approval' : 'auto',
    amount_inr: order.food,
    why: `complaint with a photo ${after} min after delivery: refund the ₹${order.food} food total${order.food > APPROVAL_OVER ? ` (over ₹${APPROVAL_OVER}: a person decides)` : ''}`,
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'message', label: 'The customer writes', options: MESSAGES },
    { id: 'lead', label: 'If a person must approve', options: LEAD },
    { id: 'server', label: 'Server while it waits', options: SERVER },
  ],
  defaults: { message: MESSAGES[1], lead: LEAD[0], server: SERVER[1] },
  run(values) {
    const message = MESSAGES.includes(values.message) ? values.message : MESSAGES[1]
    const approves = values.lead !== LEAD[1]
    const server = SERVER.indexOf(values.server) >= 0 ? SERVER.indexOf(values.server) : 1
    const steps: Trace['steps'] = []
    const state: State = { messages: [] }
    const thread = 'support-8812'
    let checkpoints = 2 // the input, and the graph starting
    let superSteps = 0
    const ran: string[] = []

    // Apply a node's update the way the state's reducers say: messages append, the rest replaces.
    const apply = (update: Partial<State>) => {
      const { messages, ...rest } = update
      if (messages) state.messages.push(...messages)
      Object.assign(state, rest)
    }
    const node = (name: string, update: Partial<State>, text: string, nodes: string[]) => {
      apply(update)
      superSteps++
      checkpoints++
      ran.push(name)
      steps.push({ text, nodes, data: `node ${name} returns:\n${JSON.stringify(update)}\n\ncheckpoint ${checkpoints} saved (step ${superSteps}) for thread "${thread}"` })
    }

    apply({ messages: [message] })
    steps.push({
      text: `The Customer writes in. The server calls graph.invoke() with the message and a thread_id. Before any node runs, LangGraph saves a checkpoint of the input and one as the graph starts, both in the checkpointer.`,
      nodes: ['Customer (Chat App)', 'Checkpointer (Postgres)'],
      data: `await graph.invoke(\n  { messages: [${JSON.stringify(message)}] },\n  { configurable: { thread_id: "${thread}" } },\n)`,
    })

    // classify (LLM): the stand-in reads the message for intent, order and reason.
    const isQuestion = !/refund/i.test(message)
    const orderId = message.match(/\b(\d{4})\b/)?.[1]
    const reason = /cold/i.test(message) ? 'cold' : 'late'
    node(
      'classify',
      isQuestion ? { intent: 'question' } : { intent: 'refund', order_id: orderId, reason },
      `classify (LLM) asks the model one narrow question: is this a refund request, and for which order and reason? It returns only those fields, using structured output, not free text. Route by Intent then picks the next node from state.intent.`,
      ['classify (LLM)', 'Model Provider', 'Route by Intent'],
    )

    if (isQuestion) {
      node(
        'answer_faq',
        { messages: ['We deliver until 23:30 every day. Orders placed after 23:00 may be declined if the restaurant is closing.'] },
        `The intent is a question, so the conditional edge goes to answer_faq (LLM), which answers from the help articles. Its message is added to state.messages: that key's reducer appends instead of replacing.`,
        ['Route by Intent', 'answer_faq (LLM)', 'Model Provider'],
      )
    } else {
      const order = ORDERS[orderId ?? '4101']
      node('lookup_order', { order }, `The intent is refund, so the edge goes to lookup_order, which reads order ${order.id} from the Orders API into state. It's ordinary code: no model can make up the times or the amounts.`, ['Route by Intent', 'lookup_order', 'Orders API'])
      const p = policy(order, reason)
      node(
        'check_policy',
        p,
        `check_policy (code) applies the refund rules to the facts in state: ${p.why}. Needs Approval? then routes on state.decision: auto, needs_approval or not_eligible. The model never decides money.`,
        ['check_policy (code)', 'Needs Approval?'],
      )

      if (p.decision === 'needs_approval') {
        steps.push({
          text: `approve (interrupt) calls interrupt() with the refund details. The run stops; nothing is refunded. The state up to here is already in the Checkpointer (Postgres), and the server returns at once with __interrupt__. The Support Lead sees the request in a dashboard.`,
          nodes: ['Needs Approval?', 'approve (interrupt)', 'Checkpointer (Postgres)', 'Support Lead'],
          data: `result.__interrupt__ = [{ value: ${JSON.stringify({ order_id: order.id, amount_inr: p.amount_inr, why: p.why })} }]\n\nno server is waiting: the run is just rows in Postgres`,
        })
        if (server > 0) {
          const lost = server === 2
          steps.push({
            text: lost
              ? `The server restarts (a deploy) while the lead is deciding. MemorySaver kept checkpoints in the server's memory, so they are gone. When the lead clicks Approve, there is no saved run for thread "${thread}" to resume: the request is lost, and the customer has to ask again. MemorySaver is for tests only.`
              : `The server restarts (a deploy) while the lead is deciding. Nothing is lost: the checkpoints are rows in Postgres. A different server will load thread "${thread}" when the lead decides.`,
            nodes: ['Checkpointer (Postgres)', 'approve (interrupt)'],
            data: lost
              ? `MemorySaver: 0 checkpoints after the restart\nawait graph.getState({ configurable: { thread_id: "${thread}" } })  // empty`
              : `SELECT checkpoint_id, metadata->>'step' AS step FROM checkpoints\nWHERE thread_id = '${thread}' ORDER BY checkpoint_id;\n→ ${checkpoints} rows, steps -1 to ${superSteps}`,
          })
          if (lost) {
            return {
              input: `${message.slice(0, 30)}… · restart with MemorySaver → request lost after ${checkpoints} checkpoints`,
              steps,
            }
          }
        }
        steps.push({
          text: `The Support Lead ${approves ? 'approves' : 'rejects'}. The server calls invoke() again with new Command({ resume: ${approves} }) and the same thread_id. LangGraph loads the last checkpoint and runs approve (interrupt) again from its first line; this time interrupt() returns ${approves}. That re-run is why a node does nothing with side effects before interrupt().`,
          nodes: ['Support Lead', 'approve (interrupt)', 'Checkpointer (Postgres)'],
          data: `await graph.invoke(new Command({ resume: ${approves} }), { configurable: { thread_id: "${thread}" } })`,
        })
        apply({ approved: approves })
        superSteps++
        checkpoints++
        ran.push('approve')
      }

      const pays = p.decision === 'auto' || (p.decision === 'needs_approval' && approves)
      if (pays) {
        const key = `refund:${thread}:${order.id}`
        node(
          'issue_refund',
          { refund_id: 'rf_9K31' },
          `issue_refund calls the Payments API for ₹${p.amount_inr}, with an idempotency key made from the thread and order. If this node ever runs twice (a retry, a replay from an old checkpoint), the Payments API returns the first refund instead of paying again.`,
          ['issue_refund', 'Payments API'],
        )
        steps[steps.length - 1].data = `POST /refunds  Idempotency-Key: ${key}\n${JSON.stringify({ order_id: order.id, amount_inr: p.amount_inr, to: 'wallet' })}\n→ { refund_id: "rf_9K31", status: "done" }\n\ncheckpoint ${checkpoints} saved (step ${superSteps})`
      }
      const reply = pays
        ? `Done: ₹${p.amount_inr} is back in your wallet for order ${order.id}.`
        : p.decision === 'not_eligible'
          ? `Sorry, order ${order.id} doesn't qualify: ${p.why}.`
          : `A colleague checked order ${order.id} and couldn't approve this refund. We've noted your complaint.`
      node('write_reply', { messages: [reply] }, `write_reply (LLM) turns the outcome in state into a short, polite message. The model writes words; the decision was already made in code.`, ['write_reply (LLM)', 'Model Provider', 'Customer (Chat App)'])
    }

    steps.push({
      text: `The graph reaches END. Every step is a checkpoint in the Checkpointer (Postgres), so you can list the thread's history, see the state after any node, or run it again from an earlier checkpoint (time travel) after fixing a bug. The default recursion limit stops a run after 25 super-steps, so a loop between nodes can't run for ever.`,
      nodes: ['Checkpointer (Postgres)', 'Customer (Chat App)'],
      data: `nodes run: ${ran.join(' → ')}\nsuper-steps: ${superSteps} of at most 25 · checkpoints: ${checkpoints}\nfinal state: ${JSON.stringify({ intent: state.intent, decision: state.decision, amount_inr: state.amount_inr, approved: state.approved, refund_id: state.refund_id })}\nreply: "${state.messages[state.messages.length - 1]}"`,
    })

    const outcome = state.refund_id ? `₹${state.amount_inr} refunded` : state.intent === 'question' ? 'answered' : state.decision === 'not_eligible' ? 'not eligible' : 'rejected by the lead'
    return {
      input: `${message.slice(0, 30)}…${state.decision === 'needs_approval' ? ` · ${approves ? 'approved' : 'rejected'}${server === 1 ? ' after a restart' : ''}` : ''} → ${outcome} · ${superSteps} steps, ${checkpoints} checkpoints`,
      steps,
    }
  },
}

export const langgraph: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'langgraph',
  title: 'LangGraph: Stateful Agent Workflows',
  blurb: 'An LLM workflow as a graph: shared state, nodes, branching edges, checkpoints, pauses for a person and time travel',
  guides: ['what-is-an-ai-agent', 'scale-airflow---workflow-orchestration', 'the-open-source-ai-stack'],
  takeaways: [
    'LangGraph builds a workflow as a graph: nodes are functions, edges decide what runs next, and all of them share one state.',
    'Each state key has a reducer that says how updates combine: replace the value, or append to a list such as messages.',
    'Put decisions that must be right (money, permissions) in plain-code nodes, and use the model only where language is needed.',
    'A checkpointer saves the state after every step under a thread_id; use Postgres in production, because in-memory checkpoints vanish on restart.',
    'interrupt() pauses a run for a person with no server waiting; Command({ resume }) continues it, re-running that node from its start.',
    'Checkpoints give you history and time travel, and the recursion limit (25 steps by default) stops runaway loops.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'graph', label: 'Compiled StateGraph' },
      { id: 'services', label: 'Services' },
    ],
    nodes: [
      { id: 'user', label: 'Customer (Chat App)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'classify', label: 'classify (LLM)', shape: 'rectangle', color: 'violet', group: 'graph' },
      { id: 'route', label: 'Route by Intent', shape: 'diamond', color: 'violet', group: 'graph' },
      { id: 'faq', label: 'answer_faq (LLM)', shape: 'rectangle', color: 'violet', group: 'graph' },
      { id: 'lookup', label: 'lookup_order', shape: 'rectangle', color: 'violet', group: 'graph' },
      { id: 'policy', label: 'check_policy (code)', shape: 'rectangle', color: 'violet', group: 'graph' },
      { id: 'needs', label: 'Needs Approval?', shape: 'diamond', color: 'violet', group: 'graph' },
      { id: 'approve', label: 'approve (interrupt)', shape: 'rectangle', color: 'orange', group: 'graph' },
      { id: 'refund', label: 'issue_refund', shape: 'rectangle', color: 'violet', group: 'graph' },
      { id: 'reply', label: 'write_reply (LLM)', shape: 'rectangle', color: 'violet', group: 'graph' },
      { id: 'lead', label: 'Support Lead', shape: 'ellipse', color: 'blue', group: null },
      { id: 'model', label: 'Model Provider', shape: 'cloud', color: 'violet', group: null },
      { id: 'orders', label: 'Orders API', shape: 'rectangle', color: 'violet', group: 'services' },
      { id: 'payments', label: 'Payments API', shape: 'rectangle', color: 'violet', group: 'services' },
      { id: 'ckpt', label: 'Checkpointer (Postgres)', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'user', to: 'classify', label: 'invoke(input, thread_id)', dashed: false },
      { from: 'classify', to: 'model', label: 'structured output', dashed: true },
      { from: 'classify', to: 'route', label: 'state.intent', dashed: false },
      { from: 'route', to: 'faq', label: 'question', dashed: false },
      { from: 'route', to: 'lookup', label: 'refund', dashed: false },
      { from: 'faq', to: 'user', label: 'answer', dashed: true },
      { from: 'lookup', to: 'orders', label: 'GET /orders/:id', dashed: false },
      { from: 'lookup', to: 'policy', label: '', dashed: false },
      { from: 'policy', to: 'needs', label: 'state.decision', dashed: false },
      { from: 'needs', to: 'approve', label: 'over ₹200', dashed: false },
      { from: 'needs', to: 'refund', label: 'auto', dashed: false },
      { from: 'needs', to: 'reply', label: 'not eligible', dashed: false },
      { from: 'approve', to: 'lead', label: 'pause', dashed: true },
      { from: 'lead', to: 'approve', label: 'Command({ resume })', dashed: true },
      { from: 'approve', to: 'refund', label: 'approved', dashed: false },
      { from: 'approve', to: 'reply', label: 'rejected', dashed: false },
      { from: 'refund', to: 'payments', label: 'idempotency key', dashed: false },
      { from: 'refund', to: 'reply', label: '', dashed: false },
      { from: 'reply', to: 'model', label: 'words only', dashed: true },
      { from: 'reply', to: 'user', label: 'reply', dashed: false },
      { from: 'route', to: 'ckpt', label: 'checkpoint every step', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'checkpoints',
        name: 'checkpoints',
        columns: [
          { name: 'thread_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'checkpoint_ns', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'checkpoint_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'parent_checkpoint_id', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'type', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'checkpoint', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
          { name: 'metadata', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(thread_id)'],
      },
      {
        id: 'checkpoint_writes',
        name: 'checkpoint_writes',
        columns: [
          { name: 'thread_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'checkpoint_ns', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'checkpoint_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'task_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'idx', type: 'integer', pk: true, fk: null, nullable: false, unique: false },
          { name: 'channel', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'type', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'blob', type: 'bytea', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(thread_id)'],
      },
      {
        id: 'checkpoint_blobs',
        name: 'checkpoint_blobs',
        columns: [
          { name: 'thread_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'checkpoint_ns', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'channel', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'version', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'type', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'blob', type: 'bytea', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(thread_id)'],
      },
      {
        id: 'refunds',
        name: 'refunds',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'idempotency_key', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'order_id', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'amount_inr', type: 'integer', pk: false, fk: null, nullable: false, unique: false },
          { name: 'approved_by', type: 'text', pk: false, fk: null, nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(order_id)'],
      },
    ],
    // The checkpoint tables join on (thread_id, checkpoint_ns, checkpoint_id), a composite key
    // the diagram can't draw as one line, so they're shown side by side.
    relations: [],
  },
  explanation: {
    title: 'LangGraph: Stateful Agent Workflows',
    summary:
      'LangGraph is an open-source library (JavaScript and Python) for building LLM workflows and agents as graphs. Nodes are functions, edges choose what runs next, and every node reads and updates one shared state. A checkpointer saves that state after every step under a thread_id, so a run can pause for a person, survive a restart, resume later and be replayed. LangChain\'s createAgent runs on it.',
    sections: [
      {
        heading: 'Overview',
        body: 'An agent loop lets the model choose every step. That is flexible, but for a refund you want some steps fixed: always look the order up, always apply the policy in code, always ask a person above ₹200. LangGraph lets you draw exactly that, and still call a model where language helps.\n\n- State: one object every node reads; each key has a reducer that says how updates combine (replace, or append for messages).\n- Nodes: functions that take the state and return an update. Some call a model; many are plain code.\n- Edges: fixed ("after lookup_order, run check_policy") or conditional (a function reads the state and names the next node).\n- Checkpointer: saves the state after every step under a thread_id. That is what makes pausing, resuming, memory and time travel possible.\n\nLangGraph 1.0 came out in October 2025, alongside LangChain 1.0.\n\nThe simulator runs this refund graph. The LLM nodes are rule-based stand-ins so it runs in your browser; the policy, the amounts, the pause, the resume and the checkpoints are worked out from your input.',
      },
      {
        heading: 'Requirements',
        body: 'What it must do:\n- Answer questions, and handle refund requests for late or cold orders.\n- Decide refunds by the written policy, never by the model\'s judgement.\n- Ask a person before any refund over ₹200, and wait however long they take.\n- Never refund twice, even after a retry or a restart.\n\nHow well it must do it:\n- A deploy while a refund waits for approval loses nothing.\n- Every step can be inspected afterwards.',
      },
      {
        heading: 'Capacity estimates',
        body: '- A refund that needs approval runs 6 nodes: classify, lookup_order, check_policy, approve, issue_refund, write_reply. Only 2 call a model.\n- LangGraph saves a checkpoint for the input, one as the graph starts and one per step: 8 for that run.\n- 10k refund chats a day × 8 checkpoints = 80k rows a day in the checkpoints table; at a few KB each, a few hundred MB a day. Delete old threads on a schedule.\n- The default recursion limit is 25 steps, far above this graph\'s 6.',
      },
      {
        heading: 'Step by step',
        body: '1. The Customer (Chat App) writes; the server calls graph.invoke() with a thread_id, and the Checkpointer (Postgres) saves the input.\n2. classify (LLM) asks the Model Provider for the intent, order and reason, as structured output.\n3. Route by Intent sends questions to answer_faq (LLM) and refunds to lookup_order.\n4. lookup_order reads the order from the Orders API.\n5. check_policy (code) applies the refund rules; Needs Approval? routes to issue_refund, approve (interrupt) or write_reply (LLM).\n6. approve (interrupt) pauses the run; the Support Lead decides, and the server resumes the thread with Command({ resume }).\n7. issue_refund calls the Payments API with an idempotency key.\n8. write_reply (LLM) writes the message for the Customer (Chat App).',
      },
      {
        heading: 'Components',
        body: "- Customer (Chat App): sends the message and gets the reply.\n- classify (LLM): asks the model for intent, order and reason as structured fields.\n- Route by Intent: a conditional edge: questions one way, refunds the other.\n- answer_faq (LLM): answers questions from the help articles.\n- lookup_order: plain code that reads the order into state.\n- check_policy (code): applies the refund rules; decides auto, needs approval or not eligible.\n- Needs Approval?: a conditional edge on the policy's decision.\n- approve (interrupt): pauses the run with interrupt() until a person decides.\n- issue_refund: pays the refund through the Payments API, with an idempotency key.\n- write_reply (LLM): turns the outcome into a short message.\n- Support Lead: approves or rejects paused refunds.\n- Model Provider: the hosted LLM the model nodes call.\n- Orders API: the source of order times and amounts.\n- Payments API: issues refunds and ignores repeats with the same key.\n- Checkpointer (Postgres): saves the state after every step, per thread.",
      },
      {
        heading: 'Key decisions',
        body: '- Graph or agent loop: a graph when the steps are known and some must always happen; an agent loop (createAgent) when the model should choose freely. You can mix them: an agent can be one node of a graph.\n- Code nodes for rules, model nodes for language: the model classifies and writes; code decides money.\n- Reducers: messages append; everything else replaces. Pick per key.\n- PostgresSaver in production: MemorySaver loses every paused run on restart.\n- Make side effects safe to repeat: a resumed node runs again from its start, and replays re-run nodes; idempotency keys stop double payments.\n- Keep the state small and serialisable: it is saved after every step.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The graph runs in your normal servers; any server can resume any thread, because the state is in Postgres.\n- A crash mid-step: the run restarts from the last checkpoint, so the step that was running runs again. That is why side effects need idempotency keys.\n- Runaway loops: the recursion limit (25 steps by default) raises GraphRecursionError; add your own retry counters in state too.\n- Checkpoint tables grow with every step: delete finished threads after a retention period.\n- Paused runs can wait for days: show them in a queue with their age, and expire stale ones.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- When would you build a graph instead of using an agent loop?\n- What is a reducer, and why do messages need one?\n- How does a run survive a server restart while waiting for approval?\n- What happens to code before interrupt() when the run resumes?\n- How would you stop a refund being paid twice?\n- How would you debug a wrong refund from last week?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'The graph: state, nodes and edges',
        language: 'javascript',
        source: `import { Annotation, END, START, StateGraph } from '@langchain/langgraph'

const State = Annotation.Root({
  // messages append; every other key is replaced by the latest update
  messages: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  intent: Annotation(),
  order: Annotation(),
  decision: Annotation(),
  amount_inr: Annotation(),
})

const graph = new StateGraph(State)
  .addNode('classify', classify) // model call, structured output
  .addNode('answer_faq', answerFaq)
  .addNode('lookup_order', async (s) => ({ order: await ordersApi.get(s.order_id) }))
  .addNode('check_policy', checkPolicy) // plain code: the model never decides money
  .addNode('approve', approve)
  .addNode('issue_refund', issueRefund)
  .addNode('write_reply', writeReply)
  .addEdge(START, 'classify')
  .addConditionalEdges('classify', (s) => (s.intent === 'refund' ? 'lookup_order' : 'answer_faq'), ['lookup_order', 'answer_faq'])
  .addEdge('lookup_order', 'check_policy')
  .addConditionalEdges(
    'check_policy',
    (s) => ({ auto: 'issue_refund', needs_approval: 'approve', not_eligible: 'write_reply' })[s.decision],
    ['issue_refund', 'approve', 'write_reply'],
  )
  .addEdge('issue_refund', 'write_reply')
  .addEdge('answer_faq', END)
  .addEdge('write_reply', END)`,
        versions: [
          {
            language: 'python',
            source: `import operator
from typing import Annotated, TypedDict
from langgraph.graph import END, START, StateGraph

class State(TypedDict, total=False):
    messages: Annotated[list, operator.add]  # append; other keys are replaced
    intent: str
    order: dict
    decision: str
    amount_inr: int

builder = StateGraph(State)
builder.add_node("classify", classify)  # model call, structured output
builder.add_node("answer_faq", answer_faq)
builder.add_node("lookup_order", lambda s: {"order": orders_api.get(s["order_id"])})
builder.add_node("check_policy", check_policy)  # plain code
builder.add_node("approve", approve)
builder.add_node("issue_refund", issue_refund)
builder.add_node("write_reply", write_reply)
builder.add_edge(START, "classify")
builder.add_conditional_edges("classify", lambda s: "lookup_order" if s["intent"] == "refund" else "answer_faq")
builder.add_edge("lookup_order", "check_policy")
builder.add_conditional_edges(
    "check_policy",
    lambda s: {"auto": "issue_refund", "needs_approval": "approve", "not_eligible": "write_reply"}[s["decision"]],
)
builder.add_edge("issue_refund", "write_reply")
builder.add_edge("answer_faq", END)
builder.add_edge("write_reply", END)`,
          },
          {
            language: 'java',
            source: `// LangGraph4j: a community port of LangGraph to Java, with the same ideas.
import static org.bsc.langgraph4j.StateGraph.END;
import static org.bsc.langgraph4j.StateGraph.START;
import static org.bsc.langgraph4j.action.AsyncEdgeAction.edge_async;
import static org.bsc.langgraph4j.action.AsyncNodeAction.node_async;

import java.util.Map;
import org.bsc.langgraph4j.CompileConfig;
import org.bsc.langgraph4j.StateGraph;
import org.bsc.langgraph4j.checkpoint.MemorySaver;

var graph = new StateGraph<>(RefundState.SCHEMA, RefundState::new)
    .addNode("classify", node_async(RefundNodes::classify))
    .addNode("lookup_order", node_async(RefundNodes::lookupOrder))
    .addNode("check_policy", node_async(RefundNodes::checkPolicy)) // plain code
    .addNode("issue_refund", node_async(RefundNodes::issueRefund))
    .addNode("write_reply", node_async(RefundNodes::writeReply))
    .addEdge(START, "classify")
    .addEdge("classify", "lookup_order")
    .addEdge("lookup_order", "check_policy")
    .addConditionalEdges("check_policy", edge_async(s -> s.decision()),
        Map.of("auto", "issue_refund", "not_eligible", "write_reply"))
    .addEdge("issue_refund", "write_reply")
    .addEdge("write_reply", END)
    .compile(CompileConfig.builder().checkpointSaver(new MemorySaver()).build());`,
          },
        ],
      },
      {
        title: 'Pause for a person, resume later',
        language: 'javascript',
        source: `import { Command, interrupt } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

// Nothing with side effects before interrupt(): on resume this node runs again from the top.
function approve(state) {
  const ok = interrupt({ order_id: state.order.id, amount_inr: state.amount_inr })
  return { approved: ok === true }
}

const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL)
await checkpointer.setup() // creates the checkpoint tables once
const app = graph.compile({ checkpointer })

const config = { configurable: { thread_id: 'support-8812' } }
const paused = await app.invoke({ messages: ['Order 4102 arrived cold. Refund it please.'] }, config)
console.log(paused.__interrupt__) // [{ value: { order_id: '4102', amount_inr: 640 } }]

// Hours later, on any server, when the lead clicks Approve:
const done = await app.invoke(new Command({ resume: true }), config)`,
        versions: [
          {
            language: 'python',
            source: `from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.types import Command, interrupt

def approve(state):
    # Nothing with side effects before interrupt(): on resume this node runs again from the top.
    ok = interrupt({"order_id": state["order"]["id"], "amount_inr": state["amount_inr"]})
    return {"approved": ok is True}

with PostgresSaver.from_conn_string(DATABASE_URL) as checkpointer:
    checkpointer.setup()
    app = builder.compile(checkpointer=checkpointer)
    config = {"configurable": {"thread_id": "support-8812"}}
    paused = app.invoke({"messages": ["Order 4102 arrived cold. Refund it please."]}, config)
    print(paused["__interrupt__"])

    # When the lead clicks Approve:
    done = app.invoke(Command(resume=True), config)`,
          },
        ],
      },
      {
        title: 'History and time travel',
        language: 'javascript',
        source: `const config = { configurable: { thread_id: 'support-8812' } }

// Newest first: the state after every step of this thread.
for await (const snapshot of app.getStateHistory(config)) {
  console.log(snapshot.metadata.step, snapshot.next, snapshot.values.decision)
}

// After fixing a bug in write_reply, run again from the checkpoint before it.
// Nodes before that checkpoint are skipped; nodes after it run again.
const before = { configurable: { thread_id: 'support-8812', checkpoint_id: '1f0a…' } }
await app.invoke(null, before)`,
      },
    ],
    related: ['LangChain', 'AI agent with tools', 'Job scheduler', 'Idempotent payments', 'Agent context'],
  },
  simulator,
}
