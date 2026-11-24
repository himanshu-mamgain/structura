import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'An agent is a model in a loop',
      text: 'The model asks for a tool, the Agent Harness runs it, and the result goes back to the model. Then the model decides the next step. A coding agent fixing one bug can take 60 steps.',
      focus: ['Developer', 'Agent Harness', 'Language Model'],
      remember: 'The harness is the code around the model: the loop, the tools, the permissions.',
    },
    {
      title: 'The model remembers nothing',
      text: 'Between calls, the model keeps nothing. So every step, the Context Builder sends the whole conversation again: instructions, the task, and every turn so far. The context only grows.',
      focus: ['Context Builder', 'Message History'],
      example: 'step 1: 14,950 tokens\nstep 20: 81,600 tokens\nstep 33: over 131,072 → "prompt is too long"',
    },
    {
      title: 'Tool results are most of it',
      text: 'One file read adds 6,000 tokens, and a test run 3,500. They stay in the context long after the agent has used them. A long run is mostly old file contents.',
      focus: ['Code Tools', 'Test Runner'],
    },
    {
      title: 'Don\'t drop the oldest messages',
      text: 'Deleting from the start sounds simple. But the first message is the task, with its rules. An agent that drops it keeps working, and breaks the rule it was given.',
      focus: ['Message History'],
      remember: 'The oldest message is usually the most important one.',
    },
    {
      title: 'Clear old tool results',
      text: 'Keep the last 10 tool results whole, and replace older ones with a one-line stub. The full output stays in the Tool Result Store in case it\'s needed. The model already wrote down what it learned, so little is lost.',
      focus: ['Tool Result Store', 'Message History'],
      example: '[cleared: read src/payments/api.ts, 6,000 tokens. Call read_file again if needed.]',
    },
    {
      title: 'Compact before it\'s full',
      text: 'At about 80% of the window, the Compactor asks the model to summarise the old turns. The summary replaces them, and the last few turns stay. Summaries keep rules and decisions, but often drop small details.',
      focus: ['Context Full?', 'Compactor'],
      example: 'Keep: constraints, decisions, open bugs, the plan.\nDrop: file contents, passing test output.',
    },
    {
      title: 'Notes outside the context',
      text: 'Give the agent a tool to save one-line notes, and put the notes back at the top of every call. Whatever a summary drops is still in the notes. They also survive a crash.',
      focus: ['Notes File', 'Context Builder'],
      example: '- seed: Tests need `npm run seed` first.',
    },
    {
      title: 'Sub-agents for big searches',
      text: 'An Explorer Sub-agent reads many files in its own, empty context, then hands back a short summary. The main context never holds those files. It costs extra tokens, so use it for wide searches, not every step.',
      focus: ['Explorer Sub-agent', 'Agent Harness'],
      example: 'sub-agent reads 39,200 tokens → returns 1,500',
    },
    {
      title: 'Three layers',
      text: 'The harness gives the model a place to work. Orchestration decides who does what next: a workflow, or a lead agent with sub-agents. Context engineering decides what the model sees at each step.',
      remember: 'Harness: where it works. Orchestration: what happens next. Context: what it sees.',
    },
  ],
  quiz: [
    {
      question: 'An agent\'s context passes the window at step 33. Which fix risks losing the task\'s own rules?',
      options: ['Clearing old tool results', 'Dropping the oldest messages', 'A notes file', 'A sub-agent for exploring'],
      answer: 1,
      why: 'The oldest message is usually the task. Dropping from the start removes its constraints first, and the agent carries on without them.',
    },
    {
      question: 'After compaction, the agent forgot that tests need `npm run seed` first. What would have kept it?',
      options: ['A bigger summary', 'Waiting until the window is full', 'A notes file read back every step', 'Dropping old messages instead'],
      answer: 2,
      why: 'Summaries lose details. Notes outside the context are put back at the top of every call, so they survive any compaction.',
    },
    {
      question: 'Which saving is usually the cheapest and safest?',
      options: ['Clearing old tool results', 'A bigger context window', 'Summarising every step', 'Starting a new conversation'],
      answer: 0,
      why: 'Old file contents and test output are most of the tokens, and the model has already written down what it learned from them. The full results can be fetched again.',
    },
  ],
}

export default lesson
