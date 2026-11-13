import { lazy, Suspense, useEffect, useState } from 'react'
import { BookA, Boxes, Clapperboard, GraduationCap, Headphones, House, Loader2, Search, type LucideIcon } from 'lucide-react'
import { board } from './board/store'
import { InstallButton } from './pwa/InstallButton'
import { AppSwitcher } from './shell/AppSwitcher'
import { Home } from './shell/Home'
import { NotificationBell, useNotificationEngine } from './shell/Notifications'
import { MiniPlayer } from './shell/MiniPlayer'
import { Reels } from './shell/Reels'
import { SearchBox } from './shell/Search'
import { VoiceAssistant } from './shell/VoiceAssistant'
import { loadTopic, topicMeta, type TopicMeta } from './topics/catalog'
import type { StaticTopic } from './topics/types'

// The topic page and every topic's content load together, the first time a topic opens.
const TopicView = lazy(() => import('./shell/TopicView').then((m) => ({ default: m.TopicView })))
// Read mode (?topic=…&read): the same topic as one article.
const Reader = lazy(() => import('./shell/Reader').then((m) => ({ default: m.Reader })))
// Other pages load when first visited, so the home page starts with less to download.
const Explore = lazy(() => import('./shell/Explore').then((m) => ({ default: m.Explore })))
const NoteView = lazy(() => import('./shell/Notes').then((m) => ({ default: m.NoteView })))
const Quiz = lazy(() => import('./shell/Practice').then((m) => ({ default: m.Quiz })))
const Glossary = lazy(() => import('./shell/Practice').then((m) => ({ default: m.Glossary })))
const Commute = lazy(() => import('./shell/Commute').then((m) => ({ default: m.Commute })))
const Roadmap = lazy(() => import('./shell/Roadmap').then((m) => ({ default: m.Roadmap })))

type Page = 'quiz' | 'glossary' | 'listen' | 'explore' | 'reels' | 'roadmap'
const PAGES: Page[] = ['quiz', 'glossary', 'listen', 'explore', 'reels', 'roadmap']

/** Where the learner is lives in the URL (?topic=…, ?page=reels&reel=…, ?note=…, ?library=…), so links can be shared. */
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
    noteId: query.get('note'),
    read: query.has('read'),
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

function PageLoading() {
  return (
    <div className="page-loading" aria-busy="true">
      <Loader2 size={26} className="spin" aria-label="Loading" />
    </div>
  )
}

/** Shown for the moment a topic's content is loading (only the first time, or on a slow connection). */
function TopicLoading({ meta }: { meta: TopicMeta }) {
  return (
    <div className="topic-loading" aria-busy="true">
      <h1>{meta.title}</h1>
      <p>{meta.blurb}</p>
      <Loader2 size={28} className="spin" aria-label="Loading" />
    </div>
  )
}

export default function App() {
  const [route, setRoute] = useState(readRoute)
  useNotificationEngine()
  const meta = topicMeta(route.topicId) ?? null
  const [loaded, setLoaded] = useState<StaticTopic | null>(null)
  useEffect(() => {
    if (!meta) return
    let alive = true
    void loadTopic(meta.id).then((t) => alive && setLoaded(t))
    return () => {
      alive = false
    }
  }, [meta])
  const topic = loaded && loaded.id === meta?.id ? loaded : null
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

  function open(next: TopicMeta | null) {
    navigate(next ? `?topic=${next.id}` : '')
    window.scrollTo({ top: 0 })
  }

  function openRead(next: TopicMeta) {
    navigate(`?topic=${next.id}&read`)
    window.scrollTo({ top: 0 })
  }

  function openPage(page: Page) {
    navigate(`?page=${page}`)
    window.scrollTo({ top: 0 })
  }

  function openReel(id: string) {
    navigate(`?page=reels&reel=${id}`)
  }

  function openNote(id: string) {
    navigate(`?note=${id}`)
    window.scrollTo({ top: 0 })
  }

  function openCategory(id: string | null) {
    navigate(id ? `?library=${id}` : '?page=explore')
    requestAnimationFrame(() => document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' }))
  }

  const tab: Tab | null = meta
    ? null
    : route.noteId
      ? 'explore'
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

  const reels = !meta && route.page === 'reels'

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
          {route.page !== 'explore' && <SearchBox onOpen={open} onRead={openRead} onNote={openNote} className="appbar-search" />}
          <InstallButton />
          <NotificationBell
            onOpen={(url) => {
              navigate(new URL(url, window.location.origin).search)
              window.scrollTo({ top: 0 })
            }}
          />
          <AppSwitcher />
        </header>

        <main className="content">
          <Suspense fallback={<PageLoading />}>
            {meta ? (
              topic ? (
                <Suspense fallback={<TopicLoading meta={meta} />}>
                  {route.read ? (
                    <Reader key={topic.id} topic={topic} onExit={() => open(meta)} onRead={openRead} />
                  ) : (
                    <TopicView key={topic.id} topic={topic} board={board} openLoad={openLoad} onNote={openNote} onRead={() => openRead(meta)} />
                  )}
                </Suspense>
              ) : (
                <TopicLoading meta={meta} />
              )
            ) : route.noteId ? (
              <NoteView id={route.noteId} onNote={openNote} onOpen={open} />
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
            ) : route.page === 'roadmap' ? (
              <Roadmap onOpen={open} onRead={openRead} />
            ) : route.page === 'explore' ? (
              <Explore onOpen={open} onRead={openRead} onNote={openNote} category={route.category} onCategory={openCategory} onRoadmap={() => openPage('roadmap')} />
            ) : reels ? (
              <Reels start={route.reel} onOpen={open} />
            ) : (
              <Home onOpen={open} onPage={openPage} onReel={openReel} />
            )}
          </Suspense>
        </main>
      </div>
      <Tabs current={tab} onTab={onTab} className="tabbar" />
      {route.page !== 'listen' && !reels && <MiniPlayer onOpen={() => openPage('listen')} />}
      {/* Stays mounted on Reels (hidden there by CSS), so a conversation isn't lost. */}
      <VoiceAssistant topic={topic} open={open} openPage={openPage} />
    </div>
  )
}
