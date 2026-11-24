import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One door to every model',
      text: 'An LLM gateway sits between your apps and the model providers. Apps call the gateway; the gateway calls the models. The real API keys, limits and logs live in one place.',
      focus: ['Product Apps', 'Gateway API'],
    },
    {
      title: 'Virtual keys and budgets',
      text: 'Each team gets its own virtual key and a monthly budget. When a team hits its budget, the gateway stops its calls before a runaway loop costs thousands.',
      focus: ['Keys & Budgets'],
    },
    {
      title: 'Mask personal data first',
      text: 'Guardrails remove things like phone numbers and card numbers before a prompt leaves the company. The provider never sees them.',
      focus: ['Guardrails'],
      example: '"Call me on 98765 43210" → "Call me on [PHONE]"',
    },
    {
      title: 'Pick the right model',
      text: 'Easy tasks go to a small, cheap model; hard ones to a large one. Routing support to the small model and caching cut the cost from $10.22 to $6.41 a minute in the example.',
      focus: ['Which Model?', 'Small Model (A)', 'Large Model (A)'],
    },
    {
      title: 'Cache what is safe',
      text: 'The exact cache returns a saved answer for the very same prompt. The semantic cache matches similar prompts, so it needs a strict threshold and no personal data, or it serves wrong answers.',
      focus: ['Exact Cache', 'Semantic Cache'],
    },
    {
      title: 'Limit by tokens, not requests',
      text: 'Providers limit tokens a minute. The Token Limiter reserves the input tokens plus the maximum output before each call, then corrects to the real count.',
      focus: ['Token Limiter'],
      remember: 'Rate-limit by tokens: that is what providers count.',
    },
    {
      title: 'Fail over when a provider is down',
      text: 'If provider A keeps failing, a circuit breaker stops calling it and sends requests to Large Model (B). Test your prompts on B first: models behave differently.',
      focus: ['Provider Healthy?', 'Large Model (A)', 'Large Model (B)'],
    },
    {
      title: 'Log every call',
      text: 'Each call is logged with its team, model, tokens and cost. 1.44 million calls a day is about 1.44 GB of log a day, without prompt text.',
      focus: ['Usage Log', 'Usage Store'],
    },
  ],
  quiz: [
    {
      question: 'Why rate-limit by tokens instead of requests?',
      options: ['Requests are free', 'Providers limit tokens a minute, and requests vary hugely in size', 'Tokens are easier to count', 'It removes the need for budgets'],
      answer: 1,
      why: 'One request can be 900 tokens or 8k; the provider\'s limit is in tokens.',
    },
    {
      question: 'What is the main risk of a loose semantic cache?',
      options: ['It uses too much memory', 'It returns a confident answer to a different question', 'It is slower than the model', 'It leaks API keys'],
      answer: 1,
      why: 'Similar is not the same; a low threshold serves wrong answers.',
    },
    {
      question: 'Provider A is down. What should happen?',
      options: ['Every request waits for A', 'A circuit breaker fails fast and a tested fallback model answers', 'Apps call B directly with their own keys', 'The gateway turns off'],
      answer: 1,
      why: 'Failing fast plus a fallback turns an outage into slower successes.',
    },
  ],
}

export default lesson
