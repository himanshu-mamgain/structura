// Writes dist/topics.json after the build: every topic's id, title and blurb, plus its area,
// level, roadmap stage and place in the study order. The scheduled push function
// (netlify/functions/push-send.mts) reads it to announce new topics, and the Studia site's daily
// plan reads it to give one topic at a time, in this order: every area's Foundations, then every
// area's Intermediate, and so on (the roadmap, src/learn/roadmap.ts); topics with no roadmap
// step come last.
//
//   npx tsx scripts/export-topics.ts   (run by `npm run build`)
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC_TOPICS } from '../src/topics'
import { AREA_OF, AREAS } from '../src/topics/areas'
import { ROADMAP, STAGES } from '../src/learn/roadmap'

const stageOf = new Map<string, string>()
const order: string[] = []
for (const stage of STAGES)
  for (const area of [...AREAS.map((a) => a.id), null])
    for (const part of ROADMAP.filter((p) => p.stage === stage && p.area === area))
      for (const step of part.steps)
        if (step.topic && !stageOf.has(step.topic)) {
          stageOf.set(step.topic, stage)
          order.push(step.topic)
        }
for (const t of STATIC_TOPICS) if (!stageOf.has(t.id)) order.push(t.id)

const out = join(dirname(fileURLToPath(import.meta.url)), '../dist/topics.json')
writeFileSync(
  out,
  JSON.stringify(
    STATIC_TOPICS.map(({ id, title, blurb, difficulty }) => ({
      id,
      title,
      blurb,
      area: AREA_OF[id],
      difficulty,
      stage: stageOf.get(id) ?? null,
      order: order.indexOf(id),
    })),
  ),
)
console.log(`topics.json: ${STATIC_TOPICS.length} topics`)
