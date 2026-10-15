import { useState } from 'react'
import { BookA, Check, RotateCcw, Search, Trophy, X } from 'lucide-react'
import course from '../learn/course.json'
import { recordQuiz } from '../learn/progress'

// Practice pages built from Mominur Rahman's System Design 101 course (MIT):
// a quiz and a glossary. The credit and MIT notice show under each.

function Credit() {
  return (
    <p className="practice-credit">
      From the{' '}
      <a href={course.source.repo} target="_blank" rel="noreferrer">
        {course.source.name}
      </a>
      , used under the{' '}
      <a href={course.source.notice} target="_blank" rel="noreferrer">
        MIT licence
      </a>
      .
    </p>
  )
}

/** One question at a time: pick an answer, see why, move on, get a score. */
export function Quiz() {
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState<number | null>(null)
  const [score, setScore] = useState(0)
  const done = index >= course.quiz.length
  const q = course.quiz[index]

  function pick(option: number) {
    if (picked !== null) return
    setPicked(option)
    const next = option === q.correct ? score + 1 : score
    setScore(next)
    if (index === course.quiz.length - 1) recordQuiz(next)
  }

  function restart() {
    setIndex(0)
    setPicked(null)
    setScore(0)
  }

  return (
    <div className="practice">
      <header className="practice-head">
        <h1>Quiz</h1>
        <p>{course.quiz.length} questions on the fundamentals. Pick an answer to see the explanation.</p>
      </header>

      {done ? (
        <section className="card quiz-card quiz-done">
          <Trophy size={40} />
          <h2>
            {score} / {course.quiz.length}
          </h2>
          <p>{score === course.quiz.length ? 'Perfect score.' : score >= course.quiz.length * 0.7 ? 'Solid. Review the ones you missed.' : 'Worth another pass: open the related topics, then try again.'}</p>
          <button type="button" className="btn btn-primary" onClick={restart}>
            <RotateCcw size={16} /> Try again
          </button>
        </section>
      ) : (
        <section className="card quiz-card" aria-live="polite">
          <div className="quiz-progress">
            <span>
              Question {index + 1} of {course.quiz.length}
            </span>
            <span>Score {score}</span>
          </div>
          <div className="quiz-bar">
            <div style={{ width: `${(index / course.quiz.length) * 100}%` }} />
          </div>
          <h2>{q.question}</h2>
          <div className="quiz-options">
            {q.options.map((option, i) => {
              const state = picked === null ? '' : i === q.correct ? ' is-correct' : i === picked ? ' is-wrong' : ' is-faded'
              return (
                <button key={i} type="button" className={`quiz-option${state}`} onClick={() => pick(i)} disabled={picked !== null}>
                  <span className="quiz-letter">{'ABCD'[i]}</span>
                  <span>{option}</span>
                  {picked !== null && i === q.correct && <Check size={18} />}
                  {picked === i && i !== q.correct && <X size={18} />}
                </button>
              )
            })}
          </div>
          {picked !== null && (
            <>
              <p className="quiz-explanation">{q.explanation}</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setIndex(index + 1)
                  setPicked(null)
                }}
              >
                {index + 1 < course.quiz.length ? 'Next question' : 'See my score'}
              </button>
            </>
          )}
        </section>
      )}
      <Credit />
    </div>
  )
}

/** Every term, grouped by section, with a filter. */
export function Glossary() {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const terms = course.glossary.filter((t) => !q || `${t.term} ${t.def}`.toLowerCase().includes(q))
  const sections = [...new Set(terms.map((t) => t.section))]
  return (
    <div className="practice">
      <header className="practice-head">
        <h1>Glossary</h1>
        <p>{course.glossary.length} terms you will meet in every system design discussion.</p>
      </header>
      <div className="search glossary-search">
        <Search size={17} aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter terms…" aria-label="Filter terms" />
      </div>
      {sections.map((section) => (
        <section key={section} className="glossary-section">
          <h2>
            <BookA size={18} /> {section}
          </h2>
          <dl className="glossary">
            {terms
              .filter((t) => t.section === section)
              .map((t) => (
                <div key={t.term} className="card glossary-term">
                  <dt>{t.term}</dt>
                  <dd>{t.def}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
      {!terms.length && <p className="practice-empty">No term matches “{query}”.</p>}
      <Credit />
    </div>
  )
}
