// Kokoro-82M text-to-speech in plain Node: espeak-ng phonemes (phonemizer, WebAssembly)
// fed to the Kokoro ONNX model (onnxruntime-web, WebAssembly). No Python, no native
// builds, no service: the same on Windows, macOS and Linux.
//
// The model (Apache-2.0) and voice files are downloaded once from npm and checked
// against pinned hashes, then cached. The phoneme vocabulary in vocab.json is
// Kokoro's own (hexgrad/Kokoro-82M config.json, Apache-2.0).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as ort from 'onnxruntime-web'
import { phonemize } from 'phonemizer'

const SAMPLE_RATE = 24_000
const VOCAB = JSON.parse(readFileSync(new URL('./vocab.json', import.meta.url), 'utf8'))

/** npm tarballs, pinned by their registry integrity hash. */
const MODEL = {
  tarball: 'https://registry.npmjs.org/kokoro-q8-shards/-/kokoro-q8-shards-1.0.0.tgz',
  integrity: 'sha512-KoJQ203LxUOFrHAm12mu+hRmvqTmOcCgz61OVgTxmxX4isWaufLCF6kYz+QwOzVFYGNS62HHJWBHUbhzeoR43g==',
  // onnx-community/Kokoro-82M-v1.0-ONNX model_quantized.onnx, rejoined from 6 shards.
  sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
}
const VOICES = {
  tarball: 'https://registry.npmjs.org/kokoro-js/-/kokoro-js-1.2.1.tgz',
  integrity: 'sha512-oq0HZJWis3t8lERkMJh84WLU86dpYD0EuBPtqYnLlQzyFP1OkyBRDcweAqCfhNOpltyN9j/azp1H6uuC47gShw==',
}

/** Kokoro voice ids look like "am_michael": a = American, b = British; f/m = female/male. */
export const isKokoroVoice = (voice) => /^[ab][fm]_[a-z]+$/.test(voice)

async function download(url, integrity) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const [algorithm, expected] = integrity.split(/-(.*)/s)
  const actual = createHash(algorithm).update(buffer).digest('base64')
  if (actual !== expected) throw new Error(`${url}: integrity check failed`)
  return gunzipSync(buffer)
}

/** Files in a tar archive (ustar), as { name, data }. */
function* untar(tar) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const field = (start, length) => tar.toString('utf8', offset + start, offset + start + length).replace(/\0[\s\S]*$/, '')
    const name = field(0, 100)
    if (!name) return
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const prefix = field(345, 155)
    yield { name: prefix ? `${prefix}/${name}` : name, data: tar.subarray(offset + 512, offset + 512 + size) }
    offset += 512 + Math.ceil(size / 512) * 512
  }
}

/** Downloads the model and the voice into `cacheDir` the first time; returns their paths. */
export async function ensureAssets(cacheDir, voice) {
  mkdirSync(cacheDir, { recursive: true })
  const modelPath = join(cacheDir, 'kokoro-v1.0-q8.onnx')
  const voicePath = join(cacheDir, `${voice}.bin`)
  if (!existsSync(modelPath)) {
    console.log('Downloading the Kokoro model (92 MB, once)…')
    const parts = [...untar(await download(MODEL.tarball, MODEL.integrity))]
      .filter((f) => /kokoro-q8\.part\d+\.bin$/.test(f.name))
      .sort((a, b) => Number(a.name.match(/part(\d+)/)[1]) - Number(b.name.match(/part(\d+)/)[1]))
    const model = Buffer.concat(parts.map((p) => p.data))
    if (createHash('sha256').update(model).digest('hex') !== MODEL.sha256) throw new Error('Kokoro model: sha256 mismatch')
    writeFileSync(modelPath, model)
  }
  if (!existsSync(voicePath)) {
    const file = [...untar(await download(VOICES.tarball, VOICES.integrity))].find((f) => f.name === `package/voices/${voice}.bin`)
    if (!file) throw new Error(`Unknown Kokoro voice "${voice}"`)
    writeFileSync(voicePath, file.data)
  }
  return { modelPath, voicePath }
}

// ─── Text → phonemes → token ids (as kokoro-js does it) ─────────────────────

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]'
const SPLIT = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g')

/** espeak-ng phonemes for `text`, keeping punctuation (Kokoro uses it for pauses and intonation). */
export async function toPhonemes(text, british = false) {
  const clean = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  const pieces = []
  let last = 0
  for (const m of clean.matchAll(SPLIT)) {
    if (m.index > last) pieces.push({ punct: false, text: clean.slice(last, m.index) })
    pieces.push({ punct: true, text: m[0] })
    last = m.index + m[0].length
  }
  if (last < clean.length) pieces.push({ punct: false, text: clean.slice(last) })
  const lang = british ? 'en' : 'en-us'
  const spoken = await Promise.all(pieces.map(async (p) => (p.punct ? p.text : await wordsToPhonemes(p.text, lang))))
  let phonemes = spoken
    .join('')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
  if (!british) phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
  return phonemes.trim()
}

/** Words espeak-ng gets wrong, in IPA. */
const LEXICON = {
  idempotency: 'ˌaɪdəmpˈoʊtənsi',
  idempotent: 'ˌaɪdəmpˈoʊtənt',
}
const LEXICON_WORDS = new RegExp(`\\b(${Object.keys(LEXICON).join('|')})\\b`, 'gi')

/** Phonemes for a run of words with no punctuation, using the lexicon where it has the word. */
async function wordsToPhonemes(text, lang) {
  const parts = text.split(LEXICON_WORDS).filter((part) => part.trim())
  const phonemes = await Promise.all(parts.map(async (part) => LEXICON[part.toLowerCase()] ?? (await phonemize(part.trim(), lang)).join(' ')))
  return (text.startsWith(' ') ? ' ' : '') + phonemes.join(' ') + (text.endsWith(' ') ? ' ' : '')
}

const toIds = (phonemes) => [...phonemes].map((c) => VOCAB[c]).filter((id) => id !== undefined)

// ─── Synthesis ───────────────────────────────────────────────────────────────

export async function createVoice(cacheDir, voice) {
  const { modelPath, voicePath } = await ensureAssets(cacheDir, voice)
  ort.env.wasm.numThreads = Math.min(4, availableParallelism())
  const session = await ort.InferenceSession.create(readFileSync(modelPath))
  const styles = new Float32Array(new Uint8Array(readFileSync(voicePath)).buffer)
  const british = voice.startsWith('b')

  /** Mono float samples at 24 kHz for one line of text. */
  async function speak(text, speed = 1) {
    const ids = toIds(await toPhonemes(text, british)).slice(0, 510)
    // The voice holds one style vector per input length.
    const style = styles.slice(ids.length * 256, ids.length * 256 + 256)
    const { waveform } = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0].map(BigInt)), [1, ids.length + 2]),
      style: new ort.Tensor('float32', style, [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    })
    return waveform.data
  }
  return { speak, sampleRate: SAMPLE_RATE }
}

// ─── Word timings, for word-by-word captions ─────────────────────────────────

/**
 * Trims the silence around a clip and estimates when each word is spoken.
 * Kokoro's ONNX export returns audio only, so timings are estimated: pauses
 * found in the audio are matched to the punctuation that caused them, and the
 * speech between pauses is shared out by each word's phoneme count.
 */
export async function trimAndTime(text, samples, sampleRate, british = false) {
  const hop = Math.round(sampleRate / 100) // 10 ms frames
  const level = []
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0
    for (let j = i; j < i + hop; j++) sum += samples[j] * samples[j]
    level.push(Math.sqrt(sum / hop))
  }
  const peak = Math.max(...level)
  // Tuned against forced alignment: median word-start error about 50 ms.
  const quiet = level.map((l) => l < peak * 0.06)
  const first = quiet.indexOf(false)
  const last = quiet.lastIndexOf(false)
  // Keep a little air either side so consonants aren't clipped.
  const startFrame = Math.max(0, first - 3)
  const endFrame = Math.min(level.length, last + 6)
  const audio = samples.slice(startFrame * hop, endFrame * hop)
  const t = (frame) => (frame - startFrame) / 100

  const pauses = []
  for (let f = first, run = -1; f <= last; f++) {
    if (quiet[f] && run < 0) run = f
    if (!quiet[f] && run >= 0) {
      if (f - run >= 5) pauses.push({ start: t(run), end: t(f) })
      run = -1
    }
  }

  const words = text.split(/\s+/).filter(Boolean)
  const lang = british ? 'en' : 'en-us'
  const weights = await Promise.all(
    words.map(async (w) => {
      const core = w.replace(/[^\p{L}\p{N}'-]/gu, '')
      if (!core) return 1
      const phonemes = await wordsToPhonemes(core, lang)
      return Math.max(1, [...phonemes].filter((c) => c !== 'ˈ' && c !== 'ˌ' && c !== ' ').length)
    }),
  )
  const speechStart = t(first)
  const speechEnd = t(last + 1)

  // First guess: words share the whole span by weight. It places each punctuation break.
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  const guessEnd = weights.map((w) => speechStart + ((acc += w) / total) * (speechEnd - speechStart))

  // Anchor each punctuation break to the nearest unused pause, keeping time order.
  const anchors = [] // { after: word index, start, end } — the pause between word `after` and the next
  let from = 0
  for (let i = 0; i < words.length - 1; i++) {
    if (!/[,.;:!?—…]["”')]*$/.test(words[i])) continue
    let best = -1
    for (let p = from; p < pauses.length; p++) {
      const centre = (pauses[p].start + pauses[p].end) / 2
      if (Math.abs(centre - guessEnd[i]) > 0.8) continue
      if (best < 0 || Math.abs(centre - guessEnd[i]) < Math.abs((pauses[best].start + pauses[best].end) / 2 - guessEnd[i])) best = p
    }
    if (best >= 0) {
      anchors.push({ after: i, start: pauses[best].start, end: pauses[best].end })
      from = best + 1
    }
  }

  // Share each stretch between anchors by weight.
  const timings = []
  const segments = [{ firstWord: 0, start: speechStart }]
  for (const a of anchors) {
    segments.at(-1).lastWord = a.after
    segments.at(-1).end = a.start
    segments.push({ firstWord: a.after + 1, start: a.end })
  }
  segments.at(-1).lastWord = words.length - 1
  segments.at(-1).end = speechEnd
  for (const s of segments) {
    const w = weights.slice(s.firstWord, s.lastWord + 1)
    const sum = w.reduce((a, b) => a + b, 0)
    let at = s.start
    w.forEach((weight, k) => {
      const length = ((s.end - s.start) * weight) / sum
      timings.push({ word: words[s.firstWord + k], start: round(Math.max(0, at - LEAD)), end: round(at + length - LEAD) })
      at += length
    })
  }
  return { audio, words: timings }
}

/** Seconds each word lights up early: a caption that lags the voice reads as out of sync. */
const LEAD = 0.04
const round = (s) => Math.round(s * 1000) / 1000
