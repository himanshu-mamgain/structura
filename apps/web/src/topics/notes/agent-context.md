# Context Engineering for Long-Running Agents

> 💡 **TL;DR**: An **agent** is a large language model (LLM) in a loop. It calls a tool, reads the result, and decides what to do next. The model remembers nothing between calls, so every step resends the whole conversation, and the conversation grows every step. The **context window** is the most the model can read at once (for example 128,000 tokens). A long task fills it in an hour. **Context engineering** is choosing what the model sees at each step, so it can keep working for hours. The main tools: **clear old tool results**, **compact** the history into a summary, keep **notes** outside the context, and hand wide searches to **sub-agents**. Around all of it sits the **harness**: the code that runs the loop and the tools.

## At a glance

| Technique | What it does | Saves | Risk |
|---|---|---|---|
| Keep everything | resend every message, every step | nothing | the window fills, and the agent stops |
| Drop the oldest messages | delete from the start until it fits | everything old | the first message is the task itself |
| Clear old tool results | replace old file reads and test output with a one-line stub | most of the tokens | small: the model already wrote down what it learned |
| Compaction | summarise old turns, keep the last few | most of the history | summaries lose details |
| Notes file | the agent writes facts to a file outside the context and reads them back | nothing; it's for memory | notes go stale if never updated |
| Sub-agents | a second agent explores in its own context and returns a summary | big searches never enter the main context | more total tokens; a summary can miss things |
| Just-in-time loading | keep file paths, not file contents; read a file only when needed | files you'd never read | more tool calls |

## What the subject is

**An agent.** A language model on its own answers one message. An agent gives it **tools** (read a file, run the tests, search the web) and a **loop**: the model asks for a tool, the harness runs it, the result goes back to the model, and the model decides the next step. It stops when the task is done. A coding agent fixing a bug might take 60 steps; a research agent might take hundreds.

**The context window.** A model reads text as **tokens**: pieces of words, about three quarters of an English word each. The **context window** is how many tokens one call can hold: everything the model reads (instructions, the conversation, tool results) plus what it writes. Common sizes are 128,000 tokens (often written 128K; exactly 131,072) and 200,000.

**The problem.** The model keeps nothing between calls. To continue a conversation, the harness sends the whole thing again, every time. So the context only grows. A single file read adds thousands of tokens, and it stays in the context long after the agent has used it.

**Context engineering** is the work of deciding what goes into each call: which instructions, which tools, which parts of the history, which notes. It grew out of **prompt engineering** (writing good instructions); the difference is that it happens again at every step of a long run, not once.

## The harness, orchestration and context engineering

Three words that get mixed up. They are layers, each fixing a way the one below breaks:

| Layer | Its job | Without it |
|---|---|---|
| **Harness** | gives the model a place to work: runs the loop, runs tools, checks permissions, saves everything | a person copies text between the model and a terminal |
| **Orchestration** | decides what happens next across steps and agents: a fixed workflow, a graph of steps, or a lead agent handing work to sub-agents | one agent does everything in one ever-growing context |
| **Context engineering** | decides what the model sees at each step | the context fills, the model loses track, and the bill grows |

Claude Code and similar coding tools are harnesses. LangGraph-style workflow graphs, and a lead agent that starts sub-agents, are orchestration. Compaction, notes and tool-result clearing are context engineering, and they live inside the harness.

## How it works underneath: why the context fills up

Take the topic's example: an agent fixing a flaky test in a payments service, on a model with a 131,072-token window.

| Part of every call | Tokens |
|---|---|
| System prompt and tool definitions | 8,000 |
| The task ("Fix the flaky date test. Don't change the public API of the payments module.") | 600 |
| Each step: the model's reasoning and tool call | about 350 |
| A file read | 6,000 |
| A search result | 1,200 |
| A test run | 3,500 |

A 6-step cycle (read, search, read, edit, test, look something up) adds 19,600 tokens of results plus 6 × 350 = 2,100 of the model's own writing: 21,700 tokens. Before any work, each call already carries 8,000 + 600 = 8,600 tokens.

| After step | Context | Share of the window |
|---|---|---|
| 1 | 14,950 | 11% |
| 10 | 45,300 | 35% |
| 20 | 81,600 | 62% |
| 30 | 117,100 | 89% |
| 33 | over 131,072 | the call fails: "prompt is too long" |

Two more costs come with a big context:

- **Money.** Every call resends everything. Those 32 calls sent 2,228,700 input tokens in total: about $6.69 at an illustrative $3 per million, for a task that stopped halfway. **Prompt caching** (the provider keeps the repeated start of the context ready, and charges less for it) cuts the price of the repeated part, but not its size.
- **Quality.** Models use long contexts unevenly. Researchers found models recall facts at the start or the end of a long context better than those in the middle ("lost in the middle"). Anthropic calls the general decline as the window fills **context rot**. A smaller, cleaner context gives better answers, not just cheaper ones.

## The techniques, one by one

### Dropping the oldest messages (don't)

The simplest fix: when it's full, delete messages from the start until it fits. The first message is usually the task, with its constraints. In the simulator, dropping keeps the agent running for 60 steps, but it forgets 3 of the 5 things it needed: the "don't change the public API" rule (lost at step 33), the time zone that triggers the bug, and the decision about where to fix it. It finishes, confidently, having broken the API.

### Clearing old tool results

Most of the tokens are tool results, and most are only useful for a few steps. Once the agent has read a file and written "the bug is in `parseDate`, line 42", it doesn't need the file's 6,000 tokens any more. **Tool-result clearing** replaces all but the most recent results with a stub:

```text
[cleared: read src/payments/api.ts, 6,000 tokens. Call read_file again if needed.]
```

The full output stays in the harness's store, so the agent can ask again. Keeping the last 10 results, the 60-step task never passes 65,730 tokens: half the window. It finishes and keeps all 5 facts, because the facts were in the model's own messages, which are never cleared. It is the cheapest and safest saving, so do it first.

### Compaction

When the context passes a threshold (say 80% of the window), **compaction** asks the model to summarise the history, then replaces the old turns with the summary and keeps the last few turns. In the simulator: a 3,000-token summary, the task pinned at the top, and the last 3 turns.

A good summary prompt says what must survive:

```text
Summarise the work so far for yourself. Keep: every constraint from the task,
every decision and why, open bugs with file and line, commands that worked,
and the current plan. Drop: file contents, passing test output, dead ends.
```

Summaries are lossy. In the simulator, the first compaction (step 27) drops the detail that the bug only shows with `TZ=Asia/Kolkata`, so the final test run checks nothing. The second (step 50) drops `npm run seed`, and the agent wastes 3 test runs finding it again. Compact at a threshold, not at the limit: the summary call itself needs room.

### Notes outside the context

The fix for lossy summaries is memory the agent controls. Give it a tool to **save a note** (a `NOTES.md` file, a to-do list, a database table), and put the notes back at the top of every call. A note is one line, about 60 tokens:

```text
- constraint-api: Don't change the public API of the payments module.
- bug-tz: The flaky test only fails with TZ=Asia/Kolkata.
- seed: Tests need `npm run seed` first.
```

With notes on, compaction keeps all 5 facts: whatever the summary drops is still in the notes. Notes also survive a crash: the harness can restart from them. Anthropic describes agents keeping progress notes like this across thousands of steps.

### Sub-agents

Exploring a codebase means reading many files to find a few lines that matter. A **sub-agent** does that in its own, empty context: it reads 39,200 tokens of files over 12 steps, then hands back a 1,500-token summary. The main agent never holds the files. The cost: the sub-agent's own calls (it resends its context too: 334,300 tokens over its 12 calls in the simulator), and a summary that might miss something. Use sub-agents for wide searches, not every step.

### Loading just in time

Instead of loading every relevant file at the start, keep **references** in the context (paths, search queries, links) and read a file only when needed. Coding agents typically load a small instructions file up front (such as `CLAUDE.md`), then search for files with tools like `grep` as they go.

## What the simulator shows

60 steps, 131,072-token window:

| Setup | Finishes? | Facts kept | Tokens sent |
|---|---|---|---|
| Keep everything | no: stops at step 33 | 0 of 5 | 2,228,700 |
| Drop the oldest messages | yes | 2 of 5 | 5,349,200 |
| Compact at 80% | yes, 63 steps (3 wasted) | 4 of 5 | 3,767,600 |
| Compact + notes | yes | 5 of 5 | about 3.4 million |
| Clear old tool results | yes, peak 65,730 | 5 of 5 | 3,033,300 |
| Clear + sub-agent for exploring | yes | 5 of 5 | about 2.7 million |

- **Dropping costs the most and keeps the least**: it runs near the limit every step, resending about 100,000 tokens each time.
- **Compaction alone works, but leaks details.** Notes plug the leak.
- **Clearing tool results alone is enough for this task.** On a 120-step task, combine all of them.

## How to choose

1. **Always clear old tool results.** Keep the last 5 to 10 whole, and store the rest outside the context so they can be fetched again.
2. **Give the agent a notes tool** for constraints, decisions, open bugs and commands that worked. Put the notes at the top of every call.
3. **Compact at about 80%** when the context still grows too large, with a summary prompt that names what must survive. Keep the original task pinned.
4. **Use sub-agents for wide searches** (many files, many web pages) where only a summary matters.
5. **Load just in time**: paths and queries in the context, contents only when needed.
6. **Never drop the oldest messages blindly.**
7. **Measure**: tokens per call, total tokens per task, and whether the agent still knows its constraints at the end. Build long test runs for this, like an eval set.

## ⚠️ Critical Mistakes

- **Dropping the oldest messages.** The task and its constraints go first.
- **Waiting until the window is full.** The call fails, and there's no room left to summarise. Act at a threshold.
- **Trusting the summary.** It drops details silently. Keep notes, and test what survives.
- **Keeping every tool result forever.** Most tokens in a long run are file contents the agent read once.
- **Loading everything up front.** Big contexts cost more on every call and make the model worse at finding what matters.
- **Treating a bigger window as the fix.** A 200,000-token window only moves the wall: keeping everything, the same task stops at step 53 instead of 33, after sending 5.5 million tokens.
- **Sub-agents for everything.** Each one is a whole agent with its own token bill.

## Interview Q&As

**Q: How would you keep an agent working for hours without exceeding the model's token limit?**

A: Layer the techniques. Clear old tool results first, keeping the last few whole and the rest in a store the agent can fetch from. Give the agent a notes tool for constraints, decisions and open problems, and put the notes at the top of every call. When the context still passes about 80% of the window, compact: summarise old turns with a prompt that says what must survive, keep the task pinned and the last few turns. Use sub-agents for wide searches so their reading never enters the main context. Measure tokens per call and whether constraints survive to the end.

**Q: Why not just drop the oldest messages?**

A: The oldest message is usually the task, with its constraints. In the simulator, a 60-step agent that drops old messages keeps running but forgets "don't change the public API" at step 33, and breaks it. It also costs more: it runs near the limit, so every call resends close to the whole window.

**Q: What should a compaction summary keep?**

A: Every constraint from the task, every decision and its reason, open bugs with file and line, commands that worked, and the current plan. Drop raw file contents, passing test output and dead ends. Test it: run long tasks, compact, and check the agent still knows what it must. Back it up with notes, because summaries lose details.

**Q: What is the difference between an agent harness, orchestration and context engineering?**

A: The harness gives the model a place to work: it runs the loop and the tools, applies permissions and saves state. Orchestration decides what happens next across steps or agents: a workflow graph, or a lead agent handing tasks to sub-agents. Context engineering decides what the model sees at each step: instructions, notes, recent turns, cleared or summarised history. Each layer fixes a way the one below breaks.

**Q: When would you use a sub-agent instead of a tool call?**

A: When a job needs lots of reading but only a short answer: search a codebase for every place a function is used, or research a question across many pages. The sub-agent spends tens of thousands of tokens in its own context and returns 1,000 to 2,000. For a single file read or a test run, a plain tool call is cheaper.

## Related topics

- [AI Agent with Tools](/?topic=ai-agent&read): the agent loop, tool permissions and safe actions.
- [LLM Guardrails](/?topic=llm-guardrails&read): checking what the agent produces, and evals.
- [Model Weights & LLM Inference](/?topic=llm-inference&read): why long contexts take memory on the server: the key-value (KV) cache.
- [RAG Pipeline](/?topic=rag-pipeline&read): fetching just the passages you need instead of whole documents.

## Sources

- Anthropic: [Effective context engineering for AI agents](https://anthropic.com/engineering/effective-context-engineering-for-ai-agents) (September 2025)
- Anthropic: [Effective harnesses for long-running agents](https://www.anthropic.com/news/effective-harnesses-for-long-running-agents)
- Liu et al., [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) (2023)

## Why This Matters

"How would you manage the context window of a long-running agent?" is now a common AI engineering question, and the honest answer is a design, not a trick. If you can say "clear old tool results first, keep notes outside the context, compact at 80% with a summary that keeps constraints and open bugs, and hand wide searches to sub-agents", and show what each one costs, you're describing how real coding and research agents stay useful for hours.
