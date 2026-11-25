import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'A kit for LLM apps',
      text: 'A language model only turns text into text. LangChain is a free library that adds the rest: one way to call any model, tools, search over your documents, and an agent loop. It works in JavaScript and Python.',
      focus: ['Customer (Chat App)', 'createAgent Loop'],
    },
    {
      title: 'One interface, any model',
      text: 'You pick a model with one string, like "anthropic:claude-sonnet-5". The Chat Model Interface turns your messages into that provider\'s format. Switching provider is a one-line change.',
      focus: ['Chat Model Interface', 'Model Provider (Anthropic / OpenAI)'],
      example: "createAgent({ model: 'anthropic:claude-sonnet-5', tools })\ncreateAgent({ model: 'openai:gpt-5.5', tools })",
    },
    {
      title: 'Tools are your functions',
      text: 'A tool is a normal function with a name, a description and an argument schema. The model reads only the name and description, then asks for a call. LangChain runs it.',
      focus: ['Tool Runner', 'Orders API'],
      example: "tool(getOrder, { name: 'get_order', description: \"Look up an order's status\", schema: z.object({ order_id: z.string() }) })",
      remember: 'The description is a prompt: write it well.',
    },
    {
      title: 'The agent loop',
      text: 'createAgent sends the messages to the model. If the reply asks for tools, it runs them and calls the model again. When the model answers in text, the loop ends.',
      focus: ['createAgent Loop', 'Tool Calls?', 'Tool Runner'],
      example: 'model → get_order(4101)\nmodel → search_help("late delivery refund")\nmodel → "Done: ₹49 refunded"',
    },
    {
      title: 'Same tool call, two formats',
      text: 'Anthropic sends a tool call as a tool_use block. OpenAI sends tool_calls with the arguments as a JSON string. LangChain turns both into one tool_calls list, so your code never changes.',
      focus: ['Chat Model Interface', 'Tool Calls?'],
      example: "[{ name: 'get_order', args: { order_id: '4101' }, id: '…' }]",
    },
    {
      title: 'Search your documents',
      text: 'A retriever finds the help passages closest to a question in a vector store. Wrap it as a tool, and the model can answer from your real policy instead of guessing.',
      focus: ['Help Docs Retriever', 'Vector Store'],
    },
    {
      title: 'Middleware sets the rules',
      text: 'Middleware runs before and after each model and tool call. humanInTheLoopMiddleware stops the refund tool and asks a Support Lead first. Rules in code can\'t be talked around.',
      focus: ['Middleware', 'Support Lead', 'Payments API'],
      remember: 'Money needs a person, in code.',
    },
    {
      title: 'Save the thread',
      text: 'A checkpointer saves each conversation under a thread_id. That keeps follow-up questions in context, and lets a paused refund resume hours later on any server. Traces record every step.',
      focus: ['Checkpointer (Postgres)', 'Traces (LangSmith)'],
      example: "agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), { configurable: { thread_id: 'chat-8812' } })",
    },
  ],
  quiz: [
    {
      question: 'You move from Anthropic to OpenAI. What changes in a LangChain app?',
      options: ['Every tool', 'The model string', 'The tool_calls format your code reads', 'The checkpointer'],
      answer: 1,
      why: 'LangChain gives every provider one interface and one tool_calls shape, so only the model string changes.',
    },
    {
      question: 'When does the createAgent loop stop?',
      options: ['After exactly 3 tool calls', 'When a tool returns an error', 'When the model answers in text instead of asking for a tool', 'When the checkpointer is full'],
      answer: 2,
      why: 'Each reply either asks for tools, which run, or is a text answer, which ends the loop.',
    },
    {
      question: 'How do you make sure no refund happens without a person?',
      options: ['Say so in the system prompt', 'Give the tool a scary name', 'Use a bigger model', 'Use humanInTheLoopMiddleware on the refund tool, with a checkpointer'],
      answer: 3,
      why: 'Middleware pauses the run before the tool executes; a prompt can be ignored or overridden.',
    },
  ],
}

export default lesson
