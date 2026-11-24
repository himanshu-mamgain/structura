import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator follows a coding agent through a long task: find and fix a flaky
// test in a payments service. Every step, the harness sends the whole context to the
// model: system prompt, tools, the task, and every turn so far. Tool results are big,
// so the context grows until it hits the window. Each strategy then keeps or loses
// five facts the agent needs at the end. Token sizes are typical, not measured.

const SYSTEM = 8000 // system prompt + tool definitions
const TASK = 600 // the user's task message
const OUTPUT = 350 // what the model writes each step: reasoning and a tool call
const SUMMARY = 3000 // a compaction summary
const STUB = 40 // what a cleared tool result leaves behind
const NOTE = 60 // one line in NOTES.md
const SUB_RESULT = 1500 // what an explorer sub-agent hands back
const SUB_BASE = 3000 // the sub-agent's own instructions and search task
const KEEP_RESULTS = 10 // clearing leaves the last 10 tool results whole

type Kind = 'read' | 'grep' | 'test' | 'edit' | 'docs'
const SIZE: Record<Kind, number> = { read: 6000, grep: 1200, test: 3500, edit: 400, docs: 2500 }
const CYCLE: Kind[] = ['read', 'grep', 'read', 'edit', 'test', 'docs']

interface Fact {
  id: string
  step: number
  text: string
  /** Compaction summaries keep constraints, decisions and open bugs; they tend to drop details. */
  kind: 'constraint' | 'decision' | 'detail' | 'open bug'
  check: string
  /** What goes wrong at the end if the agent no longer knows it. */
  ifLost: string
}

const FACTS: Fact[] = [
  { id: 'api', step: 0, kind: 'constraint', text: "Don't change the public API of the payments module.", check: 'Public payments API unchanged', ifLost: 'renamed a public function: 3 other services break' },
  { id: 'tz', step: 9, kind: 'detail', text: 'The flaky test fails only with TZ=Asia/Kolkata.', check: 'Fix checked with TZ=Asia/Kolkata', ifLost: 'final test run used the default time zone: the bug was never really checked' },
  { id: 'where', step: 18, kind: 'decision', text: 'Fix the date parsing in utils/date.ts, not in its callers.', check: 'Fix kept in one place', ifLost: 'patched a caller as well: two fixes that disagree' },
  { id: 'seed', step: 31, kind: 'detail', text: 'Tests need `npm run seed` first.', check: 'Tests run on a seeded database', ifLost: 're-discovered after 3 failed runs' },
  { id: 'refund', step: 44, kind: 'open bug', text: 'Second bug: rounding in refunds.ts, line 88.', check: 'Rounding bug in refunds.ts fixed', ifLost: 'forgotten: shipped with the rounding bug' },
]

type Strategy = 'keep' | 'drop' | 'compact'

interface Options {
  steps: number
  window: number
  strategy: Strategy
  clear: boolean
  notes: boolean
  subagent: boolean
}

interface Turn {
  step: number
  kind: Kind | 'delegate'
  result: number
  cleared: boolean
}

function simulate(o: Options) {
  // Steps 1 to 12 explore the code. A sub-agent does that in its own context and hands back a summary.
  const plan: { step: number; kind: Kind | 'delegate' }[] = []
  for (let s = 1; s <= o.steps; s++) {
    if (o.subagent && s <= 12) {
      if (s === 12) plan.push({ step: s, kind: 'delegate' })
      continue
    }
    plan.push({ step: s, kind: CYCLE[(s - 1) % CYCLE.length] })
  }
  // The sub-agent is an agent too: it resends its own (smaller) context on each of its 12 calls.
  let subagentRead = 0
  let subagentSent = 0
  if (o.subagent) {
    let ctx = SUB_BASE
    for (let i = 0; i < 12; i++) {
      ctx += SIZE[CYCLE[i % CYCLE.length]] + OUTPUT
      subagentRead += SIZE[CYCLE[i % CYCLE.length]]
      subagentSent += ctx
    }
  }

  let turns: Turn[] = []
  let taskInContext = true
  let summary = 0
  const known = new Set<string>(['api'])
  const lostAt: Record<string, number> = {}
  let notes = o.notes ? NOTE : 0 // the task's constraint is the first note
  let peak = 0
  let sent = 0
  let compactions = 0
  let dropped = 0
  let overflowAt: number | null = null
  let extraSteps = 0
  const growth: { step: number; tokens: number }[] = []

  const contextSize = () =>
    SYSTEM + (taskInContext ? TASK : 0) + summary + notes + turns.reduce((sum, t) => sum + OUTPUT + (t.cleared ? STUB : t.result), 0)

  for (const p of plan) {
    // The new step's fact, if any, is first written in the model's own words.
    for (const f of FACTS) if (f.step === p.step || (p.kind === 'delegate' && f.step > 0 && f.step <= 12)) {
      known.add(f.id)
      if (o.notes) notes += NOTE
    }
    const result = p.kind === 'delegate' ? SUB_RESULT : SIZE[p.kind]
    turns.push({ step: p.step, kind: p.kind, result, cleared: false })

    if (o.clear) {
      const withResults = turns.filter((t) => !t.cleared)
      for (const t of withResults.slice(0, Math.max(0, withResults.length - KEEP_RESULTS))) t.cleared = true
    }

    let size = contextSize()
    if (size > o.window * 0.8 && o.strategy === 'compact') {
      // Summarise everything but the last 3 turns. The summary keeps constraints, decisions and
      // open bugs; details survive only in NOTES.md.
      compactions++
      for (const f of FACTS) if (known.has(f.id) && f.kind === 'detail' && !o.notes) {
        known.delete(f.id)
        lostAt[f.id] ??= p.step
      }
      turns = turns.slice(-3) // the task message stays pinned at the top
      summary = SUMMARY
      size = contextSize()
    }
    if (size > o.window && o.strategy === 'drop') {
      // Drop the oldest turns (and the task message first of all) until it fits in 75%.
      if (taskInContext) {
        taskInContext = false
        if (!o.notes) {
          known.delete('api')
          lostAt.api ??= p.step
        }
      }
      while (contextSize() > o.window * 0.75 && turns.length > 1) {
        const gone = turns.shift()!
        dropped++
        // A fact lives in the turn where the agent wrote it down (or in the sub-agent's summary).
        const lives = (f: Fact) => f.step === gone.step || (gone.kind === 'delegate' && f.step > 0 && f.step <= 12)
        for (const f of FACTS) if (!o.notes && known.has(f.id) && lives(f)) {
          known.delete(f.id)
          lostAt[f.id] ??= p.step
        }
      }
      size = contextSize()
    }
    if (size > o.window && o.strategy === 'keep') {
      overflowAt = p.step
      break
    }
    sent += size
    peak = Math.max(peak, size)
    if (p.step <= 3 || p.step % 10 === 0) growth.push({ step: p.step, tokens: size })
  }

  // Forgetting how to seed the database costs three failed test runs later on.
  const seedLost = FACTS.find((f) => f.id === 'seed')!.step <= o.steps && !known.has('seed') && overflowAt === null
  if (seedLost) {
    extraSteps = 3
    sent += 3 * (peak + SIZE.test)
  }
  const finished = overflowAt === null
  const checks = FACTS.filter((f) => f.step <= o.steps).map((f) => ({
    f,
    ok: finished && (known.has(f.id) || (f.id === 'seed' && seedLost)),
    note: f.id === 'seed' && seedLost ? `forgotten at step ${lostAt.seed}; ${f.ifLost}` : undefined,
    lostAt: lostAt[f.id],
  }))
  return { plan, peak, sent: sent + subagentSent, subagentRead, subagentSent, compactions, dropped, overflowAt, extraSteps, checks, growth, finished, notes }
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const k = (n: number) => `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`
const usd = (tokens: number) => `$${((tokens / 1e6) * 3).toFixed(2)}`

const STRATEGY: Record<string, Strategy> = {
  'Nothing: keep every message': 'keep',
  'Drop the oldest messages': 'drop',
  'Compact: summarise at 80%': 'compact',
}
const WINDOWS: Record<string, number> = { '128K tokens (131,072)': 131072, '200K tokens (200,000)': 200000 }
const STEPS: Record<string, number> = { '60 steps (about an hour)': 60, '120 steps (an afternoon)': 120 }

const simulator: Simulator = {
  fields: [
    { id: 'steps', label: 'Task length', options: Object.keys(STEPS) },
    { id: 'window', label: 'Context window', options: Object.keys(WINDOWS) },
    { id: 'strategy', label: 'When the context fills up', options: Object.keys(STRATEGY) },
    { id: 'clear', label: 'Clear old tool results', options: ['Off', 'On: keep the last 10'] },
    { id: 'notes', label: 'Notes file (NOTES.md)', options: ['Off', 'On'] },
    { id: 'subagent', label: 'Sub-agent for exploring', options: ['Off', 'On'] },
  ],
  defaults: { steps: '60 steps (about an hour)', window: '128K tokens (131,072)', strategy: 'Nothing: keep every message', clear: 'Off', notes: 'Off', subagent: 'Off' },
  run(values) {
    const o: Options = {
      steps: STEPS[values.steps] ?? 60,
      window: WINDOWS[values.window] ?? 131072,
      strategy: STRATEGY[values.strategy] ?? 'keep',
      clear: values.clear.startsWith('On'),
      notes: values.notes === 'On',
      subagent: values.subagent === 'On',
    }
    const r = simulate(o)
    const steps: Trace['steps'] = []
    const okCount = r.checks.filter((c) => c.ok).length

    steps.push({
      text: `A developer asks the agent to fix a flaky test in the payments service. The Agent Harness runs the loop: each step, the Context Builder puts together everything the Language Model will see, and sends all of it. Before any work, that is already ${int(SYSTEM + TASK)} tokens.`,
      nodes: ['Developer', 'Agent Harness', 'Context Builder'],
      data: [
        `system prompt + tool definitions   ${int(SYSTEM)}`,
        `the task                             ${int(TASK)}`,
        `  "Fix the flaky date test. ${FACTS[0].text}"`,
        `context window                     ${int(o.window)}`,
      ].join('\n'),
    })

    steps.push({
      text: `Each step the model writes about ${OUTPUT} tokens (its reasoning and a tool call), and the tool's result is added too. A file read adds ${int(SIZE.read)} tokens; a test run ${int(SIZE.test)}. The model has no memory between calls, so every call resends the whole history: the context only grows.`,
      nodes: ['Language Model', 'Code Tools', 'Test Runner', 'Message History'],
      data: r.growth.slice(0, 6).map((g) => `step ${String(g.step).padStart(3)}: ${int(g.tokens).padStart(7)} tokens  ${'█'.repeat(Math.max(1, Math.round((g.tokens / o.window) * 30)))}`).join('\n'),
    })

    steps.push({
      text: o.subagent
        ? `Exploring the code (steps 1 to 12) goes to an Explorer Sub-agent with its own, empty context. It reads ${int(r.subagentRead)} tokens of files and hands back a ${int(SUB_RESULT)}-token summary, so the main context never holds those files.`
        : 'The first 12 steps explore the code: reading files, searching, running the tests once. Every file read stays in the context, long after the agent has used it.',
      nodes: o.subagent ? ['Agent Harness', 'Explorer Sub-agent'] : ['Code Tools', 'Message History'],
      data: o.subagent ? `sub-agent read:   ${int(r.subagentRead)} tokens of files\nits 12 calls sent: ${int(r.subagentSent)} tokens\nmain context got: ${int(SUB_RESULT)} tokens` : `steps 1-12 add about ${int(2 * CYCLE.reduce((s, c) => s + SIZE[c] + OUTPUT, 0))} tokens`,
    })

    steps.push({
      text: o.clear
        ? `Tool result clearing keeps only the last ${KEEP_RESULTS} tool results whole. Older ones become a ${STUB}-token stub saying what was there, kept in the Tool Result Store in case it's needed again. The model's own notes about them stay.`
        : 'Old tool results are kept in full: a file read at step 3 is still resent at step 50.',
      nodes: o.clear ? ['Tool Result Store', 'Message History'] : ['Message History'],
      data: o.clear ? `[cleared: read src/payments/api.ts, ${int(SIZE.read)} tokens. Ask again if needed.]` : 'nothing cleared',
    })

    const full = r.overflowAt
      ? `At step ${r.overflowAt} the context passes ${int(o.window)} tokens. The model refuses the call ("prompt is too long"), and the agent stops halfway.`
      : o.strategy === 'drop'
        ? r.dropped
          ? `The context filled up, so the oldest messages were dropped: ${int(r.dropped)} turns in all, and the task message went first. Whatever was only in them is gone.`
          : 'The context never filled up, so nothing was dropped.'
        : o.strategy === 'compact'
          ? r.compactions
            ? `Each time the context passed 80% of the window, the Compactor summarised the history into ${int(SUMMARY)} tokens and kept the last 3 turns. That happened ${r.compactions} time${r.compactions > 1 ? 's' : ''}. Summaries keep constraints, decisions and open bugs, but drop details.`
            : 'The context never reached 80%, so no compaction was needed.'
          : `The context peaked at ${int(r.peak)} tokens and never filled up.`
    steps.push({
      text: `${full}${o.notes ? ' Every fact the agent learned is also written to the Notes File and read back each step, so nothing important depends on the history.' : ''}`,
      nodes: o.strategy === 'compact' ? ['Context Full?', 'Compactor', 'Message History'] : ['Context Full?', 'Message History'],
      data: [
        `peak context:  ${int(r.peak)} of ${int(o.window)} (${Math.round((r.peak / o.window) * 100)}%)`,
        r.overflowAt ? `overflow:      step ${r.overflowAt}` : o.strategy === 'compact' ? `compactions:   ${r.compactions}` : '',
        o.strategy === 'drop' ? `turns dropped: ${int(r.dropped)}` : '',
        o.notes ? `NOTES.md:      ${int(r.notes)} tokens` : '',
      ].filter(Boolean).join('\n'),
    })

    steps.push({
      text: r.finished
        ? `At the end, does the agent still know the ${r.checks.length} things it learned? ${okCount} of ${r.checks.length}.${r.extraSteps ? ` It forgot how to seed the database, and spent ${r.extraSteps} extra steps finding out again.` : ''}`
        : 'The agent never reached the end, so none of the checks pass.',
      nodes: o.notes ? ['Notes File', 'Context Builder', 'Language Model'] : ['Context Builder', 'Language Model'],
      data: r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.f.check}${c.note ? `\n    ${c.note}` : !c.ok && r.finished ? `\n    ${c.f.ifLost}${c.lostAt ? ` (lost at step ${c.lostAt})` : ''}` : ''}`).join('\n'),
    })

    steps.push({
      text: `Every call resends the whole context, so the total grows faster than the number of steps. This run sent ${int(r.sent)} input tokens in all${o.subagent ? ', counting the sub-agent' : ''}: about ${usd(r.sent)} at an illustrative $3 per million. Prompt caching makes the repeated part much cheaper, but every token still competes for the model's attention.`,
      nodes: ['Agent Harness', 'Developer'],
      data: [
        `steps run:          ${r.overflowAt ? `${r.overflowAt} (stopped)` : int(o.steps + r.extraSteps)}`,
        `input tokens sent:  ${int(r.sent)}`,
        `cost at $3/M:       ${usd(r.sent)}`,
        `facts kept:         ${okCount} of ${r.checks.length}`,
      ].join('\n'),
    })

    return {
      input: `${o.steps} steps · ${k(o.window)} · ${o.strategy}${o.clear ? ' · clear' : ''}${o.notes ? ' · notes' : ''}${o.subagent ? ' · sub-agent' : ''} → ${r.overflowAt ? `stopped at step ${r.overflowAt}` : `${okCount}/${r.checks.length} facts kept`}, ${k(r.sent)} tokens sent`,
      steps,
    }
  },
}

export const agentContext: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'agent-context',
  title: 'Context Engineering for Long-Running Agents',
  blurb: 'Keep an agent working for hours inside a fixed context window: compaction, notes, clearing tool results, sub-agents, and the harness that runs it all',
  guides: ['what-is-an-ai-agent', 'how-does-chatgpt-work', 'the-open-source-ai-stack'],
  takeaways: [
    'A model remembers nothing between calls: each step resends the whole context, so it grows every step and the cost grows faster still.',
    'When the window fills, dropping the oldest messages throws away the task itself; compaction keeps a summary, but summaries lose details.',
    'Clearing old tool results is the cheapest, safest saving: the model already wrote down what it learned from them.',
    'A notes file outside the context (NOTES.md, a to-do list) is the agent\'s long-term memory; read it back after every compaction.',
    'Sub-agents explore in their own clean context and hand back a short summary, so the main context stays small.',
    'The harness runs the loop and the tools, orchestration decides who does what next, and context engineering decides what the model sees at each step.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'harness', label: 'Agent harness' },
      { id: 'tools', label: 'Tools' },
      { id: 'memory', label: 'Memory outside the model' },
    ],
    nodes: [
      { id: 'dev', label: 'Developer', shape: 'ellipse', color: 'blue', group: null },
      { id: 'harness', label: 'Agent Harness', shape: 'rectangle', color: 'violet', group: 'harness' },
      { id: 'builder', label: 'Context Builder', shape: 'rectangle', color: 'violet', group: 'harness' },
      { id: 'full', label: 'Context Full?', shape: 'diamond', color: 'violet', group: 'harness' },
      { id: 'compactor', label: 'Compactor', shape: 'rectangle', color: 'orange', group: 'harness' },
      { id: 'model', label: 'Language Model', shape: 'cloud', color: 'violet', group: null },
      { id: 'code', label: 'Code Tools', shape: 'rectangle', color: 'orange', group: 'tools' },
      { id: 'tests', label: 'Test Runner', shape: 'rectangle', color: 'orange', group: 'tools' },
      { id: 'sub', label: 'Explorer Sub-agent', shape: 'rectangle', color: 'violet', group: 'tools' },
      { id: 'history', label: 'Message History', shape: 'rectangle', color: 'green', group: 'memory' },
      { id: 'notes', label: 'Notes File', shape: 'rectangle', color: 'green', group: 'memory' },
      { id: 'store', label: 'Tool Result Store', shape: 'rectangle', color: 'green', group: 'memory' },
    ],
    edges: [
      { from: 'dev', to: 'harness', label: 'task', dashed: false },
      { from: 'harness', to: 'builder', label: 'next call', dashed: false },
      { from: 'history', to: 'builder', label: 'recent turns', dashed: false },
      { from: 'notes', to: 'builder', label: 'notes', dashed: false },
      { from: 'builder', to: 'full', label: 'token count', dashed: false },
      { from: 'full', to: 'compactor', label: 'yes: over 80%', dashed: false },
      { from: 'compactor', to: 'history', label: 'summary replaces old turns', dashed: false },
      { from: 'full', to: 'model', label: 'no: send', dashed: false },
      { from: 'model', to: 'harness', label: 'tool call or answer', dashed: false },
      { from: 'harness', to: 'code', label: 'read, search, edit', dashed: false },
      { from: 'harness', to: 'tests', label: 'run tests', dashed: false },
      { from: 'harness', to: 'sub', label: 'delegate a search', dashed: false },
      { from: 'sub', to: 'harness', label: 'short summary', dashed: true },
      { from: 'code', to: 'store', label: 'full output', dashed: false },
      { from: 'store', to: 'history', label: 'stub when cleared', dashed: true },
      { from: 'harness', to: 'notes', label: 'write notes', dashed: false },
      { from: 'harness', to: 'history', label: 'append turn', dashed: false },
      { from: 'harness', to: 'dev', label: 'result', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'sessions',
        name: 'agent_sessions',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'task', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'model', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'context_window', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'started_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'turns',
        name: 'turns',
        columns: [
          { name: 'session_id', type: 'uuid', pk: true, fk: 'agent_sessions.id', nullable: false, unique: false },
          { name: 'step', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'role', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'content', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'tokens', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'tool_result_id', type: 'uuid', pk: false, fk: 'tool_results.id', nullable: true, unique: false },
          { name: 'cleared', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'summarised_in', type: 'int', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'tool_results',
        name: 'tool_results',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'tool', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'input', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
          { name: 'output', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'tokens', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'notes',
        name: 'notes',
        columns: [
          { name: 'session_id', type: 'uuid', pk: true, fk: 'agent_sessions.id', nullable: false, unique: false },
          { name: 'key', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'body', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'updated_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'sessions', to: 'turns', kind: 'one-to-many', label: 'has' },
      { from: 'tool_results', to: 'turns', kind: 'one-to-many', label: 'referenced by' },
      { from: 'sessions', to: 'notes', kind: 'one-to-many', label: 'remembers' },
    ],
  },
  explanation: {
    title: 'Context Engineering for Long-Running Agents',
    summary:
      'An agent is a language model in a loop: it calls a tool, reads the result, and decides the next step. The model remembers nothing between calls, so every step resends the whole conversation, and the context grows until it fills the window. Context engineering is choosing what the model sees at each step: clearing old tool results, compacting the history into a summary, keeping notes outside the context, and handing exploration to sub-agents.',
    sections: [
      {
        heading: 'Overview',
        body: 'A context window is the most text a model can read in one call, counted in tokens (pieces of words, about three quarters of a word each). Common windows are 128,000 or 200,000 tokens.\n\nA long task (fixing a bug across a codebase, researching for an hour) runs for dozens or hundreds of steps. Each step adds the model\'s reasoning and a tool\'s result, often thousands of tokens for one file. Long before the window is full, models also get worse at using what\'s in it: facts in the middle of a long context are found less reliably than those at the start or end.\n\nThe simulator follows a coding agent through 60 or 120 steps, and checks whether it still knows five things it learned along the way.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Run a task for hours, across hundreds of tool calls, without hitting the context limit.\n- Keep the task\'s constraints, decisions and open problems for the whole run.\n- Let the agent fetch old tool results again when it needs them.\n- Survive a crash or restart: resume from saved notes and history.\n\nNon-functional:\n- Keep each call well under the window (say, below 80%), where the model works best.\n- Keep the total tokens sent, and so the cost, roughly in line with the work done.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Fixed part of every call: system prompt and tool definitions about 8,000 tokens, the task 600.\n- Each step: about 350 tokens from the model, plus a tool result: a file read 6,000, a test run 3,500, a search 1,200.\n- A 6-step cycle (read, search, read, edit, test, look up docs) adds about 21,700 tokens. 60 steps add about 217,000: well past a 128K window.\n- Keeping everything, the context passes 131,072 tokens at step 33, and the agent stops.\n- Cost: every call resends everything, so its 32 calls sent 2,228,700 input tokens: about $6.69 at an illustrative $3 per million, for a task that stopped halfway.\n- Clearing all but the last 10 tool results keeps the 60-step task under 70,000 tokens a call: it finishes, having sent about 3 million tokens in all.',
      },
      {
        heading: 'Step by step',
        body: '1. The Developer gives the Agent Harness a task.\n2. Each step, the Context Builder puts together the call: system prompt, tools, Notes File, and the turns in Message History.\n3. Context Full? counts the tokens. Over 80% of the window, the Compactor summarises old turns, and the summary replaces them in Message History.\n4. The call goes to the Language Model, which answers with a tool call or a final answer.\n5. The Agent Harness runs the tool: Code Tools to read, search and edit, the Test Runner, or an Explorer Sub-agent for a search that needs many reads.\n6. Full tool outputs are kept in the Tool Result Store; old ones are cleared from Message History, leaving a short stub.\n7. The agent writes what it learns to the Notes File, which is read back every step.\n8. When the work is done, the Agent Harness returns the result to the Developer.',
      },
      {
        heading: 'Components',
        body: '- Developer: the person who gives the task and reviews the result.\n- Agent Harness: runs the loop, calls tools, applies permissions, and saves everything; the agent\'s body around the model\'s brain.\n- Context Builder: decides what goes into each call, in what order.\n- Context Full?: counts tokens and starts compaction before the window fills.\n- Compactor: asks the model to summarise old turns, keeping constraints, decisions and open problems.\n- Language Model: reads the context and chooses the next tool call or the answer; it remembers nothing between calls.\n- Code Tools: read files, search the code, and edit.\n- Test Runner: runs the tests and returns their output.\n- Explorer Sub-agent: a second agent with its own clean context, for searches that read many files; it returns a short summary.\n- Message History: every turn so far, as the model will see it.\n- Notes File: what the agent chose to remember (NOTES.md, a to-do list), kept outside the context.\n- Tool Result Store: full tool outputs, so a cleared one can be fetched again.',
      },
      {
        heading: 'Key decisions',
        body: '- Clear before you compact: old tool results are most of the tokens, and clearing them loses little, because the model already wrote down what it learned.\n- Compact at a threshold (say 80%), not at the limit: leave room for the summary call and the next step.\n- What the summary keeps: constraints, decisions, open bugs and the current plan. Test the summariser against long runs; it is lossy.\n- Notes outside the context: the agent writes facts as it learns them and reads them back after compaction. This is the only memory that never fades.\n- Sub-agents for wide searches: they spend tens of thousands of tokens in their own context and return a summary of 1,000 to 2,000.\n- Load just in time: keep file paths and queries in the context, and read the file only when needed, rather than loading everything up front.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Dropping the oldest messages is the naive fix, and the worst: the first message is usually the task itself.\n- A bad summary is silent: the agent carries on confidently without a constraint. Keep the original task pinned at the top, and keep notes.\n- Context rot: long before the window is full, recall gets worse, especially for things in the middle. Smaller contexts give better answers, not just cheaper ones.\n- Cost grows with the square of the length when everything is resent; prompt caching cuts the price of the repeated part, not its size.\n- Save the harness state (history, notes, tool results) so a crash resumes, rather than restarts.\n- Many sub-agents in parallel multiply token use; use them for wide searches, not for every step.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you keep an agent working for hours without exceeding its token limit?\n- What would you keep in a compaction summary, and how would you test it?\n- Why is dropping the oldest messages a bad idea?\n- When would you use a sub-agent instead of a tool call?\n- What is the difference between an agent harness, orchestration and context engineering?\n- How does context length affect cost and answer quality?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Clear old tool results, then compact',
        language: 'javascript',
        source: `// Run before every model call. Tokens are estimated at 4 characters each;
// use the provider's token counter when you can.
const tokens = (msg) => Math.ceil(JSON.stringify(msg.content).length / 4)
const total = (msgs) => msgs.reduce((sum, m) => sum + tokens(m), 0)

export async function fitContext(messages, { window = 131072, keepResults = 10, keepTurns = 3 }) {
  // 1. Clear old tool results: cheap and safe. The full output stays in the store.
  const results = messages.filter((m) => m.role === 'tool' && !m.cleared)
  for (const m of results.slice(0, -keepResults)) {
    m.content = \`[cleared: \${m.toolName} output, \${tokens(m)} tokens. Call \${m.toolName} again if needed.]\`
    m.cleared = true
  }
  if (total(messages) < window * 0.8) return messages

  // 2. Still too big: summarise everything but the task and the last few turns.
  const [system, task, ...rest] = messages
  const old = rest.slice(0, -keepTurns)
  const summary = await summarise(old) // a model call with a prompt like the one below
  return [system, task, { role: 'user', content: \`Summary of earlier work:\\n\${summary}\` }, ...rest.slice(-keepTurns)]
}

// The summary prompt says what must survive:
// "Keep every constraint from the task, every decision and why, open bugs with
//  file and line, and the current plan. Drop raw file contents and passing test output."`,
        versions: [
          {
            language: 'java',
            source: `import java.util.ArrayList;
import java.util.List;

public class ContextFitter {
  public static class Message {
    String role, toolName, content;
    boolean cleared;
    Message(String role, String toolName, String content) { this.role = role; this.toolName = toolName; this.content = content; }
  }

  public interface Summariser { String summarise(List<Message> old); }

  // Tokens are estimated at 4 characters each; use the provider's counter when you can.
  static int tokens(Message m) { return (m.content.length() + 3) / 4; }
  static int total(List<Message> msgs) { return msgs.stream().mapToInt(ContextFitter::tokens).sum(); }

  public static List<Message> fit(List<Message> messages, Summariser summariser, int window, int keepResults, int keepTurns) {
    // 1. Clear old tool results: cheap and safe. The full output stays in the store.
    List<Message> results = messages.stream().filter(m -> m.role.equals("tool") && !m.cleared).toList();
    for (Message m : results.subList(0, Math.max(0, results.size() - keepResults))) {
      m.content = "[cleared: " + m.toolName + " output, " + tokens(m) + " tokens. Call " + m.toolName + " again if needed.]";
      m.cleared = true;
    }
    if (total(messages) < window * 0.8) return messages;

    // 2. Still too big: summarise everything but the system prompt, the task and the last few turns.
    List<Message> rest = messages.subList(2, messages.size());
    List<Message> old = rest.subList(0, Math.max(0, rest.size() - keepTurns));
    String summary = summariser.summarise(old);
    List<Message> out = new ArrayList<>(List.of(messages.get(0), messages.get(1)));
    out.add(new Message("user", null, "Summary of earlier work:\\n" + summary));
    out.addAll(rest.subList(Math.max(0, rest.size() - keepTurns), rest.size()));
    return out;
  }
}`,
          },
          {
            language: 'python',
            source: `def tokens(msg) -> int:
    # Estimated at 4 characters a token; use the provider's counter when you can.
    return (len(str(msg["content"])) + 3) // 4

def total(msgs) -> int:
    return sum(tokens(m) for m in msgs)

def fit_context(messages, summarise, window=131_072, keep_results=10, keep_turns=3):
    # 1. Clear old tool results: cheap and safe. The full output stays in the store.
    results = [m for m in messages if m["role"] == "tool" and not m.get("cleared")]
    for m in results[:-keep_results] if len(results) > keep_results else []:
        m["content"] = f'[cleared: {m["tool_name"]} output, {tokens(m)} tokens. Call {m["tool_name"]} again if needed.]'
        m["cleared"] = True
    if total(messages) < window * 0.8:
        return messages

    # 2. Still too big: summarise everything but the system prompt, the task and the last few turns.
    system, task, *rest = messages
    summary = summarise(rest[:-keep_turns])
    return [system, task, {"role": "user", "content": f"Summary of earlier work:\\n{summary}"}, *rest[-keep_turns:]]`,
          },
        ],
      },
      {
        title: 'A notes tool the agent writes to',
        language: 'javascript',
        source: `// Give the model a tool for its own notes. The harness stores them outside the
// context and puts them back at the top of every call, so they survive compaction.
export const notesTool = {
  name: 'save_note',
  description: 'Save a fact you will need later: a constraint, a decision and why, an open bug with file and line, or a command that works. Keep each note to one line.',
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short id, such as "constraint-api" or "bug-refund-rounding"' },
      note: { type: 'string' },
    },
    required: ['key', 'note'],
  },
}

export async function handleSaveNote(db, sessionId, { key, note }) {
  await db.query(
    \`INSERT INTO notes (session_id, key, body, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (session_id, key) DO UPDATE SET body = EXCLUDED.body, updated_at = now()\`,
    [sessionId, key, note],
  )
  return 'saved'
}

// When building each call:
// const notes = await db.query('SELECT key, body FROM notes WHERE session_id = $1 ORDER BY key', [id])
// system += '\\n\\nYour notes so far:\\n' + notes.rows.map((n) => \`- \${n.key}: \${n.body}\`).join('\\n')`,
        versions: [
          {
            language: 'java',
            source: `import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.UUID;

public class Notes {
  // The tool the model sees: save one fact it will need later.
  public static final String TOOL_JSON = """
      {"name": "save_note",
       "description": "Save a fact you will need later: a constraint, a decision and why, an open bug with file and line, or a command that works. One line each.",
       "input_schema": {"type": "object",
         "properties": {"key": {"type": "string"}, "note": {"type": "string"}},
         "required": ["key", "note"]}}""";

  public static String save(Connection db, UUID sessionId, String key, String note) throws Exception {
    try (PreparedStatement st = db.prepareStatement("""
        INSERT INTO notes (session_id, key, body, updated_at) VALUES (?, ?, ?, now())
        ON CONFLICT (session_id, key) DO UPDATE SET body = EXCLUDED.body, updated_at = now()""")) {
      st.setObject(1, sessionId);
      st.setString(2, key);
      st.setString(3, note);
      st.executeUpdate();
    }
    return "saved";
  }

  // Put the notes back at the top of every call, so they survive compaction.
  public static String forPrompt(Connection db, UUID sessionId) throws Exception {
    StringBuilder out = new StringBuilder("Your notes so far:\\n");
    try (PreparedStatement st = db.prepareStatement("SELECT key, body FROM notes WHERE session_id = ? ORDER BY key")) {
      st.setObject(1, sessionId);
      try (ResultSet rs = st.executeQuery()) {
        while (rs.next()) out.append("- ").append(rs.getString(1)).append(": ").append(rs.getString(2)).append('\\n');
      }
    }
    return out.toString();
  }
}`,
          },
        ],
      },
    ],
    related: ['AI agent with tools', 'LLM guardrails', 'RAG pipeline', 'Model weights & LLM inference', 'Workflow orchestration'],
  },
  simulator,
}
