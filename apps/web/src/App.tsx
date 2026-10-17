import { useEffect, useState } from 'react'
import { BookA, BookMarked, Bookmark, Boxes, CheckCircle2, ExternalLink, GraduationCap, Headphones, House, Menu, Search, X } from 'lucide-react'
import { board } from './board/store'
import { useProgress } from './learn/progress'
import { InstallButton } from './pwa/InstallButton'
import { Home } from './shell/Home'
import { Glossary, Quiz } from './shell/Practice'
import { Commute, MiniPlayer } from './shell/Commute'
import { TopicView } from './shell/TopicView'
import { VoiceAssistant } from './shell/VoiceAssistant'
import { topicIcon } from './shell/topicIcons'
import { STATIC_TOPICS, type StaticTopic } from './topics'
import { categoryTitle, LIBRARY } from './topics/library'

type Page = 'quiz' | 'glossary' | 'listen'

/** Where the learner is lives in the URL (?topic=…, ?page=quiz, ?library=…), so links can be shared. */
function readRoute() {
  const query = new URLSearchParams(window.location.search)
  const page = query.get('page')
  return { topicId: query.get('topic'), category: query.get('library'), page: page === 'quiz' || page === 'glossary' || page === 'listen' ? (page as Page) : null }
}

export default function App() {
  const [route, setRoute] = useState(readRoute)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const progress = useProgress()
  const topic = STATIC_TOPICS.find((t) => t.id === route.topicId) ?? null
  // ?topic=…&load opens the topic with its load test running.
  const [openLoad] = useState(() => new URLSearchParams(window.location.search).has('load'))

  useEffect(() => {
    const onPop = () => setRoute(readRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function navigate(search: string) {
    const url = new URL(window.location.href)
    url.search = search
    window.history.pushState(null, '', url)
    setRoute(readRoute())
    setMenuOpen(false)
    setQuery('')
  }

  function open(next: StaticTopic | null) {
    navigate(next ? `?topic=${next.id}` : '')
    window.scrollTo({ top: 0 })
  }

  function openPage(page: Page) {
    navigate(`?page=${page}`)
    window.scrollTo({ top: 0 })
  }

  function openCategory(id: string | null) {
    navigate(id ? `?library=${id}` : '')
    requestAnimationFrame(() => document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' }))
  }

  const q = query.trim().toLowerCase()
  const matches = q ? STATIC_TOPICS.filter((t) => `${t.title} ${t.blurb} ${t.difficulty}`.toLowerCase().includes(q)) : []
  const guideMatches = q ? LIBRARY.guides.filter((g) => `${g.title} ${g.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 8) : []
  const home = !topic && !route.page

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
          <button type="button" className={`nav-item${home && !route.category ? ' is-active' : ''}`} onClick={() => open(null)}>
            <House size={18} /> Home
          </button>
          <p className="nav-group">System design</p>
          {STATIC_TOPICS.map((t) => {
            const Icon = topicIcon(t.id)
            const tp = progress.topics[t.id]
            return (
              <button key={t.id} type="button" className={`nav-item${t.id === topic?.id ? ' is-active' : ''}`} onClick={() => open(t)}>
                <Icon size={18} /> <span className="nav-label">{t.title}</span>
                {tp?.completed ? <CheckCircle2 className="nav-flag is-done" size={15} aria-label="Completed" /> : tp?.bookmarked ? <Bookmark className="nav-flag" size={14} aria-label="Bookmarked" /> : null}
              </button>
            )
          })}
          <p className="nav-group">Practice</p>
          <button type="button" className={`nav-item${route.page === 'listen' ? ' is-active' : ''}`} onClick={() => openPage('listen')}>
            <Headphones size={18} /> Commute mode
          </button>
          <button type="button" className={`nav-item${route.page === 'quiz' ? ' is-active' : ''}`} onClick={() => openPage('quiz')}>
            <GraduationCap size={18} /> Quiz
          </button>
          <button type="button" className={`nav-item${route.page === 'glossary' ? ' is-active' : ''}`} onClick={() => openPage('glossary')}>
            <BookA size={18} /> Glossary
          </button>
          <p className="nav-group">Library</p>
          {LIBRARY.categories.map((c) => (
            <button key={c.id} type="button" className={`nav-item is-small${home && route.category === c.id ? ' is-active' : ''}`} onClick={() => openCategory(c.id)}>
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
                      <span>
                        Interactive topic · {t.difficulty} · {t.blurb}
                      </span>
                    </button>
                  </li>
                ))}
                {guideMatches.map((g) => (
                  <li key={g.slug}>
                    <a href={g.url} target="_blank" rel="noreferrer" onClick={() => setQuery('')}>
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
          ) : route.page === 'quiz' ? (
            <Quiz />
          ) : route.page === 'glossary' ? (
            <Glossary />
          ) : route.page === 'listen' ? (
            <Commute />
          ) : (
            <Home onOpen={open} onPage={openPage} category={route.category} onCategory={openCategory} />
          )}
        </main>
      </div>
      {route.page !== 'listen' && <MiniPlayer onOpen={() => openPage('listen')} />}
      <VoiceAssistant topic={topic} open={open} openPage={openPage} />
    </div>
  )
}
