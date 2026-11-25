import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator runs LangChain's agent loop (createAgent: model → tool calls → tools → model)
// over a food-delivery support case with real (fictional) data: an orders API, help articles
// searched by a retriever, and a refund tool behind human approval. The model is a rule-based
// stand-in so it runs in the browser with no LLM. What is real: the loop, the messages, the
// two providers' wire formats for the same tool call (Anthropic `tool_use` blocks, OpenAI
// `tool_calls` with JSON-string arguments) and how LangChain turns both into one `tool_calls`
// list, the interrupt and resume of humanInTheLoopMiddleware, and the token counts, measured
// from the actual messages at about 4 characters a token.

const NOW = '20:20'

const ORDER = {
  order_id: '4101',
  restaurant: 'Biryani Blues',
  items: ['Chicken biryani', 'Raita'],
  food_total_inr: 412,
  delivery_fee_inr: 49,
  promised_at: '19:40',
  status: 'on the way',
  rider_km_away: 1.2,
  eta: '20:26',
}

const HELP = [
  { id: 'late-delivery', text: 'If your order arrives more than 30 minutes after the promised time, we refund the delivery fee to your wallet.' },
  { id: 'cold-food', text: 'If food arrives cold or spilled, share a photo within 2 hours of delivery and we refund the affected items.' },
  { id: 'cancel', text: 'You can cancel an order free of charge until the restaurant accepts it.' },
  { id: 'wallet', text: 'Wallet refunds arrive instantly. Refunds to cards take 5 to 7 working days.' },
]

const STOP = new Set('a an the to of and or if we you your is it on in for do does my me please our with by until this that be are'.split(' '))
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]+/g)?.filter((w) => !STOP.has(w)) ?? [])

/** Keyword overlap (Jaccard): a stand-in for embedding similarity, so the scores are real numbers you can check. */
function score(query: string, text: string) {
  const q = words(query)
  const t = words(text)
  const both = [...q].filter((w) => t.has(w)).length
  return both / new Set([...q, ...t]).size
}

function searchHelp(query: string) {
  return HELP.map((h) => ({ ...h, score: Number(score(query, h.text).toFixed(2)) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const LATE = minutes(NOW) - minutes(ORDER.promised_at) // 40

const QUESTIONS: Record<string, 'where' | 'refund' | 'policy'> = {
  'Where is my order 4101?': 'where',
  'Order 4101 is 40 minutes late. Please refund the delivery fee.': 'refund',
  'Do you refund cold food?': 'policy',
}
const MODELS = ['anthropic:claude-sonnet-5', 'openai:gpt-5.5']
const APPROVAL: Record<string, 'approve' | 'reject' | 'none'> = {
  'Ask a person before refunds; the lead approves': 'approve',
  'Ask a person before refunds; the lead rejects': 'reject',
  'No approval step': 'none',
}

const SYSTEM = 'You are the support assistant for a food-delivery app. Use the tools to look things up; never guess order details. Refunds follow the help articles. Be brief.'
const TOOLS = [
  { name: 'get_order', description: "Look up an order's status, promised time and fees.", args: '{ order_id: string }' },
  { name: 'search_help', description: 'Search the help articles. Returns the 2 best passages.', args: '{ query: string }' },
  { name: 'refund_delivery_fee', description: "Refund an order's delivery fee to the customer's wallet.", args: '{ order_id: string, amount_inr: number }' },
]
const tokensOf = (text: string) => Math.ceil(text.length / 4)
const SETUP_TOKENS = tokensOf(SYSTEM) + tokensOf(JSON.stringify(TOOLS))

type ToolName = 'get_order' | 'search_help' | 'refund_delivery_fee'
interface Call {
  id: string
  name: ToolName
  args: Record<string, string | number>
}

const TOOL_NODE: Record<ToolName, string[]> = {
  get_order: ['Orders API'],
  search_help: ['Help Docs Retriever', 'Vector Store'],
  refund_delivery_fee: ['Payments API'],
}

/** The same tool call as each provider sends it, and as LangChain hands it to your code. */
function wire(model: string, call: Call) {
  const anthropic = model.startsWith('anthropic')
  const raw = anthropic
    ? JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${call.id}`, name: call.name, input: call.args }] })
    : JSON.stringify({ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call_${call.id}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } })
  const normal = JSON.stringify({ tool_calls: [{ name: call.name, args: call.args, id: `${anthropic ? 'toolu' : 'call'}_${call.id}` }] })
  return `${anthropic ? 'Anthropic' : 'OpenAI'} sends:\n${raw}\n\nLangChain gives your code (AIMessage):\n${normal}`
}

function run(question: string, kind: 'where' | 'refund' | 'policy', model: string, approval: 'approve' | 'reject' | 'none') {
  const steps: Trace['steps'] = []
  const messages: string[] = [question]
  let read = 0
  let written = 0
  let modelCalls = 0
  let toolCalls = 0
  let refunded = 0
  let paused = false
  const context = () => SETUP_TOKENS + messages.reduce((t, m) => t + tokensOf(m), 0)

  steps.push({
    text: `The Customer asks: "${question}". The App Server calls agent.invoke() with the message and a thread_id. createAgent's loop starts: the system prompt, ${TOOLS.length} tool descriptions and the question go to the model (${context()} tokens).`,
    nodes: ['Customer (Chat App)', 'createAgent Loop'],
    data: `await agent.invoke(\n  { messages: [{ role: "user", content: ${JSON.stringify(question)} }] },\n  { configurable: { thread_id: "chat-8812" } },\n)\n\ntools: ${TOOLS.map((t) => t.name).join(', ')}`,
  })

  // What the stand-in model asks for next, given what it has seen.
  const plan: Call[] =
    kind === 'where'
      ? [{ id: '01', name: 'get_order', args: { order_id: '4101' } }]
      : kind === 'policy'
        ? [{ id: '01', name: 'search_help', args: { query: 'refund cold food' } }]
        : [
            { id: '01', name: 'get_order', args: { order_id: '4101' } },
            { id: '02', name: 'search_help', args: { query: 'late delivery refund delivery fee' } },
            { id: '03', name: 'refund_delivery_fee', args: { order_id: '4101', amount_inr: ORDER.delivery_fee_inr } },
          ]

  for (const call of plan) {
    modelCalls++
    const seen = context()
    read += seen
    const callText = JSON.stringify(call)
    written += tokensOf(callText)
    messages.push(callText)
    steps.push({
      text: `Model call ${modelCalls}: the Chat Model Interface turns LangChain's messages into ${model.startsWith('anthropic') ? "Anthropic's" : "OpenAI's"} request format and sends it. The model answers with a tool call, not text. Each provider writes tool calls differently; LangChain turns them into one shape, so the rest of your code never changes when you switch with "${model}".`,
      nodes: ['createAgent Loop', 'Chat Model Interface', 'Model Provider (Anthropic / OpenAI)'],
      data: `${wire(model, call)}\n\nthe model read ${seen} tokens for this call`,
    })

    if (call.name === 'refund_delivery_fee' && approval !== 'none') {
      paused = true
      steps.push({
        text: `Tool Calls? says yes, but humanInTheLoopMiddleware is set to stop refund_delivery_fee. It raises an interrupt: the run pauses and the Checkpointer (Postgres) saves the whole conversation under thread chat-8812. The App Server shows the request to a Support Lead. Nothing has been refunded yet, and no server has to wait: the run can resume on any machine, minutes or hours later.`,
        nodes: ['Tool Calls?', 'Middleware', 'Checkpointer (Postgres)', 'Support Lead'],
        data: `result.__interrupt__[0].value =\n${JSON.stringify(
          { actionRequests: [{ name: call.name, args: call.args, description: 'Refunds need a person' }], reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }] },
          null,
          1,
        )}`,
      })
      const decision = approval === 'approve' ? { type: 'approve' } : { type: 'reject', message: 'Refunds over the policy need a photo first.' }
      steps.push({
        text:
          approval === 'approve'
            ? `The Support Lead approves. The App Server resumes the same thread with a Command. The agent loads its saved state from the Checkpointer and runs the tool with the original arguments.`
            : `The Support Lead rejects it, with a reason. The tool never runs. The middleware hands the reason back to the model as the tool's result, so the model can explain it to the customer.`,
        nodes: ['Support Lead', 'Middleware', 'Checkpointer (Postgres)', 'createAgent Loop'],
        data: `await agent.invoke(\n  new Command({ resume: { decisions: [${JSON.stringify(decision)}] } }),\n  { configurable: { thread_id: "chat-8812" } },\n)`,
      })
      if (approval === 'reject') {
        const result = `Rejected by a person: ${decision.message}`
        messages.push(result)
        continue
      }
    }

    toolCalls++
    let result: string
    let text: string
    if (call.name === 'get_order') {
      result = JSON.stringify(ORDER)
      text = `Tool Calls? says yes, so the Tool Runner runs get_order against the Orders API. The result goes back into the conversation as a ToolMessage, tied to the call's id.`
    } else if (call.name === 'search_help') {
      const hits = searchHelp(String(call.args.query))
      result = JSON.stringify(hits.map(({ id, text: t, score: s }) => ({ id, score: s, text: t })))
      text = `The Tool Runner runs search_help. The Help Docs Retriever scores every help article against the query and returns the best 2 from the Vector Store. Here the score is plain keyword overlap so you can check it; a real retriever compares embeddings.`
    } else {
      refunded = Number(call.args.amount_inr)
      result = JSON.stringify({ refund_id: 'rf_77Q2', order_id: '4101', amount_inr: refunded, to: 'wallet', status: 'done' })
      text = approval === 'none' ? `No middleware stops it, so the Tool Runner calls the Payments API straight away: ₹${refunded} goes back. Fine here, because the order really is ${LATE} minutes late; but nothing would have stopped a wrong refund either.` : `The Tool Runner calls the Payments API: ₹${refunded} goes back to the wallet.`
    }
    messages.push(result)
    steps.push({ text, nodes: ['Tool Calls?', 'Tool Runner', ...TOOL_NODE[call.name]], data: `${call.name}(${JSON.stringify(call.args)})\n→ ${result}` })
  }

  modelCalls++
  read += context()
  const answer =
    kind === 'where'
      ? `Your order from ${ORDER.restaurant} is on the way. The rider is ${ORDER.rider_km_away} km away and should reach you by ${ORDER.eta}. Sorry, it's ${LATE} minutes past the promised ${ORDER.promised_at}.`
      : kind === 'policy'
        ? `Yes. If food arrives cold or spilled, share a photo within 2 hours of delivery and we refund the affected items. [cold-food]`
        : approval === 'reject'
          ? `I've asked a colleague, and they need a photo of the order before refunding. Please share one here.`
          : `Done: ₹${refunded} delivery fee refunded to your wallet, because the order is ${LATE} minutes late (our limit is 30). It's there now.`
  written += tokensOf(answer)
  steps.push({
    text: `Model call ${modelCalls}: the model has what it needs and answers in text. Tool Calls? says no, so the loop ends. The Checkpointer saves the thread, so a follow-up question ("and when does it reach me?") continues the same conversation.`,
    nodes: ['Model Provider (Anthropic / OpenAI)', 'Tool Calls?', 'Checkpointer (Postgres)', 'Customer (Chat App)'],
    data: `"${answer}"`,
  })
  steps.push({
    text: `Every model call and tool call above is recorded as one trace in Traces (LangSmith), with its inputs, outputs, tokens and time, so you can see why the agent did what it did.`,
    nodes: ['createAgent Loop', 'Traces (LangSmith)'],
    data: `model calls: ${modelCalls} · tool calls: ${toolCalls}${paused ? ' · paused once for a person' : ''}\ntokens read: ${read.toLocaleString('en-IN')} · written: ${written}\nrefunded: ₹${refunded}`,
  })
  return { steps, modelCalls, toolCalls, refunded, read }
}

const simulator: Simulator = {
  fields: [
    { id: 'question', label: 'The customer asks', options: Object.keys(QUESTIONS) },
    { id: 'model', label: 'Model', options: MODELS },
    { id: 'approval', label: 'Refunds', options: Object.keys(APPROVAL) },
  ],
  defaults: {
    question: 'Order 4101 is 40 minutes late. Please refund the delivery fee.',
    model: MODELS[0],
    approval: 'Ask a person before refunds; the lead approves',
  },
  run(values) {
    const kind = QUESTIONS[values.question] ?? 'refund'
    const model = MODELS.includes(values.model) ? values.model : MODELS[0]
    const approval = APPROVAL[values.approval] ?? 'approve'
    const r = run(values.question in QUESTIONS ? values.question : Object.keys(QUESTIONS)[1], kind, model, approval)
    return {
      input: `${kind === 'where' ? 'where is it' : kind === 'policy' ? 'cold food policy' : 'refund the fee'} · ${model}${kind === 'refund' ? ` · ${approval === 'none' ? 'no approval' : `lead ${approval}s`}` : ''} → ${r.modelCalls} model calls, ${r.toolCalls} tool calls${r.refunded ? `, ₹${r.refunded} refunded` : ''}`,
      steps: r.steps,
    }
  },
}

export const langchain: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'langchain',
  title: 'LangChain: Building LLM Apps',
  blurb: 'Standard pieces for LLM apps: one interface for every model, tools, retrievers, and an agent loop with middleware',
  guides: ['what-is-an-ai-agent', 'how-does-chatgpt-work', 'the-open-source-ai-stack'],
  takeaways: [
    'LangChain gives every model provider one interface, so switching from one provider to another is a one-line change.',
    'createAgent is the standard agent loop: the model asks for tools, LangChain runs them, and the loop ends when the model answers in text.',
    'Each provider writes tool calls differently; LangChain turns them all into one tool_calls list for your code.',
    'Middleware hooks run before and after each model and tool call, for approvals, trimming history, redacting personal data and limits.',
    'A checkpointer saves each conversation under a thread_id, which is what lets a run pause for a person and carry on later.',
    'createAgent runs on LangGraph; when you need your own steps, branches and loops, drop down to LangGraph itself.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'lc', label: 'LangChain (in your server)' },
      { id: 'tools', label: 'Tools' },
    ],
    nodes: [
      { id: 'user', label: 'Customer (Chat App)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'loop', label: 'createAgent Loop', shape: 'rectangle', color: 'violet', group: 'lc' },
      { id: 'mw', label: 'Middleware', shape: 'rectangle', color: 'violet', group: 'lc' },
      { id: 'chat', label: 'Chat Model Interface', shape: 'rectangle', color: 'violet', group: 'lc' },
      { id: 'provider', label: 'Model Provider (Anthropic / OpenAI)', shape: 'cloud', color: 'violet', group: null },
      { id: 'decide', label: 'Tool Calls?', shape: 'diamond', color: 'violet', group: 'lc' },
      { id: 'runner', label: 'Tool Runner', shape: 'rectangle', color: 'orange', group: 'lc' },
      { id: 'orders', label: 'Orders API', shape: 'rectangle', color: 'violet', group: 'tools' },
      { id: 'retriever', label: 'Help Docs Retriever', shape: 'rectangle', color: 'violet', group: 'tools' },
      { id: 'vector', label: 'Vector Store', shape: 'rectangle', color: 'green', group: 'tools' },
      { id: 'payments', label: 'Payments API', shape: 'rectangle', color: 'violet', group: 'tools' },
      { id: 'lead', label: 'Support Lead', shape: 'ellipse', color: 'blue', group: null },
      { id: 'ckpt', label: 'Checkpointer (Postgres)', shape: 'rectangle', color: 'green', group: null },
      { id: 'traces', label: 'Traces (LangSmith)', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'user', to: 'loop', label: 'invoke(messages, thread_id)', dashed: false },
      { from: 'loop', to: 'mw', label: 'before / after hooks', dashed: false },
      { from: 'loop', to: 'chat', label: 'messages + tools', dashed: false },
      { from: 'chat', to: 'provider', label: "provider's format", dashed: false },
      { from: 'provider', to: 'decide', label: 'AIMessage', dashed: true },
      { from: 'decide', to: 'runner', label: 'yes', dashed: false },
      { from: 'decide', to: 'user', label: 'no: answer', dashed: true },
      { from: 'mw', to: 'lead', label: 'interrupt: approve?', dashed: true },
      { from: 'runner', to: 'orders', label: 'get_order', dashed: false },
      { from: 'runner', to: 'retriever', label: 'search_help', dashed: false },
      { from: 'retriever', to: 'vector', label: 'similar passages', dashed: false },
      { from: 'runner', to: 'payments', label: 'refund_delivery_fee', dashed: false },
      { from: 'runner', to: 'loop', label: 'ToolMessage', dashed: true },
      { from: 'loop', to: 'ckpt', label: 'save thread', dashed: false },
      { from: 'loop', to: 'traces', label: 'every call', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'LangChain: Building LLM Apps',
    summary:
      'LangChain is an open-source library (for JavaScript and Python) of standard pieces for apps built on large language models: one interface for every model provider, messages, tools, retrievers and structured output. Its createAgent function runs the usual agent loop: the model asks for tools, LangChain runs them and feeds back the results, until the model answers. Middleware adds approvals, limits and clean-up around each step, and a checkpointer saves each conversation.',
    sections: [
      {
        heading: 'Overview',
        body: 'A large language model (LLM) only turns text into text. A useful app also needs the model to look things up, call your APIs, keep a conversation, and switch models without a rewrite. LangChain is the standard kit for that.\n\n- Chat models: one interface, `model.invoke(messages)`, for Anthropic, OpenAI, Google and others. You pick one with a string such as "anthropic:claude-sonnet-5".\n- Tools: ordinary functions with a name, a description and an argument schema. The model asks for them; LangChain runs them.\n- Retrievers: search your documents and return the best passages (the R in RAG, retrieval-augmented generation).\n- createAgent: the agent loop, with middleware hooks around every model and tool call.\n\nLangChain 1.0 came out in October 2025. Its createAgent runs on LangGraph, the lower-level library for building your own step-by-step workflows.\n\nThe simulator runs that loop on a food-delivery support chat. The model is a rule-based stand-in so it runs in your browser; the messages, both providers\' formats, the interrupt and the token counts are real.',
      },
      {
        heading: 'Requirements',
        body: 'What it must do:\n- Answer "where is my order?" from the real order, not a guess.\n- Answer policy questions from the help articles, citing them.\n- Refund a late order\'s delivery fee, but only after a person approves.\n- Keep the conversation, so a follow-up question still makes sense.\n\nHow well it must do it:\n- Swap the model provider without changing app code.\n- Show every model and tool call afterwards, to debug wrong answers.',
      },
      {
        heading: 'Capacity estimates',
        body: '- One question takes 2 to 4 model calls: one per tool call, plus one for the answer.\n- Every model call re-reads the whole conversation, so tokens read grow with each step: the refund chat reads about 1.1k tokens across 4 model calls, though no single message is over 100.\n- 10k chats a day × 3 model calls = 30k model calls a day, about 0.35 a second on average.\n- The slow part is the model (often 1 to 5 seconds a call), not LangChain; stream the answer so the customer sees words straight away.',
      },
      {
        heading: 'Step by step',
        body: '1. The Customer (Chat App) sends a message; the server calls agent.invoke() with a thread_id.\n2. The createAgent Loop runs any Middleware "before model" hooks, then gives the messages and tool descriptions to the Chat Model Interface.\n3. The Chat Model Interface converts them to the provider\'s format and calls the Model Provider (Anthropic / OpenAI).\n4. The reply comes back as one AIMessage. Tool Calls? checks whether it asks for tools.\n5. If yes, the Tool Runner runs each one: the Orders API, the Help Docs Retriever (which searches the Vector Store) or the Payments API. A Middleware hook can stop a call and ask the Support Lead first.\n6. The results go back into the conversation, and the loop calls the model again.\n7. When the model answers in text, Tool Calls? says no and the answer goes to the Customer (Chat App).\n8. The Checkpointer (Postgres) saves the thread after each step, and Traces (LangSmith) records every call.',
      },
      {
        heading: 'Components',
        body: "- Customer (Chat App): sends messages and shows the answers.\n- createAgent Loop: LangChain's agent: calls the model, runs tools, repeats until the model answers.\n- Middleware: hooks before and after each model and tool call: approvals, trimming history, hiding personal data, limits.\n- Chat Model Interface: one API for every provider; converts messages and tool calls to and from each provider's format.\n- Model Provider (Anthropic / OpenAI): the hosted model behind an API key.\n- Tool Calls?: the loop's decision: run the tools the model asked for, or finish with its text answer.\n- Tool Runner: runs the requested tools and wraps each result as a ToolMessage.\n- Orders API: the app's own order data, behind the get_order tool.\n- Help Docs Retriever: finds the help passages closest to a query, behind the search_help tool.\n- Vector Store: holds each help passage with its embedding (a list of numbers that captures meaning).\n- Payments API: issues refunds, behind the refund_delivery_fee tool.\n- Support Lead: the person who approves or rejects a paused refund.\n- Checkpointer (Postgres): saves each thread's state, so runs can pause, resume and continue a conversation.\n- Traces (LangSmith): records every step of every run for debugging and evaluation.",
      },
      {
        heading: 'Key decisions',
        body: '- createAgent or your own graph: createAgent when the flow is "model decides, tools run, repeat". LangGraph when you need fixed steps, branches, parallel work or long-running processes.\n- Tool descriptions are prompts: the model chooses tools by their name and description, so write them for a reader who knows nothing else.\n- Put rules in code, not the prompt: approval for money, which tools a task may use, step limits. The model can be talked out of a prompt; it can\'t be talked out of middleware.\n- A real checkpointer in production: MemorySaver forgets everything on restart; Postgres keeps paused runs and conversations.\n- Structured output (responseFormat with a schema) when another program reads the answer, instead of parsing free text.\n- Keep the provider swappable, but test each model: tool-calling quality differs between models.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The model is the bottleneck: calls take seconds and are rate-limited per key. Put an LLM gateway in front for keys, budgets and fallbacks.\n- Long conversations get expensive, because each call re-reads everything: trim or summarise old messages with middleware.\n- Tools fail: return a clear error to the model as the tool result, so it can retry or explain, and cap the steps.\n- A tool that changes something (refunds, bookings) can run twice after a retry: give it an idempotency key.\n- Tool results are untrusted text: a help article or web page can contain instructions. Keep risky tools behind approval.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What does LangChain give you over calling the provider\'s API directly?\n- How does an agent decide when to stop?\n- How would you stop the agent issuing a refund without a person?\n- How do you keep a conversation across requests, and across server restarts?\n- When would you use LangGraph instead of createAgent?\n- How do you find out why the agent gave a wrong answer?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'An agent with tools (createAgent)',
        language: 'javascript',
        source: `import { createAgent, tool } from 'langchain'
import * as z from 'zod'

// A tool is a plain function plus a name, a description and an argument schema.
// The model only sees the name and description, so write them carefully.
const getOrder = tool(async ({ order_id }) => JSON.stringify(await ordersApi.get(order_id)), {
  name: 'get_order',
  description: "Look up an order's status, promised time and fees.",
  schema: z.object({ order_id: z.string() }),
})

const searchHelp = tool(async ({ query }) => JSON.stringify(await helpRetriever.invoke(query)), {
  name: 'search_help',
  description: 'Search the help articles. Returns the 2 best passages.',
  schema: z.object({ query: z.string() }),
})

const agent = createAgent({
  model: 'anthropic:claude-sonnet-5', // "openai:gpt-5.5" works the same
  tools: [getOrder, searchHelp],
  systemPrompt: 'You are the support assistant for a food-delivery app. Use the tools; never guess order details.',
})

const result = await agent.invoke({ messages: [{ role: 'user', content: 'Where is my order 4101?' }] })
console.log(result.messages.at(-1).content)`,
        versions: [
          {
            language: 'python',
            source: `from langchain.agents import create_agent
from langchain.tools import tool

# The docstring is the description the model reads.
@tool
def get_order(order_id: str) -> dict:
    """Look up an order's status, promised time and fees."""
    return orders_api.get(order_id)

@tool
def search_help(query: str) -> list:
    """Search the help articles. Returns the 2 best passages."""
    return help_retriever.invoke(query)

agent = create_agent(
    model="anthropic:claude-sonnet-5",  # "openai:gpt-5.5" works the same
    tools=[get_order, search_help],
    system_prompt="You are the support assistant for a food-delivery app. Use the tools; never guess order details.",
)

result = agent.invoke({"messages": [{"role": "user", "content": "Where is my order 4101?"}]})
print(result["messages"][-1].content)`,
          },
          {
            language: 'java',
            source: `// Java has no official LangChain; LangChain4j is the closest library, with the same ideas.
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.anthropic.AnthropicChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.UserMessage;

public class SupportBot {
  interface SupportAgent {
    String chat(@MemoryId String customerId, @UserMessage String message);
  }

  static class OrderTools {
    @Tool("Look up an order's status, promised time and fees.")
    String getOrder(@P("the order id") String orderId) {
      return OrdersApi.get(orderId).toJson();
    }
  }

  public static void main(String[] args) {
    var model = AnthropicChatModel.builder()
        .apiKey(System.getenv("ANTHROPIC_API_KEY"))
        .modelName("claude-sonnet-5")
        .build();
    // The AI service runs the same loop: model, tool calls, results, until it answers.
    SupportAgent agent = AiServices.builder(SupportAgent.class)
        .chatModel(model)
        .tools(new OrderTools())
        .chatMemoryProvider(id -> MessageWindowChatMemory.withMaxMessages(20))
        .build();
    System.out.println(agent.chat("customer-8812", "Where is my order 4101?"));
  }
}`,
          },
        ],
      },
      {
        title: 'A person approves refunds (middleware + resume)',
        language: 'javascript',
        source: `import { createAgent, humanInTheLoopMiddleware } from 'langchain'
import { Command } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL)
await checkpointer.setup() // creates its tables once

const agent = createAgent({
  model: 'anthropic:claude-sonnet-5',
  tools: [getOrder, searchHelp, refundDeliveryFee],
  middleware: [
    // Pause before this tool runs; reading tools run without asking.
    humanInTheLoopMiddleware({
      interruptOn: { refund_delivery_fee: { allowedDecisions: ['approve', 'reject'] } },
    }),
  ],
  checkpointer, // required: the paused run is saved here
})

const config = { configurable: { thread_id: 'chat-8812' } }
const first = await agent.invoke({ messages: [{ role: 'user', content: 'Order 4101 is late. Refund the delivery fee.' }] }, config)
// first.__interrupt__[0].value.actionRequests → [{ name: 'refund_delivery_fee', args: { order_id: '4101', amount_inr: 49 } }]

// Later, from any server, when the lead clicks Approve:
const done = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)`,
        versions: [
          {
            language: 'python',
            source: `from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.types import Command

with PostgresSaver.from_conn_string(DATABASE_URL) as checkpointer:
    checkpointer.setup()  # creates its tables once
    agent = create_agent(
        model="anthropic:claude-sonnet-5",
        tools=[get_order, search_help, refund_delivery_fee],
        middleware=[
            HumanInTheLoopMiddleware(
                interrupt_on={"refund_delivery_fee": {"allowed_decisions": ["approve", "reject"]}},
            ),
        ],
        checkpointer=checkpointer,
    )
    config = {"configurable": {"thread_id": "chat-8812"}}
    first = agent.invoke({"messages": [{"role": "user", "content": "Order 4101 is late. Refund the delivery fee."}]}, config)
    print(first["__interrupt__"])  # the refund waiting for a decision

    # When the lead clicks Approve:
    done = agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config)`,
          },
        ],
      },
      {
        title: 'One interface, any provider',
        language: 'javascript',
        source: `import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'

const getOrderSpec = {
  name: 'get_order',
  description: "Look up an order's status, promised time and fees.",
  schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
}

for (const model of [new ChatAnthropic({ model: 'claude-sonnet-5' }), new ChatOpenAI({ model: 'gpt-5.5' })]) {
  const reply = await model.bindTools([getOrderSpec]).invoke('Where is my order 4101?')
  // Anthropic sends tool_use blocks; OpenAI sends tool_calls with arguments as a JSON string.
  // LangChain gives you the same shape from both:
  console.log(reply.tool_calls) // [{ name: 'get_order', args: { order_id: '4101' }, id: '…' }]
}`,
      },
    ],
    related: ['LangGraph', 'AI agent with tools', 'RAG pipeline', 'LLM gateway', 'LLM guardrails'],
  },
  simulator,
}
