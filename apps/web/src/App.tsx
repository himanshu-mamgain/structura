import { lazy, Suspense, useEffect, useState } from 'react'
import { BookA, Boxes, Briefcase, Clapperboard, GraduationCap, Headphones, House, Loader2, Search, type LucideIcon } from 'lucide-react'
import { InstallButton } from './pwa/InstallButton'
import { updateReady } from './pwa/updates'
import { AppSwitcher } from './shell/AppSwitcher'
import { Home } from './shell/Home'
import { NotificationBell, useNotificationEngine } from './shell/Notifications'
import { MiniPlayer } from './shell/MiniPlayer'
import { Reels } from './shell/Reels'
import { focusSearchNext, SearchBox } from './shell/Search'
import { VoiceAssistant } from './shell/VoiceAssistant'
import { type AreaId, isArea } from './topics/areas'
import { loadTopic, topicMeta, type TopicMeta } from './topics/catalog'
import type { StaticTopic } from './topics/types'

// The topic page and every topic's content load together, the first time a topic opens.
const TopicView = lazy(() => import('./shell/TopicView').then((m) => ({ default: m.TopicView })))
// Read mode (?topic=…&read): the same topic as one article.
const Reader = lazy(() => import('./shell/Reader').then((m) => ({ default: m.Reader })))
// Lesson mode (?topic=…&learn): the topic as short cards over the diagram, then a quick check.
const Lesson = lazy(() => import('./shell/Lesson').then((m) => ({ default: m.Lesson })))
// Other pages load when first visited, so the home page starts with less to download.
const Explore = lazy(() => import('./shell/Explore').then((m) => ({ default: m.Explore })))
const NoteView = lazy(() => import('./shell/Notes').then((m) => ({ default: m.NoteView })))
const Quiz = lazy(() => import('./shell/Practice').then((m) => ({ default: m.Quiz })))
const Glossary = lazy(() => import('./shell/Practice').then((m) => ({ default: m.Glossary })))
const Commute = lazy(() => import('./shell/Commute').then((m) => ({ default: m.Commute })))
const Roadmap = lazy(() => import('./shell/Roadmap').then((m) => ({ default: m.Roadmap })))
const Prep = lazy(() => import('./shell/Prep').then((m) => ({ default: m.Prep })))

type Page = 'quiz' | 'glossary' | 'prep' | 'listen' | 'explore' | 'reels' | 'roadmap'
const PAGES: Page[] = ['quiz', 'glossary', 'prep', 'listen', 'explore', 'reels', 'roadmap']

// A topic has its own address, /topic/<id>/, which the build also writes as a ready-made page
// (scripts/prerender.tsx) for search engines and link previews. Older ?topic=<id> links still work.
const TOPIC_PATH = /^\/topic\/([a-z0-9-]+)\/?$/

/**
 * The address for a route written as a query (?topic=x&read, ?page=explore…): topics move into
 * the path, everything else stays on /.
 */
function urlFor(search: string): URL {
  const url = new URL(window.location.href)
  const query = new URLSearchParams(search)
  const topic = query.get('topic')
  query.delete('topic')
  url.pathname = topic ? `/topic/${topic}/` : '/'
  // ?read, not ?read=
  url.search = query.toString().replace(/=(?=&|$)/g, '')
  url.hash = ''
  return url
}

/** Where the learner is lives in the URL (/topic/<id>/, ?page=reels&reel=…, ?note=…, ?library=…, ?area=…), so links can be shared. */
function readRoute() {
  const query = new URLSearchParams(window.location.search)
  const page = query.get('page') as Page | null
  const category = query.get('library')
  const area = query.get('area')
  return {
    // One roadmap module (?page=roadmap&part=docker).
    partId: query.get('part'),
    // Explore and the roadmap can show one area: Development, Infra, Databases or AI.
    area: isArea(area) ? area : null,
    topicId: query.get('topic') ?? window.location.pathname.match(TOPIC_PATH)?.[1] ?? null,
    category,
    // The library lives in Explore, so its links open there.
    page: page && PAGES.includes(page) ? page : category ? 'explore' : null,
    reel: query.get('reel'),
    noteId: query.get('note'),
    read: query.has('read'),
    learn: query.has('learn'),
  }
}

/**
 * Scrolls to a Read-mode section (#read-…) once it's on the page: the topic and its deep
 * notes load after the address changes. Gives up after a few seconds, or if the reader
 * starts scrolling first.
 */
function scrollToSection(hash: string) {
  const id = decodeURIComponent(hash.replace(/^#/, ''))
  if (!id) return
  const started = performance.now()
  let moved = false
  const stop = () => (moved = true)
  window.addEventListener('wheel', stop, { once: true, passive: true })
  window.addEventListener('touchstart', stop, { once: true, passive: true })
  const done = () => {
    window.removeEventListener('wheel', stop)
    window.removeEventListener('touchstart', stop)
  }
  const tick = () => {
    if (moved) return done()
    const el = document.getElementById(id)
    if (!el) return performance.now() - started < 6000 ? requestAnimationFrame(tick) : done()
    el.scrollIntoView({ block: 'start' })
    el.classList.add('is-target')
    setTimeout(() => el.classList.remove('is-target'), 2400)
    // The diagram above finishes its layout a moment later and can push the section down.
    setTimeout(() => {
      if (!moved && Math.abs(el.getBoundingClientRect().top - parseFloat(getComputedStyle(el).scrollMarginTop || '0')) > 8) el.scrollIntoView({ block: 'start' })
      done()
    }, 700)
  }
  requestAnimationFrame(tick)
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

  // An old ?topic=<id> link: show the topic's own address instead.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('topic')) window.history.replaceState(null, '', urlFor(window.location.search))
  }, [])

  useEffect(() => {
    const onPop = () => setRoute(readRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A shared link to a section (/topic/<id>/?read#read-…) lands on it.
  useEffect(() => {
    if (window.location.hash.startsWith('#read-')) scrollToSection(window.location.hash)
  }, [])

  // Deep links between topics (learn/links.ts) open in the app, at the section they name.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const link = (e.target as Element | null)?.closest?.('a[data-topic-link]')
      const href = link?.getAttribute('href')
      const url = href ? new URL(href, window.location.origin) : null
      const id = url?.pathname.match(TOPIC_PATH)?.[1]
      if (!url || !id || !topicMeta(id)) return
      e.preventDefault()
      const search = `?topic=${id}${url.searchParams.has('read') ? '&read' : ''}`
      const here = urlFor(search)
      if (here.pathname === window.location.pathname && here.search === window.location.search) {
        // Same page: just move to the section, and let Back return to where the reader was.
        window.history.pushState(null, '', url.hash || here)
        if (url.hash) scrollToSection(url.hash)
        return
      }
      navigate(search)
      window.scrollTo({ top: 0 })
      if (url.hash) {
        window.history.replaceState(null, '', url.hash)
        scrollToSection(url.hash)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  })

  function navigate(search: string) {
    const url = urlFor(search)
    // A newer version took over while this page was open: load the next page fresh, in it.
    if (updateReady()) return window.location.assign(url)
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

  function openLearn(next: TopicMeta) {
    navigate(`?topic=${next.id}&learn`)
    window.scrollTo({ top: 0 })
  }

  /** One roadmap module, such as AWS basics (?page=roadmap&part=aws-start). */
  function openPart(id: string) {
    navigate(`?page=roadmap&part=${id}`)
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

  /** Explore, or the roadmap, showing one area (or all of them). */
  function openArea(area: AreaId | null, page: 'explore' | 'roadmap' = 'explore') {
    navigate(`?page=${page}${area ? `&area=${area}` : ''}`)
    window.scrollTo({ top: 0 })
  }

  function openCategory(id: string | null) {
    const area = route.area ? `&area=${route.area}` : ''
    navigate(id ? `?library=${id}${area}` : `?page=explore${area}`)
    requestAnimationFrame(() => document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' }))
  }

  const tab: Tab | null = meta
    ? null
    : route.noteId
      ? 'explore'
      : route.page === 'quiz' || route.page === 'glossary' || route.page === 'prep'
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
  const lessonOpen = Boolean(meta && route.learn)

  return (
    <div className={`shell${reels ? ' is-reels' : ''}${lessonOpen ? ' is-lesson' : ''}`}>
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
          {route.page !== 'explore' && <SearchBox onOpen={open} onRead={openRead} onNote={openNote} onPart={openPart} className="appbar-search" />}
          {/* Narrower screens have no room for the field: this opens Explore's, ready to type. */}
          {route.page !== 'explore' && (
            <button
              type="button"
              className="icon-btn appbar-find"
              onClick={() => {
                focusSearchNext()
                openPage('explore')
              }}
              aria-label="Search"
            >
              <Search size={19} />
            </button>
          )}
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
                  {route.learn ? (
                    <Lesson key={topic.id} topic={topic} onExit={() => open(meta)} onRead={() => openRead(meta)} onLearn={openLearn} />
                  ) : route.read ? (
                    <Reader key={topic.id} topic={topic} onExit={() => open(meta)} onRead={openRead} onOpen={open} onArea={openArea} onLearn={() => openLearn(meta)} />
                  ) : (
                    <TopicView
                      key={topic.id}
                      topic={topic}
                      openLoad={openLoad}
                      onNote={openNote}
                      onRead={() => openRead(meta)}
                      onLearn={() => openLearn(meta)}
                      onArea={openArea}
                    />
                  )}
                </Suspense>
              ) : (
                <TopicLoading meta={meta} />
              )
            ) : route.noteId ? (
              <NoteView id={route.noteId} onNote={openNote} onOpen={open} />
            ) : route.page === 'quiz' || route.page === 'glossary' || route.page === 'prep' ? (
              <>
                <div className="seg practice-switch" role="group" aria-label="Practice">
                  <button type="button" aria-pressed={route.page === 'quiz'} onClick={() => openPage('quiz')}>
                    <GraduationCap size={16} /> Quiz
                  </button>
                  <button type="button" aria-pressed={route.page === 'glossary'} onClick={() => openPage('glossary')}>
                    <BookA size={16} /> Glossary
                  </button>
                  <button type="button" aria-pressed={route.page === 'prep'} onClick={() => openPage('prep')}>
                    <Briefcase size={16} /> Interview prep
                  </button>
                </div>
                {route.page === 'quiz' ? <Quiz /> : route.page === 'glossary' ? <Glossary /> : <Prep onRoadmap={() => openPage('roadmap')} />}
              </>
            ) : route.page === 'listen' ? (
              <Commute />
            ) : route.page === 'roadmap' ? (
              <Roadmap
                area={route.area}
                partId={route.partId}
                onArea={(area) => openArea(area, 'roadmap')}
                onPart={openPart}
                onOpen={open}
                onRead={openRead}
                onLearn={openLearn}
              />
            ) : route.page === 'explore' ? (
              <Explore
                onOpen={open}
                onRead={openRead}
                onNote={openNote}
                area={route.area}
                onArea={(area) => openArea(area)}
                category={route.category}
                onCategory={openCategory}
                onRoadmap={(area) => openArea(area ?? null, 'roadmap')}
                onPart={openPart}
              />
            ) : reels ? (
              <Reels start={route.reel} onOpen={open} />
            ) : (
              <Home onOpen={open} onPage={openPage} onReel={openReel} onArea={(area) => openArea(area)} />
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
