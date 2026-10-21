// Generates Commute-mode audio lessons: every topic voiced with Kokoro (offline,
// on this machine) into one AAC file per chapter, plus src/learn/lessons.json
// with durations and sentence cues for highlighting.
//
//   npx tsx scripts/lessons.ts                  (every topic)
//   npx tsx scripts/lessons.ts rbac uber-surge  (some topics)
//   npx tsx scripts/lessons.ts --voice=am_michael
//
// Needs apps/video/.venv (Kokoro, see apps/video/scripts/kokoro_speak.py); ffmpeg is the one
// bundled with Remotion. Voice: am_michael at 0.96 (see measure_voices.py); --voice / --speed override.
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
// The target speaking profile: a male voice around 114 Hz, ~158 words a minute.
// am_michael measures 121 Hz and 164 wpm at 1.0 (scripts/measure_voices.py), so 0.96 lands on ~158.
const voice = args.find((a) => a.startsWith('--voice='))?.slice(8) ?? 'am_michael'
const speed = Number(args.find((a) => a.startsWith('--speed='))?.slice(8) ?? 0.96)
const ffmpeg = join(web, '../../node_modules/@remotion', process.platform === 'win32' ? 'compositor-win32-x64-msvc/ffmpeg.exe' : 'compositor-linux-x64-gnu/ffmpeg')
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

const manifest: { voice: string; speed?: number; topics: Record<string, { chapters: ChapterAudio[]; duration: number }> } = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { voice, topics: {} }
manifest.voice = voice
manifest.speed = speed

for (const topic of topics) {
  const next = STATIC_TOPICS[STATIC_TOPICS.indexOf(topic) + 1]
  const chapters = lessonChapters(topic, next)
  const out = join(web, 'public/lessons', topic.id)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  console.log(`\n${topic.title}`)

  const run = spawnSync(python, [join(video, 'scripts/lesson_speak.py'), '--voice', voice, '--speed', String(speed), '--out-dir', out], {
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
    // Streaming loudness (-14 LUFS, true peak -1.5 dB), 44.1 kHz stereo AAC: plays on every phone,
    // and sits at the same level as music and podcasts in the same earphones. Two passes: one-pass
    // loudnorm undershoots on speech with long pauses, so measure first, then correct linearly.
    // Stereo and 44.1 kHz come first, so what's measured is exactly what's encoded. The true-peak
    // target is -2 dB because AAC encoding adds a few tenths of overshoot (finals stay under -1.5).
    const pre = 'aresample=44100,pan=stereo|c0=c0|c1=c0'
    const target = 'I=-14:TP=-2:LRA=11'
    const measure = spawnSync(ffmpeg, ['-hide_banner', '-i', wav, '-af', `${pre},loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' })
    const m = JSON.parse(measure.stderr.slice(measure.stderr.lastIndexOf('{'), measure.stderr.lastIndexOf('}') + 1))
    const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    // The bundled ffmpeg doesn't know the .m4a extension, so name the container (MP4) explicitly.
    execFileSync(
      ffmpeg,
      ['-y', '-v', 'error', '-i', wav, '-af', `${pre},loudnorm=${target}:${measured},aresample=44100`, '-c:a', 'aac', '-b:a', '80k', '-f', 'mp4', '-movflags', '+faststart', join(out, file)],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    rmSync(wav)
    audio.push({ id: chapter.id, title: chapter.title, file: `/lessons/${topic.id}/${file}`, ...timings[chapter.id] })
  }
  manifest.topics[topic.id] = { chapters: audio, duration: Math.round(audio.reduce((s, c) => s + c.duration, 0)) }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`)
  console.log(`  → ${audio.length} chapters, ${(manifest.topics[topic.id].duration / 60).toFixed(1)} min`)
}
