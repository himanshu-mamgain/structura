import { useState } from 'react'
import { STATIC_TOPICS, type StaticTopic } from '.'

/** Picks a learning topic. Each one opens on its own page in 3D. */
export function TopicsPanel({ onPick, onClose }: { onPick: (topic: StaticTopic) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const topics = STATIC_TOPICS.filter((topic) =>
    `${topic.title} ${topic.blurb}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <aside className="explain topics" aria-label="Learning topics">
      <header className="explain-header">
        <h2>Learn a topic</h2>
        <button type="button" className="assistant-icon-btn" onClick={onClose} aria-label="Close topics">
          ×
        </button>
      </header>
      <div className="topics-search">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search topics…" aria-label="Search topics" autoFocus />
      </div>
      <div className="explain-scroll">
        <ul className="topic-list">
          {topics.map((topic) => (
            <li key={topic.id}>
              <button type="button" className="topic" onClick={() => onPick(topic)}>
                <span className="topic-title">{topic.title}</span>
                <span className="topic-blurb">{topic.blurb}</span>
              </button>
            </li>
          ))}
        </ul>
        {!topics.length && <p className="topics-note">No topic matches “{query.trim()}” yet.</p>}
      </div>
    </aside>
  )
}
