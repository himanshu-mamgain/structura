import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'The model never calls the API',
      text: 'A language model only writes text. Tool calling is an agreement about that text: the model writes a structured request, and your app decides whether to run it.',
      focus: ['User', 'Your App (Agent Loop)', 'LLM'],
      remember: 'The model asks; your code acts.',
    },
    {
      title: '1. Definition',
      text: 'You describe each tool with a name, a description and a JSON Schema for its arguments. They go with the messages on every call, and cost input tokens each time.',
      focus: ['Tool Registry (schemas)', 'Your App (Agent Loop)'],
      example: '{ name: "get_order", description: "Get the customer\'s order…", input_schema: { order_id: string } }',
    },
    {
      title: 'Under the hood',
      text: 'The provider puts your tools into a special system prompt. The model was trained to write a tool-call block when a tool would help. The API parses that block and hands it to you as data.',
      focus: ['Prompt Builder (tools into context)', 'LLM', 'Tool-Call Parser'],
    },
    {
      title: '2. Decision',
      text: 'The reply is either text or tool calls. Anthropic sends tool_use blocks with stop_reason "tool_use". OpenAI sends tool_calls, with the arguments as a JSON string you must parse.',
      focus: ['Tool-Call Parser', 'Stop Reason?'],
      example: '{ type: "tool_use", id: "toolu_02", name: "get_order", input: { order_id: "4101" } }',
    },
    {
      title: '3. Execution: check first',
      text: 'Your app validates the arguments against the schema, then checks permissions. The user\'s id comes from the session, never from the model. Only then does the tool run.',
      focus: ['Argument Validator', 'Permission Check', 'Tool Executor'],
      example: 'cancel_order(4207) → order 4207 belongs to u_3390, not u_8812 → refused',
      remember: 'Never trust model-written arguments.',
    },
    {
      title: '4. Result, by call id',
      text: 'Each result goes back tied to its call\'s id. Errors go back too, marked as errors, so the model can fix a bad call or explain the problem.',
      focus: ['Conversation (messages)', 'Argument Validator'],
      example: '{ type: "tool_result", tool_use_id: "toolu_02", content: "…", is_error: true }',
    },
    {
      title: '5. Loop, and parallel calls',
      text: 'Your app calls the model again. It may ask for more tools or answer. Asked "rain in Bengaluru, and where is 4101?", it asks for 2 tools at once; run them in parallel.',
      focus: ['Tool Executor', 'Weather API', 'Orders API'],
    },
    {
      title: 'Forcing a tool',
      text: 'tool_choice can let the model decide (auto), forbid tools (none), or force one tool. Forcing applies to every call, so switch back to auto after the first one.',
      focus: ['Your App (Agent Loop)', 'Model API (Anthropic / OpenAI)'],
    },
  ],
  quiz: [
    {
      question: 'Who runs get_order when the model asks for it?',
      options: ['The model provider', 'The LLM itself', 'Your app, after checking the arguments', 'The user\'s browser'],
      answer: 2,
      why: 'The model only writes a request; your code validates it and runs the real function.',
    },
    {
      question: 'The model sends cancel_order for an order that belongs to another customer. What stops it?',
      options: ['A firmer system prompt', 'A permission check using the session\'s user id', 'strict: true', 'A lower temperature'],
      answer: 1,
      why: 'Identity and ownership must come from your session, not from anything the model writes.',
    },
    {
      question: 'Why send an invalid call back as an error result instead of failing the request?',
      options: ['It is cheaper', 'The provider requires it', 'The model can fix the arguments or explain the problem', 'It hides the error'],
      answer: 2,
      why: 'With the error in the conversation, the model can retry with corrected arguments.',
    },
  ],
}

export default lesson
