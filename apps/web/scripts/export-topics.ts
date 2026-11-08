// Writes dist/topics.json after the build: every topic's id, title and blurb.
// The scheduled push function (netlify/functions/push-send.mts) reads it from
// the live site to announce topics added since its last run.
//
//   npx tsx scripts/export-topics.ts   (run by `npm run build`)
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC_TOPICS } from '../src/topics'

const out = join(dirname(fileURLToPath(import.meta.url)), '../dist/topics.json')
writeFileSync(out, JSON.stringify(STATIC_TOPICS.map(({ id, title, blurb }) => ({ id, title, blurb }))))
console.log(`topics.json: ${STATIC_TOPICS.length} topics`)
