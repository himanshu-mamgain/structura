// Prints each video's chapter start times (from the narration timing), for the
// app's chapter list:   npx tsx scripts/chapters.ts
import { readFileSync } from 'node:fs'
import { sceneFrames, type Narration, type Voice } from '../src/timeline'

const FPS = 30

/** [scene key or null, planned frames, chapter label] per video, matching each composition's SCENES. */
const VIDEOS: Record<string, { narration: string; scenes: [string | null, number, string][] }> = {
  'url-shortener': {
    narration: 'url-shortener',
    scenes: [[null, 120, 'Introduction'], ['shorten', 600, 'Making a short link'], ['base62', 450, 'Base62 encoding'], ['redirect', 750, 'Redirect and caching'], ['scale', 450, 'Scaling for reads'], [null, 150, 'Recap']],
  },
  rbac: {
    narration: 'rbac',
    scenes: [[null, 120, 'Introduction'], ['auth', 480, '401 vs 403'], ['model', 480, 'Users, roles, permissions'], ['flow', 900, 'Following a request'], ['deny', 480, 'When access is refused'], [null, 150, 'Recap']],
  },
  'uber-surge': {
    narration: 'uber-surge',
    scenes: [[null, 120, 'Introduction'], ['surge', 570, 'How surge works'], ['gaming', 660, 'Gaming the surge'], ['smooth', 390, 'Fix 1: smooth the signal'], ['fixes', 480, 'Fixes 2–4'], ['pipeline', 480, 'Under the hood'], [null, 150, 'Recap']],
  },
  'docker-vs-vm': {
    narration: 'docker-vs-vm',
    scenes: [[null, 120, 'Introduction'], ['problem', 210, 'The classic problem'], ['vm', 570, 'Virtual machines'], ['containers', 540, 'Containers'], ['compare', 420, 'Side by side'], ['when', 360, 'When to use which'], ['workflow', 300, 'Dockerfile to container'], [null, 120, 'Recap']],
  },
}

const out: Record<string, [number, string][]> = {}
for (const [video, { narration: file, scenes }] of Object.entries(VIDEOS)) {
  const narration = JSON.parse(readFileSync(`src/narration/${file}.json`, 'utf8')) as Narration
  const voice = (JSON.parse(readFileSync(`public/voice/${video}/manifest.json`, 'utf8')) as { lines: Voice }).lines
  let frame = 0
  out[video] = scenes.map(([key, planned, label]) => {
    const start = Math.round(frame / FPS)
    frame += sceneFrames(video, narration, key, planned, voice)
    return [start, label]
  })
}
console.log(JSON.stringify(out))
