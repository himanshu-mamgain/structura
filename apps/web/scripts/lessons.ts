// Generates Commute-mode audio lessons: every topic voiced with Kokoro (offline,
// on this machine) into one AAC file per chapter, plus src/learn/lessons.json
// with durations and sentence cues for highlighting.
//
//   npx tsx scripts/lessons.ts                  (every topic)
//   npx tsx scripts/lessons.ts rbac uber-surge  (some topics)
//   npx tsx scripts/lessons.ts --voice=am_michael
//
// Needs apps/video/.venv (Kokoro, see apps/video/scripts/kokoro_speak.py) and ffmpeg
// (the one bundled with Remotion is used).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lessonChapters } from '../src/learn/lesson'
import { STATIC_TOPICS } from '../src/topics'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const video = join(web, '../video')
const python = join(video, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const args = process.argv.slice(2)
const voice = args.find((a) => a.startsWith('--voice='))?.slice(8) ?? 'af_heart'
const wanted = args.filter((a) => !a.startsWith('--'))
const topics = wanted.length ? STATIC_TOPICS.filter((t) => wanted.includes(t.id)) : STATIC_TOPICS
const manifestPath = join(web, 'src/learn/lessons.json')

interface ChapterAudio {
  id: string
  title: string
  file: string
  duration: number
  cues: { t: number; text: string }[]
}

const manifest: { voice: string; topics: Record<string, { chapters: ChapterAudio[]; duration: number }> } = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { voice, topics: {} }
manifest.voice = voice

for (const topic of topics) {
  const next = STATIC_TOPICS[STATIC_TOPICS.indexOf(topic) + 1]
  const chapters = lessonChapters(topic, next)
  const out = join(web, 'public/lessons', topic.id)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  console.log(`\n${topic.title}`)

  const run = spawnSync(python, [join(video, 'scripts/lesson_speak.py'), '--voice', voice, '--out-dir', out], {
    input: JSON.stringify({ chapters }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.status !== 0) throw new Error(`Kokoro failed for ${topic.id}`)
  const timings = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, { duration: number; cues: ChapterAudio['cues'] }>

  const audio: ChapterAudio[] = []
  for (const [i, chapter] of chapters.entries()) {
    const wav = join(out, `${chapter.id}.wav`)
    const file = `${String(i + 1).padStart(2, '0')}-${chapter.id}.m4a`
    // AAC-LC, mono, 48 kbps: clear speech at ~21 MB an hour, plays on every phone.
    execFileSync('npx', ['remotion', 'ffmpeg', '-y', '-v', 'error', '-i', wav, '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', join(out, file)], {
      cwd: video,
      shell: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    rmSync(wav)
    audio.push({ id: chapter.id, title: chapter.title, file: `/lessons/${topic.id}/${file}`, ...timings[chapter.id] })
  }
  manifest.topics[topic.id] = { chapters: audio, duration: Math.round(audio.reduce((s, c) => s + c.duration, 0)) }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`)
  console.log(`  → ${audio.length} chapters, ${(manifest.topics[topic.id].duration / 60).toFixed(1)} min`)
}
