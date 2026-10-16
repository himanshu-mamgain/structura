// Generates narration audio: one WAV per caption line in src/narration/<video>.json,
// plus a manifest of their lengths (and, for Kokoro voices, when each word is
// spoken) that the video uses to time captions and scenes. Offline, no AI service.
//
// The narration's "voice" picks the engine:
//   - a Kokoro voice id like "am_michael": open-source neural voice, any OS (tts/kokoro.mjs)
//   - anything else, like "Heera": a built-in Windows voice (Windows only)
//
//   npm run voice -w @structura/video                        (every video)
//   npm run voice -w @structura/video -- payment-idempotency (one video)
//   npm run voice -w @structura/video -- --voice=am_fenrir   (another voice)
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const voiceOverride = args.find((a) => a.startsWith('--voice='))?.slice('--voice='.length)
const named = args.filter((a) => !a.startsWith('--'))
const videos = named.length ? named : readdirSync(join(root, 'src/narration')).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'))

const isKokoroVoice = (voice) => /^[ab][fm]_[a-z]+$/.test(voice)

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

/** 16-bit mono PCM WAV. */
function wavFile(samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// ─── Windows voices ──────────────────────────────────────────────────────────

function voiceWithWindows(narration, voice, outDir, manifest) {
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
}

// ─── Kokoro voices ───────────────────────────────────────────────────────────

/** Speech level (RMS of the voiced parts) the narration is mastered to: the video lands at about −14.5 LUFS, as loud as reels. */
const TARGET_DB = -11.4

/** RMS level in dB of the 10 ms frames that have speech in them, across all clips. */
function speechLevel(clips, sampleRate) {
  const hop = Math.round(sampleRate / 100)
  const peak = Math.max(...clips.map((c) => c.reduce((m, s) => Math.max(m, Math.abs(s)), 0)))
  let energy = 0
  let frames = 0
  for (const clip of clips) {
    for (let i = 0; i + hop <= clip.length; i += hop) {
      let sum = 0
      for (let j = i; j < i + hop; j++) sum += clip[j] * clip[j]
      if (Math.sqrt(sum / hop) > peak * 0.01) {
        energy += sum / hop
        frames++
      }
    }
  }
  return 10 * Math.log10(energy / Math.max(1, frames))
}

/**
 * Masters every line the same way so levels match across the video: a gentle
 * 3:1 compressor that evens out loud and soft words, one make-up gain for the
 * whole narration to reach TARGET_DB, and a peak limiter.
 */
function master(raw, sampleRate) {
  // Kokoro's top octave is mostly vocoder fizz; it also causes inter-sample overs.
  const clips = raw.map((clip) => lowpass(clip, sampleRate, 10_000))
  const into = 10 ** ((-18 - speechLevel(clips, sampleRate)) / 20) // into the compressor at −18 dB
  const threshold = 10 ** (-24 / 20)
  const attack = Math.exp(-1 / (0.005 * sampleRate))
  const release = Math.exp(-1 / (0.08 * sampleRate))
  const compressed = clips.map((clip) => {
    const out = new Float32Array(clip.length)
    let envelope = 0
    for (let i = 0; i < clip.length; i++) {
      const x = clip[i] * into
      const level = Math.abs(x)
      envelope = level > envelope ? attack * envelope + (1 - attack) * level : release * envelope + (1 - release) * level
      out[i] = envelope > threshold ? x * (threshold / envelope) ** (1 - 1 / 3) : x
    }
    return out
  })
  const makeUp = 10 ** ((TARGET_DB - speechLevel(compressed, sampleRate)) / 20)
  return compressed.map((clip) => limit(clip.map((s) => s * makeUp), sampleRate))
}

/**
 * Look-ahead peak limiter: the gain starts dipping 3 ms before a peak and
 * recovers over 60 ms, so peaks stay under the ceiling without the distortion
 * (and the inter-sample overs) that clipping would add.
 */
function limit(clip, sampleRate) {
  // Remotion plays the mono clips at −3 dB per stereo channel, so −1 dBFS here
  // leaves the encoded video's peaks (between samples too) near −2.5 dBTP.
  const ceiling = 10 ** (-1 / 20)
  const ahead = Math.round(0.003 * sampleRate)
  const release = Math.exp(-1 / (0.06 * sampleRate))
  // Peaks between samples too (a 4-point estimate of the midpoint), so the
  // resampled, encoded audio doesn't go over either.
  const at = (i) => clip[Math.max(0, Math.min(clip.length - 1, i))]
  const need = clip.map((s, i) => {
    const mid = (-at(i - 1) + 9 * s + 9 * at(i + 1) - at(i + 2)) / 16
    return Math.min(1, ceiling / Math.max(Math.abs(s), Math.abs(mid), 1e-9))
  })
  const out = new Float32Array(clip.length)
  let gain = 1
  for (let i = 0; i < clip.length; i++) {
    let wanted = 1
    for (let j = Math.max(0, i - ahead); j <= Math.min(clip.length - 1, i + ahead); j++) wanted = Math.min(wanted, need[j])
    gain = wanted < gain ? wanted : wanted - (wanted - gain) * release
    out[i] = clip[i] * gain
  }
  return out
}

/** Two-pole low-pass filter (RBJ cookbook biquad, Butterworth Q). */
function lowpass(clip, sampleRate, cutoff) {
  const w = (2 * Math.PI * cutoff) / sampleRate
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  const b0 = (1 - cos) / 2 / a0
  const b1 = (1 - cos) / a0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  const out = new Float32Array(clip.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < clip.length; i++) {
    const y = b0 * clip[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = clip[i]
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

const normalize = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * Word timings for the caption text, from timings of the spoken text. They differ
 * where "say" spells something out ("₹100" is spoken "a hundred rupees"): words
 * the two share keep their times, and the caption words in between share the
 * time of the spoken words in between.
 */
function captionWords(text, spoken) {
  const shown = text.split(/\s+/).filter(Boolean)
  if (shown.length === spoken.length) return shown.map((word, i) => [word, spoken[i].start, spoken[i].end])
  // Longest common subsequence of normalised words.
  const a = shown.map(normalize)
  const b = spoken.map((w) => normalize(w.word))
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] && a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const pairs = []
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] && a[i] === b[j]) pairs.push([i++, j++])
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  const out = new Array(shown.length)
  for (const [i, j] of pairs) out[i] = [shown[i], spoken[j].start, spoken[j].end]
  // Fill the gaps between matched words.
  const anchors = [[-1, -1], ...pairs, [shown.length, spoken.length]]
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [i0, j0] = anchors[k]
    const [i1, j1] = anchors[k + 1]
    if (i1 - i0 <= 1) continue
    // The spoken words between the two matches, or the instant between them if there are none.
    const between = j1 - j0 > 1
    const start = between ? spoken[j0 + 1].start : j0 >= 0 ? spoken[j0].end : spoken[0].start
    const end = between ? spoken[j1 - 1].end : Math.max(start, j1 < spoken.length ? spoken[j1].start : spoken.at(-1).end)
    const gap = shown.slice(i0 + 1, i1)
    const total = gap.reduce((s, w) => s + w.length, 0)
    let at = start
    gap.forEach((word, n) => {
      const length = ((end - start) * word.length) / total
      out[i0 + 1 + n] = [word, Math.round(at * 1000) / 1000, Math.round((at + length) * 1000) / 1000]
      at += length
    })
  }
  return out
}

async function voiceWithKokoro(narration, voice, outDir, manifest) {
  const tts = join(root, 'tts')
  if (!existsSync(join(tts, 'node_modules/onnxruntime-web'))) {
    console.log('Installing the Kokoro voice engine (once)…')
    execSync('npm ci --no-audit --no-fund', { cwd: tts, stdio: 'inherit' })
  }
  const { createVoice, trimAndTime } = await import(pathToFileURL(join(tts, 'kokoro.mjs')).href)
  const engine = await createVoice(join(root, '.cache/kokoro'), voice)
  const speed = narration.speed ?? 1
  const british = voice.startsWith('b')

  const lines = Object.values(narration.scenes).flat()
  const clips = []
  manifest.words = {}
  // Raw clips are cached by voice, speed and words: editing one line re-voices only that line.
  const clipDir = join(root, '.cache/kokoro/clips')
  mkdirSync(clipDir, { recursive: true })
  for (const line of lines) {
    const spokenText = line.say ?? line.text
    const cached = join(clipDir, `${createHash('sha1').update(`${voice}|${speed}|${spokenText}`).digest('hex')}.f32`)
    let raw
    if (existsSync(cached)) raw = new Float32Array(new Uint8Array(readFileSync(cached)).buffer)
    else {
      raw = await engine.speak(spokenText, speed)
      writeFileSync(cached, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))
    }
    const { audio, words } = await trimAndTime(spokenText, raw, engine.sampleRate, british)
    clips.push(audio)
    manifest.words[line.id] = captionWords(line.text, words)
    console.log(`${line.id.padEnd(14)} ${(audio.length / engine.sampleRate).toFixed(2)}s  ${spokenText}`)
  }
  master(clips, engine.sampleRate).forEach((audio, i) => {
    writeFileSync(join(outDir, `${lines[i].id}.wav`), wavFile(audio, engine.sampleRate))
    manifest.lines[lines[i].id] = audio.length / engine.sampleRate
  })
}

async function voiceVideo(video) {
  const narration = JSON.parse(readFileSync(join(root, 'src/narration', `${video}.json`), 'utf8'))
  const voice = voiceOverride ?? narration.voice
  const outDir = join(root, 'public/voice', video)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = { voice, lines: {} }
  if (isKokoroVoice(voice)) await voiceWithKokoro(narration, voice, outDir, manifest)
  else voiceWithWindows(narration, voice, outDir, manifest)
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`
${video}: ${Object.keys(manifest.lines).length} lines voiced by ${voice} → public/voice/${video}/
`)
}

for (const video of videos) await voiceVideo(video)
