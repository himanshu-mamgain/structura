import { useSyncExternalStore } from 'react'
import { STATIC_TOPICS } from '../topics'
import lessons from './lessons.json'
import { lessonChapters } from './lesson'
import { updateTopic } from './progress'
import { stopSpeaking } from './speech'

// Commute mode: the audio lessons (pre-recorded with Kokoro, see scripts/lessons.ts)
// played like a podcast. One <audio> element for the whole app, so playback
// continues while browsing, with the screen off, and from the lock screen and
// earphone buttons (Media Session). Lessons can be saved for offline listening.

export interface LessonChapterAudio {
  id: string
  title: string
  file: string
  duration: number
  cues: { t: number; text: string }[]
}

export const LESSONS = lessons as { voice: string; speed?: number; topics: Record<string, { chapters: LessonChapterAudio[]; duration: number }> }

/** Topics that have an audio lesson, in course order. */
export const lessonTopics = () => STATIC_TOPICS.filter((t) => LESSONS.topics[t.id])

export interface CommuteState {
  topicId: string | null
  chapter: number
  time: number
  duration: number
  playing: boolean
  rate: number
  /** When the sleep timer stops playback (ms timestamp), or 'chapter' for the end of this chapter. */
  sleep: number | 'chapter' | null
  saved: Record<string, boolean>
  saving: { topicId: string; done: number; total: number } | null
}

const KEY = 'structura:commute:v1'
const CACHE = 'structura-lessons'

function load(): Partial<CommuteState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

const saved = load()
let state: CommuteState = {
  topicId: saved.topicId && LESSONS.topics[saved.topicId] ? saved.topicId : null,
  chapter: saved.chapter ?? 0,
  time: saved.time ?? 0,
  duration: 0,
  playing: false,
  rate: saved.rate ?? 1,
  sleep: null,
  saved: {},
  saving: null,
}
const listeners = new Set<() => void>()

function set(patch: Partial<CommuteState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

let lastPersist = 0
function persist(force = false) {
  if (!force && Date.now() - lastPersist < 4000) return
  lastPersist = Date.now()
  try {
    localStorage.setItem(KEY, JSON.stringify({ topicId: state.topicId, chapter: state.chapter, time: state.time, rate: state.rate }))
  } catch {
    // Not remembered.
  }
}

export const useCommute = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  )

export const chaptersOf = (topicId: string | null) => (topicId ? (LESSONS.topics[topicId]?.chapters ?? []) : [])
const topicTitle = (id: string) => STATIC_TOPICS.find((t) => t.id === id)?.title ?? id

// ─── The player ──────────────────────────────────────────────────────────

let audio: HTMLAudioElement | null = null

function player(): HTMLAudioElement {
  if (audio) return audio
  audio = new Audio()
  audio.preload = 'auto'
  audio.addEventListener('timeupdate', () => {
    const a = audio!
    set({ time: a.currentTime, duration: a.duration || state.duration })
    persist()
    if (typeof state.sleep === 'number' && Date.now() >= state.sleep) {
      a.pause()
      set({ sleep: null })
    }
    if ('mediaSession' in navigator && a.duration) {
      try {
        navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate })
      } catch {
        // Some browsers reject position updates mid-load.
      }
    }
  })
  audio.addEventListener('play', () => set({ playing: true }))
  audio.addEventListener('pause', () => {
    set({ playing: false })
    persist(true)
  })
  audio.addEventListener('ended', () => {
    countAsHeard()
    if (state.sleep === 'chapter') {
      set({ sleep: null })
      return
    }
    next(true)
  })
  return audio
}

/** Listening counts toward interview readiness, like reading and walking through. */
function countAsHeard() {
  const topic = STATIC_TOPICS.find((t) => t.id === state.topicId)
  const chapter = chaptersOf(state.topicId)[state.chapter]
  if (!topic || !chapter) return
  if (chapter.id === 'walkthrough') updateTopic(topic.id, { walked: true })
  const section = topic.explanation.sections.findIndex((s) => s.heading === chapter.title)
  if (section >= 0) updateTopic(topic.id, (p) => ({ sectionsRead: [...new Set([...(p.sectionsRead ?? []), section])] }))
  if (chapter.id === 'practice') updateTopic(topic.id, { completed: true })
}

function load_(topicId: string, chapter: number, time = 0, autoplay = true) {
  const chapters = chaptersOf(topicId)
  const c = chapters[chapter]
  if (!c) return
  const a = player()
  a.src = c.file
  a.playbackRate = state.rate
  a.currentTime = time
  set({ topicId, chapter, time, duration: c.duration })
  persist(true)
  mediaSession()
  if (autoplay) {
    stopSpeaking()
    void a.play().catch(() => set({ playing: false }))
  }
}

/** Plays a topic's lesson from a chapter (resuming where it left off if it's the current one). */
export function playTopic(topicId: string, chapter = 0) {
  if (topicId === state.topicId && chapter === state.chapter && audio?.src) return toggle(true)
  load_(topicId, chapter)
}

export function toggle(forcePlay?: boolean) {
  if (!state.topicId) {
    const first = lessonTopics()[0]
    if (first) load_(first.id, 0)
    return
  }
  const a = player()
  if (!a.src) return load_(state.topicId, state.chapter, state.time)
  if (forcePlay || a.paused) {
    stopSpeaking()
    a.playbackRate = state.rate
    void a.play()
  } else a.pause()
}

/** Next chapter, then the next topic's lesson. */
export function next(auto = false) {
  if (!state.topicId) return
  const chapters = chaptersOf(state.topicId)
  if (state.chapter < chapters.length - 1) return load_(state.topicId, state.chapter + 1)
  const order = lessonTopics()
  const following = order[order.findIndex((t) => t.id === state.topicId) + 1]
  if (following) load_(following.id, 0)
  else if (auto) set({ playing: false })
}

/** Back to the start of this chapter, or the previous one if it just started. */
export function previous() {
  if (!state.topicId) return
  const a = player()
  if (a.currentTime > 4 || state.chapter === 0) {
    a.currentTime = 0
    return
  }
  load_(state.topicId, state.chapter - 1)
}

export function seek(seconds: number) {
  const a = player()
  a.currentTime = Math.max(0, Math.min(seconds, a.duration || seconds))
  set({ time: a.currentTime })
}

export const skip = (delta: number) => seek((audio?.currentTime ?? state.time) + delta)

export function setRate(rate: number) {
  if (audio) audio.playbackRate = rate
  set({ rate })
  persist(true)
}

export function setSleep(minutes: number | 'chapter' | null) {
  set({ sleep: typeof minutes === 'number' ? Date.now() + minutes * 60_000 : minutes })
}

// The voice assistant is about to speak: pause the lesson so they don't talk over each other.
if (typeof window !== 'undefined') window.addEventListener('structura:voice-start', () => audio?.pause())

// ─── Lock screen and earphones ───────────────────────────────────────────

function mediaSession() {
  if (!('mediaSession' in navigator) || !state.topicId) return
  const chapter = chaptersOf(state.topicId)[state.chapter]
  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapter?.title ?? '',
    artist: topicTitle(state.topicId),
    album: 'Structura · Commute mode',
    artwork: [{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' }],
  })
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => toggle(true)],
    ['pause', () => audio?.pause()],
    ['previoustrack', previous],
    ['nexttrack', () => next()],
    ['seekbackward', (d) => skip(-(d.seekOffset ?? 15))],
    ['seekforward', (d) => skip(d.seekOffset ?? 30)],
    ['seekto', (d) => d.seekTime !== undefined && seek(d.seekTime)],
  ]
  for (const [action, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // Unsupported action on this browser.
    }
  }
}

// ─── Offline ─────────────────────────────────────────────────────────────

/** Which topics' lessons are saved for offline listening. */
export async function refreshSaved() {
  if (!('caches' in window)) return
  const cache = await caches.open(CACHE)
  const result: Record<string, boolean> = {}
  for (const [id, lesson] of Object.entries(LESSONS.topics)) {
    const hits = await Promise.all(lesson.chapters.map((c) => cache.match(c.file)))
    result[id] = hits.every(Boolean)
  }
  set({ saved: result })
}

/** Saves lessons for offline listening (whole files, so seeking works from the cache). */
export async function saveOffline(topicIds: string[]) {
  if (!('caches' in window)) return
  const cache = await caches.open(CACHE)
  for (const topicId of topicIds) {
    const files = chaptersOf(topicId).map((c) => c.file)
    set({ saving: { topicId, done: 0, total: files.length } })
    for (const [i, file] of files.entries()) {
      if (!(await cache.match(file))) {
        const res = await fetch(file)
        if (res.ok) await cache.put(file, res)
      }
      set({ saving: { topicId, done: i + 1, total: files.length } })
    }
  }
  set({ saving: null })
  await refreshSaved()
}

export async function removeOffline(topicId: string) {
  const cache = await caches.open(CACHE)
  await Promise.all(chaptersOf(topicId).map((c) => cache.delete(c.file)))
  await refreshSaved()
}

/** The cue (sentence) being spoken at a time in a chapter. */
export function cueAt(chapter: LessonChapterAudio | undefined, time: number): number {
  if (!chapter) return -1
  let i = -1
  for (const [k, cue] of chapter.cues.entries()) if (cue.t <= time + 0.05) i = k
  return i
}

/** Chapter titles for a topic as written (for topics without generated audio yet). */
export const plannedChapters = (topicId: string) => {
  const topic = STATIC_TOPICS.find((t) => t.id === topicId)
  return topic ? lessonChapters(topic).map((c) => c.title) : []
}
