// Writes src/topics/catalog.json: the little the app needs about every topic before
// one is opened (title, blurb, level, area, video, section headings, related guides). The
// home page, Explore, search, reels, the roadmap and reminders read only this, so the
// full topics (diagrams, stories, simulators) load when a topic is opened, not at
// start-up. `npm run dev` and `npm run build` regenerate it; commit the result.
//
//   npx tsx scripts/export-catalog.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { STATIC_TOPICS } from '../src/topics'
import { AREA_OF } from '../src/topics/areas'
import type { TopicMeta } from '../src/topics/catalog'
import type { Lesson } from '../src/topics/lessonTypes'

// Every topic must belong to an area: Explore, Home and the roadmap are organised by them.
const unplaced = STATIC_TOPICS.filter((t) => !AREA_OF[t.id]).map((t) => t.id)
if (unplaced.length) {
  console.error(`No area for ${unplaced.join(', ')}: add each to AREA_OF in src/topics/areas.ts.`)
  process.exit(1)
}

// Lessons light up boxes by their exact labels, so a typo would silently light nothing.
const lessonDir = join(dirname(fileURLToPath(import.meta.url)), '../src/topics/lessons')
const lessonErrors: string[] = []
for (const file of readdirSync(lessonDir).filter((f) => f.endsWith('.ts'))) {
  const id = file.replace(/\.ts$/, '')
  const topic = STATIC_TOPICS.find((t) => t.id === id)
  if (!topic) {
    lessonErrors.push(`${file}: no topic with id ${id}`)
    continue
  }
  const { default: lesson } = (await import(pathToFileURL(join(lessonDir, file)).href)) as { default: Lesson }
  const labels = new Set(topic.architecture.nodes.map((n) => n.label))
  if (lesson.cards.length < 4 || lesson.cards.length > 12) lessonErrors.push(`${file}: ${lesson.cards.length} cards (4 to 12)`)
  lesson.cards.forEach((card, i) => {
    for (const label of card.focus ?? []) if (!labels.has(label)) lessonErrors.push(`${file}: card ${i + 1} focuses on "${label}", which isn't a box in the diagram`)
  })
  if (lesson.quiz.length !== 3) lessonErrors.push(`${file}: ${lesson.quiz.length} questions (3)`)
  lesson.quiz.forEach((q, i) => {
    if (!(q.answer >= 0 && q.answer < q.options.length)) lessonErrors.push(`${file}: question ${i + 1}'s answer is out of range`)
  })
}
if (lessonErrors.length) {
  console.error(lessonErrors.join('\n'))
  process.exit(1)
}

const catalog: TopicMeta[] = STATIC_TOPICS.map((t) => ({
  id: t.id,
  title: t.title,
  blurb: t.blurb,
  difficulty: t.difficulty,
  area: AREA_OF[t.id],
  ...(t.video ? { video: t.video } : {}),
  ...(t.chapters ? { chapters: t.chapters } : {}),
  ...(t.guides?.length ? { guides: t.guides } : {}),
  explanation: {
    summary: t.explanation.summary,
    sections: t.explanation.sections.map((s) => ({ heading: s.heading })),
    // A walkthrough without a simulator (simulator topics are flagged below).
    ...(!t.simulator && t.explanation.trace ? { trace: true } : {}),
  },
  // Flags only: the real simulator and load test come with the full topic.
  ...(t.simulator ? { simulator: true } : {}),
  ...(t.loadTest ? { loadTest: true } : {}),
  ...(t.story ? { story: true } : {}),
}))

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/topics/catalog.json')
const json = JSON.stringify(catalog, null, 1) + '\n'
let before = ''
try {
  before = readFileSync(out, 'utf8')
} catch {
  // first run
}
if (json !== before) writeFileSync(out, json)
console.log(`catalog.json: ${catalog.length} topics${json === before ? ' (unchanged)' : ' (updated)'}`)
