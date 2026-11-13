// Writes src/topics/catalog.json: the little the app needs about every topic before
// one is opened (title, blurb, level, video, section headings, related guides). The
// home page, Explore, search, reels, the roadmap and reminders read only this, so the
// full topics (diagrams, stories, simulators) load when a topic is opened, not at
// start-up. `npm run dev` and `npm run build` regenerate it; commit the result.
//
//   npx tsx scripts/export-catalog.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC_TOPICS } from '../src/topics'
import type { TopicMeta } from '../src/topics/catalog'

const catalog: TopicMeta[] = STATIC_TOPICS.map((t) => ({
  id: t.id,
  title: t.title,
  blurb: t.blurb,
  difficulty: t.difficulty,
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
