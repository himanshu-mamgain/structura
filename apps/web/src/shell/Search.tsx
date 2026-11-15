import { useEffect, useRef, useState } from 'react'
import { BookOpen, ExternalLink, NotebookPen, Route, Search as SearchIcon, X } from 'lucide-react'
import { useNotes } from '../learn/notes'
import { ROADMAP, type RoadmapPart } from '../learn/roadmap'
import { AREA_OF, areaById } from '../topics/areas'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import { useLibrary } from '../topics/useLibrary'
import { searchNotes } from './Notes'
import { topicIcon } from './topicIcons'

// Search over the roadmap's modules, the interactive topics, the owner's Notion notes and the library's
// guides. Explore shows the results in the page; the desktop app bar shows them in a dropdown.

const topicTitle = new Map(TOPICS.map((t) => [t.id, t.title]))

/** A roadmap module's words: its title and why, and every step with the topic it opens. */
const partText = new Map(
  ROADMAP.map((p) => [
    p.id,
    [p.title, p.why, ...p.steps.flatMap((s) => [s.title, s.detail, s.topic ? `${s.topic.replace(/-/g, ' ')} ${topicTitle.get(s.topic) ?? ''}` : ''])]
      .join(' ')
      .toLowerCase(),
  ]),
)

/** The module each topic is a step of, so "aws" also finds AWS topics whose titles don't say it (the ALB, ECS). */
const moduleOf = new Map<string, string>()
/** Each topic's place in the roadmap, so results come in learning order: basics first. */
const rankOf = new Map<string, number>()
for (const p of ROADMAP)
  for (const s of p.steps)
    if (s.topic && !moduleOf.has(s.topic)) {
      moduleOf.set(s.topic, p.title)
      rankOf.set(s.topic, rankOf.size)
    }
const rank = (id: string) => rankOf.get(id) ?? Number.MAX_SAFE_INTEGER

export function search(query: string, library?: ReturnType<typeof useLibrary>) {
  const q = query.trim().toLowerCase()
  if (!q) return { parts: [] as RoadmapPart[], topics: [], guides: [] }
  return {
    // The roadmap's modules first, in learning order: "aws" finds AWS basics → building blocks → shipping.
    parts: ROADMAP.filter((p) => partText.get(p.id)?.includes(q)).slice(0, 5),
    // An area's name finds its topics too ("infra", "databases", "ai"), and so does the module a topic is in.
    topics: TOPICS.filter((t) =>
      `${t.title} ${t.blurb} ${t.difficulty} ${AREA_OF[t.id] ? areaById(AREA_OF[t.id]).title : ''} ${t.id.replace(/-/g, ' ')} ${moduleOf.get(t.id) ?? ''}`
        .toLowerCase()
        .includes(q),
    ).sort((a, b) => rank(a.id) - rank(b.id)),
    // Guides join the results as soon as the library has loaded.
    guides: library ? library.LIBRARY.guides.filter((g) => `${g.title} ${g.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 8) : [],
  }
}

function Results({
  query,
  onOpen,
  onRead,
  onNote,
  onPart,
  onDone,
}: {
  query: string
  onOpen: (t: TopicMeta) => void
  onRead?: (t: TopicMeta) => void
  onNote?: (id: string) => void
  onPart?: (id: string) => void
  onDone: () => void
}) {
  // Only load the library once there is something to search for.
  const library = useLibrary(Boolean(query.trim()))
  const found = search(query, library)
  const { topics, guides } = found
  const parts = onPart ? found.parts : []
  const notesState = useNotes()
  const notes = onNote && notesState.status === 'ready' ? searchNotes(notesState.index, query) : []
  if (!parts.length && !topics.length && !guides.length && !notes.length) return null
  return (
    <ul className="search-results">
      {/* Where to learn it, in order: the roadmap's modules come first. */}
      {parts.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => {
              onDone()
              onPart?.(p.id)
            }}
          >
            <span className="search-result-icon is-roadmap" aria-hidden>
              <Route size={17} />
            </span>
            <span className="search-result-text">
              <strong>{p.title}</strong>
              <span>
                Roadmap · {p.area ? `${areaById(p.area).title} · ${p.stage}` : 'Final project'} · {p.steps.length} steps
              </span>
            </span>
          </button>
        </li>
      ))}
      {topics.map((t) => {
        const Icon = topicIcon(t.id)
        return (
          <li key={t.id} className={onRead ? 'search-topic' : undefined}>
            <button type="button" onClick={() => onOpen(t)}>
              <span className="search-result-icon" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="search-result-text">
                <strong>{t.title}</strong>
                <span>
                  {AREA_OF[t.id] ? areaById(AREA_OF[t.id]).title : 'Topic'} · {t.difficulty} · {t.blurb}
                </span>
              </span>
            </button>
            {/* Straight to the article, for when you'd rather read than click through the diagram. */}
            {onRead && (
              <button type="button" className="search-read" onClick={() => onRead(t)} aria-label={`Read ${t.title}`}>
                <BookOpen size={15} aria-hidden /> Read
              </button>
            )}
          </li>
        )
      })}
      {notes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => {
              onDone()
              onNote?.(n.id)
            }}
          >
            <span className="search-result-icon is-note" aria-hidden>
              {n.icon && !/^https?:/.test(n.icon) ? n.icon : <NotebookPen size={16} />}
            </span>
            <span className="search-result-text">
              <strong>{n.title}</strong>
              <span>Your note{n.summary ? ` · ${n.summary}` : ''}</span>
            </span>
          </button>
        </li>
      ))}
      {guides.map((g) => (
        <li key={g.slug}>
          <a href={g.url} target="_blank" rel="noreferrer" onClick={onDone}>
            <span className="search-result-icon is-guide" aria-hidden>
              <ExternalLink size={16} />
            </span>
            <span className="search-result-text">
              <strong>{g.title}</strong>
              <span>Guide · {g.categories.map(library!.categoryTitle).join(', ')}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

// Set by the app bar's search button just before it opens Explore, so Explore's field
// takes the focus once, when it appears.
let focusOnMount = false
export function focusSearchNext() {
  focusOnMount = true
}

/**
 * The search field. `inline` (Explore) lists results under it in the page;
 * otherwise (the desktop app bar) they drop down over the content.
 */
export function SearchBox({
  onOpen,
  onRead,
  onNote,
  onPart,
  inline = false,
  query: controlled,
  onQuery,
  className = '',
}: {
  onOpen: (t: TopicMeta) => void
  onRead?: (t: TopicMeta) => void
  onNote?: (id: string) => void
  /** Opens a roadmap module; without it, modules aren't listed. */
  onPart?: (id: string) => void
  inline?: boolean
  query?: string
  onQuery?: (q: string) => void
  className?: string
}) {
  const [own, setOwn] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inline && focusOnMount) {
      focusOnMount = false
      input.current?.focus()
    }
  }, [inline])
  const query = controlled ?? own
  const setQuery = onQuery ?? setOwn
  const first = search(query).topics[0]
  const pick = (t: TopicMeta) => {
    setQuery('')
    onOpen(t)
  }
  const read = onRead
    ? (t: TopicMeta) => {
        setQuery('')
        onRead(t)
      }
    : undefined

  return (
    <div className={`search${inline ? ' is-inline' : ''} ${className}`}>
      <div className="search-field">
        <SearchIcon size={17} aria-hidden />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) pick(first)
            if (e.key === 'Escape') setQuery('')
          }}
          placeholder={inline ? 'Search topics, roadmap and guides' : 'Search… (AWS, Redis, Kafka)'}
          aria-label="Search topics, roadmap and guides"
        />
        {query && (
          <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <X size={16} />
          </button>
        )}
      </div>
      <Results query={query} onOpen={pick} onRead={read} onNote={onNote} onPart={onPart} onDone={() => setQuery('')} />
    </div>
  )
}
