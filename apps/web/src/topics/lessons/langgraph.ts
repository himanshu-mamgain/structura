import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'A workflow as a graph',
      text: 'LangGraph builds an LLM app as a graph. Nodes are functions that do one job. Edges say what runs next. You decide the steps, and use the model only where you need language.',
      focus: ['classify (LLM)', 'lookup_order', 'check_policy (code)', 'write_reply (LLM)'],
    },
    {
      title: 'One shared state',
      text: 'Every node reads the same state and returns an update. A reducer says how updates combine: messages append to the list, other keys are replaced.',
      focus: ['classify (LLM)', 'lookup_order'],
      example: 'classify returns { intent: "refund", order_id: "4102" }\nlookup_order returns { order: { food: 640 } }',
    },
    {
      title: 'Edges that choose',
      text: 'A conditional edge is a small function. It reads the state and names the next node. Questions go to answer_faq; refunds go to lookup_order.',
      focus: ['Route by Intent', 'answer_faq (LLM)', 'lookup_order'],
    },
    {
      title: 'Code decides money',
      text: 'check_policy is plain code. A cold-food refund needs a photo within 2 hours, and anything over ₹200 needs a person. The model never decides the amount.',
      focus: ['check_policy (code)', 'Needs Approval?'],
      example: '₹640 food total > ₹200 → needs_approval',
      remember: 'Model for words, code for rules.',
    },
    {
      title: 'Save after every step',
      text: 'A checkpointer saves the state after each step, under a thread_id. The paused refund has 5 checkpoints in Postgres, so any server can carry on.',
      focus: ['Checkpointer (Postgres)'],
      example: 'steps -1 (input), 0 (start), 1 classify, 2 lookup_order, 3 check_policy',
    },
    {
      title: 'Pause for a person',
      text: 'The approve node calls interrupt(). The run stops and returns at once; no server waits. When the Support Lead decides, Command({ resume: true }) continues the same thread.',
      focus: ['approve (interrupt)', 'Support Lead'],
      example: "app.invoke(new Command({ resume: true }), { configurable: { thread_id: 'support-8812' } })",
    },
    {
      title: 'Resume re-runs the node',
      text: 'On resume, the paused node runs again from its first line. So nothing with side effects goes before interrupt(). issue_refund sends an idempotency key, so a repeat never pays twice.',
      focus: ['approve (interrupt)', 'issue_refund', 'Payments API'],
      remember: 'Side effects after the interrupt, with a key.',
    },
    {
      title: 'Restarts and time travel',
      text: 'With PostgresSaver, a deploy while waiting loses nothing. MemorySaver keeps checkpoints in memory, so a restart loses the run. Saved checkpoints also let you replay a thread from any step.',
      focus: ['Checkpointer (Postgres)', 'Customer (Chat App)'],
    },
  ],
  quiz: [
    {
      question: 'Two nodes each return { messages: [...] }. Why do both messages stay in the state?',
      options: ['The messages key has a reducer that appends', 'LangGraph keeps every value', 'The checkpointer merges them', 'They run in different threads'],
      answer: 0,
      why: 'A reducer decides how updates combine; messages append, while keys without one are replaced.',
    },
    {
      question: 'The server restarts while a refund waits for approval. Which setup loses nothing?',
      options: ['MemorySaver', 'No checkpointer', 'PostgresSaver', 'A longer recursion limit'],
      answer: 2,
      why: 'PostgresSaver keeps checkpoints in the database, so any server can resume the thread.',
    },
    {
      question: 'Why must the approve node avoid side effects before interrupt()?',
      options: ['interrupt() is slow', 'On resume the node runs again from its first line', 'Side effects break the checkpointer', 'The Support Lead sees them'],
      answer: 1,
      why: 'Resuming re-runs the whole node, so anything before interrupt() happens twice.',
    },
  ],
}

export default lesson
