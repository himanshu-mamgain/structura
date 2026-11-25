import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator runs one tool-calling conversation the way the APIs really work: your app
// sends tool definitions with the messages, the model replies with structured tool calls,
// your app validates the arguments against the schema, checks permissions with the logged-in
// user's id, runs the tools (several at once when the model asks for several), sends the
// results back tied to each call's id, and asks again. The request and response bodies follow
// Anthropic's Messages API and OpenAI's Chat Completions API. The model is a rule-based
// stand-in so it runs in the browser with no LLM; the validation, the permission check and the
// token counts (about 4 characters a token, measured from the actual JSON) are real.

const USER_ID = 'u_8812' // from the session, never from the model
const ORDERS: Record<string, { order_id: string; customer_id: string; status: string; eta: string; restaurant: string }> = {
  '4101': { order_id: '4101', customer_id: 'u_8812', status: 'on the way', eta: '20:26', restaurant: 'Biryani Blues' },
  '4207': { order_id: '4207', customer_id: 'u_3390', status: 'preparing', eta: '20:50', restaurant: 'Dosa Corner' },
}
const WEATHER = { city: 'Bengaluru', now: 'light rain', temp_c: 22, rain_next_hour_mm: 1.8 }

interface ToolDef {
  name: 'get_order' | 'get_weather' | 'cancel_order'
  description: string
  schema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: false }
}
const TOOLS: ToolDef[] = [
  {
    name: 'get_order',
    description: "Get the logged-in customer's order: status, restaurant and arrival time. Use it for any question about an order.",
    schema: { type: 'object', properties: { order_id: { type: 'string', pattern: '^[0-9]{4}$', description: 'The 4-digit order number' } }, required: ['order_id'], additionalProperties: false },
  },
  {
    name: 'get_weather',
    description: 'Current weather for a city: conditions, temperature and expected rain in the next hour.',
    schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  },
  {
    name: 'cancel_order',
    description: 'Cancel one of the customer\'s orders before it is picked up.',
    schema: {
      type: 'object',
      properties: { order_id: { type: 'string', pattern: '^[0-9]{4}$' }, reason: { type: 'string', enum: ['late', 'changed mind', 'wrong address'] } },
      required: ['order_id', 'reason'],
      additionalProperties: false,
    },
  },
]
const tokensOf = (text: string) => Math.ceil(text.length / 4)

type Args = Record<string, unknown>
interface Call {
  id: string
  name: ToolDef['name']
  args: Args
}

/** A small JSON Schema check: the keywords these tools use (type, pattern, enum, required, no extra keys). */
function validate(def: ToolDef, args: Args): string | null {
  for (const key of def.schema.required) if (!(key in args)) return `missing required "${key}"`
  for (const [key, value] of Object.entries(args)) {
    const rule = def.schema.properties[key]
    if (!rule) return `unexpected "${key}"`
    if (rule.type === 'string' && typeof value !== 'string') return `"${key}" must be a string, got ${typeof value} ${JSON.stringify(value)}`
    if (typeof rule.pattern === 'string' && !new RegExp(rule.pattern).test(String(value))) return `"${key}" must match ${rule.pattern}, got ${JSON.stringify(value)}`
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return `"${key}" must be one of ${rule.enum.join(', ')}`
  }
  return null
}

const QUESTIONS: Record<string, 'order' | 'parallel' | 'cancel' | 'chat'> = {
  'Where is my order 4101?': 'order',
  'Is it raining in Bengaluru, and where is order 4101?': 'parallel',
  'Cancel order 4207, it is late.': 'cancel',
  'Tell me a joke about biryani.': 'chat',
}
const CHOICE: Record<string, 'auto' | 'none' | 'force'> = {
  'auto: the model decides': 'auto',
  'none: no tools this time': 'none',
  'Force get_order': 'force',
}
const ARGS: Record<string, 'good' | 'number'> = {
  'The model sends valid arguments': 'good',
  'The model sends order_id as a number': 'number',
}
const PROVIDERS = ['Anthropic (Messages API)', 'OpenAI (Chat Completions)']

function requestBody(anthropic: boolean, choice: 'auto' | 'none' | 'force', question: string) {
  const tools = anthropic
    ? TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
    : TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema, strict: true } }))
  const toolChoice = anthropic
    ? choice === 'force'
      ? { type: 'tool', name: 'get_order' }
      : { type: choice }
    : choice === 'force'
      ? { type: 'function', function: { name: 'get_order' } }
      : choice
  return { tools, toolChoice, body: { tools: `[${TOOLS.length} tools]`, tool_choice: toolChoice, messages: [{ role: 'user', content: question }] } }
}

function callBlock(anthropic: boolean, calls: Call[], text?: string) {
  return anthropic
    ? JSON.stringify({
        stop_reason: 'tool_use',
        content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'tool_use', id: `toolu_${c.id}`, name: c.name, input: c.args }))],
      })
    : JSON.stringify({
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: text ?? null, tool_calls: calls.map((c) => ({ id: `call_${c.id}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
      })
}

function resultBlock(anthropic: boolean, results: { call: Call; content: string; error: boolean }[]) {
  return anthropic
    ? JSON.stringify({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: `toolu_${r.call.id}`, content: r.content, ...(r.error ? { is_error: true } : {}) })) })
    : results.map((r) => JSON.stringify({ role: 'tool', tool_call_id: `call_${r.call.id}`, content: r.error ? `Error: ${r.content}` : r.content })).join('\n')
}

const simulator: Simulator = {
  fields: [
    { id: 'question', label: 'The customer asks', options: Object.keys(QUESTIONS) },
    { id: 'choice', label: 'tool_choice', options: Object.keys(CHOICE) },
    { id: 'args', label: 'Arguments', options: Object.keys(ARGS) },
    { id: 'provider', label: 'Provider', options: PROVIDERS },
  ],
  defaults: {
    question: 'Is it raining in Bengaluru, and where is order 4101?',
    choice: 'auto: the model decides',
    args: 'The model sends valid arguments',
    provider: PROVIDERS[0],
  },
  run(values) {
    const question = values.question in QUESTIONS ? values.question : 'Is it raining in Bengaluru, and where is order 4101?'
    const kind = QUESTIONS[question]
    let choice = CHOICE[values.choice] ?? 'auto'
    const badArgs = ARGS[values.args] === 'number'
    const anthropic = values.provider !== PROVIDERS[1]
    const steps: Trace['steps'] = []
    const req = requestBody(anthropic, choice, question)
    const toolTokens = tokensOf(JSON.stringify(req.tools))
    let convo = tokensOf(question)
    let read = 0
    let modelCalls = 0
    let toolRuns = 0
    let rejected = 0
    let n = 0
    const nextId = () => String(++n).padStart(2, '0')

    steps.push({
      text: `The User asks a question. Your App (Agent Loop) builds the request: the conversation, the ${TOOLS.length} tool definitions from the Tool Registry (a name, a description and a JSON Schema for the arguments each) and tool_choice. The definitions are about ${toolTokens} tokens, and they are sent again on every call.`,
      nodes: ['User', 'Your App (Agent Loop)', 'Tool Registry (schemas)'],
      data: `POST ${anthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions'}\n${JSON.stringify(req.body, null, 1)}\n\none tool, as sent:\n${JSON.stringify(req.tools[0])}`,
    })

    // What the stand-in model asks for on each turn, given what it has seen.
    const firstCalls = (): Call[] => {
      if (choice === 'none') return []
      const orderArg = badArgs ? 4101 : '4101'
      if (choice === 'force') return [{ id: nextId(), name: 'get_order', args: { order_id: kind === 'chat' ? '' : kind === 'cancel' ? (badArgs ? 4207 : '4207') : orderArg } }]
      if (kind === 'order') return [{ id: nextId(), name: 'get_order', args: { order_id: orderArg } }]
      if (kind === 'parallel') return [{ id: nextId(), name: 'get_weather', args: { city: 'Bengaluru' } }, { id: nextId(), name: 'get_order', args: { order_id: orderArg } }]
      if (kind === 'cancel') return [{ id: nextId(), name: 'cancel_order', args: { order_id: badArgs ? 4207 : '4207', reason: 'late' } }]
      return []
    }

    let calls = firstCalls()
    const answered: string[] = []
    let blocked = false
    let round = 0
    while (calls.length && round < 4) {
      round++
      modelCalls++
      read += toolTokens + convo
      const out = callBlock(anthropic, calls)
      convo += tokensOf(out)
      steps.push({
        text: `Model call ${modelCalls}. Under the hood, the Prompt Builder renders your tool definitions into a special system prompt. The LLM was fine-tuned to write a structured block when a tool would help, and the Tool-Call Parser turns that into ${anthropic ? 'tool_use blocks with stop_reason "tool_use"' : 'tool_calls with finish_reason "tool_calls"; the arguments arrive as a JSON string you must parse'}.${calls.length > 1 ? ` It asks for ${calls.length} tools in one reply: they don't depend on each other, so they can run at the same time.` : ''} The model has run nothing: a tool call is only a request.`,
        nodes: ['Model API (Anthropic / OpenAI)', 'Prompt Builder (tools into context)', 'LLM', 'Tool-Call Parser'],
        data: out,
      })

      const results: { call: Call; content: string; error: boolean }[] = []
      for (const call of calls) {
        const def = TOOLS.find((t) => t.name === call.name)!
        const invalid = validate(def, call.args)
        if (invalid) {
          rejected++
          results.push({ call, content: `Invalid arguments for ${call.name}: ${invalid}`, error: true })
          continue
        }
        const order = typeof call.args.order_id === 'string' ? ORDERS[call.args.order_id] : undefined
        if ((call.name === 'get_order' || call.name === 'cancel_order') && order && order.customer_id !== USER_ID) {
          blocked = true
          results.push({ call, content: `Order ${order.order_id} doesn't belong to this customer.`, error: true })
          continue
        }
        toolRuns++
        if (call.name === 'get_weather') results.push({ call, content: JSON.stringify(WEATHER), error: false })
        else if (call.name === 'get_order') results.push({ call, content: JSON.stringify(order ?? { error: 'not found' }), error: !order })
        else results.push({ call, content: JSON.stringify({ cancelled: true }), error: false })
        answered.push(call.name)
      }

      const errors = results.filter((r) => r.error)
      steps.push({
        text: errors.length
          ? `Stop Reason? says tool calls, so your app takes over. The Argument Validator checks each call against its schema, and the Permission Check uses the session's user id (${USER_ID}), never one the model could write. ${errors.map((e) => e.content).join(' ')} Nothing runs for ${errors.length === 1 ? 'that call' : 'those calls'}; the error goes back as the result, so the model can fix it or explain.`
          : `Stop Reason? says tool calls, so your app takes over. The Argument Validator checks each call against its schema, the Permission Check confirms the order belongs to the session's user (${USER_ID}), and the Tool Executor runs ${results.length > 1 ? `the ${results.length} calls in parallel` : 'the call'}.`,
        nodes: ['Stop Reason?', 'Argument Validator', 'Permission Check', ...(errors.length === results.length ? [] : ['Tool Executor']), ...results.filter((r) => !r.error).map((r) => (r.call.name === 'get_weather' ? 'Weather API' : 'Orders API'))],
        data: results.map((r) => `${r.call.name}(${JSON.stringify(r.call.args)})\n→ ${r.error ? '✗ ' : ''}${r.content}`).join('\n\n'),
      })

      const back = resultBlock(anthropic, results)
      convo += tokensOf(back)
      steps.push({
        text: `Your app adds the model's reply and the results to the Conversation (messages), each result tied to its call's id, and calls the model again with the same tools. ${anthropic ? 'In the Messages API, every tool_result goes in one user message, straight after the tool_use message.' : 'In Chat Completions, each result is its own message with role "tool".'}`,
        nodes: ['Your App (Agent Loop)', 'Conversation (messages)', 'Model API (Anthropic / OpenAI)'],
        data: back,
      })

      // Forcing a tool applies to every call: switch back to auto, or the loop never ends.
      if (choice === 'force') choice = 'auto'
      const retry = results.filter((r) => r.error && r.content.startsWith('Invalid') && !(kind === 'chat'))
      calls = retry.map((r) => ({ id: nextId(), name: r.call.name, args: { ...r.call.args, order_id: String(r.call.args.order_id) } }))
      if (calls.length) continue
      if (kind === 'parallel' && !answered.includes('get_weather') && CHOICE[values.choice] === 'force') calls = []
    }

    modelCalls++
    read += toolTokens + convo // the definitions are in the request even when tool_choice is none
    const order = ORDERS['4101']
    const answer =
      kind === 'chat'
        ? 'Why did the biryani go to school? To get a little more rice-ponsible. 🍛'
        : CHOICE[values.choice] === 'none'
          ? "I can't look that up right now. Please check the Orders page in the app."
          : blocked
            ? "I can't change order 4207: it isn't on your account. If it's yours, sign in with the account that placed it."
            : kind === 'cancel'
              ? 'Order 4207 is cancelled.'
              : kind === 'parallel'
                ? answered.includes('get_weather')
                  ? `Yes, light rain in Bengaluru (22 °C), about ${WEATHER.rain_next_hour_mm} mm in the next hour. Your ${order.restaurant} order is on the way and should arrive by ${order.eta}.`
                  : `Your ${order.restaurant} order is on the way and should arrive by ${order.eta}. I couldn't check the weather this time.`
                : `Your ${order.restaurant} order is on the way and should arrive by ${order.eta}.`
    steps.push({
      text: `Model call ${modelCalls}: the model answers in text. ${anthropic ? 'stop_reason is "end_turn"' : 'finish_reason is "stop"'}, so Stop Reason? ends the loop and your app shows the answer to the User.${CHOICE[values.choice] === 'force' ? ' Because tool_choice forced get_order on the first call only, the model was free to answer now.' : ''}`,
      nodes: ['LLM', 'Stop Reason?', 'User'],
      data: `"${answer}"\n\nmodel calls: ${modelCalls} · tools run: ${toolRuns}${rejected ? ` · rejected by the validator: ${rejected}` : ''}${blocked ? ' · blocked by the permission check: 1' : ''}\ntokens read across all calls: ${read.toLocaleString('en-IN')} (${toolTokens} of them are tool definitions, every call)`,
    })

    const label = values.question in QUESTIONS ? kind : 'parallel'
    return {
      input: `${label} · ${values.choice.split(':')[0]}${badArgs ? ' · bad args' : ''} · ${anthropic ? 'Anthropic' : 'OpenAI'} → ${modelCalls} model calls, ${toolRuns} tools run${rejected ? `, ${rejected} rejected` : ''}${blocked ? ', 1 blocked' : ''}`,
      steps,
    }
  },
}

export const toolCalling: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'tool-calling',
  title: 'Tool Calling Under the Hood',
  blurb: 'How a model "uses" a tool: definitions in, a structured request out, your code runs it, the result goes back',
  guides: ['what-is-an-ai-agent', 'how-does-chatgpt-work'],
  takeaways: [
    'The model never runs a tool: it writes a structured request, and your code decides whether to run it.',
    'Each tool is a name, a description and a JSON Schema; they are put into the model\'s context on every call and cost input tokens.',
    'Validate the arguments against the schema, and take identity and permissions from the session, never from the model.',
    'Send each result back tied to its call id, including errors, so the model can fix a bad call or explain.',
    'A model can ask for several independent tools in one reply; run them in parallel and return all the results together.',
    'tool_choice can force or forbid tools; forcing applies to every call, so switch back to auto after the first.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'app', label: 'Your app' },
      { id: 'provider', label: 'Model provider' },
      { id: 'tools', label: 'Your services' },
    ],
    nodes: [
      { id: 'user', label: 'User', shape: 'ellipse', color: 'blue', group: null },
      { id: 'loop', label: 'Your App (Agent Loop)', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'registry', label: 'Tool Registry (schemas)', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'convo', label: 'Conversation (messages)', shape: 'rectangle', color: 'green', group: 'app' },
      { id: 'api', label: 'Model API (Anthropic / OpenAI)', shape: 'cloud', color: 'violet', group: null },
      { id: 'prompt', label: 'Prompt Builder (tools into context)', shape: 'rectangle', color: 'violet', group: 'provider' },
      { id: 'llm', label: 'LLM', shape: 'rectangle', color: 'violet', group: 'provider' },
      { id: 'parser', label: 'Tool-Call Parser', shape: 'rectangle', color: 'violet', group: 'provider' },
      { id: 'stop', label: 'Stop Reason?', shape: 'diamond', color: 'violet', group: 'app' },
      { id: 'validate', label: 'Argument Validator', shape: 'rectangle', color: 'violet', group: 'app' },
      { id: 'perm', label: 'Permission Check', shape: 'diamond', color: 'violet', group: 'app' },
      { id: 'exec', label: 'Tool Executor', shape: 'rectangle', color: 'orange', group: 'app' },
      { id: 'orders', label: 'Orders API', shape: 'rectangle', color: 'violet', group: 'tools' },
      { id: 'weather', label: 'Weather API', shape: 'rectangle', color: 'violet', group: 'tools' },
    ],
    edges: [
      { from: 'user', to: 'loop', label: 'question', dashed: false },
      { from: 'registry', to: 'loop', label: 'name, description, schema', dashed: false },
      { from: 'loop', to: 'api', label: 'messages + tools + tool_choice', dashed: false },
      { from: 'api', to: 'prompt', label: '', dashed: false },
      { from: 'prompt', to: 'llm', label: 'tools in a system prompt', dashed: false },
      { from: 'llm', to: 'parser', label: 'special tool-call block', dashed: false },
      { from: 'parser', to: 'stop', label: 'tool_use / tool_calls', dashed: true },
      { from: 'stop', to: 'validate', label: 'tool calls', dashed: false },
      { from: 'stop', to: 'user', label: 'text: the answer', dashed: true },
      { from: 'validate', to: 'perm', label: 'valid', dashed: false },
      { from: 'perm', to: 'exec', label: 'allowed', dashed: false },
      { from: 'exec', to: 'orders', label: 'get_order, cancel_order', dashed: false },
      { from: 'exec', to: 'weather', label: 'get_weather', dashed: false },
      { from: 'exec', to: 'convo', label: 'results by call id', dashed: false },
      { from: 'validate', to: 'convo', label: 'error result', dashed: true },
      { from: 'convo', to: 'loop', label: 'call the model again', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Tool Calling Under the Hood',
    summary:
      'Tool calling (also called function calling) lets a language model use your code. You describe each tool with a name, a description and a JSON Schema for its arguments. The model never runs anything: when a tool would help, it replies with a structured request naming the tool and its arguments. Your app checks the request, runs the real function, sends the result back tied to the call\'s id, and asks the model again, until it answers in text.',
    sections: [
      {
        heading: 'Overview',
        body: 'A language model (LLM) only produces text. "Tool calling" is an agreement about that text: the provider\'s API turns your tool definitions into part of the prompt, the model has been trained to write a special structured block when a tool would help, and the API hands you that block as data instead of prose.\n\nFive steps, every time:\n- Definition: you send each tool\'s name, description and argument schema with the messages.\n- Decision: the model replies with text, or with one or more tool calls.\n- Execution: your code validates the arguments, checks permissions and runs the real function.\n- Result: you send the result back, linked to the call by its id.\n- Loop: the model calls more tools or gives the final answer.\n\nThe simulator runs that loop with the real request and response formats of Anthropic\'s Messages API and OpenAI\'s Chat Completions API. The model is a rule-based stand-in so it runs in your browser; the validation, the permission check and the token counts are real.',
      },
      {
        heading: 'Requirements',
        body: 'What it must do:\n- Answer "where is my order?" from the real order, not a guess.\n- Answer two independent questions with two tools at once.\n- Never cancel or show another customer\'s order.\n- Recover when the model sends arguments in the wrong shape.\n\nHow well it must do it:\n- Work the same with Anthropic or OpenAI, with only the request format changing.\n- Keep the tool definitions small: they are re-sent on every call.',
      },
      {
        heading: 'Capacity estimates',
        body: '- The 3 tool definitions in the simulator are about 233 tokens in Anthropic\'s format and 265 in OpenAI\'s (which wraps each in a function object), sent with every model call.\n- A question that needs one tool takes 2 model calls (ask, then answer); a bad argument adds a third.\n- With 20 tools of about 80 tokens each, every call carries about 1.6k tokens of definitions before any conversation. That is why providers suggest keeping the list short (OpenAI suggests fewer than 20) and why prompt caching helps.\n- Running 2 independent tools in parallel takes as long as the slower one, not the sum: a 300 ms and a 500 ms call take about 500 ms together.',
      },
      {
        heading: 'Step by step',
        body: '1. The User asks a question; Your App (Agent Loop) builds the request with the tool definitions from the Tool Registry (schemas) and tool_choice.\n2. The Model API (Anthropic / OpenAI) gets it; the Prompt Builder (tools into context) puts the definitions into a system prompt.\n3. The LLM writes either text or a tool-call block; the Tool-Call Parser turns the block into tool_use (Anthropic) or tool_calls (OpenAI).\n4. Stop Reason? sends text answers to the User and tool calls into your app.\n5. The Argument Validator checks each call against its schema; the Permission Check uses the session\'s user, not the model\'s words.\n6. The Tool Executor runs the allowed calls against the Orders API and Weather API, several at once if asked.\n7. Results (and errors) go into the Conversation (messages), each tied to its call id, and the app calls the model again.',
      },
      {
        heading: 'Components',
        body: "- User: asks the question and sees the answer.\n- Your App (Agent Loop): sends requests, runs tools, and repeats until the model answers in text.\n- Tool Registry (schemas): each tool's name, description and JSON Schema for its arguments.\n- Conversation (messages): the messages so far, including tool calls and their results.\n- Model API (Anthropic / OpenAI): the provider's API endpoint.\n- Prompt Builder (tools into context): inside the provider, turns your tool definitions into a system prompt the model was trained on.\n- LLM: the model; writes text or a structured tool-call block.\n- Tool-Call Parser: inside the provider, turns that block into tool_use or tool_calls with ids.\n- Stop Reason?: tool calls go to your code; plain text ends the loop.\n- Argument Validator: checks arguments against the schema before anything runs.\n- Permission Check: decides with the logged-in user's id whether this call is allowed.\n- Tool Executor: runs the real functions, in parallel when the model asks for several.\n- Orders API: the order data behind get_order and cancel_order.\n- Weather API: the weather data behind get_weather.",
      },
      {
        heading: 'Key decisions',
        body: '- The description is a prompt: say what the tool does, when to use it, and what each argument means. The model picks tools by reading it.\n- Validate everything: types, patterns, allowed values. A strict mode (strict: true on both providers) makes the model\'s arguments follow the schema, but your server still checks.\n- Identity comes from the session: never accept a user id from the model, and check ownership on every call.\n- Return errors as results (is_error on Anthropic, an error message as the tool content on OpenAI) instead of failing the request, so the model can retry.\n- tool_choice: auto by default; none to stop tools; force one tool for a fixed first step, then switch back to auto.\n- Actions that change things (cancel, pay) need confirmation, and an idempotency key if they might be retried.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Every call re-sends the tool definitions and the whole conversation: cap the number of tools, cache the prompt, and trim old messages.\n- Tools time out: set a deadline per tool and return a clear error result.\n- The model may loop on a failing tool: cap the steps per question.\n- Tool results are untrusted text: a web page or document can contain instructions (prompt injection). Keep risky tools behind permission checks and approvals.\n- Parallel calls can conflict (two writes to one order): run only reads in parallel, or lock.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Does the LLM call the API? What actually happens?\n- How does the model know which tools exist, and what does that cost?\n- How do you stop a model cancelling another user\'s order?\n- What do you do when the model sends invalid arguments?\n- How do parallel tool calls work, and when should you turn them off?\n- What does tool_choice do, and when would you force a tool?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'The whole loop, by hand (Anthropic Messages API)',
        language: 'javascript',
        source: `import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
const tools = [
  {
    name: 'get_order',
    description: "Get the logged-in customer's order: status, restaurant and arrival time.",
    input_schema: { type: 'object', properties: { order_id: { type: 'string', pattern: '^[0-9]{4}$' } }, required: ['order_id'] },
  },
]

export async function ask(question, session) {
  const messages = [{ role: 'user', content: question }]
  for (let step = 0; step < 6; step++) {
    const res = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 1024, tools, messages })
    if (res.stop_reason !== 'tool_use') return res.content.find((b) => b.type === 'text')?.text

    messages.push({ role: 'assistant', content: res.content }) // keep the model's tool_use blocks as they are
    const calls = res.content.filter((b) => b.type === 'tool_use')
    // Independent calls run at the same time; every result goes back in one user message.
    const results = await Promise.all(calls.map((c) => runTool(c, session)))
    messages.push({ role: 'user', content: results })
  }
  return 'Sorry, I could not finish that.'
}

async function runTool(call, session) {
  const error = (text) => ({ type: 'tool_result', tool_use_id: call.id, content: text, is_error: true })
  if (call.name !== 'get_order') return error(\`Unknown tool \${call.name}\`)
  if (typeof call.input.order_id !== 'string' || !/^[0-9]{4}$/.test(call.input.order_id)) return error('order_id must be a 4-digit string')
  const order = await ordersDb.find(call.input.order_id)
  // Who is asking comes from the session, never from the model.
  if (!order || order.customerId !== session.userId) return error('No such order on this account')
  return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(order) }
}`,
        versions: [
          {
            language: 'python',
            source: `import json, re
import anthropic

client = anthropic.Anthropic()
tools = [{
    "name": "get_order",
    "description": "Get the logged-in customer's order: status, restaurant and arrival time.",
    "input_schema": {"type": "object", "properties": {"order_id": {"type": "string", "pattern": "^[0-9]{4}$"}}, "required": ["order_id"]},
}]

def ask(question, session):
    messages = [{"role": "user", "content": question}]
    for _ in range(6):
        res = client.messages.create(model="claude-sonnet-5", max_tokens=1024, tools=tools, messages=messages)
        if res.stop_reason != "tool_use":
            return next((b.text for b in res.content if b.type == "text"), "")
        messages.append({"role": "assistant", "content": res.content})
        results = [run_tool(b, session) for b in res.content if b.type == "tool_use"]
        messages.append({"role": "user", "content": results})
    return "Sorry, I could not finish that."

def run_tool(call, session):
    def error(text):
        return {"type": "tool_result", "tool_use_id": call.id, "content": text, "is_error": True}
    order_id = call.input.get("order_id")
    if call.name != "get_order" or not isinstance(order_id, str) or not re.fullmatch(r"[0-9]{4}", order_id):
        return error("order_id must be a 4-digit string")
    order = orders_db.find(order_id)
    if not order or order["customer_id"] != session.user_id:  # identity from the session
        return error("No such order on this account")
    return {"type": "tool_result", "tool_use_id": call.id, "content": json.dumps(order)}`,
          },
          {
            language: 'java',
            source: `// The same loop over plain HTTP with Java's built-in client and Jackson.
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class ToolLoop {
  static final ObjectMapper json = new ObjectMapper();
  static final HttpClient http = HttpClient.newHttpClient();

  static String ask(String question, String userId, ArrayNode tools) throws Exception {
    ArrayNode messages = json.createArrayNode();
    messages.addObject().put("role", "user").put("content", question);
    for (int step = 0; step < 6; step++) {
      ObjectNode body = json.createObjectNode().put("model", "claude-sonnet-5").put("max_tokens", 1024);
      body.set("tools", tools);
      body.set("messages", messages);
      JsonNode res = post(body);
      if (!"tool_use".equals(res.path("stop_reason").asText())) return res.path("content").path(0).path("text").asText();

      messages.addObject().put("role", "assistant").set("content", res.get("content"));
      ArrayNode results = json.createArrayNode();
      for (JsonNode block : res.get("content")) {
        if (!"tool_use".equals(block.path("type").asText())) continue;
        results.add(runTool(block, userId)); // identity from the session, not the model
      }
      messages.addObject().put("role", "user").set("content", results);
    }
    return "Sorry, I could not finish that.";
  }

  static JsonNode post(ObjectNode body) throws Exception {
    HttpRequest req = HttpRequest.newBuilder(URI.create("https://api.anthropic.com/v1/messages"))
        .header("x-api-key", System.getenv("ANTHROPIC_API_KEY"))
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
        .build();
    return json.readTree(http.send(req, HttpResponse.BodyHandlers.ofString()).body());
  }

  static ObjectNode runTool(JsonNode call, String userId) {
    ObjectNode result = json.createObjectNode().put("type", "tool_result").put("tool_use_id", call.get("id").asText());
    String orderId = call.path("input").path("order_id").asText("");
    Order order = OrdersDb.find(orderId);
    if (!orderId.matches("[0-9]{4}") || order == null || !order.customerId().equals(userId))
      return result.put("content", "No such order on this account").put("is_error", true);
    return result.put("content", order.toJson());
  }
}`,
          },
        ],
      },
      {
        title: 'The same call, OpenAI Chat Completions',
        language: 'javascript',
        source: `import OpenAI from 'openai'

const client = new OpenAI()
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_order',
      description: "Get the logged-in customer's order: status, restaurant and arrival time.",
      parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'], additionalProperties: false },
      strict: true, // arguments follow the schema exactly
    },
  },
]

const messages = [{ role: 'user', content: 'Where is my order 4101?' }]
const res = await client.chat.completions.create({ model: 'gpt-5.5', messages, tools, tool_choice: 'auto' })
const msg = res.choices[0].message

if (res.choices[0].finish_reason === 'tool_calls') {
  messages.push(msg)
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) // a JSON string, not an object
    const order = await getOrderFor(session.userId, args.order_id)
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(order) })
  }
  const final = await client.chat.completions.create({ model: 'gpt-5.5', messages, tools })
  console.log(final.choices[0].message.content)
}`,
      },
    ],
    related: ['AI agent with tools', 'LangChain', 'LangGraph', 'LLM guardrails', 'Idempotent payments'],
  },
  simulator,
}
