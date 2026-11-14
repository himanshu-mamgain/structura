// Writes src/topics/catalog.json: the little the app needs about every topic before
// one is opened (title, blurb, level, area, video, section headings, related guides). The
// home page, Explore, search, reels, the roadmap and reminders read only this, so the
// full topics (diagrams, stories, simulators) load when a topic is opened, not at
// start-up. `npm run dev` and `npm run build` regenerate it; commit the result.
//
//   npx tsx scripts/export-catalog.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC_TOPICS } from '../src/topics'
import { AREA_OF } from '../src/topics/areas'
import type { TopicMeta } from '../src/topics/catalog'

// Every topic must belong to an area: Explore, Home and the roadmap are organised by them.
const unplaced = STATIC_TOPICS.filter((t) => !AREA_OF[t.id]).map((t) => t.id)
if (unplaced.length) {
  console.error(`No area for ${unplaced.join(', ')}: add each to AREA_OF in src/topics/areas.ts.`)
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
