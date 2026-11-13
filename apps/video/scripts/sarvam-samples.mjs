// Voices one short Structura passage with several Sarvam Bulbul v3 speakers, so the
// owner can pick a narrator by ear before a full run. Writes apps/web/public/voice-samples/
// (an .m4a per speaker and an index.html to play them) for a pull request's deploy
// preview; it isn't meant to be merged.
//
//   SARVAM_API_KEY=… node scripts/sarvam-samples.mjs                 (the default speakers)
//   SARVAM_API_KEY=… node scripts/sarvam-samples.mjs shubh priya     (these)
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeWav, SAMPLE_RATE, SAMPLE_SPEAKERS, speak } from '../tts/sarvam.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '../web/public/voice-samples')
const ffmpeg = join(root, '../../node_modules/@remotion', process.platform === 'win32' ? 'compositor-win32-x64-msvc/ffmpeg.exe' : 'compositor-linux-x64-gnu/ffmpeg')
const named = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const speakers = named.length ? named : (process.env.SAMPLE_SPEAKERS?.split(/[\s,]+/).filter(Boolean) ?? SAMPLE_SPEAKERS)
const pace = Number(process.env.TTS_PACE ?? 1)

// The kind of sentence the narration is full of: service names, numbers, a price, an acronym.
const PASSAGE = [
  'AWS rents out computing by the hour. A rented server is an EC2 instance; an m6i.large costs about ten cents an hour in Mumbai.',
  'Kafka stores events in partitions, and a consumer group shares them. Redis keeps the leaderboard in a sorted set.',
  'With Terraform, you run terraform plan, read it, and only then apply.',
]

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const made = []
for (const speaker of speakers) {
  const parts = []
  for (const sentence of PASSAGE) {
    parts.push(await speak(sentence, { speaker, pace, cacheDir: join(root, '.cache/sarvam') }))
    parts.push(new Float32Array(Math.round(0.35 * SAMPLE_RATE)))
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.length
  }
  const wav = join(out, `${speaker}.wav`)
  writeFileSync(wav, encodeWav(all, SAMPLE_RATE))
  // Same loudness as the audio lessons (-14 LUFS), so the comparison is fair.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav, '-af', 'aresample=44100,pan=stereo|c0=c0|c1=c0,loudnorm=I=-14:TP=-2:LRA=11', '-c:a', 'aac', '-b:a', '96k', '-f', 'mp4', join(out, `${speaker}.m4a`)])
  rmSync(wav)
  made.push({ speaker, seconds: all.length / SAMPLE_RATE })
  console.log(`${speaker.padEnd(10)} ${(all.length / SAMPLE_RATE).toFixed(1)}s`)
}

const rows = made
  .map(({ speaker, seconds }) => `<li><span>${speaker[0].toUpperCase()}${speaker.slice(1)}<small>${seconds.toFixed(1)} s · <code>${speaker}</code></small></span><audio controls preload="none" src="${speaker}.m4a"></audio></li>`)
  .join('\n      ')
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Narrator samples</title>
  <style>
    :root { color-scheme: dark; --bg: #0a0e1a; --card: #10172a; --line: rgba(148, 163, 184, 0.16); --text: #e6e9f2; --muted: #94a0b8; --brand: #d4ff3f; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { margin: 0 0 16px; color: var(--muted); }
    blockquote { margin: 0 0 20px; padding: 12px 14px; border-left: 3px solid var(--brand); background: var(--card); border-radius: 8px; color: var(--text); }
    ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
    li { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
    li span { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
    small { color: var(--muted); font-weight: 400; }
    audio { width: 100%; }
  </style>
</head>
<body>
  <main>
    <h1>Narrator samples</h1>
    <p>Sarvam Bulbul v3, Indian English, pace ${pace}. Each voice reads the same passage. Pick one, then run the narration workflow with it as the speaker.</p>
    <blockquote>${PASSAGE.join(' ')}</blockquote>
    <ul>
      ${rows}
      <li><span>Current voice (Kokoro am_michael)<small>for comparison</small></span><audio controls preload="none" src="/lessons/rbac/01-intro.m4a"></audio></li>
    </ul>
  </main>
</body>
</html>
`,
)
console.log(`\n${made.length} samples → apps/web/public/voice-samples/`)
