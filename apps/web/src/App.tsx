import { useEffect, useState } from 'react'
import { BookMarked, Boxes, ExternalLink, Footprints, House, Library, Menu, Search, Video, X, Zap } from 'lucide-react'
import { board } from './board/store'
import { InstallButton } from './pwa/InstallButton'
import { TopicView } from './shell/TopicView'
import { topicIcon } from './shell/topicIcons'
import { STATIC_TOPICS, type StaticTopic } from './topics'
import { categoryTitle, guideUrl, LIBRARY, topicForGuide } from './topics/library'

/** The open topic lives in the URL (?topic=url-shortener), so links can be shared. */
function readTopic(): string | null {
  return new URLSearchParams(window.location.search).get('topic')
}

/** A library category filter on Home: ?library=caching-performance. */
function readCategory(): string | null {
  return new URLSearchParams(window.location.search).get('library')
}

export default function App() {
  const [topicId, setTopicId] = useState(readTopic)
  const [category, setCategory] = useState(readCategory)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const topic = STATIC_TOPICS.find((t) => t.id === topicId) ?? null
  // ?topic=…&load opens the topic with its load test running.
  const [openLoad] = useState(() => new URLSearchParams(window.location.search).has('load'))

  useEffect(() => {
    const onPop = () => {
      setTopicId(readTopic())
      setCategory(readCategory())
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function navigate(search: string) {
    const url = new URL(window.location.href)
    url.search = search
    window.history.pushState(null, '', url)
    setTopicId(readTopic())
    setCategory(readCategory())
    setMenuOpen(false)
    setQuery('')
  }

  function open(next: StaticTopic | null) {
    navigate(next ? `?topic=${next.id}` : '')
    window.scrollTo({ top: 0 })
  }

  function openCategory(id: string | null) {
    navigate(id ? `?library=${id}` : '')
    requestAnimationFrame(() => document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' }))
  }

  const q = query.trim().toLowerCase()
  const matches = q ? STATIC_TOPICS.filter((t) => `${t.title} ${t.blurb}`.toLowerCase().includes(q)) : []
  const guideMatches = q ? LIBRARY.guides.filter((g) => `${g.title} ${g.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 8) : []

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Boxes size={22} />
          </span>
          <span>
            <strong>Structura</strong>
            <small>System design, visualised</small>
          </span>
          <button type="button" className="icon-btn sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>
        <nav>
          <button type="button" className={`nav-item${topic || category ? '' : ' is-active'}`} onClick={() => open(null)}>
            <House size={18} /> Home
          </button>
          <p className="nav-group">System design</p>
          {STATIC_TOPICS.map((t) => {
            const Icon = topicIcon(t.id)
            return (
              <button key={t.id} type="button" className={`nav-item${t.id === topic?.id ? ' is-active' : ''}`} onClick={() => open(t)}>
                <Icon size={18} /> {t.title}
              </button>
            )
          })}
          <p className="nav-group">Library</p>
          {LIBRARY.categories.map((c) => (
            <button key={c.id} type="button" className={`nav-item is-small${!topic && category === c.id ? ' is-active' : ''}`} onClick={() => openCategory(c.id)}>
              <BookMarked size={16} /> {c.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <InstallButton />
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

      <div className="main">
        <header className="appbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="search">
            <Search size={17} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && matches[0] && open(matches[0])}
              placeholder="Search topics and guides… (Redis, Kafka, OAuth)"
              aria-label="Search topics and guides"
            />
            {(matches.length > 0 || guideMatches.length > 0) && (
              <ul className="search-results">
                {matches.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => open(t)}>
                      <strong>{t.title}</strong>
                      <span>Interactive topic · {t.blurb}</span>
                    </button>
                  </li>
                ))}
                {guideMatches.map((g) => (
                  <li key={g.slug}>
                    <a href={guideUrl(g.slug)} target="_blank" rel="noreferrer" onClick={() => setQuery('')}>
                      <strong>
                        {g.title} <ExternalLink size={12} aria-hidden />
                      </strong>
                      <span>Guide · {g.categories.map(categoryTitle).join(', ')}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </header>

        <main className="content">
          {topic ? (
            <TopicView key={topic.id} topic={topic} board={board} openLoad={openLoad} />
          ) : (
            <Home onOpen={open} category={category} onCategory={openCategory} />
          )}
        </main>
      </div>
    </div>
  )
}

function Home({ onOpen, category, onCategory }: { onOpen: (topic: StaticTopic) => void; category: string | null; onCategory: (id: string | null) => void }) {
  return (
    <div className="home">
      <section className="hero">
        <h1>Learn system design by seeing it</h1>
        <p>Each topic has a diagram you can walk through step by step, a 3D city you can put load on, a narrated video, code and the key takeaways.</p>
      </section>
      <div className="topic-cards">
        {STATIC_TOPICS.map((t) => {
          const Icon = topicIcon(t.id)
          return (
            <button key={t.id} type="button" className="card topic-card" onClick={() => onOpen(t)}>
              <span className="topic-icon" aria-hidden>
                <Icon size={24} />
              </span>
              <strong>{t.title}</strong>
              <span className="topic-card-blurb">{t.blurb}</span>
              <span className="chips">
                {t.video && (
                  <span>
                    <Video size={13} /> Video
                  </span>
                )}
                {t.explanation.trace && (
                  <span>
                    <Footprints size={13} /> Walkthrough
                  </span>
                )}
                {t.loadTest && (
                  <span>
                    <Zap size={13} /> Load test
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      <LibraryList category={category} onCategory={onCategory} onOpen={onOpen} />
    </div>
  )
}

/** The whole syllabus: every guide title, filterable by category, linking to the original. */
function LibraryList({ category, onCategory, onOpen }: { category: string | null; onCategory: (id: string | null) => void; onOpen: (topic: StaticTopic) => void }) {
  const [limit, setLimit] = useState(60)
  const guides = category ? LIBRARY.guides.filter((g) => g.categories.includes(category)) : LIBRARY.guides
  return (
    <section className="library" id="library" aria-label="Library">
      <header className="library-head">
        <h2>
          <Library size={20} /> Library
        </h2>
        <p>
          {LIBRARY.guides.length} guides from{' '}
          <a href={LIBRARY.source.repo} target="_blank" rel="noreferrer">
            {LIBRARY.source.name}
          </a>
          , our syllabus. Titles link to the originals; the ones marked Interactive are already Structura topics.
        </p>
      </header>
      <div className="library-cats">
        <button type="button" aria-pressed={!category} onClick={() => onCategory(null)}>
          All
        </button>
        {LIBRARY.categories.map((c) => (
          <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => onCategory(c.id)}>
            {c.title}
          </button>
        ))}
      </div>
      <ul className="guides">
        {guides.slice(0, limit).map((g) => {
          const covered = topicForGuide(g.slug)
          return (
            <li key={g.slug} className="guide">
              <a href={guideUrl(g.slug)} target="_blank" rel="noreferrer">
                {g.title} <ExternalLink size={13} aria-hidden />
              </a>
              <span className="guide-tags">{g.tags.slice(0, 3).join(' · ')}</span>
              {covered && (
                <button type="button" className="guide-interactive" onClick={() => onOpen(covered)}>
                  Interactive: {covered.title}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {guides.length > limit && (
        <button type="button" className="btn btn-ghost library-more" onClick={() => setLimit(limit + 90)}>
          Show more ({guides.length - limit} left)
        </button>
      )}
      <p className="library-note">{LIBRARY.source.license}</p>
    </section>
  )
}
