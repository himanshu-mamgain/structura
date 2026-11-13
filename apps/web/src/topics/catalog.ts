import data from './catalog.json'
import type { StaticTopic } from './types'

/**
 * What the app knows about a topic before it's opened (scripts/export-catalog.ts writes
 * catalog.json from the topics). Every full topic also fits this shape, so anything that
 * takes a TopicMeta takes a loaded topic too.
 */
export interface TopicMeta {
  id: string
  title: string
  blurb: string
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced'
  video?: string
  chapters?: [number, string][]
  guides?: string[]
  explanation: { summary: string; sections: { heading: string }[]; trace?: unknown }
  /** Truthy when the topic has one; the real thing loads with the topic. */
  simulator?: unknown
  loadTest?: unknown
  story?: unknown
}

export const TOPICS = data as unknown as TopicMeta[]

/** A video's cover image, and the small copy (300px wide) for tiles and cards. */
export const cover = (video: string) => video.replace(/\.mp4$/, '.jpg')
export const smallCover = (video: string) => video.replace(/\.mp4$/, '-sm.jpg')

/** If a small cover is missing (a video made before they existed), fall back to the full one. */
export function fullCoverOnError(e: { currentTarget: HTMLImageElement }) {
  const img = e.currentTarget
  if (img.src.endsWith('-sm.jpg')) img.src = img.src.replace(/-sm\.jpg$/, '.jpg')
}

export const topicMeta = (id: string | null | undefined): TopicMeta | undefined => TOPICS.find((t) => t.id === id)

// Every full topic, in one chunk that loads on first use (and is precached for offline).
let registry: Promise<StaticTopic[]> | null = null
export function loadTopics(): Promise<StaticTopic[]> {
  registry ??= import('./index').then((m) => m.STATIC_TOPICS)
  return registry
}

export const loadTopic = async (id: string): Promise<StaticTopic | null> => (await loadTopics()).find((t) => t.id === id) ?? null
