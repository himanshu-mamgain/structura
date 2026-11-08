import { type PointerEvent, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Bookmark, BookmarkCheck, ChevronDown, ChevronUp, Clapperboard, ListVideo, Pause, Play, RotateCcw, Send, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { toggle as toggleCommute, useCommute } from '../learn/commute'
import { updateTopic, useProgress, videoFraction } from '../learn/progress'
import { STATIC_TOPICS, type StaticTopic } from '../topics'
import { topicIcon } from './topicIcons'

// Reels: every topic video, full screen, one after another, swiped like
// Instagram. Home shows them as a row of covers; the Reels tab plays them.

export const REELS = STATIC_TOPICS.filter((t) => t.video)
const cover = (t: StaticTopic) => t.video!.replace(/\.mp4$/, '.jpg')

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
        {REELS.map((t) => {
          const watched = videoFraction(progress.topics[t.id])
          return (
            <button key={t.id} type="button" className={`reel-tile${watched >= 0.97 ? ' is-watched' : ''}`} onClick={() => onPlay(t.id)}>
              <img src={cover(t)} alt="" loading="lazy" />
              <span className="reel-tile-shade" aria-hidden />
              <Play className="reel-tile-play" size={15} fill="currentColor" aria-hidden />
              <span className="reel-tile-text">
                <strong>{t.title}</strong>
                <small>{watched >= 0.97 ? 'Watched' : t.chapters ? `${t.chapters.length} chapters` : t.difficulty}</small>
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
export function Reels(props: { start: string | null; onOpen: (topic: StaticTopic) => void }) {
  return REELS.length ? <Feed {...props} /> : <p className="practice-empty">No reels yet.</p>
}

function Feed({ start, onOpen }: { start: string | null; onOpen: (topic: StaticTopic) => void }) {
  const progress = useProgress()
  const commute = useCommute()
  const feed = useRef<HTMLDivElement>(null)
  const videos = useRef<(HTMLVideoElement | null)[]>([])
  const [initial] = useState(() => Math.max(0, REELS.findIndex((t) => t.id === start)))
  const [active, setActive] = useState(initial)
  const [muted, setMuted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [ended, setEnded] = useState(false)
  const [time, setTime] = useState({ at: 0, of: 0 })
  const [more, setMore] = useState(false)
  const [flash, setFlash] = useState<{ icon: 'play' | 'pause'; key: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Read inside event handlers and effects without re-running them.
  const live = useRef({ muted, progress, commute })
  live.current = { muted, progress, commute }
  const lastSaved = useRef(0)

  const reel = REELS[active]

  function save(v: HTMLVideoElement, t: StaticTopic) {
    if (!v.duration) return
    lastSaved.current = Date.now()
    updateTopic(t.id, { videoTime: v.currentTime, videoDuration: v.duration, lastWatchedAt: Date.now() })
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
    const saved = live.current.progress.topics[t.id]
    const resume = saved?.videoTime && saved.videoDuration && saved.videoTime > 5 && saved.videoTime < saved.videoDuration - 5 ? saved.videoTime : 0
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

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  async function share(t: StaticTopic) {
    const url = `${window.location.origin}/?page=reels&reel=${t.id}`
    if (navigator.share) {
      try {
        await navigator.share({ title: `${t.title} · Structura`, text: t.blurb, url })
      } catch {
        // Closed the share sheet.
      }
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      setToast('Link copied')
    } catch {
      setToast(url)
    }
  }

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
        {REELS.map((t, i) => {
          const near = Math.abs(i - active) <= 1
          const here = i === active
          const Icon = topicIcon(t.id)
          const saved = progress.topics[t.id]?.bookmarked
          return (
            <section key={t.id} className="reel" data-index={i} aria-label={t.title}>
              <div className="reel-stage" onClick={() => here && togglePlay()}>
                <img className="reel-backdrop" src={cover(t)} alt="" aria-hidden />
                {near ? (
                  <video
                    ref={(el) => {
                      videos.current[i] = el
                    }}
                    src={t.video}
                    poster={cover(t)}
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
                      if (Date.now() - lastSaved.current > 5000) save(v, t)
                    }}
                    onPause={(e) => {
                      if (here) {
                        setPaused(true)
                        save(e.currentTarget, t)
                      }
                    }}
                    onPlaying={() => here && setPaused(false)}
                    onEnded={(e) => {
                      if (!here) return
                      save(e.currentTarget, t)
                      setEnded(true)
                    }}
                  />
                ) : (
                  <img className="reel-poster" src={cover(t)} alt="" />
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
                  <strong>{t.title}</strong>
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
                  <strong>{t.title}</strong>
                  <span className="reel-level">{t.difficulty}</span>
                </button>
                <button type="button" className={`reel-blurb${here && more ? ' is-open' : ''}`} onClick={() => setMore(!more)}>
                  {t.blurb}
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
                <button type="button" onClick={() => void share(t)}>
                  <Send size={25} />
                  <span>Share</span>
                </button>
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

      {toast && (
        <p className="reels-toast" role="status">
          {toast}
        </p>
      )}
    </div>
  )
}
