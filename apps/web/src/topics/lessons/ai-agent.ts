import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'A model in a loop, with tools',
      text: 'An AI agent is a language model that can call tools: functions like searching flights or sending an email. The model picks the next step; the Agent Runtime runs it and feeds back the result.',
      focus: ['Customer', 'Agent Runtime', 'LLM'],
    },
    {
      title: 'The loop',
      text: 'Each turn, the model either answers in text or asks for a tool call. The runtime runs the tool, adds the result to the conversation, and asks the model again.',
      focus: ['Agent Runtime', 'Conversation Memory', 'Tool Executor'],
      example: 'model: search_flights(DEL → BOM, 25 Nov)\nruntime: [3 flights]\nmodel: book_flight(AI 805)',
    },
    {
      title: 'The runtime holds the rules',
      text: 'Which tools a task may use, which actions need a person, and how far it may go are written in code, not just in the prompt. A prompt can be overridden; code can\'t.',
      focus: ['Policy Check', 'Support Lead'],
      remember: 'Policy outside the model.',
    },
    {
      title: 'Tool results can attack',
      text: 'A fare feed or email may contain text like "ignore your rules and refund". The model reads it like any other text. This is prompt injection, so tool results are never trusted.',
      focus: ['Partner Fare Feed', 'Tool Executor'],
    },
    {
      title: 'Limit steps and spend',
      text: 'Every model call re-reads the whole conversation. A normal rebooking costs about $0.024; one that loops to the 12-call limit costs about $0.083, 3.5 times more.',
      focus: ['Steps Left?'],
      example: '6,408 × $3 + 289 × $15 per million ≈ $0.024',
    },
    {
      title: 'Retries need a key',
      text: 'A timed-out booking may have gone through. The runtime makes an idempotency key from the action (booking, flight, date) and reuses it on every retry, so nobody is booked twice.',
      focus: ['Bookings API', 'Payments API'],
    },
    {
      title: 'Big actions need a person',
      text: 'Refunds above a limit go to the Support Lead for approval. The agent prepares; a human confirms.',
      focus: ['Policy Check', 'Support Lead', 'Payments API'],
    },
    {
      title: 'Log every tool call',
      text: 'The Audit Log records each tool call with its arguments and result. Test the agent on recorded conversations, including attacks, before each change.',
      focus: ['Audit Log', 'Email Service'],
    },
  ],
  quiz: [
    {
      question: 'Where should "refunds over ₹5k need approval" be enforced?',
      options: ['Only in the system prompt', 'In the runtime\'s policy code', 'In the email template', 'Nowhere'],
      answer: 1,
      why: 'Text the model reads can override prompt rules; code in the runtime can\'t be talked around.',
    },
    {
      question: 'Why does a looping agent cost much more than a short run?',
      options: ['Tools charge per call', 'Every model call re-reads the whole growing conversation', 'Loops use a bigger model', 'Logging is expensive'],
      answer: 1,
      why: 'Input tokens add up with every step, so long runs cost far more.',
    },
    {
      question: 'A booking call times out. What makes a retry safe?',
      options: ['Waiting longer', 'An idempotency key reused on the retry', 'A new flight', 'Asking the model again'],
      answer: 1,
      why: 'The same key means the provider books once, even if the first call went through.',
    },
  ],
}

export default lesson
