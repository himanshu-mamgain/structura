import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, BookOpenText, Check, Cpu, Headphones, MousePointerClick, Route, Volume2, Bookmark, BookmarkCheck, BookOpen, Box, CheckCircle2, ChevronLeft, ChevronRight, Circle, Code2, Database, ExternalLink, Footprints, GraduationCap, Lightbulb, Pause, Play, Power, Square, Video, X, Zap } from 'lucide-react'
import type { Trace } from '@structura/shared'
import { Diagram2D } from '../diagram/Diagram2D'
import { failureEffect, responsibilitiesOf, responsibility, sameComponent, stepsThrough, subtitleOf, technologiesOf } from '../diagram/inspect'
import { iconFor } from '../diagram/icons'
import type { LoadStats } from '../sim/LoadPanel'
import { Body, CodeBlock, SimulatorForm } from '../learn/content'
import { Parts, TopicLink, topicNamed, useLinkedList } from '../learn/Linked'
import { erdToSql } from '../learn/ddl'
import { readiness, updateTopic, useProgress } from '../learn/progress'
import { readingMinutes, storyText, StoryView } from '../learn/story'
import { speak, speechSupported, stopSpeaking, useNowSpeaking } from '../learn/speech'
import type { WalkCommand } from '../learn/assistant'
import { erdToDbml, schemaSnippet } from '../learn/dbml'
import type { StaticTopic } from '../topics'
import { guidesFor, sourceOf } from '../topics/library'
import { hasLesson, lessonLabel } from '../topics/lessonsIndex'
import { NoteBox, TopicNotes } from './Notes'
import { ShareWhatsApp } from './Share'
import { OfflineVideoButton } from './OfflineVideo'
import { VoiceSettingsButton } from './VoiceGuide'
import { Karaoke } from './VoiceAssistant'
import type { AreaId } from '../topics/areas'
import { AreaTag } from './Areas'
import { topicIcon } from './topicIcons'
import { ecoLinks } from '../ecosystem'

// The load test (the Rust/WASM simulator) loads on first use.
const LoadPanel = lazy(() => import('../sim/LoadPanel').then((m) => ({ default: m.LoadPanel })))
// The ERD viewer (React Flow) loads only when someone opens the data model.
const DataModel = lazy(() => import('../diagram/DataModel'))

type Tab = 'story' | 'explain' | 'walk' | 'code' | 'data'

/** Seconds a walkthrough step stays on screen: long enough to read it. */
const stepDuration = (text: string) => Math.max(3500, text.length * 60)
const isCache = (label: string) => /cache|redis|cdn/i.test(label)
/** A short title for a step: the text before a colon ("Issue JWT: …"), or the boxes it involves. */
const stepTitle = (step: { text: string; nodes: string[] }) => {
  const colon = step.text.indexOf(':')
  if (colon > 0 && colon < 42) return step.text.slice(0, colon)
  return step.nodes.slice(0, 2).join(' → ') || `${step.text.split(' ').slice(0, 5).join(' ')}…`
}
const SPEEDS = [1, 1.5, 2]
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function useNarrow() {
  const query = '(max-width: 760px)'
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

/**
 * One topic, laid out like a study dashboard: the hand-drawn diagram,
 * the narrated video with chapters, the explanation with a walkthrough, code
 * and data model, and the key takeaways. Mounted fresh for each topic.
 */
export function TopicView({
  topic,
  openLoad = false,
  onNote,
  onRead,
  onLearn,
  onArea,
}: {
  topic: StaticTopic
  openLoad?: boolean
  onNote?: (id: string) => void
  onRead?: () => void
  onLearn?: () => void
  onArea?: (area: AreaId) => void
}) {
  const narrow = useNarrow()
  const [diagramView, setDiagramView] = useState<'architecture' | 'data'>('architecture')
  // A review reminder (?review) opens the interview follow-ups, to answer without looking;
  // otherwise a topic with a story opens on it.
  const [review] = useState(() => new URLSearchParams(window.location.search).has('review'))
  const [tab, setTab] = useState<Tab>(topic.story && !review ? 'story' : 'explain')
  const [section, setSection] = useState(() => (review ? Math.max(0, topic.explanation.sections.findIndex((s) => /interview/i.test(s.heading))) : 0))
  const [trace, setTrace] = useState<Trace | null>(topic.explanation.trace)
  const [walk, setWalk] = useState<{ index: number; playing: boolean } | null>(null)
  const [showLoad, setShowLoad] = useState(openLoad && Boolean(topic.loadTest))
  const [load, setLoad] = useState<LoadStats | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [videoTime, setVideoTime] = useState(0)
  // The voice guide: intro (summary), then the walkthrough spoken step by step, then the takeaways.
  const [tour, setTour] = useState<'off' | 'intro' | 'walk' | 'outro'>('off')
  const [walkSpeed, setWalkSpeed] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const video = useRef<HTMLVideoElement>(null)
  const content = useRef<HTMLElement>(null)
  const diagramCard = useRef<HTMLElement>(null)
  const lastSaved = useRef(0)
  const Icon = topicIcon(topic.id)
  const progress = useProgress().topics[topic.id]
  const ready = readiness(topic, progress)

  // Progress: when the topic was opened, which sections were read.
  useEffect(() => updateTopic(topic.id, { lastOpenedAt: Date.now() }), [topic.id])
  useEffect(() => {
    if (tab !== 'explain') return
    updateTopic(topic.id, (p) => ({ sectionsRead: [...new Set([...(p.sectionsRead ?? []), section])] }))
  }, [topic.id, tab, section])

  function saveVideo(v: HTMLVideoElement) {
    lastSaved.current = Date.now()
    updateTopic(topic.id, { videoTime: v.currentTime, videoDuration: v.duration, lastWatchedAt: Date.now() })
  }

  const explanation = topic.explanation
  const steps = trace?.steps ?? []
  const architecture = useMemo(() => (narrow ? { ...topic.architecture, direction: 'down' as const } : topic.architecture), [topic, narrow])
  // One line under each component's name: the start of its description in "Components".
  const subtitles = useMemo(
    () => Object.fromEntries(topic.architecture.nodes.map((n) => [n.id, subtitleOf(responsibility(topic, n.label))]).filter(([, v]) => v)) as Record<string, string>,
    [topic],
  )
  const sql = useMemo(() => (topic.database ? erdToSql(topic.database) : null), [topic])
  const dbml = useMemo(() => (topic.database ? erdToDbml(topic.database) : null), [topic])
  // First mentions of what other topics teach link there (learn/links.ts).
  const [summaryLinks] = useLinkedList([explanation.summary], topic.id)
  const takeawayLinks = useLinkedList(topic.takeaways, topic.id)

  // Walkthrough: focus the step, wait long enough to read, move on.
  useEffect(() => {
    if (!walk) return
    const step = steps[walk.index]
    if (!step) return
    if (walk.index === steps.length - 1) updateTopic(topic.id, { walked: true })
    if (!walk.playing) {
      if (tour === 'walk') stopSpeaking()
      return
    }
    if (tour === 'walk') {
      let current = true
      void speak(`Step ${walk.index + 1}. ${step.text}`, { source: `step:${topic.id}:${walk.index}`, title: topic.title }).then((done) => {
        if (!done || !current) return
        if (walk.index < steps.length - 1) setWalk((w) => w && { ...w, index: w.index + 1 })
        else {
          setTour('outro')
          void speak(`That's the whole flow. Key takeaways. ${topic.takeaways.join(' ')}`, { source: `takeaways:${topic.id}`, title: topic.title }).then(() => setTour('off'))
        }
      })
      return () => {
        current = false
      }
    }
    const timer = setTimeout(
      () => setWalk((w) => (w && w.index < steps.length - 1 ? { ...w, index: w.index + 1 } : w && { ...w, playing: false })),
      stepDuration(step.text) / walkSpeed,
    )
    return () => clearTimeout(timer)
  }, [walk, steps, topic, tour, walkSpeed])

  // Leaving the topic, or stopping the walkthrough mid-tour, ends the voice.
  const tourRef = useRef(tour)
  tourRef.current = tour
  useEffect(
    () => () => {
      if (tourRef.current !== 'off') stopSpeaking()
    },
    [],
  )

  // The voice assistant drives the walkthrough with commands (see learn/assistant.ts).
  useEffect(() => {
    const onCommand = (e: Event) => {
      const c = (e as CustomEvent<WalkCommand>).detail
      if (c.cmd === 'tour') void startTourRef.current()
      else if (c.cmd === 'start') startWalkRef.current(0)
      else if (c.cmd === 'stop') {
        stopSpeaking()
        setTour('off')
        setWalk(null)
      } else if (c.cmd === 'step') setWalk({ index: Math.max(0, Math.min(steps.length - 1, c.index)), playing: tourRef.current === 'walk' })
      else if (c.cmd === 'next') setWalk((w) => (w ? { ...w, index: Math.min(steps.length - 1, w.index + 1) } : { index: 0, playing: false }))
      else if (c.cmd === 'back') setWalk((w) => (w ? { ...w, index: Math.max(0, w.index - 1) } : w))
      else if (c.cmd === 'pause') setWalk((w) => w && { ...w, playing: false })
      else if (c.cmd === 'resume') setWalk((w) => w && { ...w, playing: true })
    }
    window.addEventListener('structura:walk', onCommand)
    return () => window.removeEventListener('structura:walk', onCommand)
  }, [steps.length])
  useEffect(() => {
    if (!walk && tour === 'walk') {
      stopSpeaking()
      setTour('off')
    }
  }, [walk, tour])

  const startTourRef = useRef<() => Promise<void>>(async () => {})
  const startWalkRef = useRef<(from?: number) => void>(() => {})
  async function startTour() {
    if (tour !== 'off') {
      stopSpeaking()
      setTour('off')
      setWalk(null)
      return
    }
    setWalk(null)
    setTour('intro')
    setDiagramView('architecture')
    const intro = `${topic.title}. ${explanation.summary}${steps.length ? ` Let's follow one request through the design, step by step.` : ''}`
    const done = await speak(intro, { source: `topic:${topic.id}`, title: topic.title })
    if (!done) return
    if (steps.length) {
      setTour('walk')
      startWalk(0)
    } else setTour('off')
  }

  /** A story chapter's "replay" button: run the simulator with its inputs and play it on the diagram. */
  function replay(values: Record<string, string>) {
    if (!topic.simulator) return
    setTrace(topic.simulator.run(values))
    setDiagramView('architecture')
    setWalk({ index: 0, playing: true })
    diagramCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function startWalk(from = 0) {
    setTab('walk')
    setDiagramView('architecture')
    setWalk({ index: from, playing: true })
  }

  function go(to: Tab, sectionIndex?: number) {
    setTab(to)
    if (sectionIndex !== undefined) setSection(sectionIndex)
    if (to === 'data') setDiagramView('data')
    content.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function watch() {
    const v = video.current
    if (!v) return
    v.scrollIntoView({ behavior: 'smooth', block: 'center' })
    void v.play()
  }

  const showData = diagramView === 'data' && topic.database !== null
  const nodes = topic.architecture.nodes
  const edges = topic.architecture.edges
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id
  const inspected = selected && !showData ? (nodes.find((n) => n.id === selected) ?? null) : null
  const inspectedIn = inspected ? edges.filter((e) => e.to === inspected.id) : []
  const inspectedOut = inspected ? edges.filter((e) => e.from === inspected.id) : []
  const inspectedSteps = inspected ? stepsThrough(trace, inspected.label) : []
  const failedLabels = topic.architecture.nodes.filter((n) => failed.has(n.id)).map((n) => n.label)
  const resumeAt = progress?.videoTime && progress.videoTime > 5 && progress.videoTime < (progress.videoDuration ?? 0) - 5 ? progress.videoTime : 0

  function toggleFailure(id: string) {
    setFailed((f) => {
      const next = new Set(f)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  startTourRef.current = startTour
  startWalkRef.current = startWalk
  const now = useNowSpeaking()
  const step = walk ? steps[walk.index] : null
  const downInStep = step ? failedLabels.filter((l) => step.nodes.some((n) => sameComponent(n, l))) : []
  const focus = step && diagramView === 'architecture' ? step.nodes : null
  const chapterIndex = topic.chapters ? topic.chapters.findLastIndex(([start]) => videoTime >= start) : -1

  return (
    <div className="topic-view">
      <header className="topic-head">
        <span className="topic-icon" aria-hidden>
          <Icon size={26} />
        </span>
        <div className="topic-heading">
          <h1>{topic.title}</h1>
          <div className="topic-meta">
            <AreaTag topicId={topic.id} onArea={onArea} />
            <span className={`level is-${topic.difficulty.toLowerCase()}`}>{topic.difficulty}</span>
            <span className="readiness" title="Interview readiness: sections read, walkthrough, video and completion">
              <span className="readiness-bar">
                <span style={{ width: `${ready}%` }} />
              </span>
              {ready}% interview ready
            </span>
          </div>
          <p>
            <Parts parts={summaryLinks} read={false} />
          </p>
          {topic.story && (
            <button type="button" className="story-teaser" onClick={() => go('story')}>
              <BookOpenText size={18} aria-hidden />
              <span>
                <small>Story · {readingMinutes(topic.story)} min read</small>
                {topic.story.title}
              </span>
              <ChevronRight size={18} aria-hidden />
            </button>
          )}
          {topic.adaptedFrom && (
            <p className="credit">
              Adapted from{' '}
              <a href={topic.adaptedFrom.url} target="_blank" rel="noreferrer">
                {topic.adaptedFrom.title}
              </a>{' '}
              by {topic.adaptedFrom.author}, licensed{' '}
              <a href={topic.adaptedFrom.licenseUrl} target="_blank" rel="noreferrer">
                {topic.adaptedFrom.license}
              </a>
              . Changes: walkthrough, simulator, code and diagram are Structura's.
            </p>
          )}
        </div>
        <div className="topic-actions">
          {onLearn && hasLesson(topic.id) && (
            <button type="button" className="btn btn-primary" onClick={onLearn} title="Learn it in short steps, then a quick check">
              <GraduationCap size={17} /> {lessonLabel(progress)}
            </button>
          )}
          {onRead && (
            <button type="button" className="btn" onClick={onRead} title="Read the whole topic as one article">
              <BookOpen size={17} /> Read
            </button>
          )}
          {speechSupported && (
            <>
              <button type="button" className={`btn${tour !== 'off' ? ' is-on' : ''}`} onClick={() => void startTour()}>
                {tour !== 'off' ? <Square size={15} /> : <Headphones size={17} />} {tour !== 'off' ? 'Stop guide' : 'Listen'}
              </button>
              <VoiceSettingsButton />
            </>
          )}
          <button
            type="button"
            className={`icon-btn${progress?.bookmarked ? ' is-on' : ''}`}
            onClick={() => updateTopic(topic.id, (p) => ({ bookmarked: !p.bookmarked }))}
            aria-pressed={Boolean(progress?.bookmarked)}
            title={progress?.bookmarked ? 'Remove bookmark' : 'Bookmark'}
          >
            {progress?.bookmarked ? <BookmarkCheck size={19} /> : <Bookmark size={19} />}
          </button>
          <ShareWhatsApp text={`${topic.title} on Structura: ${topic.blurb}`} path={`/topic/${topic.id}/`} className="btn btn-ghost" />
          <button
            type="button"
            className={`btn btn-ghost${progress?.completed ? ' is-on' : ''}`}
            onClick={() => updateTopic(topic.id, (p) => ({ completed: !p.completed, completedAt: p.completed ? undefined : Date.now() }))}
            aria-pressed={Boolean(progress?.completed)}
          >
            {progress?.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />} {progress?.completed ? 'Completed' : 'Mark complete'}
          </button>
          {/* Your DSA Atlas problems linked to this topic (DSA Atlas keeps them on your device). */}
          <a className="btn btn-ghost" href={ecoLinks.dsaProblemsForTopic(topic.id)} target="_blank" rel="noreferrer" title="Open the DSA Atlas problems you linked to this topic">
            <Code2 size={17} /> Practice DSA
          </a>
          {topic.video && (
            <button type="button" className="btn btn-primary" onClick={watch}>
              <Play size={16} fill="currentColor" />
              {resumeAt ? `Resume ${clock(resumeAt)}` : `Watch video${duration ? ` (${clock(duration)})` : ''}`}
            </button>
          )}
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {topic.story && (
          <button type="button" className={tab === 'story' ? 'is-active' : ''} onClick={() => go('story')}>
            Story
          </button>
        )}
        {explanation.sections.map((s, i) => (
          <button key={s.heading} type="button" className={tab === 'explain' && section === i ? 'is-active' : ''} onClick={() => go('explain', i)}>
            {s.heading}
          </button>
        ))}
        {steps.length > 0 && (
          <button type="button" className={tab === 'walk' ? 'is-active' : ''} onClick={() => go('walk')}>
            Walkthrough
          </button>
        )}
        {explanation.code.length > 0 && (
          <button type="button" className={tab === 'code' ? 'is-active' : ''} onClick={() => go('code')}>
            Code
          </button>
        )}
        {sql && (
          <button type="button" className={tab === 'data' ? 'is-active' : ''} onClick={() => go('data')}>
            Schema
          </button>
        )}
      </nav>

      <div className={`topic-grid${topic.video || showLoad ? '' : ' no-side'}`}>
        <section className="card diagram-card" aria-label="Diagram" ref={diagramCard}>
          <header className="card-head">
            <div className="seg" role="group" aria-label="Diagram">
              <button type="button" aria-pressed={diagramView === 'architecture'} onClick={() => setDiagramView('architecture')}>
                <Box size={15} /> Architecture
              </button>
              {topic.database && (
                <button type="button" aria-pressed={diagramView === 'data'} onClick={() => setDiagramView('data')}>
                  <Database size={15} /> Data model
                </button>
              )}
            </div>
            <div className="card-tools">
              {topic.loadTest && (
                <button
                  type="button"
                  className={`btn btn-ghost${showLoad ? ' is-on' : ''}`}
                  onClick={() => {
                    setShowLoad(!showLoad)
                    setDiagramView('architecture')
                  }}
                  title="Put real load through this design"
                >
                  <Zap size={15} /> Load test
                </button>
              )}
            </div>
          </header>
          <div className={`diagram-stage${inspected ? ' has-inspector' : ''}`}>
            <div className="diagram-body">
              {showData && topic.database ? (
                <Suspense fallback={<p className="d2-loading">Loading the data model…</p>}>
                  <DataModel erd={topic.database} narrow={narrow} />
                </Suspense>
              ) : (
                <Diagram2D
                  diagram={architecture}
                  focus={focus}
                  selected={selected}
                  failed={failed}
                  onSelect={setSelected}
                  subtitles={subtitles}
                  load={showLoad ? load : null}
                  // During a load test, show the whole design (wide screens), so every box's busy badge is in view.
                  fitAll={showLoad && !narrow}
                />
              )}
              <AnimatePresence>
                {(tour === 'intro' || tour === 'outro') && (
                  <motion.div
                    className="walk-caption voice-caption"
                    aria-live="polite"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 16 }}
                  >
                    <span className="walk-count">
                      <Headphones size={14} />
                    </span>
                    <p>
                      {now.speaking && now.sentences[now.sentence] ? (
                        <Karaoke sentence={now.sentences[now.sentence]} word={now.word} />
                      ) : tour === 'intro' ? (
                        explanation.summary
                      ) : (
                        `Key takeaways: ${topic.takeaways[0]}`
                      )}
                    </p>
                    <div className="walk-buttons">
                      <button type="button" onClick={() => void startTour()} aria-label="Stop the voice guide">
                        <Square size={14} />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence>
              {inspected && (
                <motion.aside
                  key={inspected.id}
                  className="inspector-panel"
                  aria-label={`Component: ${inspected.label}`}
                  initial={{ opacity: 0, x: 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 40 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                >
                  {(() => {
                    const Icon = iconFor(inspected.label)
                    const description = responsibility(topic, inspected.label)
                    const duties = responsibilitiesOf(description)
                    const tech = technologiesOf(inspected.label, description)
                    return (
                      <>
                        <header>
                          <span className="ip-icon">
                            <Icon size={22} />
                          </span>
                          <strong>{inspected.label}</strong>
                          <button type="button" className="icon-btn" onClick={() => setSelected(null)} aria-label="Close inspector">
                            <X size={16} />
                          </button>
                        </header>
                        <p className="ip-text">{description ?? 'One of the building blocks of this design; its connections are below.'}</p>
                        {duties.length > 1 && (
                          <>
                            <h4>Key responsibilities</h4>
                            <ul className="ip-checks">
                              {duties.map((d, i) => (
                                <motion.li key={d} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 + i * 0.05 }}>
                                  <Check size={14} /> {d}
                                </motion.li>
                              ))}
                            </ul>
                          </>
                        )}
                        {tech.length > 0 && (
                          <>
                            <h4>Technologies</h4>
                            <div className="ip-chips">
                              {tech.map((t) => (
                                <span key={t}>{t}</span>
                              ))}
                            </div>
                          </>
                        )}
                        {inspectedIn.length > 0 && (
                          <dl>
                            <dt>Called by</dt>
                            <dd>{inspectedIn.map((e) => `${labelOf(e.from)}${e.label ? ` (${e.label})` : ''}`).join(', ')}</dd>
                          </dl>
                        )}
                        {inspectedOut.length > 0 && (
                          <dl>
                            <dt>Calls</dt>
                            <dd>{inspectedOut.map((e) => `${labelOf(e.to)}${e.label ? ` (${e.label})` : ''}`).join(', ')}</dd>
                          </dl>
                        )}
                        {inspectedSteps.length > 0 && (
                          <div className="inspector-steps">
                            <span>In the walkthrough:</span>
                            {inspectedSteps.map((i) => (
                              <button key={i} type="button" onClick={() => (setTab('walk'), setWalk({ index: i, playing: false }))}>
                                step {i + 1}
                              </button>
                            ))}
                          </div>
                        )}
                        {diagramView === 'architecture' && (
                          <>
                            <button type="button" className={`btn ${failed.has(inspected.id) ? 'btn-ghost is-on' : 'btn-danger'}`} onClick={() => toggleFailure(inspected.id)}>
                              <Power size={15} /> {failed.has(inspected.id) ? 'Bring it back' : isCache(inspected.label) ? 'Turn the cache off' : 'Simulate failure'}
                            </button>
                            {failed.has(inspected.id) && <p className="inspector-impact">{failureEffect(inspected.label, inspectedSteps.length, steps.length)}</p>}
                          </>
                        )}
                      </>
                    )
                  })()}
                </motion.aside>
              )}
            </AnimatePresence>
          </div>

          {steps.length > 0 && (
            <footer className="step-player" aria-live="polite">
              <motion.button
                type="button"
                className="sp-play"
                whileTap={{ scale: 0.9 }}
                onClick={() => (walk ? setWalk({ ...walk, playing: !walk.playing }) : startWalk())}
                aria-label={walk?.playing ? 'Pause' : 'Play the walkthrough'}
              >
                {walk?.playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
              </motion.button>
              <div className="sp-info">
                <div className="sp-head">
                  <span>
                    Step {(walk?.index ?? 0) + 1}/{steps.length}
                  </span>
                  <AnimatePresence mode="wait">
                    <motion.strong key={walk?.index ?? -1} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
                      {stepTitle(steps[walk?.index ?? 0])}
                    </motion.strong>
                  </AnimatePresence>
                </div>
                <div className="sp-progress">
                  <motion.span animate={{ width: `${(((walk?.index ?? -1) + 1) / steps.length) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
                </div>
              </div>
              <p className="sp-text">
                {walk && now.speaking && now.source === `step:${topic.id}:${walk.index}` && now.sentences[now.sentence] ? (
                  <Karaoke sentence={now.sentences[now.sentence]} word={now.word} />
                ) : walk ? (
                  steps[walk.index].text
                ) : (
                  `Follow one real request through ${topic.title}, step by step: ${trace?.input}.`
                )}
                {downInStep.length > 0 && (
                  <span className="walk-broken">
                    <AlertTriangle size={15} /> {downInStep.join(', ')} {downInStep.length > 1 ? 'are' : 'is'} down: this step{' '}
                    {downInStep.every(isCache) ? 'falls back to the slower path' : 'fails'}.
                  </span>
                )}
              </p>
              <div className="sp-nav">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => walk && setWalk({ index: Math.max(0, walk.index - 1), playing: false })}
                  disabled={!walk || walk.index === 0}
                  aria-label="Previous step"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => (walk ? setWalk({ index: Math.min(steps.length - 1, walk.index + 1), playing: false }) : setWalk({ index: 0, playing: false }))}
                  disabled={Boolean(walk) && walk!.index === steps.length - 1}
                >
                  {walk ? 'Next step' : 'Step through'} <ChevronRight size={16} />
                </button>
                <select className="sp-speed" value={walkSpeed} onChange={(e) => setWalkSpeed(Number(e.target.value))} aria-label="Walkthrough speed">
                  {SPEEDS.map((x) => (
                    <option key={x} value={x}>
                      {x}×
                    </option>
                  ))}
                </select>
                {walk && (
                  <button type="button" className="icon-btn" onClick={() => setWalk(null)} aria-label="Stop walkthrough">
                    <Square size={14} />
                  </button>
                )}
              </div>
            </footer>
          )}

          <div className="facts">
            {[
              { icon: Cpu, title: 'Components', text: `${topic.architecture.nodes.length} parts, tap one to inspect it` },
              { icon: Route, title: 'Data flow', text: steps.length ? `${steps.length}-step animated request` : 'Follow the arrows' },
              { icon: MousePointerClick, title: 'Interactive', text: 'Switch parts off and see what breaks' },
              {
                icon: Footprints,
                title: topic.adaptedFrom ? 'Real world' : 'Go deeper',
                text: topic.adaptedFrom ? `Based on ${topic.adaptedFrom.author.split(',').pop()?.trim()}` : `${topic.guides?.length ?? 0} further readings`,
              },
            ].map((f, i) => (
              <motion.div key={f.title} className="fact" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.07 }}>
                <span className="fact-icon">
                  <f.icon size={20} />
                </span>
                <span>
                  <strong>{f.title}</strong>
                  <small>{f.text}</small>
                </span>
              </motion.div>
            ))}
          </div>
        </section>

        <aside className="side-col" hidden={!topic.video && !showLoad}>
          {showLoad && topic.loadTest && (
            <Suspense fallback={<p className="card d2-loading">Loading the simulator…</p>}>
              <LoadPanel test={topic.loadTest} onStats={setLoad} onClose={() => setShowLoad(false)} />
            </Suspense>
          )}
          {topic.video && (
            <section className="card video-card" aria-label="Video walkthrough">
              <header className="card-head">
                <h2>
                  <Video size={17} /> Video walkthrough
                </h2>
                <OfflineVideoButton src={topic.video} />
              </header>
              <video
                ref={video}
                src={topic.video}
                poster={topic.video.replace(/\.mp4$/, '.jpg')}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  setDuration(v.duration)
                  // Pick up where the learner left off.
                  if (resumeAt) v.currentTime = resumeAt
                }}
                onTimeUpdate={(e) => {
                  setVideoTime(e.currentTarget.currentTime)
                  if (Date.now() - lastSaved.current > 5000) saveVideo(e.currentTarget)
                }}
                onPause={(e) => saveVideo(e.currentTarget)}
                onEnded={(e) => saveVideo(e.currentTarget)}
              />
              {topic.chapters && (
                <ol className="chapters">
                  {topic.chapters.map(([start, title], i) => (
                    <li key={start}>
                      <button
                        type="button"
                        className={i === chapterIndex ? 'is-current' : ''}
                        onClick={() => {
                          const v = video.current
                          if (!v) return
                          v.currentTime = start
                          void v.play()
                        }}
                      >
                        <time>{clock(start)}</time>
                        {title}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </aside>

        <section className="card content-card" ref={content} aria-label="Explanation">
          <nav className="content-tabs">
            {topic.story && (
              <button type="button" aria-pressed={tab === 'story'} onClick={() => setTab('story')}>
                <BookOpenText size={15} /> Story
              </button>
            )}
            <button type="button" aria-pressed={tab === 'explain'} onClick={() => setTab('explain')}>
              <BookOpen size={15} /> Explanation
            </button>
            {steps.length > 0 && (
              <button type="button" aria-pressed={tab === 'walk'} onClick={() => setTab('walk')}>
                <Footprints size={15} /> Walkthrough
              </button>
            )}
            {explanation.code.length > 0 && (
              <button type="button" aria-pressed={tab === 'code'} onClick={() => setTab('code')}>
                <Code2 size={15} /> Code
              </button>
            )}
            {sql && (
              <button type="button" aria-pressed={tab === 'data'} onClick={() => go('data')}>
                <Database size={15} /> Schema
              </button>
            )}
          </nav>

          <div className="content-body explain">
            {tab === 'story' && topic.story && (
              <StoryView
                story={topic.story}
                onReplay={topic.simulator ? replay : undefined}
                onListen={speechSupported ? () => void speak(storyText(topic.story!), { source: `story:${topic.id}`, title: `${topic.title}: the story` }) : undefined}
                onFinished={() => updateTopic(topic.id, { storyRead: true })}
                listening={now.speaking && now.source === `story:${topic.id}` ? <ReadingView sentences={now.sentences} current={now.sentence} word={now.word} /> : undefined}
              />
            )}
            {tab === 'story' && topic.story && (
              <div className="story-next">
                <button type="button" className="btn" onClick={() => go('explain', 0)}>
                  <BookOpen size={16} /> Read the explanation
                </button>
                {topic.simulator && (
                  <button type="button" className="btn btn-primary" onClick={() => go('walk')}>
                    <Footprints size={16} /> Try it with your own input
                  </button>
                )}
              </div>
            )}

            {tab === 'explain' && explanation.sections[section] && (
              <>
                <h3 className="section-title">
                  <span>{section + 1}</span>
                  {explanation.sections[section].heading}
                  {speechSupported && (
                    <button
                      type="button"
                      className="listen-btn"
                      onClick={() => void speak(explanation.sections[section].body, { source: `section:${topic.id}:${section}`, title: `${topic.title}: ${explanation.sections[section].heading}` })}
                      title="Listen to this section"
                    >
                      <Volume2 size={16} />
                    </button>
                  )}
                </h3>
                {now.speaking && now.source === `section:${topic.id}:${section}` ? (
                  <ReadingView sentences={now.sentences} current={now.sentence} word={now.word} />
                ) : (
                  <Body text={explanation.sections[section].body} from={topic.id} here={explanation.sections[section].heading} />
                )}
                <div className="pager">
                  <button type="button" className="btn btn-ghost" disabled={section === 0} onClick={() => setSection(section - 1)}>
                    <ChevronLeft size={16} /> {section > 0 ? explanation.sections[section - 1].heading : 'Previous'}
                  </button>
                  <button type="button" className="btn btn-ghost" disabled={section === explanation.sections.length - 1} onClick={() => setSection(section + 1)}>
                    {section < explanation.sections.length - 1 ? explanation.sections[section + 1].heading : 'Next'} <ChevronRight size={16} />
                  </button>
                </div>
              </>
            )}

            {tab === 'walk' && (
              <>
                {topic.simulator && (
                  <SimulatorForm
                    simulator={topic.simulator}
                    onRun={(values) => {
                      setTrace(topic.simulator!.run(values))
                      setDiagramView('architecture')
                      setWalk({ index: 0, playing: true })
                    }}
                  />
                )}
                {trace && (
                  <>
                    <h3>End to end: {trace.input}</h3>
                    <ol className="trace">
                      {trace.steps.map((s, i) => (
                        <li key={i} className={walk?.index === i ? 'is-current' : undefined}>
                          <button type="button" className="trace-step" onClick={() => setWalk({ index: i, playing: false })}>
                            {s.text}
                          </button>
                          {s.data && <pre className="walk-data">{s.data}</pre>}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </>
            )}

            {tab === 'code' && explanation.code.map((snippet, i) => <CodeBlock key={i} snippet={snippet} />)}

            {tab === 'data' && sql && <CodeBlock snippet={schemaSnippet(sql, dbml)} />}

            {explanation.related.length > 0 && (
              <p className="related">
                Learn next:{' '}
                {explanation.related.map((name, i) => {
                  const target = topicNamed(name)
                  return (
                    <span key={name}>
                      {i > 0 && ' · '}
                      {target && target.id !== topic.id ? (
                        <TopicLink rule={{ topic: target.id, terms: [] }} read={false}>
                          {name}
                        </TopicLink>
                      ) : (
                        name
                      )}
                    </span>
                  )
                })}
              </p>
            )}
          </div>
        </section>

        <aside className="card takeaways" aria-label="Key takeaways">
          <h2>
            <Lightbulb size={18} /> Key takeaways
          </h2>
          <ol>
            {topic.takeaways.map((t, i) => (
              <li key={t}>
                <Parts parts={takeawayLinks[i]} read={false} />
              </li>
            ))}
          </ol>
          {onNote && <TopicNotes topic={topic} onNote={onNote} />}
          <NoteBox topic={topic} />
          {guidesFor(topic).length > 0 && (
            <>
              <h3 className="deeper-title">Go deeper</h3>
              <ul className="deeper">
                {guidesFor(topic).map((g) => (
                  <li key={g.slug}>
                    <a href={g.url} target="_blank" rel="noreferrer" title={sourceOf(g).name}>
                      {g.title} <ExternalLink size={13} aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/** A section being read aloud: past sentences dim, the current one lit (word by word), the view following along. */
function ReadingView({ sentences, current, word }: { sentences: string[]; current: number; word: number }) {
  const active = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    active.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [current])
  return (
    <p className="reading">
      {sentences.map((s, i) =>
        i === current ? (
          <span key={i} ref={active} className="reading-now">
            <Karaoke sentence={s} word={word} />
          </span>
        ) : (
          <span key={i} className={i < current ? 'reading-done' : 'reading-next'}>
            {s}{' '}
          </span>
        ),
      )}
    </p>
  )
}
