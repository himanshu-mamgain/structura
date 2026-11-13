// Sarvam Bulbul v3 text-to-speech (https://docs.sarvam.ai), for narration that is
// generated once, ahead of time, and committed: the app never calls Sarvam.
//
// Needs SARVAM_API_KEY in the environment. SARVAM_API_URL overrides the endpoint (for
// a local mock). Every clip is cached by model, speaker, pace, rate and text, so a
// re-run only pays for lines that changed.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MODEL = 'bulbul:v3'
export const SAMPLE_RATE = 24_000
/** Bulbul v3 takes at most 2,500 characters a request; stay under it. */
const MAX_CHARS = 2400

/** A few English speakers worth comparing (all Bulbul v3 voices speak en-IN). */
export const SAMPLE_SPEAKERS = ['shubh', 'aditya', 'rahul', 'rohan', 'kabir', 'amit', 'priya', 'ritu', 'neha', 'kavya', 'simran', 'ishita']

/**
 * The words as they should be spoken. Bulbul reads plain text, so symbols that
 * appear in captions are written out.
 */
export function spokenForm(text) {
  return text
    .replace(/\s*→\s*/g, ' to ')
    .replace(/\s*->\s*/g, ' to ')
    .replace(/≈\s*/g, 'about ')
    .replace(/(\d)\s*×\s*(\d)/g, '$1 times $2')
    .replace(/×/g, ' times ')
    .replace(/\s+·\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits text into pieces under the request limit, at sentence ends where possible. */
function pieces(text) {
  if (text.length <= MAX_CHARS) return [text]
  const out = []
  let current = ''
  for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]) {
    if ((current + sentence).length > MAX_CHARS && current) {
      out.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** Samples of a 16-bit PCM WAV, mixed to mono, and its sample rate. */
export function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Sarvam: not a WAV response')
  let offset = 12
  let channels = 1
  let rate = SAMPLE_RATE
  let bits = 16
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10)
      rate = buffer.readUInt32LE(offset + 12)
      bits = buffer.readUInt16LE(offset + 22)
    }
    if (id === 'data') {
      if (bits !== 16) throw new Error(`Sarvam: expected 16-bit audio, got ${bits}-bit`)
      // Some encoders write 0 or 0xFFFFFFFF for a streamed data size: read to the end.
      const end = size && offset + 8 + size <= buffer.length ? offset + 8 + size : buffer.length
      const frames = Math.floor((end - offset - 8) / (2 * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += buffer.readInt16LE(offset + 8 + (i * channels + c) * 2)
        samples[i] = sum / channels / 32768
      }
      return { samples, rate }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('Sarvam: WAV has no data chunk')
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples, rate = SAMPLE_RATE) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Cuts the silence Bulbul leaves before and after speech, keeping a little air,
 * so captions and scenes are timed by the words, not by padding.
 */
export function trimSilence(samples, rate = SAMPLE_RATE, keep = 0.04) {
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  const floor = Math.max(peak * 0.02, 1e-4)
  let start = 0
  while (start < samples.length && Math.abs(samples[start]) < floor) start++
  let end = samples.length - 1
  while (end > start && Math.abs(samples[end]) < floor) end--
  const pad = Math.round(keep * rate)
  return samples.slice(Math.max(0, start - pad), Math.min(samples.length, end + 1 + pad))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(text, { speaker, pace, rate }) {
  const key = process.env.SARVAM_API_KEY
  if (!key) throw new Error('Set SARVAM_API_KEY (a Sarvam API subscription key) to voice with Bulbul.')
  const url = process.env.SARVAM_API_URL ?? 'https://api.sarvam.ai/text-to-speech'
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text, language_code: 'en-IN', speaker, model: MODEL, pace, speech_sample_rate: rate, output_audio_codec: 'wav' }),
    })
    if (res.ok) {
      const body = await res.json()
      const audio = body.audios?.[0]
      if (!audio) throw new Error('Sarvam: response had no audio')
      return decodeWav(Buffer.from(audio, 'base64'))
    }
    // Rate limits and server errors are worth retrying; a bad key or request isn't.
    const retry = (res.status === 429 || res.status >= 500) && attempt < 7
    const detail = await res.text().catch(() => '')
    if (!retry) throw new Error(`Sarvam ${res.status}: ${detail.slice(0, 300)}`)
    const wait = Math.min(60_000, 2000 * 2 ** attempt)
    console.warn(`Sarvam ${res.status}, retrying in ${wait / 1000}s`)
    await sleep(wait)
  }
}

/**
 * Speaks one piece of narration with Bulbul v3 and returns mono samples at
 * SAMPLE_RATE, trimmed of edge silence. Cached in cacheDir.
 */
export async function speak(text, { speaker = 'shubh', pace = 1, cacheDir } = {}) {
  const spoken = spokenForm(text)
  const key = createHash('sha1').update(`${MODEL}|${speaker}|${pace}|${SAMPLE_RATE}|${spoken}`).digest('hex')
  const cached = cacheDir ? join(cacheDir, `${key}.wav`) : null
  if (cached && existsSync(cached)) return decodeWav(readFileSync(cached)).samples

  const parts = []
  for (const piece of pieces(spoken)) {
    const { samples, rate } = await request(piece, { speaker, pace, rate: SAMPLE_RATE })
    if (rate !== SAMPLE_RATE) throw new Error(`Sarvam: asked for ${SAMPLE_RATE} Hz, got ${rate} Hz`)
    parts.push(trimSilence(samples))
  }
  const gap = new Float32Array(Math.round(0.25 * SAMPLE_RATE))
  const total = parts.reduce((n, p, i) => n + p.length + (i ? gap.length : 0), 0)
  const out = new Float32Array(total)
  let at = 0
  parts.forEach((p, i) => {
    if (i) at += gap.length
    out.set(p, at)
    at += p.length
  })
  if (cached) {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cached, encodeWav(out))
  }
  return out
}

/**
 * Speaks many pieces a few at a time, filling the cache, so a long lesson takes
 * minutes rather than hours. Callers then read each clip back with speak(), in order.
 */
export async function warm(texts, { speaker = 'shubh', pace = 1, cacheDir, concurrency = 6 } = {}) {
  const queue = [...new Set(texts)]
  let done = 0
  const worker = async () => {
    for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
      await speak(text, { speaker, pace, cacheDir })
      done++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return done
}
