import data from './library.json'
import type { StaticTopic } from './types'

// The syllabus, from several open sources (see scripts/kb-sync.mjs): ByteByteGo's
// System Design 101 (titles and links only), the System Design Primer (CC BY,
// which topics may be adapted from), and community diagrams (linked only).

export interface Guide {
  slug: string
  title: string
  categories: string[]
  tags: string[]
  source: string
  url: string
}

export interface Source {
  name: string
  repo: string
  license: string
}

export const LIBRARY = data as {
  sources: Record<string, Source>
  categories: { id: string; title: string; sort: number; source: string }[]
  guides: Guide[]
}

const bySlug = new Map(LIBRARY.guides.map((g) => [g.slug, g]))

export const guideUrl = (slug: string) => bySlug.get(slug)?.url ?? '#'

export const sourceOf = (guide: Guide): Source => LIBRARY.sources[guide.source]

/** The library guides a topic links to for going deeper. */
export const guidesFor = (topic: StaticTopic): Guide[] => (topic.guides ?? []).map((s) => bySlug.get(s)).filter((g): g is Guide => Boolean(g))

/** The Structura topic (of those given) that covers a guide, if any. */
export const topicForGuide = (topics: StaticTopic[], slug: string): StaticTopic | undefined => topics.find((t) => t.guides?.includes(slug))

export const categoryTitle = (id: string) => LIBRARY.categories.find((c) => c.id === id)?.title ?? id
