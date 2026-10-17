// Makes the automatic topic videos end to end: voice (Kokoro), render the MP4,
// take a thumbnail, compute chapters, and register each video with its topic
// in the app (apps/web/src/topics/videos.json).
//
//   npx tsx scripts/render-topics.ts            (every exported topic)
//   npx tsx scripts/render-topics.ts kafka      (some)
//
// Export topics first: cd apps/web && npx tsx scripts/export-videos.ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Narration, sceneFrames, sceneLines, type Voice } from '../src/timeline'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const web = join(root, '../web')
const FPS = 30
// Must match the scene plan in src/TopicVideo.tsx.
const SCENES: [key: string | null, planned: number][] = [
  [null, 100],
  ['intro', 300],
  ['walk', 600],
  ['takeaways', 300],
  ['outro', 150],
]

const index = readFileSync(join(root, 'src/data/topics.ts'), 'utf8')
const all = [...index.matchAll(/^ {2}'([\w-]+)': \{ data/gm)].map((m) => m[1])
const wanted = process.argv.slice(2)
const ids = wanted.length ? all.filter((id) => wanted.includes(id)) : all
const registryPath = join(web, 'src/topics/videos.json')
const registry: Record<string, { video: string; chapters: [number, string][] }> = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' })

for (const id of ids) {
  const video = `topic-${id}`
  const narrationPath = join(root, `src/narration/${video}.json`)
  const manifestPath = join(root, `public/voice/${video}/manifest.json`)
  console.log(`\n▶ ${id}`)

  // 1. Voice, unless it's up to date with the narration.
  if (!existsSync(manifestPath) || statSync(manifestPath).mtimeMs < statSync(narrationPath).mtimeMs) run('node', ['scripts/voice.mjs', video])

  // 2. Render.
  run('npx', ['remotion', 'render', 'src/index.ts', `Topic-${id}`, `../web/public/videos/${id}.mp4`])

  // 3. Chapters from the voiced timing: intro, each walkthrough step, takeaways.
  const narration = JSON.parse(readFileSync(narrationPath, 'utf8')) as Narration
  const voice = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { lines: Voice }).lines
  const data = JSON.parse(readFileSync(join(root, `src/data/topics/${id}.json`), 'utf8')) as { steps: { title: string }[] }
  const chapters: [number, string][] = []
  let start = 0
  for (const [key, planned] of SCENES) {
    if (key === 'intro') chapters.push([Math.floor(start / FPS), 'Introduction'])
    if (key === 'walk') {
      const lines = sceneLines(video, narration, key, voice)
      data.steps.forEach((step, i) => {
        const first = lines.find((l) => l.id.startsWith(`step${i}-`))
        if (first) chapters.push([Math.floor((start + first.from) / FPS), `Step ${i + 1}: ${step.title}`])
      })
    }
    if (key === 'takeaways') chapters.push([Math.floor(start / FPS), 'Key takeaways'])
    start += sceneFrames(video, narration, key, planned, voice)
  }

  // 4. Thumbnail: a frame from the second walkthrough step.
  const thumbFrame = (chapters[2]?.[0] ?? 10) * FPS + 45
  run('npx', ['remotion', 'still', 'src/index.ts', `Topic-${id}`, `../web/public/videos/${id}.jpg`, `--frame=${thumbFrame}`, '--scale=0.5', '--image-format=jpeg'])

  registry[id] = { video: `/videos/${id}.mp4`, chapters }
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 1)}\n`)
  console.log(`✓ ${id}: ${chapters.length} chapters, ${Math.round(start / FPS)}s`)
}
