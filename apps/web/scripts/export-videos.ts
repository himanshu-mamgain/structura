// Exports topics for the automatic topic videos (apps/video, TopicVideo): each
// topic's architecture laid out for a vertical video, its walkthrough and
// takeaways (apps/video/src/data/topics/<id>.json), plus a narration script
// voiced with Kokoro (apps/video/src/narration/topic-<id>.json).
//
//   npx tsx scripts/export-videos.ts                 (topics without a hand-made video)
//   npx tsx scripts/export-videos.ts kafka rbac      (these topics)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layout } from '../src/board/layout'
import { responsibility, subtitleOf } from '../src/diagram/inspect'
import { splitSentences } from '../src/learn/text'
import { STATIC_TOPICS } from '../src/topics'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const video = join(web, '../video')
const wanted = process.argv.slice(2)
// Topics with a hand-made video keep it; the rest get the automatic one.
const HAND_MADE = new Set(['url-shortener', 'rbac', 'uber-surge', 'docker-vs-vm'])
const topics = wanted.length ? STATIC_TOPICS.filter((t) => wanted.includes(t.id)) : STATIC_TOPICS.filter((t) => !HAND_MADE.has(t.id))

/** A step's short title: the text before a colon, or the boxes it involves (as in the app's step player). */
const stepTitle = (step: { text: string; nodes: string[] }) => {
  const colon = step.text.indexOf(':')
  if (colon > 0 && colon < 42) return step.text.slice(0, colon)
  return step.nodes.slice(0, 2).join(' → ')
}

const line = (id: string, text: string, highlight = '', frames = 75) => ({ id, text, highlight, frames })

/**
 * Caption-sized pieces of a sentence: break at a comma, colon or semicolon once a
 * line has 6 words, or at 11 words regardless; a tiny last piece joins the line before.
 */
function captionChunks(sentence: string, max = 11): string[] {
  const chunks: string[][] = [[]]
  for (const word of sentence.split(/\s+/)) {
    const current = chunks[chunks.length - 1]
    current.push(word)
    if (current.length >= max || (current.length >= 6 && /[,;:]$/.test(word))) chunks.push([])
  }
  if (!chunks[chunks.length - 1].length) chunks.pop()
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 3) chunks[chunks.length - 2].push(...chunks.pop()!)
  return chunks.map((c) => c.join(' '))
}

/** Narration lines for some text: one per caption chunk, ids prefix-0, prefix-1… */
const lines = (prefix: string, text: string, highlight = '') =>
  splitSentences(text).flatMap((sentence) => captionChunks(sentence)).map((chunk, k) => line(`${prefix}-${k}`, chunk, highlight))

mkdirSync(join(video, 'src/data/topics'), { recursive: true })
const exported: string[] = []

for (const topic of topics) {
  const subtitles: Record<string, string> = {}
  for (const n of topic.architecture.nodes) {
    const s = subtitleOf(responsibility(topic, n.label), 30)
    if (s) subtitles[n.id] = s
  }
  // Portrait layout: top to bottom, cards sized for icon + name + role.
  const placed = await layout(
    { ...topic.architecture, direction: 'down' },
    {
      fitRatio: 1000 / 880,
      maxLayerGap: 200,
      nodeSize: (n) => ({ width: Math.max(230, Math.round(n.label.length * 9.4 + 100)), height: subtitles[n.id] ? 84 : 70 }),
    },
  )
  const steps = (topic.explanation.trace?.steps ?? []).slice(0, 9)

  const data = {
    id: topic.id,
    title: topic.title,
    blurb: topic.blurb,
    difficulty: topic.difficulty,
    summary: topic.explanation.summary,
    width: placed.w,
    height: placed.h,
    groups: topic.architecture.groups.flatMap((g) => {
      const p = placed.groups.get(g.id)
      return p ? [{ id: g.id, label: g.label, ...p }] : []
    }),
    nodes: topic.architecture.nodes.flatMap((n) => {
      const p = placed.nodes.get(n.id)
      return p ? [{ id: n.id, label: n.label, color: n.color, shape: n.shape, subtitle: subtitles[n.id] ?? null, ...p }] : []
    }),
    edges: topic.architecture.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, dashed: e.dashed })),
    steps: steps.map((s) => ({ title: stepTitle(s), text: s.text, nodes: s.nodes, data: s.data })),
    takeaways: topic.takeaways.slice(0, 4),
    credit: topic.adaptedFrom ? `Adapted from ${topic.adaptedFrom.title}, ${topic.adaptedFrom.author} (${topic.adaptedFrom.license})` : null,
  }
  writeFileSync(join(video, `src/data/topics/${topic.id}.json`), `${JSON.stringify(data, null, 1)}\n`)

  // The narration: what each scene says, one caption line per sentence.
  const summary = splitSentences(topic.explanation.summary).slice(0, 3)
  const narration = {
    voice: 'am_michael',
    engine: 'kokoro',
    speed: 0.96,
    scenes: {
      intro: [line('title', `${topic.title}.`, topic.title.split(/[:&]/)[0]), ...lines('intro', summary.join(' '))],
      walk: steps.flatMap((s, i) =>
        lines(`step${i}`, s.text, s.nodes[0] ?? '').map((l, k) => (k === 0 ? { ...l, say: `Step ${i + 1}. ${l.text}` } : l)),
      ),
      // take-<n>-<chunk>: the video shows takeaway n when its first chunk starts.
      takeaways: [line('take-intro', 'Key takeaways.', 'takeaways', 45), ...data.takeaways.flatMap((t, i) => lines(`take-${i}`, t))],
      outro: [line('outro-0', 'Now explore it yourself in Structura: tap any component, and switch parts off to see what breaks.', 'Structura', 90)],
    },
  }
  writeFileSync(join(video, `src/narration/topic-${topic.id}.json`), `${JSON.stringify(narration, null, 1)}\n`)
  exported.push(topic.id)
  console.log(`${topic.id}: ${data.nodes.length} components, ${data.steps.length} steps, layout ${Math.round(placed.w)}×${Math.round(placed.h)}`)
}

// An index the video workspace imports (Remotion's bundler has no glob imports).
const all = STATIC_TOPICS.filter((t) => !HAND_MADE.has(t.id) || wanted.includes(t.id)).map((t) => t.id)
const ids = [...new Set([...all.filter((id) => exported.includes(id))])]
const camel = (id: string) => id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())
writeFileSync(
  join(video, 'src/data/topics.ts'),
  `// Generated by apps/web/scripts/export-videos.ts. Topics that get an automatic video.\n${ids
    .map((id) => `import ${camel(id)} from './topics/${id}.json'\nimport ${camel(id)}Narration from '../narration/topic-${id}.json'`)
    .join('\n')}\n\nexport const TOPIC_VIDEOS = {\n${ids.map((id) => `  '${id}': { data: ${camel(id)}, narration: ${camel(id)}Narration },`).join('\n')}\n}\n`,
)
console.log(`\n${ids.length} topic videos → apps/video/src/data/topics.ts`)
