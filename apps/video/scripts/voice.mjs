// Generates narration audio: one WAV per caption line in src/narration/<video>.json,
// spoken by a built-in Windows voice (offline, no AI service), plus a manifest
// of their lengths that the video uses to time captions and scenes.
//
//   npm run voice -w @structura/video                  (every video)
//   npm run voice -w @structura/video -- uber-surge    (one video)
//   npm run voice -w @structura/video -- --voice=Ravi  (another installed voice)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const voiceOverride = args.find((a) => a.startsWith('--voice='))?.slice('--voice='.length)
const named = args.filter((a) => !a.startsWith('--'))
const videos = named.length ? named : readdirSync(join(root, 'src/narration')).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'))

/** Seconds of audio in a PCM WAV file, from its header and data chunk. */
function wavSeconds(buffer) {
  const byteRate = buffer.readUInt32LE(28)
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') return size / byteRate
    offset += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

function voiceVideo(video) {
  const narration = JSON.parse(readFileSync(join(root, 'src/narration', `${video}.json`), 'utf8'))
  const voice = voiceOverride ?? narration.voice
  const outDir = join(root, 'public/voice', video)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = { voice, lines: {} }
  const textFile = join(outDir, '.line.txt')
  for (const lines of Object.values(narration.scenes)) {
    for (const line of lines) {
      const wav = join(outDir, `${line.id}.wav`)
      // "say" is the spoken form where the caption reads badly aloud (VMs → "V Ms").
      writeFileSync(textFile, line.say ?? line.text, 'utf8')
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/speak.ps1'), '-TextFile', textFile, '-OutFile', wav, '-Voice', voice],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      )
      const seconds = wavSeconds(readFileSync(wav))
      manifest.lines[line.id] = seconds
      console.log(`${line.id.padEnd(14)} ${seconds.toFixed(2)}s  ${line.say ?? line.text}`)
    }
  }
  rmSync(textFile, { force: true })
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`
${video}: ${Object.keys(manifest.lines).length} lines voiced by ${voice} → public/voice/${video}/
`)
}

for (const video of videos) voiceVideo(video)
