import { CopyLink } from './Share'
import { type TouchEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, Check, CheckCircle2, Lightbulb, RotateCcw, Shapes, Trophy, X } from 'lucide-react'
import { Diagram2D } from '../diagram/Diagram2D'
import { responsibility, subtitleOf } from '../diagram/inspect'
import { updateTopic, useProgress } from '../learn/progress'
import { nextTopicAfter } from '../learn/roadmap'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import { hasLesson, loadLesson } from '../topics/lessonsIndex'
import { reloadForNewVersion } from '../pwa/updates'
import type { Lesson as LessonData } from '../topics/lessonTypes'
import type { StaticTopic } from '../topics/types'

// Lesson mode (?topic=<id>&learn): a topic as a short, swipeable lesson. Each card is a
// few sentences in simple English with the hand-drawn diagram beside it, lighting up
// the boxes the card is about; three quick questions close it. Phones stack the diagram
// over the card; tablets and wider put them side by side.

export function Lesson({
  topic,
  onExit,
  onRead,
  onLearn,
}: {
  topic: StaticTopic
  onExit: () => void
  onRead: () => void
  onLearn: (next: TopicMeta) => void
}) {
  const [lesson, setLesson] = useState<LessonData | null>(null)
  const [failed, setFailed] = useState<'missing' | 'error' | null>(null)
  const saved = useProgress().topics[topic.id]

  useEffect(() => {
    let live = true
    setLesson(null)
    setFailed(null)
    loadLesson(topic.id).then(
      (l) => live && (l ? setLesson(l) : setFailed('missing')),
      () => live && !reloadForNewVersion() && setFailed('error'),
    )
    updateTopic(topic.id, { lastOpenedAt: Date.now() })
    return () => {
      live = false
    }
  }, [topic.id])

  if (failed === 'missing')
    return (
      <div className="practice-empty">
        <p>This topic doesn't have a lesson yet.</p>
        <button type="button" className="btn" onClick={onRead}>Read it instead</button>
      </div>
    )
  if (failed === 'error')
    return (
      <div className="practice-empty">
        <p>Couldn't load the lesson. Check your connection, or reload to get the latest version.</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  if (!lesson) return <p className="practice-empty">Loading the lesson…</p>
  return <Player topic={topic} lesson={lesson} start={saved?.lessonDone ? 0 : Math.min(saved?.lessonStep ?? 0, lesson.cards.length - 1)} onExit={onExit} onRead={onRead} onLearn={onLearn} />
}

function Player({
  topic,
  lesson,
  start,
  onExit,
  onRead,
  onLearn,
}: {
  topic: StaticTopic
  lesson: LessonData
  start: number
  onExit: () => void
  onRead: () => void
  onLearn: (next: TopicMeta) => void
}) {
  const cards = lesson.cards
  // 0 … cards.length - 1 are the cards, then the quiz, then the end.
  const [step, setStep] = useState(start)
  const [q, setQ] = useState(0)
  const [picked, setPicked] = useState<number | null>(null)
  const [score, setScore] = useState(0)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const inQuiz = step === cards.length
  const atEnd = step > cards.length
  const card = cards[Math.min(step, cards.length - 1)]
  const total = cards.length + 1

  const subtitles = useMemo(
    () => Object.fromEntries(topic.architecture.nodes.map((n) => [n.id, subtitleOf(responsibility(topic, n.label))]).filter(([, v]) => v)) as Record<string, string>,
    [topic],
  )

  // Remember where the learner is, so the lesson opens there next time.
  useEffect(() => {
    if (step < cards.length) updateTopic(topic.id, { lessonStep: step })
  }, [step, topic.id, cards.length])

  function go(to: number) {
    setStep(Math.max(0, Math.min(cards.length, to)))
    // A new card starts at the top, with its diagram in view.
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Arrow keys move between cards on a keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inQuiz || atEnd) return
      if (e.key === 'ArrowRight') go(step + 1)
      if (e.key === 'ArrowLeft') go(step - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // A swipe across the card goes to the next or previous one (the diagram itself pans).
  const onTouchStart = (e: TouchEvent) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })
  const onTouchEnd = (e: TouchEvent) => {
    const t = touch.current
    touch.current = null
    if (!t || inQuiz || atEnd) return
    const dx = e.changedTouches[0].clientX - t.x
    const dy = e.changedTouches[0].clientY - t.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(step + (dx < 0 ? 1 : -1))
  }

  function answer(i: number) {
    if (picked !== null) return
    setPicked(i)
    if (i === lesson.quiz[q].answer) setScore((s) => s + 1)
  }

  function nextQuestion() {
    if (q < lesson.quiz.length - 1) {
      setQ(q + 1)
      setPicked(null)
      return
    }
    const final = score
    updateTopic(topic.id, (p) => ({ lessonDone: true, lessonStep: 0, lessonScore: Math.max(final, p.lessonScore ?? 0) }))
    setStep(cards.length + 1)
  }

  function restart() {
    setQ(0)
    setPicked(null)
    setScore(0)
    go(0)
  }

  return (
    <div className="lesson">
      <header className="lesson-bar">
        <button type="button" className="icon-btn" onClick={onExit} aria-label="Close the lesson">
          <X size={18} />
        </button>
        <div className="lesson-bar-title">
          <strong>{topic.title}</strong>
          <span className="lesson-progress" aria-label={`Step ${Math.min(step + 1, total)} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={i < step ? 'is-done' : i === step ? 'is-here' : ''} />
            ))}
          </span>
        </div>
        <CopyLink className="icon-btn" iconOnly size={18} />
        <span className="lesson-count">{atEnd ? 'Done' : inQuiz ? 'Quiz' : `${step + 1}/${cards.length}`}</span>
      </header>

      <div className={`lesson-body${inQuiz || atEnd ? ' is-quiz' : ''}`}>
        <figure className="lesson-figure" aria-label="Diagram">
          <Diagram2D diagram={topic.architecture} focus={inQuiz || atEnd ? null : (card.focus ?? null)} subtitles={subtitles} fitAll focusFit />
        </figure>

        <section className="lesson-panel" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {!inQuiz && !atEnd && (
            <>
              <div className="lesson-card" key={step}>
                <p className="lesson-kicker">
                  Step {step + 1} of {cards.length}
                </p>
                <h2>{card.title}</h2>
                <p className="lesson-words">{card.text}</p>
                {card.example && <pre className="lesson-example">{card.example}</pre>}
                {card.remember && (
                  <p className="lesson-remember">
                    <Lightbulb size={17} aria-hidden /> {card.remember}
                  </p>
                )}
              </div>
              <nav className="lesson-nav">
                <button type="button" className="btn" onClick={() => go(step - 1)} disabled={step === 0}>
                  <ArrowLeft size={17} /> Back
                </button>
                <button type="button" className="btn btn-primary" onClick={() => go(step + 1)}>
                  {step === cards.length - 1 ? 'Quick check' : 'Next'} <ArrowRight size={17} />
                </button>
              </nav>
            </>
          )}

          {inQuiz && (
            <>
              <div className="lesson-card" key={`q${q}`}>
                <p className="lesson-kicker">
                  Quick check · {q + 1} of {lesson.quiz.length}
                </p>
                <h2>{lesson.quiz[q].question}</h2>
                <ol className="lesson-options">
                  {lesson.quiz[q].options.map((option, i) => {
                    const state = picked === null ? '' : i === lesson.quiz[q].answer ? ' is-right' : i === picked ? ' is-wrong' : ' is-other'
                    return (
                      <li key={i}>
                        <button type="button" className={`lesson-option${state}`} onClick={() => answer(i)} disabled={picked !== null}>
                          {option}
                          {picked !== null && i === lesson.quiz[q].answer && <Check size={18} aria-label="Right answer" />}
                        </button>
                      </li>
                    )
                  })}
                </ol>
                {picked !== null && (
                  <p className={`lesson-why${picked === lesson.quiz[q].answer ? ' is-right' : ''}`}>
                    <strong>{picked === lesson.quiz[q].answer ? 'Right. ' : 'Not quite. '}</strong>
                    {lesson.quiz[q].why}
                  </p>
                )}
              </div>
              <nav className="lesson-nav">
                <button type="button" className="btn" onClick={() => go(cards.length - 1)}>
                  <ArrowLeft size={17} /> Cards
                </button>
                <button type="button" className="btn btn-primary" onClick={nextQuestion} disabled={picked === null}>
                  {q < lesson.quiz.length - 1 ? 'Next question' : 'Finish'} <ArrowRight size={17} />
                </button>
              </nav>
            </>
          )}

          {atEnd && <End topic={topic} score={score} out={lesson.quiz.length} onRestart={restart} onRead={onRead} onExit={onExit} onLearn={onLearn} />}
        </section>
      </div>
    </div>
  )
}

function End({
  topic,
  score,
  out,
  onRestart,
  onRead,
  onExit,
  onLearn,
}: {
  topic: StaticTopic
  score: number
  out: number
  onRestart: () => void
  onRead: () => void
  onExit: () => void
  onLearn: (next: TopicMeta) => void
}) {
  const progress = useProgress().topics[topic.id]
  // The next topic in the roadmap that has a lesson too.
  let nextId = nextTopicAfter(topic.id)
  while (nextId && !hasLesson(nextId)) nextId = nextTopicAfter(nextId)
  const next = nextId ? TOPICS.find((t) => t.id === nextId) : undefined
  return (
    <div className="lesson-card lesson-end">
      <Trophy size={34} className="lesson-trophy" aria-hidden />
      <h2>Lesson done</h2>
      <p className="lesson-words">
        You got {score} of {out} right. {score === out ? 'Well done.' : 'Look at the cards again any time, or read the full article.'}
      </p>
      <div className="lesson-end-actions">
        {next && (
          <button type="button" className="btn btn-primary btn-wrap" onClick={() => onLearn(next)}>
            <span>
              <small>Next lesson</small> {next.title}
            </span>
            <ArrowRight size={16} />
          </button>
        )}
        <button
          type="button"
          className={`btn${progress?.completed ? ' is-on' : ''}`}
          onClick={() => updateTopic(topic.id, (p) => ({ completed: !p.completed, completedAt: p.completed ? undefined : Date.now() }))}
        >
          <CheckCircle2 size={17} /> {progress?.completed ? 'Completed' : 'Mark complete'}
        </button>
        <button type="button" className="btn" onClick={onRead}>
          <BookOpenText size={17} /> Read the full article
        </button>
        <button type="button" className="btn" onClick={onExit}>
          <Shapes size={17} /> Try it yourself
        </button>
        <button type="button" className="btn btn-ghost" onClick={onRestart}>
          <RotateCcw size={16} /> Start again
        </button>
      </div>
    </div>
  )
}
