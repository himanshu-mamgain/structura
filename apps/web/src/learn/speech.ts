import { useEffect, useState, useSyncExternalStore } from 'react'

// The voice guide's speech: the browser's own text-to-speech (Web Speech API).
// No AI and no network: it speaks the topic's written content with a voice
// installed on the device. Settings (voice, speed) are remembered per device.

export interface SpeechSettings {
  voiceURI: string | null
  rate: number
}

const KEY = 'structura:speech:v1'

function load(): SpeechSettings {
  try {
    return { voiceURI: null, rate: 1, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { voiceURI: null, rate: 1 }
  }
}

let settings = load()
const listeners = new Set<() => void>()

export function setSpeechSettings(patch: Partial<SpeechSettings>) {
  settings = { ...settings, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Not remembered; still applies now.
  }
  listeners.forEach((l) => l())
}

export function useSpeechSettings(): SpeechSettings {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => settings,
  )
}

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

/** English and Hindi voices on this device, Indian ones first. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (speechSupported ? speechSynthesis.getVoices() : []))
  useEffect(() => {
    if (!speechSupported) return
    const update = () => setVoices(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', update)
    update()
    return () => speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  const rank = (v: SpeechSynthesisVoice) => (v.lang === 'en-IN' ? 0 : v.lang === 'hi-IN' ? 1 : v.lang.startsWith('en') ? 2 : 3)
  return voices.filter((v) => /^(en|hi)/i.test(v.lang)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices()
  return (
    voices.find((v) => v.voiceURI === settings.voiceURI) ??
    voices.find((v) => v.lang === 'en-IN') ??
    voices.find((v) => v.lang.startsWith('en') && v.localService) ??
    voices.find((v) => v.lang.startsWith('en'))
  )
}

/** Text the way it should be heard: bullets and symbols read naturally. */
function speakable(text: string): string {
  return text
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/→/g, ' to ')
    .replace(/≈/g, ' about ')
    .replace(/\bvs\b\.?/gi, 'versus')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/[`*_#]/g, '')
}

/** Splits into sentences: long utterances get cut off on some browsers. */
function sentences(text: string): string[] {
  return speakable(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

let run = 0

/**
 * Speaks `text`, replacing anything already being said. Resolves true when it
 * finished, false if it was stopped or replaced first.
 */
export function speak(text: string): Promise<boolean> {
  if (!speechSupported) return Promise.resolve(false)
  speechSynthesis.cancel()
  const id = ++run
  const parts = sentences(text)
  const voice = pickVoice()
  return new Promise((resolve) => {
    if (!parts.length) return resolve(true)
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part)
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? 'en-IN'
      u.rate = settings.rate
      if (i === parts.length - 1) u.onend = () => resolve(id === run)
      u.onerror = () => resolve(false)
      speechSynthesis.speak(u)
    })
  })
}

export function stopSpeaking() {
  run++
  if (speechSupported) speechSynthesis.cancel()
}
