import { useState } from 'react'
import { ExternalLink, Search as SearchIcon, X } from 'lucide-react'
import { STATIC_TOPICS, type StaticTopic } from '../topics'
import { categoryTitle, LIBRARY } from '../topics/library'
import { topicIcon } from './topicIcons'

// Search over the interactive topics and the library's guides. Explore shows
// the results in the page; the desktop app bar shows them in a dropdown.

export function search(query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return { topics: [], guides: [] }
  return {
    topics: STATIC_TOPICS.filter((t) => `${t.title} ${t.blurb} ${t.difficulty}`.toLowerCase().includes(q)),
    guides: LIBRARY.guides.filter((g) => `${g.title} ${g.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 8),
  }
}

function Results({ query, onOpen, onDone }: { query: string; onOpen: (t: StaticTopic) => void; onDone: () => void }) {
  const { topics, guides } = search(query)
  if (!topics.length && !guides.length) return null
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
      {guides.map((g) => (
        <li key={g.slug}>
          <a href={g.url} target="_blank" rel="noreferrer" onClick={onDone}>
            <span className="search-result-icon is-guide" aria-hidden>
              <ExternalLink size={16} />
            </span>
            <span className="search-result-text">
              <strong>{g.title}</strong>
              <span>Guide · {g.categories.map(categoryTitle).join(', ')}</span>
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
  inline = false,
  query: controlled,
  onQuery,
  className = '',
}: {
  onOpen: (t: StaticTopic) => void
  inline?: boolean
  query?: string
  onQuery?: (q: string) => void
  className?: string
}) {
  const [own, setOwn] = useState('')
  const query = controlled ?? own
  const setQuery = onQuery ?? setOwn
  const first = search(query).topics[0]
  const pick = (t: StaticTopic) => {
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
      <Results query={query} onOpen={pick} onDone={() => setQuery('')} />
    </div>
  )
}
