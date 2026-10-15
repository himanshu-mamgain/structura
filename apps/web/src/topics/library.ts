import data from './library.json'
import { STATIC_TOPICS, type StaticTopic } from '.'

// The syllabus: ByteByteGo's System Design 101 guide list (titles, categories,
// tags and links only; see scripts/kb-sync.mjs). Structura's topics are its own
// writing and link back to the related guides.

export interface Guide {
  slug: string
  title: string
  categories: string[]
  tags: string[]
}

export const LIBRARY = data as { source: { name: string; repo: string; guideUrl: string; license: string }; categories: { id: string; title: string; sort: number }[]; guides: Guide[] }

export const guideUrl = (slug: string) => LIBRARY.source.guideUrl.replace('{slug}', encodeURIComponent(slug))

const bySlug = new Map(LIBRARY.guides.map((g) => [g.slug, g]))

/** The library guides a topic links to for going deeper. */
export const guidesFor = (topic: StaticTopic): Guide[] => (topic.guides ?? []).map((s) => bySlug.get(s)).filter((g): g is Guide => Boolean(g))

/** The Structura topic that covers a guide, if any. */
export const topicForGuide = (slug: string): StaticTopic | undefined => STATIC_TOPICS.find((t) => t.guides?.includes(slug))

export const categoryTitle = (id: string) => LIBRARY.categories.find((c) => c.id === id)?.title ?? id
