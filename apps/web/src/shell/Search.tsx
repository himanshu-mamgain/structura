import { useState } from 'react'
import { ExternalLink, NotebookPen, Search as SearchIcon, X } from 'lucide-react'
import { useNotes } from '../learn/notes'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import { useLibrary } from '../topics/useLibrary'
import { searchNotes } from './Notes'
import { topicIcon } from './topicIcons'

// Search over the interactive topics, the owner's Notion notes and the library's guides. Explore shows
// the results in the page; the desktop app bar shows them in a dropdown.

export function search(query: string, library?: ReturnType<typeof useLibrary>) {
  const q = query.trim().toLowerCase()
  if (!q) return { topics: [], guides: [] }
  return {
    topics: TOPICS.filter((t) => `${t.title} ${t.blurb} ${t.difficulty}`.toLowerCase().includes(q)),
    // Guides join the results as soon as the library has loaded.
    guides: library ? library.LIBRARY.guides.filter((g) => `${g.title} ${g.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 8) : [],
  }
}

function Results({ query, onOpen, onNote, onDone }: { query: string; onOpen: (t: TopicMeta) => void; onNote?: (id: string) => void; onDone: () => void }) {
  // Only load the library once there is something to search for.
  const library = useLibrary(Boolean(query.trim()))
  const { topics, guides } = search(query, library)
  const notesState = useNotes()
  const notes = onNote && notesState.status === 'ready' ? searchNotes(notesState.index, query) : []
  if (!topics.length && !guides.length && !notes.length) return null
  return (
    <ul className="search-results">
      {topics.map((t) => {
        const Icon = topicIcon(t.id)
        return (
          <li key={t.id}>
            <button type="button" onClick={() => onOpen(t)}>
              <span className="search-result-icon" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="search-result-text">
                <strong>{t.title}</strong>
                <span>
                  Interactive topic · {t.difficulty} · {t.blurb}
                </span>
              </span>
            </button>
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

/**
 * The search field. `inline` (Explore) lists results under it in the page;
 * otherwise (the desktop app bar) they drop down over the content.
 */
export function SearchBox({
  onOpen,
  onNote,
  inline = false,
  query: controlled,
  onQuery,
  className = '',
}: {
  onOpen: (t: TopicMeta) => void
  onNote?: (id: string) => void
  inline?: boolean
  query?: string
  onQuery?: (q: string) => void
  className?: string
}) {
  const [own, setOwn] = useState('')
  const query = controlled ?? own
  const setQuery = onQuery ?? setOwn
  const first = search(query).topics[0]
  const pick = (t: TopicMeta) => {
    setQuery('')
    onOpen(t)
  }

  return (
    <div className={`search${inline ? ' is-inline' : ''} ${className}`}>
      <div className="search-field">
        <SearchIcon size={17} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) pick(first)
            if (e.key === 'Escape') setQuery('')
          }}
          placeholder={inline ? 'Search topics and guides' : 'Search… (Redis, Kafka, OAuth)'}
          aria-label="Search topics and guides"
        />
        {query && (
          <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <X size={16} />
          </button>
        )}
      </div>
      <Results query={query} onOpen={pick} onNote={onNote} onDone={() => setQuery('')} />
    </div>
  )
}
