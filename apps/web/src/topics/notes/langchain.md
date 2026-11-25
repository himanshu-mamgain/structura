# LangChain: Building LLM Apps

> 💡 **TL;DR**: A **large language model (LLM)**, such as Anthropic's Claude or the model behind ChatGPT, only turns text into text. To build a real app you also need it to call your APIs, search your documents, remember a conversation and follow rules. **LangChain** is a free, open-source library (JavaScript and Python) of standard pieces for that: **one interface for every model provider**, **tools** (your functions the model may ask to run), **retrievers** (search over your documents) and **`createAgent`**, which runs the agent loop. **Middleware** adds rules around every step, such as "a person approves refunds", and a **checkpointer** saves each conversation so it can pause and carry on. `createAgent` runs on **LangGraph**, its lower-level sister library.

## At a glance

| Question | Answer |
|---|---|
| What it is | An open-source library of standard parts for LLM apps |
| Languages | JavaScript/TypeScript (`langchain`) and Python (`langchain`) |
| Version 1.0 | October 2025 |
| Chat model | One interface for every provider, picked with a string such as `"anthropic:claude-sonnet-5"` |
| Tool | Your function, with a name, a description and an argument schema |
| Agent | `createAgent`: the model asks for tools, LangChain runs them, until the model answers in text |
| Middleware | Hooks before and after each model and tool call: approvals, limits, clean-up |
| Checkpointer | Saves each conversation (a **thread**) so it can continue or resume |
| Runs on | LangGraph, which you use directly for custom workflows |
| Not included | The model itself: you still pay a provider, or run your own |

## What LangChain is, and what you'd do without it

Picture a food-delivery app's support chat. A customer writes: "Order 4101 is 40 minutes late. Please refund the delivery fee." To answer well, the app must:

1. Ask a model what to do.
2. Run the model's request to look up order 4101 in your orders API.
3. Search your help articles for the refund rule.
4. Refund ₹49, but only after a person approves.
5. Remember all of this when the customer replies "thanks, when will it arrive?".

Without LangChain, you call the provider's API yourself. Each provider writes requests and tool calls differently, so your loop is tied to one provider. You write the loop, the conversation storage, the pause for approval and the logging by hand.

LangChain gives you each of those as a standard piece. It is not a model and not a hosted service: it is a library that runs inside your own server.

## Follow one chat all the way through

The customer's message above, with the refund needing a person. The model here asks for 3 tools, one at a time.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The server calls `agent.invoke()` with the message and `thread_id: "chat-8812"` | Customer (Chat App) → createAgent Loop |
| 2 | The model is sent the system prompt, 3 tool descriptions and the message: about 155 tokens | Chat Model Interface → Model Provider (Anthropic / OpenAI) |
| 3 | It asks for `get_order({ order_id: "4101" })`; the order is promised 19:40, it is now 20:20 | Tool Calls? → Tool Runner → Orders API |
| 4 | It asks for `search_help("late delivery refund delivery fee")`; the best passage says "more than 30 minutes late: we refund the delivery fee" | Help Docs Retriever → Vector Store |
| 5 | It asks for `refund_delivery_fee({ order_id: "4101", amount_inr: 49 })` | Tool Calls? |
| 6 | Middleware stops it and pauses the run; the conversation is saved | Middleware → Checkpointer (Postgres) |
| 7 | The Support Lead approves; the server resumes the same thread | Support Lead → createAgent Loop |
| 8 | The refund runs: ₹49 back to the wallet | Tool Runner → Payments API |
| 9 | The model answers in text, so the loop ends | Model Provider (Anthropic / OpenAI) → Customer (Chat App) |
| 10 | Every call is recorded for debugging | Traces (LangSmith) |

That is 4 model calls (one per tool request, plus the answer) and 3 tool calls. A **token** is the unit models read and write, about 4 characters of English. Every model call re-reads the whole conversation so far, so the 4 calls read about 1.1k tokens in total, although no single message is longer than 100.

## Chat models: one interface, any provider

You choose a model with one string, `"provider:model"`. The **Chat Model Interface** converts LangChain's messages into that provider's request format, and the reply back into one `AIMessage`.

The clearest example is a tool call. The same request comes back in two different shapes:

| Provider | How it writes "call get_order with order 4101" |
|---|---|
| Anthropic | A content block: `{ "type": "tool_use", "name": "get_order", "input": { "order_id": "4101" } }` |
| OpenAI | `tool_calls: [{ "type": "function", "function": { "name": "get_order", "arguments": "{\"order_id\":\"4101\"}" } }]`, with the arguments as a JSON string |
| LangChain gives you | `tool_calls: [{ name: "get_order", args: { order_id: "4101" }, id: "…" }]`, the same for both |

This code asks both providers the same question and prints the same shape from each:

```javascript
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'

const getOrderSpec = {
  name: 'get_order',
  description: "Look up an order's status, promised time and fees.",
  schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
}

for (const model of [new ChatAnthropic({ model: 'claude-sonnet-5' }), new ChatOpenAI({ model: 'gpt-5.5' })]) {
  const reply = await model.bindTools([getOrderSpec]).invoke('Where is my order 4101?')
  console.log(reply.tool_calls) // [{ name: 'get_order', args: { order_id: '4101' }, id: '…' }]
}
```

`bindTools` tells the model which tools exist; `invoke` sends one request. Each provider package (`@langchain/anthropic`, `@langchain/openai`) reads its own API key from the environment.

## Tools and the agent loop

A **tool** is your own function plus three things the model can read: a name, a description and an argument schema. The model never runs anything; it only asks. This code defines two tools and an agent:

```javascript
import { createAgent, tool } from 'langchain'
import * as z from 'zod'

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
  model: 'anthropic:claude-sonnet-5',
  tools: [getOrder, searchHelp],
  systemPrompt: 'You are the support assistant for a food-delivery app. Use the tools; never guess order details.',
})

const result = await agent.invoke({ messages: [{ role: 'user', content: 'Where is my order 4101?' }] })
console.log(result.messages.at(-1).content)
```

`zod` is a small library for describing data shapes; LangChain turns the `z.object(...)` into the schema the model sees. `ordersApi` and `helpRetriever` stand for your own code.

The loop inside `createAgent`:

1. Send the messages and tool descriptions to the model.
2. If the reply asks for tools, run each one and add its result as a `ToolMessage` (a message that carries a tool's result back to the model).
3. Go back to step 1.
4. If the reply is plain text, stop and return it.

The loop has no fixed number of steps; the model decides when it's done. That is why step limits and approvals matter (below).

## Retrievers: answer from your documents

A **retriever** takes a question and returns the most relevant passages from your documents. Usually it searches a **vector store**: a database that keeps each passage with its **embedding**, a list of numbers that captures the passage's meaning, so passages about the same thing are found even with different words. This is the "retrieval" in **retrieval-augmented generation (RAG)**: the model answers from passages you gave it, not from memory.

In an agent, you wrap the retriever as a tool (`search_help` above). The model decides when it needs to look something up, and can cite the passage it used.

## Middleware: rules around every step

**Middleware** is code that runs at fixed points in the loop. LangChain 1.0 has six hooks:

| Hook | Runs |
|---|---|
| `beforeAgent` | Once, before the run starts |
| `beforeModel` | Before each model call: trim old messages, add context |
| `wrapModelCall` | Around each model call: retry, switch to a backup model |
| `afterModel` | After each model reply: check or change it |
| `wrapToolCall` | Around each tool call: limits, logging, errors |
| `afterAgent` | Once, after the run ends |

Ready-made middleware covers common jobs, such as hiding personal data and asking a person. This code makes the refund tool wait for approval:

```javascript
import { createAgent, humanInTheLoopMiddleware } from 'langchain'
import { Command } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL)
await checkpointer.setup() // creates its tables once

const agent = createAgent({
  model: 'anthropic:claude-sonnet-5',
  tools: [getOrder, searchHelp, refundDeliveryFee],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: { refund_delivery_fee: { allowedDecisions: ['approve', 'reject'] } },
    }),
  ],
  checkpointer,
})

const config = { configurable: { thread_id: 'chat-8812' } }
const first = await agent.invoke({ messages: [{ role: 'user', content: 'Order 4101 is late. Refund the delivery fee.' }] }, config)
// first.__interrupt__[0].value.actionRequests → [{ name: 'refund_delivery_fee', args: { order_id: '4101', amount_inr: 49 } }]

const done = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)
```

What the values mean:

- `interruptOn` lists the tools that pause. Tools not listed (`get_order`, `search_help`) run without asking.
- `allowedDecisions` is what the person may choose. `approve` runs the tool as asked; `reject` skips it and gives the model the person's message instead. There are also `edit` (change the arguments) and `respond`.
- `__interrupt__` is how a paused run reports what it's waiting for.
- `Command({ resume: … })` carries the decision back in. It must use the same `thread_id`.

A rule in middleware is code; a rule in the prompt is a request the model may not follow. Put money, permissions and limits in middleware.

## Memory: checkpointers and threads

A **checkpointer** saves the agent's state (the conversation so far) after each step, keyed by a `thread_id` you choose, such as one per chat. It gives you two things:

- **Conversations**: the next message on `chat-8812` continues where the last one stopped.
- **Pauses**: a run waiting for approval is just saved rows, so no server sits waiting, and any server can resume it.

| Checkpointer | Package | Use for |
|---|---|---|
| `MemorySaver` | Comes with LangGraph | Tests only: lost when the process stops |
| `SqliteSaver` | `@langchain/langgraph-checkpoint-sqlite` | One machine, local tools |
| `PostgresSaver` | `@langchain/langgraph-checkpoint-postgres` | Production |

## Watching it: traces

When an agent gives a wrong answer, you need to see which tool it called, with what arguments, and what came back. **LangSmith** is LangChain's hosted service that records each run as a **trace**: every model call and tool call with inputs, outputs, tokens and time. It's optional and paid beyond a free tier; you can also send the same data to other tracing tools.

## What it costs and where it stops

- **The library is free** (MIT licence). You pay for the model's tokens, and for LangSmith if you use it.
- **The model is the slow part**: a call often takes 1 to 5 seconds. Stream the answer so the customer sees words straight away.
- **Long chats cost more**: each model call re-reads everything. Trim or summarise old messages with middleware.
- **Abstractions hide details**: when something breaks, you may need to read what LangChain actually sent. Traces help.
- **Fast-moving library**: version 1.0 moved older pieces (old chains, some retrievers) into a separate `@langchain/classic` package. Pin versions and read the release notes.
- **`createAgent` is one loop shape**: for fixed steps, branches and long-running processes, use LangGraph.

## How to choose

- **One provider, one simple call, no tools?** Call the provider's own software development kit (SDK); LangChain adds little.
- **Tools, several providers, or a chat that must remember?** LangChain with `createAgent`.
- **Rules that must hold (money, deletes)?** Middleware, not the prompt.
- **Steps that must always happen in order, branches, waiting days for a person?** [LangGraph](/?topic=langgraph&read).
- **Java?** There's no official LangChain; LangChain4j is a separate project with the same ideas.

## ⚠️ Critical Mistakes

- **Rules only in the system prompt.** A customer or a document can talk the model out of them. Use middleware.
- **`MemorySaver` in production.** Every conversation and paused approval vanishes on restart. Use Postgres.
- **Vague tool descriptions.** The model chooses tools by their description; "does order stuff" gets the wrong tool called.
- **No step limit or approval on tools that change things.** A confused model can refund twice or loop. Pause risky tools and give them idempotency keys.
- **Trusting tool results.** A help article or web page can contain instructions for the model. Treat results as data, and keep risky tools behind approval.
- **Not testing a new model.** Switching providers is one line, but tool-calling quality differs. Re-run your test chats first.

## Interview Q&As

**Q: What does LangChain give you over calling a provider's API directly?**

A: One interface for every provider, a single tool-call format, tools from plain functions, retrievers, an agent loop, middleware for rules, and checkpointers for memory and pauses. You can switch providers in one line and keep the rest of the code.

**Q: How does a LangChain agent decide when to stop?**

A: Each model reply either asks for tools or is plain text. Tool calls are run and the loop continues; a plain-text reply ends it. Because the model decides, you also need limits on steps and approvals for risky tools.

**Q: How do you stop the agent issuing a refund without a person?**

A: Put `humanInTheLoopMiddleware` on the refund tool, with a checkpointer. The run pauses before the tool runs and is saved; the server resumes it with an approve or reject decision.

**Q: When would you use LangGraph instead of `createAgent`?**

A: When some steps must always happen (look up the order, check the policy in code), when you need branches or parallel steps, or when runs wait a long time for people. `createAgent` itself runs on LangGraph, so you can mix the two.

## Related topics

- [LangGraph](/?topic=langgraph&read): the graph runtime under `createAgent`.
- [AI Agent with Tools](/?topic=ai-agent&read): the agent loop, prompt injection and idempotent actions.
- [RAG Pipeline](/?topic=rag-pipeline&read): what goes into a good retriever.
- [LLM Gateway](/?topic=llm-gateway&read): keys, budgets and fallbacks in front of the model.

## Sources

- LangChain: [LangChain and LangGraph 1.0](https://www.langchain.com/blog/langchain-langgraph-1dot0) (22 October 2025)
- LangChain docs (JavaScript): [Agents](https://docs.langchain.com/oss/javascript/langchain/agents) and [What's new in LangChain v1](https://docs.langchain.com/oss/javascript/releases/langchain-v1)
- LangChain docs (JavaScript): [Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)
- LangGraph docs (JavaScript): [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)
- LangChain4j: [AI Services](https://docs.langchain4j.dev/tutorials/ai-services)

## Why This Matters

Most teams building with LLMs now use LangChain or something like it, and job listings for AI engineers often name it. Knowing what it actually does (one model interface, tools, the loop, middleware, checkpoints) and what it doesn't (the model, your rules, your safety) lets you build agents that are easy to change and hard to misuse, and explain those choices in an interview.
