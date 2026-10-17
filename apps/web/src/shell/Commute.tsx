import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { CheckCircle2, Download, Headphones, Loader2, Moon, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Trash2, WifiOff } from 'lucide-react'
import {
  chaptersOf,
  cueAt,
  LESSONS,
  lessonTopics,
  next,
  playTopic,
  previous,
  refreshSaved,
  removeOffline,
  saveOffline,
  seek,
  setRate,
  setSleep,
  skip,
  toggle,
  useCommute,
} from '../learn/commute'
import { STATIC_TOPICS } from '../topics'
import { topicIcon } from './topicIcons'

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const minutes = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`)
const RATES = [0.9, 1, 1.25, 1.5, 1.75, 2]

/** The transcript of the playing chapter, the spoken sentence lit and kept in view. */
function Transcript() {
  const s = useCommute()
  const chapter = chaptersOf(s.topicId)[s.chapter]
  const current = cueAt(chapter, s.time)
  const active = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    active.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [current, s.chapter])
  if (!chapter) return null
  return (
    <div className="transcript">
      {chapter.cues.map((cue, i) => (
        <motion.p
          key={`${s.topicId}-${s.chapter}-${i}`}
          ref={i === current ? active : undefined}
          className={i === current ? 'is-now' : i < current ? 'is-done' : ''}
          animate={{ opacity: i === current ? 1 : i < current ? 0.55 : 0.32, scale: i === current ? 1.02 : 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          onClick={() => seek(cue.t)}
        >
          {cue.text}
        </motion.p>
      ))}
    </div>
  )
}

/** Big player: what's on, controls, speed, sleep timer, transcript. */
function NowPlaying() {
  const s = useCommute()
  const chapters = chaptersOf(s.topicId)
  const chapter = chapters[s.chapter]
  const topic = STATIC_TOPICS.find((t) => t.id === s.topicId)
  const Icon = topic ? topicIcon(topic.id) : Headphones
  const total = LESSONS.topics[s.topicId ?? '']?.duration ?? 0
  const elapsed = chapters.slice(0, s.chapter).reduce((n, c) => n + c.duration, 0) + s.time
  return (
    <section className="card now-playing" aria-label="Now playing">
      <div className="np-head">
        <motion.span className="np-art" animate={s.playing ? { scale: [1, 1.06, 1] } : { scale: 1 }} transition={{ repeat: Infinity, duration: 2.4 }}>
          <Icon size={34} />
        </motion.span>
        <div>
          <span className="np-kicker">{topic ? `Chapter ${s.chapter + 1} of ${chapters.length}` : 'Ready when you are'}</span>
          <h2>{chapter?.title ?? 'Pick a lesson below'}</h2>
          <p>{topic?.title ?? `${lessonTopics().length} lessons · ${minutes(Object.values(LESSONS.topics).reduce((n, t) => n + t.duration, 0))} of audio`}</p>
        </div>
      </div>

      <input
        className="np-seek"
        type="range"
        min={0}
        max={chapter?.duration ?? 1}
        step={0.5}
        value={Math.min(s.time, chapter?.duration ?? 0)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Position in chapter"
        disabled={!chapter}
      />
      <div className="np-times">
        <span>{clock(s.time)}</span>
        <span>
          lesson {clock(elapsed)} / {clock(total)}
        </span>
        <span>-{clock(Math.max(0, (chapter?.duration ?? 0) - s.time))}</span>
      </div>

      <div className="np-controls">
        <button type="button" onClick={previous} aria-label="Previous chapter">
          <SkipBack size={22} />
        </button>
        <button type="button" onClick={() => skip(-15)} aria-label="Back 15 seconds">
          <RotateCcw size={22} />
        </button>
        <motion.button type="button" className="np-play" onClick={() => toggle()} aria-label={s.playing ? 'Pause' : 'Play'} whileTap={{ scale: 0.9 }}>
          {s.playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
        </motion.button>
        <button type="button" onClick={() => skip(30)} aria-label="Forward 30 seconds">
          <RotateCw size={22} />
        </button>
        <button type="button" onClick={() => next()} aria-label="Next chapter">
          <SkipForward size={22} />
        </button>
      </div>

      <div className="np-options">
        <label>
          Speed
          <select value={s.rate} onChange={(e) => setRate(Number(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        <label>
          <Moon size={14} /> Sleep
          <select
            value={s.sleep === null ? '' : s.sleep === 'chapter' ? 'chapter' : 'set'}
            onChange={(e) => setSleep(e.target.value === '' ? null : e.target.value === 'chapter' ? 'chapter' : Number(e.target.value))}
          >
            <option value="">Off</option>
            <option value="chapter">End of chapter</option>
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="60">1 hour</option>
            {s.sleep !== null && s.sleep !== 'chapter' && <option value="set">On ({Math.max(0, Math.round((s.sleep - Date.now()) / 60000))} min left)</option>}
          </select>
        </label>
      </div>

      <Transcript />
    </section>
  )
}

/** Commute mode: every topic as an offline audio lesson. */
export function Commute() {
  const s = useCommute()
  const topics = lessonTopics()
  const total = Object.values(LESSONS.topics).reduce((n, t) => n + t.duration, 0)
  const allSaved = topics.length > 0 && topics.every((t) => s.saved[t.id])
  useEffect(() => {
    void refreshSaved()
  }, [])

  return (
    <div className="commute">
      <header className="practice-head">
        <h1>
          <Headphones size={28} /> Commute mode
        </h1>
        <p>
          {topics.length} audio lessons, {minutes(total)} in all. Save them once on Wi-Fi, then listen offline with the screen off: lock-screen and
          earphone controls work, and it carries on from where you stopped.
        </p>
        <div className="commute-actions">
          {allSaved ? (
            <span className="badge offline-btn is-saved">
              <WifiOff size={14} /> All saved for offline
            </span>
          ) : (
            <button type="button" className="btn btn-primary" disabled={Boolean(s.saving)} onClick={() => void saveOffline(topics.map((t) => t.id))}>
              {s.saving ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              {s.saving ? `Saving ${STATIC_TOPICS.find((t) => t.id === s.saving!.topicId)?.title} (${s.saving.done}/${s.saving.total})` : 'Save all for offline'}
            </button>
          )}
        </div>
      </header>

      <div className="commute-grid">
        <NowPlaying />
        <section className="card lessons" aria-label="Lessons">
          <h2>Lessons</h2>
          <ol>
            {topics.map((t, i) => {
              const lesson = LESSONS.topics[t.id]
              const Icon = topicIcon(t.id)
              const current = s.topicId === t.id
              return (
                <motion.li
                  key={t.id}
                  className={current ? 'is-current' : ''}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <button type="button" className="lesson-main" onClick={() => playTopic(t.id, current ? s.chapter : 0)}>
                    <span className="lesson-icon">
                      {current && s.playing ? (
                        <span className="orb-wave is-small" aria-hidden>
                          {[0, 1, 2, 3].map((k) => (
                            <span key={k} style={{ animationDelay: `${k * 0.12}s` }} />
                          ))}
                        </span>
                      ) : (
                        <Icon size={20} />
                      )}
                    </span>
                    <span className="lesson-text">
                      <strong>{t.title}</strong>
                      <span>
                        {lesson.chapters.length} chapters · {minutes(lesson.duration)} · {t.difficulty}
                      </span>
                    </span>
                  </button>
                  {s.saved[t.id] ? (
                    <button type="button" className="icon-btn lesson-saved" onClick={() => void removeOffline(t.id)} title="Saved for offline. Click to remove.">
                      <CheckCircle2 size={18} />
                      <Trash2 size={12} className="lesson-remove" />
                    </button>
                  ) : (
                    <button type="button" className="icon-btn" onClick={() => void saveOffline([t.id])} disabled={Boolean(s.saving)} title="Save for offline">
                      <Download size={17} />
                    </button>
                  )}
                  {current && (
                    <ol className="lesson-chapters">
                      {lesson.chapters.map((c, k) => (
                        <li key={c.id}>
                          <button type="button" className={k === s.chapter ? 'is-current' : ''} onClick={() => playTopic(t.id, k)}>
                            <span>{c.title}</span>
                            <time>{clock(c.duration)}</time>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </motion.li>
              )
            })}
          </ol>
        </section>
      </div>
    </div>
  )
}

/** A slim player that follows you around the app while a lesson is loaded. */
export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const s = useCommute()
  const chapter = chaptersOf(s.topicId)[s.chapter]
  const topic = STATIC_TOPICS.find((t) => t.id === s.topicId)
  if (!topic || !chapter || (!s.playing && s.time === 0)) return null
  return (
    <motion.div className="mini-player" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}>
      <span className="mini-progress" style={{ width: `${(s.time / (chapter.duration || 1)) * 100}%` }} />
      <button type="button" className="mini-text" onClick={onOpen}>
        <strong>{chapter.title}</strong>
        <span>{topic.title}</span>
      </button>
      <button type="button" className="mini-btn" onClick={() => toggle()} aria-label={s.playing ? 'Pause' : 'Play'}>
        {s.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <button type="button" className="mini-btn" onClick={() => next()} aria-label="Next chapter">
        <SkipForward size={20} />
      </button>
    </motion.div>
  )
}
