import { type PointerEvent, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Bookmark, BookmarkCheck, ChevronDown, ChevronUp, Clapperboard, ListVideo, MessageCircle, Pause, Play, RotateCcw, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { toggle as toggleCommute, useCommute } from '../learn/commute'
import { type Progress, updateReel, updateTopic, useProgress, videoFraction } from '../learn/progress'
import { fullCoverOnError, smallCover, TOPICS, type TopicMeta } from '../topics/catalog'
import { CopyLink, whatsappHref } from './Share'
import { topicIcon } from './topicIcons'

// Reels: every topic video, full screen, one after another, swiped like
// Instagram. Home shows them as a row of covers; the Reels tab plays them.
// A topic's main video is one reel; a topic can add short ones of its own
// (the rate limiter has one per algorithm).

export interface ReelItem {
  /** The reel's address, ?page=reels&reel=<id>: the topic's id for its main video. */
  id: string
  topic: TopicMeta
  title: string
  /** "Rate Limiter · 1 of 4", for a topic's own short reels. */
  series?: string
  blurb: string
  video: string
  chapters?: [number, string][]
}

export const REELS: ReelItem[] = TOPICS.flatMap((t) => [
  ...(t.video ? [{ id: t.id, topic: t, title: t.title, blurb: t.blurb, video: t.video, chapters: t.chapters }] : []),
  ...(t.reels ?? []).map((r, i, all) => ({ id: r.id, topic: t, title: r.title, series: `${t.title} · ${i + 1} of ${all.length}`, blurb: r.blurb, video: r.video, chapters: r.chapters })),
])

const cover = (item: ReelItem) => item.video.replace(/\.mp4$/, '.jpg')
const isMain = (item: ReelItem) => item.id === item.topic.id

/** Where the learner left a reel: the topic's video progress for its main video, its own for the rest. */
function placeOf(item: ReelItem, progress: Progress): { time: number; duration: number } | null {
  if (isMain(item)) {
    const p = progress.topics[item.topic.id]
    return p?.videoTime && p.videoDuration ? { time: p.videoTime, duration: p.videoDuration } : null
  }
  const r = progress.reels?.[item.id]
  return r ? { time: r.time, duration: r.duration } : null
}

export function watchedFraction(item: ReelItem, progress: Progress): number {
  if (isMain(item)) return videoFraction(progress.topics[item.topic.id])
  const place = placeOf(item, progress)
  return place ? Math.min(1, place.time / place.duration) : 0
}

/** The row of reel covers on Home. */
export function ReelsRow({ onPlay, onAll }: { onPlay: (id: string) => void; onAll: () => void }) {
  const progress = useProgress()
  if (!REELS.length) return null
  return (
    <section className="home-section reels-strip" aria-label="Reels">
      <div className="section-head">
        <h2>
          <Clapperboard size={19} /> Reels
        </h2>
        <button type="button" className="see-all" onClick={onAll}>
          See all
        </button>
      </div>
      <div className="reel-tiles">
        {REELS.map((item) => {
          const watched = watchedFraction(item, progress)
          return (
            <button key={item.id} type="button" className={`reel-tile${watched >= 0.97 ? ' is-watched' : ''}`} onClick={() => onPlay(item.id)}>
              <img src={smallCover(item.video)} alt="" loading="lazy" onError={fullCoverOnError} />
              <span className="reel-tile-shade" aria-hidden />
              <Play className="reel-tile-play" size={15} fill="currentColor" aria-hidden />
              <span className="reel-tile-text">
                <strong>{item.title}</strong>
                <small>{watched >= 0.97 ? 'Watched' : (item.series ?? (item.chapters ? `${item.chapters.length} chapters` : item.topic.difficulty))}</small>
              </span>
              {watched > 0 && watched < 0.97 && (
                <span className="reel-tile-progress" aria-label={`${Math.round(watched * 100)}% watched`}>
                  <span style={{ width: `${watched * 100}%` }} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The Reels tab: a vertical feed that plays the reel in view. */
export function Reels(props: { start: string | null; onOpen: (topic: TopicMeta) => void }) {
  return REELS.length ? <Feed {...props} /> : <p className="practice-empty">No reels yet.</p>
}

function Feed({ start, onOpen }: { start: string | null; onOpen: (topic: TopicMeta) => void }) {
  const progress = useProgress()
  const commute = useCommute()
  const feed = useRef<HTMLDivElement>(null)
  const videos = useRef<(HTMLVideoElement | null)[]>([])
  const [initial] = useState(() => Math.max(0, REELS.findIndex((r) => r.id === start)))
  const [active, setActive] = useState(initial)
  const [muted, setMuted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [ended, setEnded] = useState(false)
  const [time, setTime] = useState({ at: 0, of: 0 })
  const [more, setMore] = useState(false)
  const [flash, setFlash] = useState<{ icon: 'play' | 'pause'; key: number } | null>(null)
  // Read inside event handlers and effects without re-running them.
  const live = useRef({ muted, progress, commute })
  live.current = { muted, progress, commute }
  const lastSaved = useRef(0)

  const reel = REELS[active]

  function save(v: HTMLVideoElement, item: ReelItem) {
    if (!v.duration) return
    lastSaved.current = Date.now()
    if (isMain(item)) updateTopic(item.topic.id, { videoTime: v.currentTime, videoDuration: v.duration, lastWatchedAt: Date.now() })
    else {
      updateReel(item.id, v.currentTime, v.duration)
      updateTopic(item.topic.id, { lastWatchedAt: Date.now() })
    }
  }

  function play(v: HTMLVideoElement) {
    v.muted = live.current.muted
    v.play().then(
      () => setPaused(false),
      (error: DOMException) => {
        // Browsers block sound until the page has been tapped: play muted instead.
        if (error.name === 'NotAllowedError' && !v.muted) {
          setMuted(true)
          v.muted = true
          v.play().then(
            () => setPaused(false),
            () => setPaused(true),
          )
        } else if (error.name !== 'AbortError') setPaused(true)
      },
    )
  }

  const go = (index: number) => {
    const root = feed.current
    if (root && index >= 0 && index < REELS.length) root.scrollTo({ top: index * root.clientHeight, behavior: 'smooth' })
  }

  // Open at the reel that was tapped.
  useEffect(() => {
    const root = feed.current
    if (root) root.scrollTop = initial * root.clientHeight
  }, [initial])

  // The reel that's mostly in view is the active one.
  useEffect(() => {
    const root = feed.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index))
      },
      { root, threshold: 0.6 },
    )
    Array.from(root.children).forEach((c) => io.observe(c))
    return () => io.disconnect()
  }, [])

  // Play the active reel, from where it was left; pause the rest.
  useEffect(() => {
    const t = REELS[active]
    setEnded(false)
    setMore(false)
    setTime({ at: 0, of: 0 })
    const url = new URL(window.location.href)
    url.searchParams.set('reel', t.id)
    window.history.replaceState(window.history.state, '', url)
    videos.current.forEach((v, i) => i !== active && v?.pause())
    const v = videos.current[active]
    if (!v) return
    const saved = placeOf(t, live.current.progress)
    const resume = saved && saved.time > 5 && saved.time < saved.duration - 5 ? saved.time : 0
    if (resume && v.currentTime < 1) v.currentTime = resume
    play(v)
    return () => {
      if (v.currentTime > 0) save(v, t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  function togglePlay() {
    const v = videos.current[active]
    if (!v) return
    if (ended) {
      v.currentTime = 0
      setEnded(false)
    }
    if (v.paused) play(v)
    else v.pause()
    setFlash({ icon: v.paused ? 'pause' : 'play', key: Date.now() })
  }

  function toggleMute() {
    const next = !muted
    setMuted(next)
    const v = videos.current[active]
    if (v) {
      v.muted = next
      if (v.paused && !ended) play(v)
    }
  }

  // Keyboard: ↑/↓ (or j/k) between reels, space to pause, m for sound.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowDown' || e.key === 'j') go(active + 1)
      else if (e.key === 'ArrowUp' || e.key === 'k') go(active - 1)
      else if (e.key === ' ') togglePlay()
      else if (e.key === 'm') toggleMute()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // A timer rather than animationend, which never fires with reduced motion.
  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 600)
    return () => window.clearTimeout(timer)
  }, [flash])

  function scrub(e: PointerEvent<HTMLDivElement>) {
    const v = videos.current[active]
    if (!v?.duration) return
    const box = e.currentTarget.getBoundingClientRect()
    v.currentTime = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * v.duration
    setTime({ at: v.currentTime, of: v.duration })
  }

  const chapter = reel.chapters?.findLast(([at]) => time.at >= at)?.[1]

  return (
    <div className="reels">
      <div className="reels-feed" ref={feed}>
        {REELS.map((item, i) => {
          const t = item.topic
          const near = Math.abs(i - active) <= 1
          const here = i === active
          const Icon = topicIcon(t.id)
          const saved = progress.topics[t.id]?.bookmarked
          return (
            <section key={item.id} className="reel" data-index={i} aria-label={item.title}>
              <div className="reel-stage" onClick={() => here && togglePlay()}>
                <img className="reel-backdrop" src={cover(item)} alt="" aria-hidden />
                {near ? (
                  <video
                    ref={(el) => {
                      videos.current[i] = el
                    }}
                    src={item.video}
                    poster={cover(item)}
                    playsInline
                    preload={here ? 'auto' : 'metadata'}
                    onPlay={(e) => {
                      // One sound at a time: a reel with sound pauses Commute mode.
                      if (!e.currentTarget.muted && live.current.commute.playing) toggleCommute()
                    }}
                    onTimeUpdate={(e) => {
                      if (!here) return
                      const v = e.currentTarget
                      setTime({ at: v.currentTime, of: v.duration || 0 })
                      if (Date.now() - lastSaved.current > 5000) save(v, item)
                    }}
                    onPause={(e) => {
                      if (here) {
                        setPaused(true)
                        save(e.currentTarget, item)
                      }
                    }}
                    onPlaying={() => here && setPaused(false)}
                    onEnded={(e) => {
                      if (!here) return
                      save(e.currentTarget, item)
                      setEnded(true)
                    }}
                  />
                ) : (
                  <img className="reel-poster" src={cover(item)} alt="" />
                )}
              </div>

              {here && paused && !ended && !flash && (
                <span className="reel-paused" aria-hidden>
                  <Play size={34} fill="currentColor" />
                </span>
              )}
              {here && flash && (
                <span key={flash.key} className="reel-flash" aria-hidden>
                  {flash.icon === 'play' ? <Play size={34} fill="currentColor" /> : <Pause size={34} fill="currentColor" />}
                </span>
              )}

              {here && ended && (
                <div className="reel-end">
                  <strong>{item.title}</strong>
                  <span>Now try it: follow a request, switch parts off, put load on it.</span>
                  <button type="button" className="btn btn-primary" onClick={() => onOpen(t)}>
                    <ArrowUpRight size={17} /> Open the topic
                  </button>
                  <div className="reel-end-row">
                    <button type="button" className="btn btn-ghost" onClick={togglePlay}>
                      <RotateCcw size={16} /> Replay
                    </button>
                    {i < REELS.length - 1 && (
                      <button type="button" className="btn btn-ghost" onClick={() => go(i + 1)}>
                        <SkipForward size={16} /> Next reel
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="reel-info">
                <button type="button" className="reel-who" onClick={() => onOpen(t)}>
                  <span className="reel-avatar" aria-hidden>
                    <Icon size={17} />
                  </span>
                  <strong>{item.title}</strong>
                  <span className="reel-level">{item.series ?? t.difficulty}</span>
                </button>
                <button type="button" className={`reel-blurb${here && more ? ' is-open' : ''}`} onClick={() => setMore(!more)}>
                  {item.blurb}
                </button>
                {here && chapter && (
                  <p className="reel-chapter">
                    <ListVideo size={14} aria-hidden /> {chapter}
                  </p>
                )}
              </div>

              <div className="reel-actions">
                <button type="button" onClick={() => updateTopic(t.id, (p) => ({ bookmarked: !p.bookmarked }))} aria-pressed={Boolean(saved)}>
                  {saved ? <BookmarkCheck size={26} /> : <Bookmark size={26} />}
                  <span>{saved ? 'Saved' : 'Save'}</span>
                </button>
                {/* Sharing is WhatsApp and Copy link (Share.tsx). */}
                <a href={whatsappHref(`${item.title} · Structura: ${item.blurb}`, `/?page=reels&reel=${item.id}`)} target="_blank" rel="noreferrer" aria-label="Share on WhatsApp">
                  <MessageCircle size={25} />
                  <span>WhatsApp</span>
                </a>
                <CopyLink path={`/?page=reels&reel=${item.id}`} className="" size={25} />
                <button type="button" onClick={() => onOpen(t)}>
                  <ArrowUpRight size={27} />
                  <span>Topic</span>
                </button>
              </div>

              {here && (
                <div className="reel-scrub" onPointerDown={scrub} role="presentation">
                  <span style={{ width: `${time.of ? (time.at / time.of) * 100 : 0}%` }} />
                </div>
              )}
            </section>
          )
        })}
      </div>

      <header className="reels-top">
        <h1>Reels</h1>
        <button type="button" className="reels-mute" onClick={toggleMute} aria-label={muted ? 'Turn sound on' : 'Mute'} aria-pressed={muted}>
          {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          {muted && <span>Tap for sound</span>}
        </button>
      </header>

      <div className="reels-step">
        <button type="button" className="icon-btn" onClick={() => go(active - 1)} disabled={active === 0} aria-label="Previous reel">
          <ChevronUp size={22} />
        </button>
        <button type="button" className="icon-btn" onClick={() => go(active + 1)} disabled={active === REELS.length - 1} aria-label="Next reel">
          <ChevronDown size={22} />
        </button>
      </div>

    </div>
  )
}
