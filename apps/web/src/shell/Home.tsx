import { useState } from 'react'
import { Bookmark, CheckCircle2, Footprints, GraduationCap, Headphones, Play, Sparkles, Video, WifiOff, Zap } from 'lucide-react'
import { ago, readiness, type TopicProgress, useProgress, videoFraction } from '../learn/progress'
import course from '../learn/course.json'
import { fullCoverOnError, smallCover, TOPICS, type TopicMeta } from '../topics/catalog'
import { NotifyPrompt } from './Notifications'
import { ReelsRow } from './Reels'
import { RoadmapCard } from './RoadmapCard'
import { topicIcon } from './topicIcons'
import { TodayCard } from './VoiceGuide'
import { LESSONS, lessonTopics, useCommute } from '../learn/commute'

const thumbnail = (topic: TopicMeta) => (topic.video ? smallCover(topic.video) : undefined)
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

type Filter = 'all' | 'bookmarked' | 'in-progress' | 'completed'

/** The first screen: the reels, what Structura is, today's pick, where you left off and every topic. */
export function Home({
  onOpen,
  onPage,
  onReel,
}: {
  onOpen: (topic: TopicMeta) => void
  onPage: (page: 'quiz' | 'glossary' | 'listen' | 'reels' | 'explore' | 'roadmap') => void
  onReel: (id: string) => void
}) {
  const progress = useProgress()
  const [filter, setFilter] = useState<Filter>('all')
  const p = (t: TopicMeta): TopicProgress | undefined => progress.topics[t.id]

  const recent = TOPICS.filter((t) => p(t)?.lastOpenedAt)
    .sort((a, b) => (p(b)?.lastOpenedAt ?? 0) - (p(a)?.lastOpenedAt ?? 0))
    .slice(0, 3)
  const overall = Math.round(TOPICS.reduce((sum, t) => sum + readiness(t, p(t)), 0) / TOPICS.length)
  const completed = TOPICS.filter((t) => p(t)?.completed).length
  const shown = TOPICS.filter((t) => {
    const tp = p(t)
    if (filter === 'bookmarked') return tp?.bookmarked
    if (filter === 'completed') return tp?.completed
    if (filter === 'in-progress') return tp?.lastOpenedAt && !tp.completed
    return true
  })

  return (
    <div className="home">
      <ReelsRow onPlay={onReel} onAll={() => onPage('reels')} />

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
          {/* New learners start with the roadmap; everyone else carries on where they were. */}
          <button type="button" className="btn btn-primary btn-wrap" onClick={() => (recent[0] ? onOpen(recent[0]) : onPage('roadmap'))}>
            <Play size={16} fill="currentColor" /> {recent[0] ? `Continue ${recent[0].title}` : 'Start the roadmap'}
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
              {completed}/{TOPICS.length}
            </dd>
          </div>
          <div>
            <dt>Best quiz score</dt>
            <dd>{progress.quizBest !== undefined ? `${progress.quizBest}/${course.quiz.length}` : '—'}</dd>
          </div>
        </dl>
      </section>

      <RoadmapCard onRoadmap={() => onPage('roadmap')} />
      <TodayCard onOpen={onOpen} />
      <NotifyPrompt />
      <CommuteCard onPage={onPage} />

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
                    {thumbnail(t) ? <img src={thumbnail(t)} alt="" loading="lazy" onError={fullCoverOnError} /> : <Icon size={30} />}
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
                  {/* simulator first: on a loaded topic, reading trace would run the simulator */}
                  {Boolean(t.simulator || t.explanation.trace) && (
                    <span>
                      <Footprints size={13} /> Walkthrough
                    </span>
                  )}
                  {Boolean(t.loadTest) && (
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

      <p className="home-more">
        More to read: the full library of guides is in{' '}
        <button type="button" className="link-btn" onClick={() => onPage('explore')}>
          Explore
        </button>
        .
      </p>
    </div>
  )
}

/** Home's way into Commute mode: the audio course, its length, and where you left off. */
function CommuteCard({ onPage }: { onPage: (page: 'listen') => void }) {
  const commute = useCommute()
  const topics = lessonTopics()
  if (!topics.length) return null
  const total = Object.values(LESSONS.topics).reduce((n, t) => n + t.duration, 0)
  const current = TOPICS.find((t) => t.id === commute.topicId)
  return (
    <button type="button" className="card commute-card" onClick={() => onPage('listen')}>
      <span className="commute-card-icon">
        <Headphones size={26} />
      </span>
      <span className="commute-card-text">
        <strong>Commute mode</strong>
        <span>
          {topics.length} audio lessons · {Math.round(total / 60)} min · <WifiOff size={13} /> works offline, screen off
        </span>
        {current && <span className="commute-card-resume">Resume: {current.title}</span>}
      </span>
      <Play size={20} fill="currentColor" />
    </button>
  )
}
