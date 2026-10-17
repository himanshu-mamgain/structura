import { useEffect, useState, useSyncExternalStore } from 'react'
import { splitSentences } from './text'

export { splitSentences }

// The voice engine behind the assistant, the Listen tour and Today's pick.
//
// Two voices, both on the device, no server:
// - "natural": Kokoro (open-weight, Apache 2.0) generating audio in a worker. It
//   plays through an <audio> element, so it keeps going in the background, with
//   lock-screen controls (Media Session).
// - "device": the browser's built-in speech, used until Kokoro is downloaded.
//
// Whatever is being said is published (text, sentence, word), so the page can
// highlight it as it's spoken.

export interface SpeechSettings {
  engine: 'natural' | 'device'
  /** Kokoro voice, e.g. af_heart. */
  naturalVoice: string
  /** Device voice (Web Speech API voiceURI), null for automatic. */
  voiceURI: string | null
  rate: number
  /** Language for listening to the learner. */
  listenLang: 'en-IN' | 'hi-IN' | 'en-US'
}

export interface NowSpeaking {
  speaking: boolean
  paused: boolean
  /** Who asked: e.g. "section:rbac:2", "step:rbac:4", "assistant". Lets that text highlight itself. */
  source: string | null
  title: string
  sentences: string[]
  sentence: number
  /** Index of the word being said within the current sentence. */
  word: number
}

export type NaturalStatus = 'off' | 'downloading' | 'ready' | 'error'

const KEY = 'structura:speech:v2'
const DEFAULTS: SpeechSettings = { engine: 'natural', naturalVoice: 'af_heart', voiceURI: null, rate: 1, listenLang: 'en-IN' }

/** Kokoro voices worth offering (the higher-graded ones). */
export const NATURAL_VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
]

// ─── Stores ──────────────────────────────────────────────────────────────

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

function loadSettings(): SpeechSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

const settingsStore = store(loadSettings())
const nowStore = store<NowSpeaking>({ speaking: false, paused: false, source: null, title: '', sentences: [], sentence: 0, word: 0 })
const naturalStore = store<{ status: NaturalStatus; progress: number }>({ status: 'off', progress: 0 })

export function setSpeechSettings(patch: Partial<SpeechSettings>) {
  settingsStore.set({ ...settingsStore.get(), ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(settingsStore.get()))
  } catch {
    // Not remembered; still applies now.
  }
}

export const useSpeechSettings = () => useSyncExternalStore(settingsStore.subscribe, settingsStore.get)
export const useNowSpeaking = () => useSyncExternalStore(nowStore.subscribe, nowStore.get)
export const useNaturalVoice = () => useSyncExternalStore(naturalStore.subscribe, naturalStore.get)

const patchNow = (patch: Partial<NowSpeaking>) => nowStore.set({ ...nowStore.get(), ...patch })

export const speechSupported = typeof window !== 'undefined' && ('speechSynthesis' in window || 'Worker' in window)

/** English and Hindi device voices, Indian ones first. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => ('speechSynthesis' in window ? speechSynthesis.getVoices() : []))
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const update = () => setVoices(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', update)
    update()
    return () => speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  const rank = (v: SpeechSynthesisVoice) => (v.lang === 'en-IN' ? 0 : v.lang === 'hi-IN' ? 1 : v.lang.startsWith('en') ? 2 : 3)
  return voices.filter((v) => /^(en|hi)/i.test(v.lang)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

// ─── Text ────────────────────────────────────────────────────────────────

/** Word index at a fraction of a sentence's duration, weighting words by length. */
function wordAt(sentence: string, fraction: number): number {
  const words = sentence.split(/\s+/)
  const total = words.reduce((n, w) => n + w.length + 1, 0)
  let acc = 0
  for (let i = 0; i < words.length; i++) {
    acc += words[i].length + 1
    if (acc / total >= fraction) return i
  }
  return words.length - 1
}

// ─── Natural voice (Kokoro in a worker) ─────────────────────────────────

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (wav: Blob) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data
    if (msg.type === 'progress') naturalStore.set({ status: 'downloading', progress: msg.progress })
    else if (msg.type === 'ready') naturalStore.set({ status: 'ready', progress: 100 })
    else if (msg.type === 'audio') {
      naturalStore.set({ status: 'ready', progress: 100 })
      pending.get(msg.id)?.resolve(toWav(msg.samples, msg.rate))
      pending.delete(msg.id)
    } else if (msg.type === 'error') {
      if (msg.id < 0) naturalStore.set({ status: 'error', progress: 0 })
      pending.get(msg.id)?.reject(new Error(msg.message))
      pending.delete(msg.id)
    }
  }
  return worker
}

/** Downloads Kokoro (once; the browser caches it) so the natural voice is ready. */
export function prepareNaturalVoice() {
  if (naturalStore.get().status === 'ready' || naturalStore.get().status === 'downloading') return
  naturalStore.set({ status: 'downloading', progress: 0 })
  getWorker().postMessage({ type: 'load' })
}

function generate(text: string): Promise<Blob> {
  const { naturalVoice, rate } = settingsStore.get()
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ type: 'speak', id, text, voice: naturalVoice, speed: rate })
  })
}

/** 16-bit PCM WAV, so an ordinary <audio> element can play it (and keep playing in the background). */
function toWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true)
  return new Blob([buffer], { type: 'audio/wav' })
}

let player: HTMLAudioElement | null = null
const getPlayer = () => (player ??= Object.assign(new Audio(), { preload: 'auto' }))

// ─── Speaking ────────────────────────────────────────────────────────────

let run = 0

export interface SpeakOptions {
  /** Identifies the text on the page, so it can highlight itself (see NowSpeaking.source). */
  source?: string
  /** Shown on the lock screen and in the caption. */
  title?: string
}

/**
 * Speaks `text`, replacing anything already being said. Resolves true when it
 * finished, false if it was stopped or replaced first.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
  stopSpeaking()
  const id = run
  const sentences = splitSentences(text)
  if (!sentences.length) return true
  nowStore.set({ speaking: true, paused: false, source: options.source ?? null, title: options.title ?? '', sentences, sentence: 0, word: 0 })
  mediaSession(options.title ?? 'Voice guide', sentences[0])

  const natural = settingsStore.get().engine === 'natural' && naturalStore.get().status === 'ready'
  const ok = natural ? await speakNatural(sentences, id) : await speakDevice(sentences, id)
  if (id === run) patchNow({ speaking: false, paused: false })
  return ok && id === run
}

/** Kokoro: generates every sentence ahead (so playback isn't interrupted, even in the background) and plays them in turn. */
async function speakNatural(sentences: string[], id: number): Promise<boolean> {
  const clips = sentences.map((s) => generate(s))
  const audio = getPlayer()
  for (let i = 0; i < sentences.length; i++) {
    let wav: Blob
    try {
      wav = await clips[i]
    } catch {
      return speakDevice(sentences.slice(i), id, i)
    }
    if (id !== run) return false
    const url = URL.createObjectURL(wav)
    patchNow({ sentence: i, word: 0 })
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = metadata(nowStore.get().title || 'Voice guide', sentences[i])
    const finished = await new Promise<boolean>((resolve) => {
      audio.src = url
      audio.ontimeupdate = () => {
        if (audio.duration) patchNow({ word: wordAt(sentences[i], audio.currentTime / audio.duration) })
      }
      audio.onended = () => resolve(true)
      audio.onerror = () => resolve(false)
      void audio.play().catch(() => resolve(false))
      stopCurrent = () => resolve(false)
    })
    URL.revokeObjectURL(url)
    if (!finished || id !== run) return false
  }
  return true
}

/** The browser's own speech: sentence by sentence, with word positions from boundary events. */
function speakDevice(sentences: string[], id: number, offset = 0): Promise<boolean> {
  if (!('speechSynthesis' in window)) return Promise.resolve(false)
  const { voiceURI, rate } = settingsStore.get()
  const voices = speechSynthesis.getVoices()
  const voice =
    voices.find((v) => v.voiceURI === voiceURI) ?? voices.find((v) => v.lang === 'en-IN') ?? voices.find((v) => v.lang.startsWith('en') && v.localService)
  return new Promise((resolve) => {
    sentences.forEach((sentence, i) => {
      const u = new SpeechSynthesisUtterance(sentence)
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? 'en-IN'
      u.rate = rate
      u.onstart = () => id === run && patchNow({ sentence: offset + i, word: 0 })
      u.onboundary = (e) => {
        if (id === run && e.name === 'word') patchNow({ word: sentence.slice(0, e.charIndex).split(/\s+/).length - 1 })
      }
      if (i === sentences.length - 1) u.onend = () => resolve(id === run)
      u.onerror = () => resolve(false)
      speechSynthesis.speak(u)
    })
    stopCurrent = () => resolve(false)
  })
}

let stopCurrent: (() => void) | null = null

export function stopSpeaking() {
  run++
  stopCurrent?.()
  stopCurrent = null
  if ('speechSynthesis' in window) speechSynthesis.cancel()
  if (player) {
    player.pause()
    player.removeAttribute('src')
  }
  patchNow({ speaking: false, paused: false })
}

export function pauseSpeaking() {
  if (player && !player.paused) player.pause()
  if ('speechSynthesis' in window) speechSynthesis.pause()
  patchNow({ paused: true })
}

export function resumeSpeaking() {
  if (player?.src) void player.play()
  if ('speechSynthesis' in window) speechSynthesis.resume()
  patchNow({ paused: false })
}

// ─── Lock screen (Media Session) ─────────────────────────────────────────

function metadata(title: string, line: string) {
  return new MediaMetadata({
    title: line.length > 80 ? `${line.slice(0, 77)}…` : line,
    artist: title,
    album: 'Structura voice guide',
    artwork: [{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' }],
  })
}

function mediaSession(title: string, line: string) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = metadata(title, line)
  navigator.mediaSession.setActionHandler('pause', pauseSpeaking)
  navigator.mediaSession.setActionHandler('play', resumeSpeaking)
  navigator.mediaSession.setActionHandler('stop', stopSpeaking)
}
