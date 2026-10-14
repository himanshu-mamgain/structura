import { useEffect, useRef, useState } from 'react'
import type { Explanation } from '@structura/shared'
import { ExplanationCard, type WalkState } from './ExplanationCard'
import { withSchemaSql } from './ddl'
import { buildSteps, focusStep, showWholeDiagram } from './walkthrough'
import { LoadPanel } from '../board/LoadPanel'
import { useBoard } from '../board/react'
import type { Board } from '../board/store'
import { STATIC_TOPICS, type StaticTopic } from '../topics'
import { openStaticTopic } from '../topics/open'
import { TopicsPanel } from '../topics/TopicsPanel'

/** Seconds a walkthrough step stays on screen: long enough to read it. */
const stepDuration = (text: string) => Math.max(3500, text.length * 60)

/**
 * The learning experience, with no AI involved: pick a hand-written topic, see
 * it in 3D, read its card, step through the flow, and load-test it.
 */
export function LearnPanel({ board }: { board: Board }) {
  useBoard(board)
  const topic = STATIC_TOPICS.find((t) => t.id === board.page.topicId) ?? null
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [showTopics, setShowTopics] = useState(false)
  const [showLoad, setShowLoad] = useState(false)
  const [walk, setWalk] = useState<WalkState | null>(null)
  const [error, setError] = useState('')
  const wasWalking = useRef(false)

  // The card follows the page: switching pages shows that topic's card.
  useEffect(() => {
    setWalk(null)
    setShowLoad(false)
    setExplanation(topic ? (topic.database ? withSchemaSql(topic.explanation, topic.database) : topic.explanation) : null)
  }, [topic])

  // Plays the walkthrough: focus the step's boxes, give time to read, move on.
  useEffect(() => {
    if (!walk) return
    const step = walk.steps[walk.index]
    focusStep(board, step)
    if (!walk.playing) return
    const timer = setTimeout(
      () => setWalk((w) => (w && w.index < w.steps.length - 1 ? { ...w, index: w.index + 1 } : w && { ...w, playing: false })),
      stepDuration(step.text),
    )
    return () => clearTimeout(timer)
  }, [board, walk])

  // When a walkthrough ends, step back to the whole diagram.
  useEffect(() => {
    if (walk) {
      wasWalking.current = true
      return
    }
    if (!wasWalking.current) return
    wasWalking.current = false
    showWholeDiagram(board)
  }, [board, walk])

  async function pickTopic(next: StaticTopic) {
    setShowTopics(false)
    setError('')
    try {
      await openStaticTopic(board, next)
    } catch (err) {
      console.error(err)
      setError(`Couldn't open ${next.title}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // A link like ?topic=url-shortener opens that topic (shareable); adding &load
  // also opens its load test, with any settings in the link (see LoadPanel).
  const openedFromLink = useRef(false)
  useEffect(() => {
    if (openedFromLink.current) return
    openedFromLink.current = true
    const query = new URLSearchParams(window.location.search)
    const linked = STATIC_TOPICS.find((t) => t.id === query.get('topic'))
    if (linked) void pickTopic(linked).then(() => query.has('load') && setShowLoad(true))
    // Runs once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startWalk(card: Explanation | null = explanation) {
    if (!card) return
    const steps = buildSteps(board, card)
    if (!steps.length) {
      setError('This card has no steps to walk through.')
      return
    }
    setError('')
    setWalk({ index: 0, steps, playing: true })
  }

  /** Runs the topic's flow on the user's own input, then steps through it. */
  function simulate(values: Record<string, string>) {
    if (!topic?.simulator || !explanation) return
    const card = { ...explanation, trace: topic.simulator.run(values) }
    setExplanation(card)
    startWalk(card)
  }

  /** "Learn next" links open a topic when there is a hand-written one for it. */
  function openRelated(name: string) {
    const wanted = name.toLowerCase().replace(/^explain\s+/, '')
    const match = STATIC_TOPICS.find((t) => t.title.toLowerCase().includes(wanted) || wanted.includes(t.title.toLowerCase()))
    if (match) void pickTopic(match)
    else setError(`No lesson for "${name}" yet.`)
  }

  return (
    <>
      {explanation && !showTopics && (
        <ExplanationCard
          explanation={explanation}
          streaming={false}
          walk={walk}
          canWalk={buildSteps(board, explanation).length > 0}
          simulator={topic?.simulator}
          onAsk={openRelated}
          onClose={() => {
            setWalk(null)
            setExplanation(null)
          }}
          onWalkStart={() => startWalk()}
          onWalkStep={(delta) =>
            setWalk((w) => w && { ...w, index: Math.min(w.steps.length - 1, Math.max(0, w.index + delta)), playing: false })
          }
          onWalkToggle={() => setWalk((w) => w && { ...w, playing: !w.playing })}
          onWalkStop={() => setWalk(null)}
          onSimulate={simulate}
        />
      )}
      {showLoad && topic?.loadTest && <LoadPanel board={board} test={topic.loadTest} onClose={() => setShowLoad(false)} />}
      {showTopics && <TopicsPanel onPick={(t) => void pickTopic(t)} onClose={() => setShowTopics(false)} />}

      <div className="assistant learn">
        <div className="assistant-header">
          <span className="assistant-status">{topic ? topic.title : 'Structura'}</span>
          <button type="button" className="assistant-icon-btn" onClick={() => setShowTopics(!showTopics)} aria-pressed={showTopics}>
            📚 Topics
          </button>
          {topic?.loadTest && (
            <button
              type="button"
              className="assistant-icon-btn"
              onClick={() => setShowLoad(!showLoad)}
              title="Put real load through this design"
              aria-pressed={showLoad}
            >
              ⚡ Load
            </button>
          )}
        </div>
        {!topic && <p className="assistant-reply">Pick a topic to explore it in 3D, step through how it works, and load-test it.</p>}
        {topic && !explanation && (
          <button type="button" className="assistant-chip" onClick={() => setExplanation(topic.explanation)}>
            Show the explanation
          </button>
        )}
        {error && <p className="assistant-error">{error}</p>}
      </div>
    </>
  )
}
