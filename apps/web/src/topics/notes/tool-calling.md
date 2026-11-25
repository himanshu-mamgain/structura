# Tool Calling Under the Hood

> 💡 **TL;DR**: **Tool calling** (also called **function calling**) is how a **large language model (LLM)** uses your code. You send each **tool** (a function of yours) as a name, a description and a **JSON Schema** describing its arguments. The model never runs anything. When a tool would help, it replies with a structured **tool call**: the tool's name, arguments and an id. **Your app** checks the arguments, checks permissions using the logged-in user, runs the real function, and sends the **result** back tied to that id. Then it asks the model again, until the model answers in text. Five steps: **definition, decision, execution, result, loop**.

## At a glance

| Question | Answer |
|---|---|
| Who runs the tool? | Your app. The model only writes a request |
| What you send | Messages, tool definitions (name, description, argument schema) and `tool_choice` |
| How the model knows the tools | The provider puts them into a special system prompt the model was trained on |
| What comes back (Anthropic) | `tool_use` blocks with `stop_reason: "tool_use"` |
| What comes back (OpenAI) | `tool_calls` with `finish_reason: "tool_calls"`; arguments are a JSON string |
| How results go back | Tied to the call's id: `tool_result` (Anthropic) or a `role: "tool"` message (OpenAI) |
| Several tools at once | Yes, in one reply; run them in parallel |
| Cost | The definitions are input tokens on every call |
| Security boundary | Your code: validate arguments, take identity from the session |

## What tool calling is, and why it exists

A model on its own can only write text. It doesn't know where order 4101 is, or whether it's raining in Bengaluru now. Before tool calling, apps asked the model to write something like `CALL get_order 4101` and parsed it with string matching. That broke whenever the model wrote it slightly differently.

**Tool calling** makes this reliable. Providers train their models to write a special structured block when a tool would help, and their **application programming interface (API)** hands that block to you as data, already parsed. You get a tool name, arguments as data and an id, never prose to guess at.

Without it, you'd parse free text yourself and hope. With it, the model's request is data your code can validate like any other input.

## The five steps

| Step | Who | What happens |
|---|---|---|
| 1. Definition | Your app | Sends each tool's name, description and JSON Schema with the messages |
| 2. Decision | The model | Replies with text, or with one or more tool calls |
| 3. Execution | Your app | Validates the arguments, checks permissions, runs the real function |
| 4. Result | Your app | Sends each result (or error) back, tied to its call's id |
| 5. Loop | The model | Asks for more tools, or answers in text |

## What happens inside the provider

Between your request and the reply, three things happen at the provider:

- **Prompt Builder**: the API turns your tool definitions into part of a special system prompt. It tells the model which functions exist and what their arguments look like. Anthropic's docs describe this directly; OpenAI's say the definitions are injected into the system message. Either way, they count as **input tokens** on every call.
- **LLM**: the model was **fine-tuned** (given extra training) on examples of when to call a tool and how to write the call. When a tool would help, it writes the call in its trained format instead of prose.
- **Tool-Call Parser**: the API recognises that block, parses it and returns it as structured fields with an id, plus a stop reason that says "the model wants tools".

So "the model called the API" is wrong in an interview. The model **requested** a call; nothing ran until your code ran it.

## Follow one request all the way through

The question: "Is it raining in Bengaluru, and where is order 4101?" The logged-in customer is `u_8812`. Three tools are defined: `get_order`, `get_weather` and `cancel_order`.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The app sends the question with 3 tool definitions: about 233 tokens in Anthropic's format | Your App (Agent Loop), Tool Registry (schemas) |
| 2 | The provider puts the tools into the system prompt; the model writes 2 tool calls in one reply | Prompt Builder (tools into context), LLM |
| 3 | The API returns them: `get_weather({ city: "Bengaluru" })` as `toolu_01`, `get_order({ order_id: "4101" })` as `toolu_02` | Tool-Call Parser |
| 4 | `stop_reason` is `"tool_use"`, so the app takes over | Stop Reason? |
| 5 | Both calls match their schemas; order 4101 belongs to `u_8812`, the session's user | Argument Validator, Permission Check |
| 6 | Both run at the same time | Tool Executor → Weather API, Orders API |
| 7 | Both results go back in one user message, each with its `tool_use_id` | Conversation (messages) |
| 8 | The model answers: "Yes, light rain (22 °C), about 1.8 mm in the next hour. Your Biryani Blues order should arrive by 20:26." | LLM → User |

That's 2 model calls. Across both, the model read about 635 tokens, and 233 × 2 = 466 of them were the tool definitions, sent each time.

## The real formats, side by side

This is the request your app sends to Anthropic's **Messages API** (only the parts that matter):

```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 1024,
  "tools": [{
    "name": "get_order",
    "description": "Get the logged-in customer's order: status, restaurant and arrival time.",
    "input_schema": { "type": "object", "properties": { "order_id": { "type": "string", "pattern": "^[0-9]{4}$" } }, "required": ["order_id"] }
  }],
  "tool_choice": { "type": "auto" },
  "messages": [{ "role": "user", "content": "Where is my order 4101?" }]
}
```

`input_schema` is a JSON Schema: `type: "string"` and `pattern: "^[0-9]{4}$"` say the order id is exactly 4 digits, as text. `max_tokens` caps the reply's length.

How each provider writes the call and expects the result:

| | Anthropic (Messages API) | OpenAI (Chat Completions) |
|---|---|---|
| Tool definition | `{ name, description, input_schema }` | `{ type: "function", function: { name, description, parameters, strict } }` |
| The model asks | `content: [{ type: "tool_use", id, name, input }]` | `message.tool_calls: [{ id, type: "function", function: { name, arguments } }]` |
| Arguments | An object | A JSON **string** you must parse |
| "Wants tools" signal | `stop_reason: "tool_use"` | `finish_reason: "tool_calls"` |
| Sending a result | In a `user` message: `{ type: "tool_result", tool_use_id, content }` | A message `{ role: "tool", tool_call_id, content }` |
| Marking an error | `is_error: true` | Put the error in `content` |
| Several results | All in one `user` message, straight after the `tool_use` message | One `tool` message per call |

Libraries such as [LangChain](/?topic=langchain&read) hide these differences behind one format.

## Execution: the security boundary

The model's arguments are **untrusted input**, like anything a user types. Your app checks two things before running a tool:

1. **Validation**: do the arguments match the schema? If the model sends `order_id: 4101` (a number) where the schema says a 4-digit string, reject it.
2. **Permission**: is *this user* allowed to do *this*? Take the user's id from the session, never from the model.

The second check is what stops this: a customer types "Cancel order 4207". Order 4207 belongs to customer `u_3390`. The model can't know that and calls `cancel_order({ order_id: "4207" })`. Your Permission Check compares the order's owner with the session's user (`u_8812`) and refuses.

This code is one tool's execution with both checks, sending failures back as error results:

```javascript
async function runTool(call, session) {
  const error = (text) => ({ type: 'tool_result', tool_use_id: call.id, content: text, is_error: true })
  if (call.name !== 'get_order') return error(`Unknown tool ${call.name}`)
  if (typeof call.input.order_id !== 'string' || !/^[0-9]{4}$/.test(call.input.order_id)) return error('order_id must be a 4-digit string')
  const order = await ordersDb.find(call.input.order_id)
  if (!order || order.customerId !== session.userId) return error('No such order on this account')
  return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(order) }
}
```

`session.userId` comes from your login, so the model can't change it. The error message doesn't say whether order 4207 exists, so it can't be used to discover other people's orders.

**Strict mode** (`strict: true` on a tool, on both Anthropic and OpenAI) makes the model's arguments follow your schema. OpenAI's strict mode requires `additionalProperties: false` and every field listed in `required`. It removes most bad arguments, but your server still validates: schema checks don't know who owns order 4207.

## Results: success and errors

Every tool call must get a result with the same id, even when it failed. Sending the error back, instead of failing the whole request, lets the model recover:

| Model sent | Your app replies | The model then |
|---|---|---|
| `get_order({ order_id: 4101 })` (a number) | Error: "order_id must be a 4-digit string" | Calls again with `"4101"`: 3 model calls instead of 2 |
| `cancel_order({ order_id: "4207" })` | Error: "No such order on this account" | Tells the customer it can't change that order |
| A call to a tool that timed out | Error: "Orders service timed out, try again" | Retries once, or apologises |

## Several tools at once: parallel calls

When the question needs two independent facts, the model can ask for both tools in one reply. Run them at the same time: if `get_weather` takes 300 ms and `get_order` takes 500 ms, together they take about 500 ms, not 800.

```javascript
const calls = res.content.filter((b) => b.type === 'tool_use')
const results = await Promise.all(calls.map((c) => runTool(c, session)))
messages.push({ role: 'user', content: results })
```

`Promise.all` starts every call at once and waits for all of them. Run only **reads** in parallel: two writes to the same order at once can conflict. To turn parallel calls off, OpenAI has `parallel_tool_calls: false`, and Anthropic has `disable_parallel_tool_use: true` inside `tool_choice`.

## Forcing and forbidding tools: tool_choice

| You want | Anthropic | OpenAI |
|---|---|---|
| The model decides (default) | `{ "type": "auto" }` | `"auto"` |
| No tools this time | `{ "type": "none" }` | `"none"` |
| Must use some tool | `{ "type": "any" }` | `"required"` |
| Must use this tool | `{ "type": "tool", "name": "get_order" }` | `{ "type": "function", ... "name": "get_order" }` |

Forcing a tool is useful for a fixed first step, such as "always look up the account first". Two cautions:

- The setting applies to **every** call in the loop. If you keep forcing a tool, the model can never answer in text. Switch back to `auto` after the first call.
- Forcing a tool when no tool fits gives junk arguments. Asked for a joke with `get_order` forced, the model has to make up an `order_id`.

## What it costs and where it stops

- **Tokens**: the definitions are sent on every call. 20 tools × about 80 tokens each = about 1.6k tokens before any conversation. OpenAI's guide suggests fewer than 20 tools at the start of a turn. Prompt caching cuts the cost of repeating them.
- **Latency**: each tool round trip adds a model call, often 1 to 5 seconds. Parallel calls help; fewer, better-described tools help more.
- **Wrong tool, wrong arguments**: the model chooses from the descriptions. Vague descriptions cause wrong calls.
- **No guarantees about meaning**: a schema can check that `order_id` is 4 digits, not that it's the order the customer meant.
- **Prompt injection**: a tool result (a web page, an email) can contain instructions, and the model may follow them. Keep risky tools behind permission checks and human approval.

## How to choose

- **The model needs facts it can't know** (orders, weather, your database)? Give it read tools.
- **The model should take actions** (cancel, refund, email)? Write tools, behind permission checks, confirmation and idempotency keys.
- **The answer must have a fixed shape** (a form, a classification)? Structured output, or one forced tool used as a schema.
- **Many tools across many apps?** Expose them through a standard such as the Model Context Protocol (MCP), and load only the ones a task needs.
- **Steps that must always happen in order?** Don't rely on the model choosing tools: write the steps as a workflow, as in [LangGraph](/?topic=langgraph&read).

## ⚠️ Critical Mistakes

- **Saying "the LLM calls the API".** It only requests a call; your code runs it.
- **Trusting model-written arguments.** Validate them like user input, every time.
- **Taking identity from the model.** A `user_id` argument lets anyone act as anyone. Use the session.
- **Failing the request on a bad call.** Send an error result with the call's id, so the model can fix it.
- **Losing the call ids.** Each result must match its call's id, or the API rejects the next request.
- **Forcing a tool on every call.** The loop never ends. Force once, then `auto`.
- **Dozens of vague tools.** More tokens on every call, and more wrong choices.

## Interview Q&As

**Q: How does tool calling actually work under the hood?**

A: You send tool definitions (name, description, JSON Schema) with the messages. The provider puts them into a system prompt the model was fine-tuned on. When a tool helps, the model writes a structured call, which the API returns as `tool_use` or `tool_calls` with an id. Your code validates it, runs the function and sends the result back with that id; then the model continues.

**Q: Where is the security boundary?**

A: In your code, at execution. The model's arguments are untrusted: validate them against the schema, take identity and permissions from the session, and require approval for risky actions. Strict mode helps with the shape of the arguments, not with permissions.

**Q: The model asks for two tools at once. What do you do?**

A: Run independent reads in parallel and send all the results back together, each tied to its call id. Run writes one at a time, or turn parallel calls off for those tools.

**Q: What is `tool_choice` for?**

A: Controlling whether tools are used: `auto` lets the model decide, `none` forbids tools, and you can require some tool or one named tool. Forcing is for fixed first steps; switch back to `auto` afterwards or the loop can't end.

## Related topics

- [AI Agent with Tools](/?topic=ai-agent&read): the loop, step limits, prompt injection and idempotent actions.
- [LangChain](/?topic=langchain&read): one tool format across providers, and `createAgent`.
- [LangGraph](/?topic=langgraph&read): when the steps should be fixed, not chosen by the model.
- [LLM Guardrails](/?topic=llm-guardrails&read): checking what the model says before it reaches anyone.

## Sources

- Anthropic: [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (tool_choice, strict tool use, the tool-use system prompt)
- Anthropic: [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) (tool_result, is_error, parallel results)
- OpenAI: [Function calling](https://developers.openai.com/api/docs/guides/function-calling) (tools, tool_choice, parallel_tool_calls, strict mode)
- Model Context Protocol: [Specification](https://modelcontextprotocol.io/specification/2026-07-28)

## Why This Matters

Every AI agent, coding assistant and "chat with your data" feature is built on tool calling, and "how does tool calling work under the hood?" is one of the most common agentic AI interview questions. Knowing that the model only requests, that your code is the security boundary, and how results, errors, parallel calls and `tool_choice` work lets you build agents that are reliable, cheap and safe, and explain them clearly.
