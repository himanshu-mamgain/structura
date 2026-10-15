import { useSyncExternalStore } from 'react'
import type { StaticTopic } from '../topics'

// Learning progress, kept in this browser (localStorage). One small object per
// topic; the shape is plain JSON so it can later sync to a backend as-is.

export interface TopicProgress {
  bookmarked?: boolean
  completed?: boolean
  /** Explanation sections the learner has opened (by index). */
  sectionsRead?: number[]
  /** Finished the walkthrough to its last step. */
  walked?: boolean
  videoTime?: number
  videoDuration?: number
  lastWatchedAt?: number
  lastOpenedAt?: number
}

export interface Progress {
  topics: Record<string, TopicProgress>
  quizBest?: number
}

const KEY = 'structura:progress:v1'

function load(): Progress {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Progress | null
    return saved?.topics ? saved : { topics: {} }
  } catch {
    return { topics: {} }
  }
}

let state = load()
const listeners = new Set<() => void>()

function save(next: Progress) {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: progress just isn't remembered.
  }
  listeners.forEach((l) => l())
}

export function updateTopic(id: string, patch: Partial<TopicProgress> | ((p: TopicProgress) => Partial<TopicProgress>)) {
  const current = state.topics[id] ?? {}
  const change = typeof patch === 'function' ? patch(current) : patch
  save({ ...state, topics: { ...state.topics, [id]: { ...current, ...change } } })
}

export function recordQuiz(score: number) {
  if (score > (state.quizBest ?? -1)) save({ ...state, quizBest: score })
}

// Other tabs update us too.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) {
    state = load()
    listeners.forEach((l) => l())
  }
})

export function useProgress(): Progress {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  )
}

/** Fraction of the video watched, 0 to 1. */
export const videoFraction = (p: TopicProgress | undefined) => (p?.videoDuration ? Math.min(1, (p.videoTime ?? 0) / p.videoDuration) : 0)

/**
 * Interview readiness for a topic, 0 to 100: the explanation read (40), the
 * walkthrough done (20), the video watched (20; its share goes to reading when
 * a topic has no video), and the topic marked complete (20).
 */
export function readiness(topic: StaticTopic, p: TopicProgress | undefined): number {
  if (!p) return 0
  const sections = topic.explanation.sections.length || 1
  const read = (p.sectionsRead?.length ?? 0) / sections
  const hasVideo = Boolean(topic.video)
  const watched = videoFraction(p) >= 0.9 ? 1 : videoFraction(p)
  const score = read * (hasVideo ? 40 : 60) + (p.walked ? 20 : 0) + (hasVideo ? watched * 20 : 0) + (p.completed ? 20 : 0)
  return Math.round(Math.min(100, score))
}

/** "3 min ago", "2 h ago", "yesterday", "12 Oct". */
export function ago(time: number | undefined): string {
  if (!time) return ''
  const s = (Date.now() - time) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 172800) return 'yesterday'
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
