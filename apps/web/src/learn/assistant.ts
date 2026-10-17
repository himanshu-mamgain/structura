import MiniSearch from 'minisearch'
import course from './course.json'
import type { Progress } from './progress'
import { planToday } from './today'
import { STATIC_TOPICS, type StaticTopic } from '../topics'

// The voice assistant's "brain", with no AI: a few commands it recognises by
// their words, and otherwise a full-text search (MiniSearch) over everything
// Structura knows: topics, sections, components, glossary terms. Answers come
// straight from that written content.

export interface AssistantContext {
  /** The topic on screen, if any. */
  topic: StaticTopic | null
  progress: Progress
  open: (topic: StaticTopic | null) => void
  openPage: (page: 'quiz' | 'glossary') => void
}

export interface Reply {
  /** What to say. */
  say: string
  /** Shown under the answer; defaults to `say`. */
  show?: string
  /** Where the answer came from, shown as a chip. */
  from?: string
  /** Run before speaking: navigate, start the walkthrough… */
  act?: () => void
  /** What the spoken text is about, for page highlighting. */
  source?: string
}

/** Commands sent to the topic page (TopicView listens). */
export type WalkCommand = { cmd: 'tour' | 'start' | 'next' | 'back' | 'stop' | 'pause' | 'resume' } | { cmd: 'step'; index: number }

export function sendWalk(command: WalkCommand) {
  window.dispatchEvent(new CustomEvent<WalkCommand>('structura:walk', { detail: command }))
}

// ─── The index ───────────────────────────────────────────────────────────

interface Doc {
  id: string
  kind: 'topic' | 'section' | 'component' | 'term'
  title: string
  text: string
  topicId?: string
  index?: number
}

function componentLines(topic: StaticTopic): { label: string; text: string }[] {
  const section = topic.explanation.sections.find((s) => /component/i.test(s.heading))
  if (!section) return []
  return section.body.split('\n').flatMap((line) => {
    const m = line.match(/^\s*-\s*([^:]+):\s*(.+)$/)
    return m ? [{ label: m[1].trim(), text: m[2].trim() }] : []
  })
}

const docs: Doc[] = [
  ...STATIC_TOPICS.flatMap((t) => [
    { id: `topic:${t.id}`, kind: 'topic' as const, title: t.title, text: `${t.blurb}. ${t.explanation.summary}`, topicId: t.id },
    ...t.explanation.sections.map((s, i) => ({ id: `section:${t.id}:${i}`, kind: 'section' as const, title: `${t.title}: ${s.heading}`, text: s.body, topicId: t.id, index: i })),
    ...componentLines(t).map((c) => ({ id: `component:${t.id}:${c.label}`, kind: 'component' as const, title: c.label, text: c.text, topicId: t.id })),
  ]),
  ...course.glossary.map((g) => ({ id: `term:${g.term}`, kind: 'term' as const, title: g.term, text: g.def })),
]

const index = new MiniSearch<Doc>({
  fields: ['title', 'text'],
  storeFields: ['kind', 'title', 'text', 'topicId', 'index'],
  searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2 },
})
index.addAll(docs)

const STOP = /\b(what|whats|is|are|the|a|an|does|do|how|why|explain|tell|me|about|please|can|you|in|of|to|work|works|mean|means)\b/g

const topicById = (id?: string) => STATIC_TOPICS.find((t) => t.id === id) ?? null

/** The topic whose name the learner said, if any. */
function findTopic(phrase: string): StaticTopic | null {
  const hit = index.search(phrase, { filter: (r) => r.kind === 'topic', combineWith: 'AND' })[0] ?? index.search(phrase, { filter: (r) => r.kind === 'topic' })[0]
  return hit && hit.score > 2 ? topicById(hit.topicId as string) : null
}

/** The first couple of sentences: answers should be short to listen to. */
const brief = (text: string, sentences = 3) =>
  text
    .replace(/^\s*[-•*]\s+/gm, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(Boolean)
    .slice(0, sentences)
    .join(' ')

// ─── Commands ────────────────────────────────────────────────────────────

const HELP =
  'You can say: open URL shortener. What should I learn today? What is a load balancer? Start the walkthrough, next, back, or step three. Give me the takeaways. Quiz me.'

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

export function respond(input: string, ctx: AssistantContext): Reply {
  const said = input.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  const topic = ctx.topic

  if (!said) return { say: "I didn't catch that. Tap the mic and try again." }
  if (/\b(help|what can you do|commands)\b/.test(said)) return { say: HELP }
  if (/\b(stop|quiet|shut up|enough)\b/.test(said) && said.split(' ').length <= 3) return { say: 'Okay.', act: () => sendWalk({ cmd: 'stop' }) }
  if (/\b(home|main page)\b/.test(said)) return { say: 'Going home.', act: () => ctx.open(null) }

  if (/\b(today|what should i (learn|study|do|pick)|plan)\b/.test(said)) {
    const plan = planToday(STATIC_TOPICS, ctx.progress, course.quiz.length)
    return { say: plan.script, show: `${plan.headline}. ${plan.reason}`, from: "Today's pick", act: plan.topic ? () => ctx.open(plan.topic) : undefined }
  }

  if (/\b(quiz|test me|test myself)\b/.test(said)) return { say: 'Opening the quiz. Good luck!', act: () => ctx.openPage('quiz') }
  if (/\bglossary\b/.test(said)) return { say: 'Here is the glossary.', act: () => ctx.openPage('glossary') }

  // Walkthrough control, on a topic page.
  const step = said.match(/\bstep (\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/)
  if (topic && step) {
    const n = Number(step[1]) || NUMBERS[step[1]]
    return { say: '', act: () => sendWalk({ cmd: 'step', index: n - 1 }) }
  }
  if (topic && /\b(next|continue|go on)\b/.test(said) && said.split(' ').length <= 3) return { say: '', act: () => sendWalk({ cmd: 'next' }) }
  if (topic && /\b(back|previous|go back)\b/.test(said) && said.split(' ').length <= 3) return { say: '', act: () => sendWalk({ cmd: 'back' }) }
  if (topic && /\b(walk ?through|walk me|guide me|tour|listen|explain (it|this|the topic)|start)\b/.test(said)) {
    return { say: '', act: () => sendWalk({ cmd: 'tour' }) }
  }
  if (topic && /\b(takeaway|takeaways|summary|summarise|summarize|key points|recap)\b/.test(said)) {
    return { say: `Key takeaways for ${topic.title}. ${topic.takeaways.join(' ')}`, show: topic.takeaways.join(' '), from: topic.title }
  }

  // "Open X" / "Explain X" / "Teach me X": a topic by name opens and is introduced.
  const named = said.match(/\b(?:open|go to|show|start|explain|teach me|learn|tell me about)\s+(.+)$/)
  const wanted = named ? findTopic(named[1]) : null
  if (wanted) {
    return {
      say: `${wanted.title}. ${wanted.explanation.summary} Say "walk me through it" to follow a request step by step.`,
      show: wanted.explanation.summary,
      from: wanted.title,
      act: () => ctx.open(wanted),
      source: `topic:${wanted.id}`,
    }
  }

  // Anything else: search what Structura knows, preferring the topic on screen.
  const query = said.replace(STOP, ' ').replace(/\s+/g, ' ').trim() || said
  const hits = index.search(query, {
    boostDocument: (_id, _term, stored) => (stored?.topicId && stored.topicId === topic?.id ? 1.6 : 1) * (stored?.kind === 'component' || stored?.kind === 'term' ? 1.3 : 1),
  })
  const best = hits[0]
  if (!best || best.score < 1.5) {
    return { say: `I don't have that one yet. ${HELP}`, show: "I couldn't find that in Structura's topics yet." }
  }
  const hitTopic = topicById(best.topicId as string)
  const title = best.title as string
  const text = best.text as string
  if (best.kind === 'topic' && hitTopic) {
    return { say: `${hitTopic.title}. ${hitTopic.explanation.summary}`, show: hitTopic.explanation.summary, from: hitTopic.title, act: () => ctx.open(hitTopic), source: `topic:${hitTopic.id}` }
  }
  if (best.kind === 'section' && hitTopic) {
    const index = best.index as number
    const openIt = hitTopic.id !== topic?.id ? () => ctx.open(hitTopic) : undefined
    return { say: `${title}. ${brief(text, 4)}`, show: brief(text, 4), from: title, act: openIt, source: `section:${hitTopic.id}:${index}` }
  }
  const where = best.kind === 'component' && hitTopic ? `In ${hitTopic.title}, the ${title}` : title
  return { say: `${where}: ${brief(text)}`, show: brief(text), from: best.kind === 'term' ? 'Glossary' : hitTopic?.title ?? title }
}

