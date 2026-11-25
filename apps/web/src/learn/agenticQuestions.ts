// Agentic AI interview questions, shown on the Interview prep page (?page=prep#agentic).
// Written for Structura in Simple English; each one points to the topics that teach it.

export interface InterviewQuestion {
  id: string
  question: string
  level: 'Basics' | 'Building' | 'Production'
  /** The short answer to give, in a few sentences. Blank lines split paragraphs; "- " makes a list. */
  answer: string
  /** What interviewers listen for. */
  points: string[]
  /** What weak answers say. */
  mistakes: string[]
  /** Structura topics that teach it, best first. */
  topics: string[]
}

export const AGENTIC_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'what-is-an-agent',
    question: 'What is an AI agent, and how is it different from a chatbot or a single LLM call?',
    level: 'Basics',
    answer:
      'A single call sends a prompt and gets text back. A chatbot does that in a conversation. An agent is a language model in a loop with tools: it decides the next step, asks for a tool, sees the result, and decides again until the task is done.\n\nThe difference is that an agent acts and chooses its own path. So it also needs things a chatbot doesn\'t: limits on steps and cost, rules on which tools it may use, and a way to hand over to a person.',
    points: ['The loop: decide, act, observe, repeat', 'Tools let it act on real systems', 'The runtime around the model enforces limits and policy'],
    mistakes: ['Calling any chatbot with a long prompt an agent', 'Forgetting that more autonomy means more ways to fail'],
    topics: ['ai-agent', 'tool-calling'],
  },
  {
    id: 'tool-calling',
    question: 'How does tool calling (function calling) actually work under the hood?',
    level: 'Basics',
    answer:
      'You send each tool as a name, a description and a JSON Schema for its arguments. The provider puts them into a system prompt the model was trained on. When a tool would help, the model writes a structured call, which the API returns as data with an id.\n\nYour code validates the arguments, checks permissions, runs the real function and sends the result back tied to that id. Then the model either calls more tools or answers.',
    points: ['Five steps: definition, decision, execution, result, loop', 'The model only requests; your code runs it', 'Tool definitions cost input tokens on every call'],
    mistakes: ['Saying "the LLM calls the API"', 'Trusting model-written arguments without validation'],
    topics: ['tool-calling', 'ai-agent'],
  },
  {
    id: 'react',
    question: 'Explain the ReAct pattern. Why did it matter?',
    level: 'Basics',
    answer:
      'ReAct (reasoning and acting) has the model alternate between thinking about what to do, taking an action with a tool, and reading the observation, then thinking again. It came from a 2022 research paper.\n\nIt mattered because it grounded the model\'s reasoning in real results. Before it, models either reasoned without checking facts or acted without explaining why. Today\'s tool-calling loop is ReAct built into the API.',
    points: ['Thought → action → observation, repeated', 'Grounds reasoning in tool results', 'Modern agent loops are its direct descendants'],
    mistakes: ['Describing it as just "chain of thought"', 'Not connecting it to how agents work today'],
    topics: ['ai-agent', 'tool-calling'],
  },
  {
    id: 'workflow-vs-agent',
    question: 'Workflow or agent: when would you NOT use an agent?',
    level: 'Building',
    answer:
      'Use a workflow when you know the steps: "look up the order, apply the refund policy, ask a person above ₹200". Code decides the order, and the model is used only where language helps. Use an agent when the steps can\'t be known in advance, such as open-ended research or debugging.\n\nAgents cost more, are slower and are harder to test. If a fixed sequence works, it is cheaper, faster and more predictable.',
    points: ['Known steps → workflow; open-ended → agent', 'Rules that must hold belong in code', 'You can mix them: an agent as one step of a workflow'],
    mistakes: ['Making everything an agent', 'Letting the model decide money or permissions'],
    topics: ['langgraph', 'ai-agent'],
  },
  {
    id: 'agent-components',
    question: 'What are the core components of an agent?',
    level: 'Basics',
    answer:
      '- The model, which decides the next step.\n- Tools, the actions it can request.\n- Memory: the conversation now, and anything kept between sessions.\n- The runtime (or harness): runs the loop and the tools, enforces policy, limits steps and cost, and asks people for approval.\n- Observability: logs and traces of every step.',
    points: ['Model, tools, memory, runtime, observability', 'The runtime matters as much as the model', 'Approvals and limits are components, not afterthoughts'],
    mistakes: ['Listing only the model and a prompt', 'Leaving out how it is stopped and monitored'],
    topics: ['ai-agent', 'agent-context'],
  },
  {
    id: 'memory',
    question: 'What is the difference between short-term and long-term memory in an agent?',
    level: 'Building',
    answer:
      'Short-term memory is what is in the model\'s context for this task: the messages, tool calls and results. It is limited by the context window, and every model call re-reads it, so it gets expensive.\n\nLong-term memory is stored outside the model, in a database, notes or a vector store. The agent saves facts there and retrieves the relevant ones when it needs them. Checkpointers sit in between: they save a run\'s state so it can resume later.',
    points: ['Short-term = the context, which is limited and paid for on every call', 'Long-term = stored outside, retrieved when needed', 'Compaction and notes keep long tasks inside the window'],
    mistakes: ['Assuming the model remembers past conversations by itself', 'Stuffing everything into the context'],
    topics: ['agent-context', 'langgraph', 'rag-pipeline'],
  },
  {
    id: 'mcp',
    question: 'What is MCP (Model Context Protocol)?',
    level: 'Basics',
    answer:
      'MCP is an open protocol for connecting AI applications to tools and data. An application (the host) runs clients that connect to servers. Each server offers tools (functions the model can call), resources (data) and prompts (templates). Messages use JSON-RPC.\n\nIt means one integration, such as a GitHub or database server, works with any MCP-capable app, instead of each app writing its own. Anthropic introduced it in November 2024, and it moved to the Linux Foundation\'s Agentic AI Foundation in December 2025.',
    points: ['Hosts, clients and servers', 'Servers offer tools, resources and prompts', 'Write an integration once, use it in many apps'],
    mistakes: ['Saying MCP replaces tool calling: it is how tools are delivered to the app', 'Ignoring that third-party servers run code and need trust and consent'],
    topics: ['tool-calling', 'ai-agent'],
  },
  {
    id: 'stop-loops',
    question: 'How do you stop an agent looping for ever, and control its cost?',
    level: 'Production',
    answer:
      'Enforce limits in the runtime, not the prompt: a maximum number of steps, a token or money budget per task, and a timeout. When a limit is hit, stop and hand over to a person with the conversation attached.\n\nAlso give the model a way out ("ask the user if two searches find nothing"), and watch for repeated identical tool calls.',
    points: ['Step, token and time limits in code', 'Every model call re-reads the conversation, so cost grows faster than steps', 'Hand over to a person instead of failing silently'],
    mistakes: ['Relying on "stop when done" in the prompt', 'No budget per conversation'],
    topics: ['ai-agent', 'agent-context', 'langgraph'],
  },
  {
    id: 'prompt-injection',
    question: 'How do you defend an agent against prompt injection?',
    level: 'Production',
    answer:
      'Prompt injection is text inside data, such as a web page, an email or a tool result, written to look like instructions. The model may follow it. No prompt reliably prevents that, so the defence is limiting what an injected instruction can do.\n\nGive each task only the tools it needs, require approval for risky actions such as money, sending or deleting, mark tool results as data, keep secrets out of the context, and log every call.',
    points: ['Tool results are untrusted text in the same context as instructions', 'Least privilege: an allow-list of tools per task', 'Approval for irreversible or money actions'],
    mistakes: ['"I\'ll tell the model to ignore injected instructions"', 'Giving every agent every tool'],
    topics: ['ai-agent', 'llm-guardrails', 'tool-calling'],
  },
  {
    id: 'safe-retries',
    question: 'A tool call times out. How do you retry it safely?',
    level: 'Production',
    answer:
      'A timeout doesn\'t tell you whether the action happened: the booking may be made and only the reply lost. Retrying blindly can book or charge twice.\n\nGive every action that changes something an idempotency key: an id for that one intended action, made by the runtime and reused on every retry. The service stores it and returns the first result for a repeat.',
    points: ['Timeout means unknown, not failed', 'The runtime makes the key, not the model', 'Reads can retry freely; writes need keys'],
    mistakes: ['Retrying a payment with no key', 'Letting the model invent the key'],
    topics: ['payment-idempotency', 'ai-agent', 'langgraph'],
  },
  {
    id: 'human-in-the-loop',
    question: 'When and how should a person approve an agent\'s action?',
    level: 'Production',
    answer:
      'Ask a person before actions that are irreversible, cost money, affect other people or are unusual for the task: refunds over a limit, sending emails, deleting data.\n\nPause the run, save its state with a checkpointer, show the person the exact action and arguments, and resume with their decision: approve, edit or reject. With saved state, no server waits, and the run survives restarts.',
    points: ['Approval rules live in code (middleware or a graph node)', 'Checkpoint the run so it can pause for hours', 'The person sees the exact arguments'],
    mistakes: ['Asking the model to "check with a human" in the prompt', 'Keeping paused runs in memory'],
    topics: ['langgraph', 'langchain', 'ai-agent'],
  },
  {
    id: 'evaluate',
    question: 'How do you evaluate an agent?',
    level: 'Production',
    answer:
      'Build a test set of real tasks with known good outcomes, including hard cases: missing data, tool errors, timeouts and injection attempts. Replay them with recorded tool results and check what happened, not just the final words: which tools were called, with what arguments, and how many steps.\n\nMeasure task success, wrong or forbidden actions, steps and cost. Run the set on every change of prompt, model or tool, and use a judge model only for things code can\'t check.',
    points: ['Check actions and outcomes, not only the text', 'Include failures and attacks in the test set', 'Run it on every change'],
    mistakes: ['Testing a few happy-path chats by hand', 'Only scoring the final answer'],
    topics: ['llm-guardrails', 'ai-agent'],
  },
  {
    id: 'agentic-rag',
    question: 'RAG pipeline or retrieval as an agent tool?',
    level: 'Building',
    answer:
      'A RAG (retrieval-augmented generation) pipeline always retrieves before answering: one search, one answer. It is fast, cheap and predictable, and suits most question-answering.\n\nAgentic RAG gives retrieval to the model as a tool, so it can decide when to search, rewrite the query and search again, or combine sources. Use it for multi-step questions, and accept that it is slower and costs more.',
    points: ['Fixed pipeline: predictable and cheap', 'Retrieval as a tool: flexible, multi-step, costlier', 'Retrieval quality matters more than the model either way'],
    mistakes: ['Making every lookup agentic', 'Not measuring whether the right passage was retrieved'],
    topics: ['rag-pipeline', 'langchain', 'vector-database'],
  },
  {
    id: 'long-context',
    question: 'How do you keep a long-running agent inside its context window?',
    level: 'Production',
    answer:
      'The context fills with tool results and old messages, and every call re-reads it. Clear old tool results once they have been used. Compact the conversation into a summary when it gets long. Have the agent write notes to a file and read them back. Hand big sub-tasks to sub-agents that return only a short result.',
    points: ['Clear tool results, compact, take notes, use sub-agents', 'Keep what the next step needs, not everything', 'Long contexts cost more and can make answers worse'],
    mistakes: ['Just buying a bigger context window', 'Summarising away details the task still needs'],
    topics: ['agent-context', 'ai-agent'],
  },
  {
    id: 'multi-agent',
    question: 'One agent or many agents?',
    level: 'Building',
    answer:
      'Start with one agent and good tools. Add more agents when the work splits into independent parts (searching several sources at once) or needs very different tools and instructions.\n\nEach extra agent adds model calls, cost and hand-offs where information can be lost. An orchestrator that gives sub-agents narrow tasks and takes back short results is the usual shape.',
    points: ['Default to one agent', 'Split for parallel, independent work', 'Hand-offs lose context and add cost'],
    mistakes: ['Many agents for a simple task', 'Agents passing whole conversations to each other'],
    topics: ['agent-context', 'langgraph'],
  },
  {
    id: 'observe',
    question: 'An agent gave a wrong answer in production. How do you find out why?',
    level: 'Production',
    answer:
      'Record every run as a trace: each model call with its input and output, each tool call with its arguments and result, and the tokens and time. Then you can see exactly where it went wrong: a wrong tool, bad arguments, a poor retrieval result or a misread result.\n\nWith checkpoints, you can replay the run from the step before the mistake after a fix, and add the case to your test set.',
    points: ['Traces of every model and tool call', 'Find the first wrong step, not the last', 'Every bug becomes a test case'],
    mistakes: ['Logging only the final answer', 'Fixing the prompt without a test to prove it'],
    topics: ['langchain', 'langgraph', 'llm-guardrails'],
  },
]
