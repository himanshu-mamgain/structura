import { useState } from 'react'
import { Bookmark, CheckCircle2, ExternalLink, Footprints, GraduationCap, Library, Play, Sparkles, Video, Zap } from 'lucide-react'
import { ago, readiness, type TopicProgress, useProgress, videoFraction } from '../learn/progress'
import course from '../learn/course.json'
import { STATIC_TOPICS, type StaticTopic } from '../topics'
import { LIBRARY, sourceOf, topicForGuide } from '../topics/library'
import { topicIcon } from './topicIcons'
import { TodayCard } from './VoiceGuide'

const thumbnail = (topic: StaticTopic) => topic.video?.replace(/\.mp4$/, '.jpg')
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

type Filter = 'all' | 'bookmarked' | 'in-progress' | 'completed'

/** The first screen: what Structura is, where you left off, the videos, every topic, and the library. */
export function Home({
  onOpen,
  onPage,
  category,
  onCategory,
}: {
  onOpen: (topic: StaticTopic) => void
  onPage: (page: 'quiz' | 'glossary') => void
  category: string | null
  onCategory: (id: string | null) => void
}) {
  const progress = useProgress()
  const [filter, setFilter] = useState<Filter>('all')
  const p = (t: StaticTopic): TopicProgress | undefined => progress.topics[t.id]

  const recent = STATIC_TOPICS.filter((t) => p(t)?.lastOpenedAt)
    .sort((a, b) => (p(b)?.lastOpenedAt ?? 0) - (p(a)?.lastOpenedAt ?? 0))
    .slice(0, 3)
  const overall = Math.round(STATIC_TOPICS.reduce((sum, t) => sum + readiness(t, p(t)), 0) / STATIC_TOPICS.length)
  const completed = STATIC_TOPICS.filter((t) => p(t)?.completed).length
  const shown = STATIC_TOPICS.filter((t) => {
    const tp = p(t)
    if (filter === 'bookmarked') return tp?.bookmarked
    if (filter === 'completed') return tp?.completed
    if (filter === 'in-progress') return tp?.lastOpenedAt && !tp.completed
    return true
  })

  return (
    <div className="home">
      <section className="hero">
        <p className="eyebrow">
          <Sparkles size={15} /> Interactive system design
        </p>
        <h1>Learn system design by seeing it work</h1>
        <p>
          Every topic is a live architecture: click any component to see what it does, follow a real request step by step, switch parts off to
          see what breaks, and put load on it in 3D. Narrated videos, code and interview questions included.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(recent[0] ?? STATIC_TOPICS[0])}>
            <Play size={16} fill="currentColor" /> {recent[0] ? `Continue ${recent[0].title}` : `Start with ${STATIC_TOPICS[0].title}`}
          </button>
          <button type="button" className="btn" onClick={() => onPage('quiz')}>
            <GraduationCap size={17} /> Test yourself
          </button>
        </div>
        <dl className="stats">
          <div>
            <dt>Interview readiness</dt>
            <dd>{overall}%</dd>
          </div>
          <div>
            <dt>Topics completed</dt>
            <dd>
              {completed}/{STATIC_TOPICS.length}
            </dd>
          </div>
          <div>
            <dt>Best quiz score</dt>
            <dd>{progress.quizBest !== undefined ? `${progress.quizBest}/${course.quiz.length}` : '—'}</dd>
          </div>
        </dl>
      </section>

      <TodayCard onOpen={onOpen} />

      {recent.length > 0 && (
        <section className="home-section" aria-label="Continue learning">
          <h2>Continue learning</h2>
          <div className="continue">
            {recent.map((t) => {
              const tp = p(t)
              const watched = videoFraction(tp)
              const Icon = topicIcon(t.id)
              return (
                <button key={t.id} type="button" className="card continue-card" onClick={() => onOpen(t)}>
                  <span className="continue-thumb">
                    {thumbnail(t) ? <img src={thumbnail(t)} alt="" loading="lazy" /> : <Icon size={30} />}
                    {t.video && <Play className="continue-play" size={22} fill="currentColor" />}
                  </span>
                  <span className="continue-body">
                    <strong>{t.title}</strong>
                    <span className="continue-meta">
                      {tp?.videoTime && watched < 0.97 ? `Resume video at ${clock(tp.videoTime)}` : `${readiness(t, tp)}% interview ready`}
                      {' · '}
                      {ago(tp?.lastWatchedAt ?? tp?.lastOpenedAt)}
                    </span>
                    <span className="progress-bar" aria-label={`${Math.round((t.video ? watched : readiness(t, tp) / 100) * 100)}% done`}>
                      <span style={{ width: `${(t.video ? watched : readiness(t, tp) / 100) * 100}%` }} />
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      <section className="home-section" aria-label="Videos">
        <h2>
          <Video size={19} /> Narrated videos
        </h2>
        <div className="video-row">
          {STATIC_TOPICS.filter((t) => t.video).map((t) => {
            const watched = videoFraction(p(t))
            return (
              <button key={t.id} type="button" className="video-tile" onClick={() => onOpen(t)}>
                <span className="video-thumb">
                  <img src={thumbnail(t)} alt="" loading="lazy" />
                  <Play className="video-tile-play" size={26} fill="currentColor" />
                  {watched > 0 && (
                    <span className="video-watched">
                      <span style={{ width: `${watched * 100}%` }} />
                    </span>
                  )}
                </span>
                <strong>{t.title}</strong>
                <span>{t.chapters ? `${t.chapters.length} chapters` : 'Video'}{watched >= 0.97 ? ' · watched' : ''}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="home-section" aria-label="Topics">
        <div className="section-head">
          <h2>Topics</h2>
          <div className="seg" role="group" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['in-progress', 'In progress'],
                ['bookmarked', 'Bookmarked'],
                ['completed', 'Completed'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="topic-cards">
          {shown.map((t) => {
            const Icon = topicIcon(t.id)
            const tp = p(t)
            const ready = readiness(t, tp)
            return (
              <button key={t.id} type="button" className="card topic-card" onClick={() => onOpen(t)}>
                <span className="topic-card-top">
                  <span className="topic-icon" aria-hidden>
                    <Icon size={24} />
                  </span>
                  <span className={`level is-${t.difficulty.toLowerCase()}`}>{t.difficulty}</span>
                  {tp?.bookmarked && <Bookmark className="card-flag" size={17} fill="currentColor" aria-label="Bookmarked" />}
                  {tp?.completed && <CheckCircle2 className="card-flag is-done" size={18} aria-label="Completed" />}
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
                <span className="card-ready">
                  <span className="progress-bar">
                    <span style={{ width: `${ready}%` }} />
                  </span>
                  {ready}% ready
                </span>
              </button>
            )
          })}
          {!shown.length && <p className="practice-empty">Nothing here yet.</p>}
        </div>
      </section>

      <LibraryList category={category} onCategory={onCategory} onOpen={onOpen} />
    </div>
  )
}

/** The whole syllabus: every guide and chapter, filterable by category, linking to the original. */
function LibraryList({ category, onCategory, onOpen }: { category: string | null; onCategory: (id: string | null) => void; onOpen: (topic: StaticTopic) => void }) {
  // Phones start with a shorter list; "Show more" loads the rest.
  const [limit, setLimit] = useState(() => (window.innerWidth < 640 ? 24 : 60))
  const guides = category ? LIBRARY.guides.filter((g) => g.categories.includes(category)) : LIBRARY.guides
  return (
    <section className="library home-section" id="library" aria-label="Library">
      <header className="library-head">
        <h2>
          <Library size={20} /> Library
        </h2>
        <p>
          {LIBRARY.guides.length} guides and chapters from open system design collections, our syllabus. Titles link to the originals; the ones
          marked Interactive are already Structura topics.
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
          const covered = topicForGuide(STATIC_TOPICS, g.slug)
          return (
            <li key={g.slug} className="guide">
              <a href={g.url} target="_blank" rel="noreferrer">
                {g.title} <ExternalLink size={13} aria-hidden />
              </a>
              <span className="guide-tags">{[sourceOf(g).name.split(' (')[0], ...g.tags.slice(0, 3)].join(' · ')}</span>
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
      <ul className="library-note">
        {Object.values(LIBRARY.sources).map((s) => (
          <li key={s.repo}>
            <a href={s.repo} target="_blank" rel="noreferrer">
              {s.name}
            </a>
            : {s.license}
          </li>
        ))}
      </ul>
    </section>
  )
}
