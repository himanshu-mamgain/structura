import { useEffect, useState } from 'react'
import { BookA, Boxes, Clapperboard, GraduationCap, Headphones, House, Search, type LucideIcon } from 'lucide-react'
import { board } from './board/store'
import { InstallButton } from './pwa/InstallButton'
import { Explore } from './shell/Explore'
import { Home } from './shell/Home'
import { NotificationBell, useNotificationEngine } from './shell/Notifications'
import { Glossary, Quiz } from './shell/Practice'
import { Commute, MiniPlayer } from './shell/Commute'
import { Reels } from './shell/Reels'
import { SearchBox } from './shell/Search'
import { TopicView } from './shell/TopicView'
import { VoiceAssistant } from './shell/VoiceAssistant'
import { STATIC_TOPICS, type StaticTopic } from './topics'

type Page = 'quiz' | 'glossary' | 'listen' | 'explore' | 'reels'
const PAGES: Page[] = ['quiz', 'glossary', 'listen', 'explore', 'reels']

/** Where the learner is lives in the URL (?topic=…, ?page=reels&reel=…, ?library=…), so links can be shared. */
function readRoute() {
  const query = new URLSearchParams(window.location.search)
  const page = query.get('page') as Page | null
  const category = query.get('library')
  return {
    topicId: query.get('topic'),
    category,
    // The library lives in Explore, so its links open there.
    page: page && PAGES.includes(page) ? page : category ? 'explore' : null,
    reel: query.get('reel'),
  }
}

type Tab = 'home' | 'explore' | 'reels' | 'listen' | 'practice'

// The five tabs, like Instagram's: along the bottom on phones, in the top bar on desktop.
const TABS: [Tab, string, LucideIcon][] = [
  ['home', 'Home', House],
  ['explore', 'Explore', Search],
  ['reels', 'Reels', Clapperboard],
  ['listen', 'Listen', Headphones],
  ['practice', 'Practice', GraduationCap],
]

function Tabs({ current, onTab, className }: { current: Tab | null; onTab: (tab: Tab) => void; className: string }) {
  return (
    <nav className={className} aria-label="Sections">
      {TABS.map(([id, label, Icon]) => (
        <button key={id} type="button" className={`tab${current === id ? ' is-active' : ''}`} onClick={() => onTab(id)} aria-current={current === id ? 'page' : undefined}>
          <Icon size={24} strokeWidth={current === id ? 2.5 : 1.8} aria-hidden />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}

export default function App() {
  const [route, setRoute] = useState(readRoute)
  useNotificationEngine()
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
  }

  function open(next: StaticTopic | null) {
    navigate(next ? `?topic=${next.id}` : '')
    window.scrollTo({ top: 0 })
  }

  function openPage(page: Page) {
    navigate(`?page=${page}`)
    window.scrollTo({ top: 0 })
  }

  function openReel(id: string) {
    navigate(`?page=reels&reel=${id}`)
  }

  function openCategory(id: string | null) {
    navigate(id ? `?library=${id}` : '?page=explore')
    requestAnimationFrame(() => document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' }))
  }

  const tab: Tab | null = topic
    ? null
    : route.page === 'quiz' || route.page === 'glossary'
      ? 'practice'
      : route.page === 'explore' || route.page === 'reels' || route.page === 'listen'
        ? route.page
        : 'home'

  function onTab(next: Tab) {
    // Tapping the tab you're on goes back to its top, as on Instagram.
    if (next === tab && !route.category) return window.scrollTo({ top: 0, behavior: 'smooth' })
    if (next === 'home') open(null)
    else openPage(next === 'practice' ? 'quiz' : next)
  }

  const reels = !topic && route.page === 'reels'

  return (
    <div className={`shell${reels ? ' is-reels' : ''}`}>
      <div className="main">
        <header className="appbar">
          <button type="button" className="brand" onClick={() => open(null)} aria-label="Structura, home">
            <span className="brand-mark" aria-hidden>
              <Boxes size={20} />
            </span>
            <span className="brand-name">Structura</span>
          </button>
          <Tabs current={tab} onTab={onTab} className="appbar-tabs" />
          {/* Explore has its own, bigger search. */}
          {route.page !== 'explore' && <SearchBox onOpen={open} className="appbar-search" />}
          <InstallButton />
          <NotificationBell
            onOpen={(url) => {
              navigate(new URL(url, window.location.origin).search)
              window.scrollTo({ top: 0 })
            }}
          />
        </header>

        <main className="content">
          {topic ? (
            <TopicView key={topic.id} topic={topic} board={board} openLoad={openLoad} />
          ) : route.page === 'quiz' || route.page === 'glossary' ? (
            <>
              <div className="seg practice-switch" role="group" aria-label="Practice">
                <button type="button" aria-pressed={route.page === 'quiz'} onClick={() => openPage('quiz')}>
                  <GraduationCap size={16} /> Quiz
                </button>
                <button type="button" aria-pressed={route.page === 'glossary'} onClick={() => openPage('glossary')}>
                  <BookA size={16} /> Glossary
                </button>
              </div>
              {route.page === 'quiz' ? <Quiz /> : <Glossary />}
            </>
          ) : route.page === 'listen' ? (
            <Commute />
          ) : route.page === 'explore' ? (
            <Explore onOpen={open} category={route.category} onCategory={openCategory} />
          ) : reels ? (
            <Reels start={route.reel} onOpen={open} />
          ) : (
            <Home onOpen={open} onPage={openPage} onReel={openReel} />
          )}
        </main>
      </div>
      <Tabs current={tab} onTab={onTab} className="tabbar" />
      {route.page !== 'listen' && !reels && <MiniPlayer onOpen={() => openPage('listen')} />}
      {/* Stays mounted on Reels (hidden there by CSS), so a conversation isn't lost. */}
      <VoiceAssistant topic={topic} open={open} openPage={openPage} />
    </div>
  )
}
