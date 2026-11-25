# LangGraph: Stateful Agent Workflows

> 💡 **TL;DR**: **LangGraph** is a free, open-source library (JavaScript and Python) for building apps around **large language models (LLMs)** as a **graph**: **nodes** are functions that each do one job, **edges** decide what runs next, and every node reads and updates one shared **state**. A **checkpointer** saves that state after every step under a **thread_id**, so a run can **pause for a person** with `interrupt()`, survive a server restart, **resume** later with `Command({ resume })`, and be **replayed** from any earlier step. You choose the steps and keep rules in plain code; the model is used only where language helps. LangChain's `createAgent` runs on LangGraph.

## At a glance

| Question | Answer |
|---|---|
| What it is | An open-source library for LLM workflows and agents as graphs |
| Version 1.0 | October 2025, with LangChain 1.0 |
| State | One object all nodes share; each key has a reducer |
| Reducer | How an update combines with the old value: replace, or append |
| Node | A function: takes the state, returns an update |
| Edge | Fixed ("then run X") or conditional (a function names the next node) |
| Super-step | One tick of the graph; nodes in the same tick run in parallel |
| Checkpointer | Saves the state at every super-step, per thread |
| Pause | `interrupt()` stops the run; `Command({ resume })` continues it |
| Recursion limit | 25 super-steps by default, then `GraphRecursionError` |

## What LangGraph is, and why not just an agent loop

An **agent loop** (like LangChain's `createAgent`) lets the model pick every step: it asks for a tool, the tool runs, and the model decides again. That is flexible, but some jobs need steps that always happen.

Take a refund request in a food-delivery app: "Order 4102 arrived cold. Refund it please." The business wants:

1. Always look the order up; never trust the model's idea of the amount.
2. Always apply the written policy, in code: a photo within 2 hours of delivery, and a person must approve anything over ₹200.
3. Wait for that person, however long they take, without a server waiting.
4. Never pay twice, even after a retry or a restart.

In a free agent loop, the model could skip step 1 or misread the policy. **LangGraph** lets you draw the steps instead, and still use the model where language helps (understanding the message, writing the reply).

Without LangGraph, you'd write this as your own state machine plus a database table for progress, your own resume logic and your own history. LangGraph gives you all of that.

## State, nodes and edges

Three ideas make up every graph:

- **State** is one object every node reads. Each key has a **reducer**: a function that combines a node's update with the old value. With no reducer, the update **replaces** the value. For `messages` you want **append**, so two nodes that each add a message keep both.
- **Nodes** are functions: `(state) => update`. A node returns only the keys it changes.
- **Edges** say what runs next. A **conditional edge** is a small function that reads the state and returns the next node's name.

This code builds the refund graph. `Annotation.Root` declares the state's keys:

```javascript
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'

const State = Annotation.Root({
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
  .addEdge('write_reply', END)
```

`START` and `END` are LangGraph's built-in entry and exit. The last argument of `addConditionalEdges` lists the nodes the function may return, so LangGraph can check the graph and draw it. Before running it, you **compile** the graph (below), which checks the structure and attaches the checkpointer.

## Follow one refund all the way through

"Order 4102 arrived cold. Refund it please." Order 4102 was delivered at 20:15; the complaint, with a photo, came at 20:31; the food cost ₹640.

| Step | Node | State update | Checkpoint |
|---|---|---|---|
| -1 | (input) | `messages: ["Order 4102 arrived cold…"]` | 1 |
| 0 | (start) | none | 2 |
| 1 | classify (LLM) | `intent: "refund", order_id: "4102", reason: "cold"` | 3 |
| 2 | lookup_order | `order: { food: 640, delivered: "20:15", … }` | 4 |
| 3 | check_policy (code) | photo 16 min after delivery (20:31 − 20:15), within 120; ₹640 > ₹200, so `decision: "needs_approval", amount_inr: 640` | 5 |
| 4 | approve (interrupt) | pauses: the run stops and returns `__interrupt__` | (waits) |
| | | the server restarts; the Support Lead approves; the run resumes | |
| 4 | approve (interrupt) | runs again from its first line; `approved: true` | 6 |
| 5 | issue_refund | `refund_id: "rf_9K31"` (with an idempotency key) | 7 |
| 6 | write_reply (LLM) | `messages: ["Done: ₹640 is back in your wallet…"]` | 8 |

Six nodes ran, and only two called a model. The amounts, times and decision came from data and code.

## Checkpoints: save every step

A **checkpointer** saves a **checkpoint** (a snapshot of the whole state) at every **super-step**: one tick of the graph, in which every node that's due runs, in parallel if there are several. Each run belongs to a **thread**, named by the `thread_id` you pass in:

```javascript
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL)
await checkpointer.setup() // creates the checkpoint tables once
const app = graph.compile({ checkpointer })

const config = { configurable: { thread_id: 'support-8812' } }
await app.invoke({ messages: ['Order 4102 arrived cold. Refund it please.'] }, config)
```

`compile` checks the graph and attaches the checkpointer. `thread_id` is the key for everything saved: the same id continues the same run or conversation; a new id starts fresh.

| Checkpointer | Package | Survives a restart? |
|---|---|---|
| `MemorySaver` | Comes with LangGraph | No: kept in the process's memory, for tests |
| `SqliteSaver` | `@langchain/langgraph-checkpoint-sqlite` | Yes, on one machine |
| `PostgresSaver` | `@langchain/langgraph-checkpoint-postgres` | Yes: use in production |

`PostgresSaver` keeps checkpoints in tables named `checkpoints`, `checkpoint_writes` (results of nodes in a step that hasn't finished) and `checkpoint_blobs` (large values). That's what the Data model tab shows.

## Pause for a person: interrupt and resume

`interrupt(value)` inside a node stops the run. The state up to there is already saved, so the server returns at once; nothing waits in memory. The value you pass shows up in the result's `__interrupt__`:

```javascript
import { Command, interrupt } from '@langchain/langgraph'

// Nothing with side effects before interrupt(): on resume this node runs again from the top.
function approve(state) {
  const ok = interrupt({ order_id: state.order.id, amount_inr: state.amount_inr })
  return { approved: ok === true }
}

const paused = await app.invoke({ messages: ['Order 4102 arrived cold. Refund it please.'] }, config)
console.log(paused.__interrupt__) // [{ value: { order_id: '4102', amount_inr: 640 } }]

// Hours later, on any server, when the lead clicks Approve:
const done = await app.invoke(new Command({ resume: true }), config)
```

`Command({ resume: true })` is the input that continues a paused thread; `true` becomes the return value of `interrupt()`. Four rules from the docs:

- **The node runs again from its first line** on resume. Anything before `interrupt()` happens twice, so put side effects after it, or in another node.
- **Don't wrap `interrupt()` in a `try`/`catch`** that swallows errors: it works by throwing a special signal.
- **Keep interrupts in the same order** in a node: resume values are matched by position.
- **Pass only plain data** (JSON) to `interrupt()`: it's saved in the checkpoint.

## Side effects: make them safe to repeat

A node can run more than once: after a resume, after a crash mid-step (the run restarts from the last checkpoint), or when you replay history. For a node that only reads, that's harmless. For `issue_refund`, it would pay twice.

So `issue_refund` sends an **idempotency key** (an id for one intended action, reused on every attempt) made from the thread and order: `refund:support-8812:4102`. The Payments API stores the key with the refund; a second request with the same key gets the first refund back instead of a new payment. The `refunds` table's unique `idempotency_key` column enforces it.

## History and time travel

Because every step is a checkpoint, you can list a thread's history and run it again from any point, for example after fixing a bug in `write_reply`:

```javascript
for await (const snapshot of app.getStateHistory(config)) {
  console.log(snapshot.metadata.step, snapshot.next, snapshot.values.decision)
}

const before = { configurable: { thread_id: 'support-8812', checkpoint_id: '1f0a…' } }
await app.invoke(null, before)
```

`getStateHistory` returns snapshots, newest first; `next` lists the nodes due to run after that checkpoint. Invoking with `null` input and a `checkpoint_id` skips the nodes before that checkpoint and runs the ones after it again. This is **time travel**, and it's one more reason side effects need idempotency keys.

## The numbers, worked out

- **Checkpoints per run**: 1 for the input + 1 as the graph starts + 1 per completed step. The refund that needed approval completed 6 steps: 1 + 1 + 6 = **8** checkpoints.
- **Table growth**: 10k refund chats a day × 8 = **80k checkpoint rows a day**. At a few KB each, that's a few hundred MB a day, so delete finished threads after a retention period (say 30 days).
- **Recursion limit**: 25 super-steps by default in LangGraph.js. This graph uses at most 6, so a run that hits 25 is looping. You can raise it per run with `recursionLimit` in the config, but add your own retry counter in state too.

## What it costs and where it stops

- **Free library** (MIT licence); you pay for the model and your own database. LangChain also sells hosting for graphs, which is optional.
- **More code than an agent loop**: you design the nodes and edges yourself.
- **Every step writes to the checkpointer**: a few milliseconds and a few KB each. Keep the state small.
- **State must be serialisable**: no open connections or class instances in state.
- **Not a general job scheduler**: for plain background jobs with no model, a queue or workflow engine is simpler.

## How to choose

- **The model should choose freely among tools?** An agent loop: [LangChain's `createAgent`](/?topic=langchain&read).
- **Some steps must always happen, in order, or rules must be code?** A LangGraph graph.
- **Both?** A graph whose nodes include an agent.
- **Waiting for people, or runs that last hours?** LangGraph with `PostgresSaver` and `interrupt()`.
- **Plain background jobs with no model?** A queue or a workflow engine such as Temporal or Airflow.
- **Java?** LangGraph4j is a separate community port with the same ideas.

## ⚠️ Critical Mistakes

- **`MemorySaver` in production.** A restart loses every paused approval. Use Postgres.
- **Side effects before `interrupt()`.** They run again on resume. Put them after it, or in their own node.
- **Letting the model decide money or permissions.** Use a plain-code node and route on its result.
- **Non-idempotent side effects.** Crashes, resumes and replays re-run nodes; send idempotency keys.
- **No reducer on `messages`.** Each node's message replaces the last one, and the conversation is lost.
- **Huge state.** It's saved at every step; store ids, not whole documents.

## Interview Q&As

**Q: When would you build a graph instead of using an agent loop?**

A: When some steps must always run in a fixed order, when rules must be enforced in code, or when the run must wait for people or last a long time. An agent loop suits open-ended tasks where the model should choose its own steps.

**Q: What is a reducer, and why do messages need one?**

A: A reducer combines a node's update with the current value of a state key. Without one, the update replaces the value. Messages use an append reducer, so every node's message is kept.

**Q: How does a run survive a server restart while waiting for approval?**

A: The state is checkpointed after every step in Postgres. `interrupt()` stops the run with nothing in memory. When the approval arrives, any server calls `invoke(new Command({ resume }))` with the same `thread_id`, and LangGraph loads the last checkpoint.

**Q: What happens to code before `interrupt()` when the run resumes?**

A: It runs again, because the node restarts from its first line. So side effects go after `interrupt()` or in a separate node, and anything that must not repeat uses an idempotency key.

## Related topics

- [LangChain](/?topic=langchain&read): models, tools and `createAgent`, which runs on LangGraph.
- [AI Agent with Tools](/?topic=ai-agent&read): the agent loop and its safety limits.
- [Idempotent Payments](/?topic=payment-idempotency&read): making a repeated refund harmless.
- [Job Scheduler](/?topic=job-scheduler&read): when a plain job queue is enough.

## Sources

- LangChain: [LangChain and LangGraph 1.0](https://www.langchain.com/blog/langchain-langgraph-1dot0) (22 October 2025)
- LangGraph docs (JavaScript): [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) (recursion limit 25, `GraphRecursionError`)
- LangGraph docs (JavaScript): [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- LangGraph docs (JavaScript): [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)
- LangGraph4j: [How to add persistence](https://langgraph4j.github.io/langgraph4j/how-tos/persistence)

## Why This Matters

As LLM apps move from chat to doing real work (refunds, bookings, approvals), teams need steps that always happen, rules in code, waits for people and a record of every step. LangGraph is one of the most used ways to build that. Knowing state and reducers, checkpoints, `interrupt()` and resume, and why side effects need idempotency keys lets you design agent workflows that are safe to run on real money.
