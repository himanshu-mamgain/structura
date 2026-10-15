import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bookmark, BookmarkCheck, BookOpen, Box, CheckCircle2, ChevronLeft, ChevronRight, Circle, Code2, Database, ExternalLink, Footprints, Lightbulb, Pause, Play, Power, Square, Video, X, Zap } from 'lucide-react'
import type { Trace } from '@structura/shared'
import { LoadPanel } from '../board/LoadPanel'
import { BoardCanvas } from '../board/react'
import type { Board } from '../board/store'
import { Diagram2D } from '../diagram/Diagram2D'
import { failureEffect, responsibility, sameComponent, stepsThrough } from '../diagram/inspect'
import { Body, CodeBlock, SimulatorForm } from '../learn/content'
import { erdToSql } from '../learn/ddl'
import { readiness, updateTopic, useProgress } from '../learn/progress'
import { erdToDiagram } from '../learn/erd'
import { buildSteps, focusStep, showWholeDiagram } from '../learn/walkthrough'
import type { StaticTopic } from '../topics'
import { guidesFor, sourceOf } from '../topics/library'
import { openStaticTopic } from '../topics/open'
import { topicIcon } from './topicIcons'

type Tab = 'explain' | 'walk' | 'code' | 'data'

/** Seconds a walkthrough step stays on screen: long enough to read it. */
const stepDuration = (text: string) => Math.max(3500, text.length * 60)
const isCache = (label: string) => /cache|redis|cdn/i.test(label)
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
 * One topic, laid out like a study dashboard: the diagram (2D or the 3D city),
 * the narrated video with chapters, the explanation with a walkthrough, code
 * and data model, and the key takeaways. Mounted fresh for each topic.
 */
export function TopicView({ topic, board, openLoad = false }: { topic: StaticTopic; board: Board; openLoad?: boolean }) {
  const narrow = useNarrow()
  const [diagramView, setDiagramView] = useState<'architecture' | 'data'>('architecture')
  const [mode, setMode] = useState<'2d' | '3d'>(openLoad ? '3d' : '2d')
  const [tab, setTab] = useState<Tab>('explain')
  const [section, setSection] = useState(0)
  const [trace, setTrace] = useState<Trace | null>(topic.explanation.trace)
  const [walk, setWalk] = useState<{ index: number; playing: boolean } | null>(null)
  const [showLoad, setShowLoad] = useState(openLoad && Boolean(topic.loadTest))
  const [board3d, setBoard3d] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  const [videoTime, setVideoTime] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const video = useRef<HTMLVideoElement>(null)
  const content = useRef<HTMLElement>(null)
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
  const dataModel = useMemo(() => (topic.database ? { ...erdToDiagram(topic.database), direction: narrow ? ('down' as const) : ('right' as const) } : null), [topic, narrow])
  const sql = useMemo(() => (topic.database ? erdToSql(topic.database) : null), [topic])

  // The 3D city is drawn on first use: it needs the topic on the board.
  useEffect(() => {
    if (mode !== '3d' || board3d) return
    void openStaticTopic(board, topic).then(() => setBoard3d(true))
  }, [mode, board3d, board, topic])

  // Walkthrough: focus the step (in 3D, fly to it), wait long enough to read, move on.
  useEffect(() => {
    if (!walk) return
    const step = steps[walk.index]
    if (!step) return
    if (mode === '3d' && board3d) {
      const built = buildSteps(board, { ...explanation, trace })[walk.index]
      if (built) focusStep(board, built)
    }
    if (walk.index === steps.length - 1) updateTopic(topic.id, { walked: true })
    if (!walk.playing) return
    const timer = setTimeout(
      () => setWalk((w) => (w && w.index < steps.length - 1 ? { ...w, index: w.index + 1 } : w && { ...w, playing: false })),
      stepDuration(step.text),
    )
    return () => clearTimeout(timer)
  }, [walk, mode, board3d, board, steps, explanation, trace, topic.id])

  const walking = Boolean(walk)
  useEffect(() => {
    if (!walking && board3d) showWholeDiagram(board)
  }, [walking, board3d, board])

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

  const nodes = diagramView === 'data' && dataModel ? dataModel.nodes : topic.architecture.nodes
  const edges = diagramView === 'data' && dataModel ? dataModel.edges : topic.architecture.edges
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id
  const inspected = selected ? (nodes.find((n) => n.id === selected) ?? null) : null
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
            <span className={`level is-${topic.difficulty.toLowerCase()}`}>{topic.difficulty}</span>
            <span className="readiness" title="Interview readiness: sections read, walkthrough, video and completion">
              <span className="readiness-bar">
                <span style={{ width: `${ready}%` }} />
              </span>
              {ready}% interview ready
            </span>
          </div>
          <p>{explanation.summary}</p>
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
          <button
            type="button"
            className={`icon-btn${progress?.bookmarked ? ' is-on' : ''}`}
            onClick={() => updateTopic(topic.id, (p) => ({ bookmarked: !p.bookmarked }))}
            aria-pressed={Boolean(progress?.bookmarked)}
            title={progress?.bookmarked ? 'Remove bookmark' : 'Bookmark'}
          >
            {progress?.bookmarked ? <BookmarkCheck size={19} /> : <Bookmark size={19} />}
          </button>
          <button
            type="button"
            className={`btn btn-ghost${progress?.completed ? ' is-on' : ''}`}
            onClick={() => updateTopic(topic.id, (p) => ({ completed: !p.completed }))}
            aria-pressed={Boolean(progress?.completed)}
          >
            {progress?.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />} {progress?.completed ? 'Completed' : 'Mark complete'}
          </button>
          {topic.video && (
            <button type="button" className="btn btn-primary" onClick={watch}>
              <Play size={16} fill="currentColor" />
              {resumeAt ? `Resume ${clock(resumeAt)}` : `Watch video${duration ? ` (${clock(duration)})` : ''}`}
            </button>
          )}
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
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
            SQL schema
          </button>
        )}
      </nav>

      <div className={`topic-grid${topic.video || showLoad ? '' : ' no-side'}`}>
        <section className="card diagram-card" aria-label="Diagram">
          <header className="card-head">
            <div className="seg" role="group" aria-label="Diagram">
              <button type="button" aria-pressed={diagramView === 'architecture'} onClick={() => setDiagramView('architecture')}>
                <Box size={15} /> Architecture
              </button>
              {dataModel && (
                <button type="button" aria-pressed={diagramView === 'data'} onClick={() => setDiagramView('data')} disabled={mode === '3d'}>
                  <Database size={15} /> Data model
                </button>
              )}
            </div>
            <div className="card-tools">
              <div className="seg" role="group" aria-label="View">
                <button type="button" aria-pressed={mode === '2d'} onClick={() => (setMode('2d'), setShowLoad(false))}>
                  2D
                </button>
                <button type="button" aria-pressed={mode === '3d'} onClick={() => (setMode('3d'), setDiagramView('architecture'))}>
                  3D
                </button>
              </div>
              {topic.loadTest && (
                <button
                  type="button"
                  className={`btn btn-ghost${showLoad ? ' is-on' : ''}`}
                  onClick={() => {
                    setShowLoad(!showLoad)
                    setMode('3d')
                    setDiagramView('architecture')
                  }}
                  title="Put real load through this design"
                >
                  <Zap size={15} /> Load test
                </button>
              )}
            </div>
          </header>
          <div className="diagram-body">
            {mode === '2d' ? (
              <Diagram2D
                diagram={diagramView === 'data' && dataModel ? dataModel : architecture}
                focus={focus}
                selected={selected}
                failed={failed}
                onSelect={setSelected}
              />
            ) : (
              <BoardCanvas board={board} />
            )}
            {inspected && (
              <aside className="inspector" aria-label={`Component: ${inspected.label}`}>
                <header>
                  <strong>{inspected.label}</strong>
                  <button type="button" className="icon-btn" onClick={() => setSelected(null)} aria-label="Close inspector">
                    <X size={16} />
                  </button>
                </header>
                <p>{responsibility(topic, inspected.label) ?? 'One of the building blocks of this design; its connections are below.'}</p>
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
              </aside>
            )}
            {step && walk && (
              <div className="walk-caption" aria-live="polite">
                <span className="walk-count">
                  {walk.index + 1}/{steps.length}
                </span>
                <p>{step.text}</p>
                {downInStep.length > 0 && (
                  <p className="walk-broken">
                    <AlertTriangle size={15} /> {downInStep.join(', ')} {downInStep.length > 1 ? 'are' : 'is'} down: this step{' '}
                    {downInStep.every(isCache) ? 'falls back to the slower path' : 'fails'}.
                  </p>
                )}
                <div className="walk-buttons">
                  <button type="button" onClick={() => setWalk({ index: Math.max(0, walk.index - 1), playing: false })} disabled={walk.index === 0} aria-label="Previous step">
                    <ChevronLeft size={18} />
                  </button>
                  <button type="button" onClick={() => setWalk({ ...walk, playing: !walk.playing })} aria-label={walk.playing ? 'Pause' : 'Play'}>
                    {walk.playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setWalk({ index: Math.min(steps.length - 1, walk.index + 1), playing: false })}
                    disabled={walk.index === steps.length - 1}
                    aria-label="Next step"
                  >
                    <ChevronRight size={18} />
                  </button>
                  <button type="button" onClick={() => setWalk(null)} aria-label="Stop walkthrough">
                    <Square size={14} />
                  </button>
                </div>
              </div>
            )}
            {!walk && steps.length > 0 && (
              <button type="button" className="btn btn-primary walk-start" onClick={() => startWalk()}>
                <Footprints size={16} /> Walk me through it
              </button>
            )}
          </div>
        </section>

        <aside className="side-col" hidden={!topic.video && !showLoad}>
          {showLoad && topic.loadTest && <LoadPanel board={board} test={topic.loadTest} onClose={() => setShowLoad(false)} />}
          {topic.video && (
            <section className="card video-card" aria-label="Video walkthrough">
              <header className="card-head">
                <h2>
                  <Video size={17} /> Video walkthrough
                </h2>
                <span className="badge">Remotion</span>
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
                <Database size={15} /> SQL schema
              </button>
            )}
          </nav>

          <div className="content-body explain">
            {tab === 'explain' && explanation.sections[section] && (
              <>
                <h3 className="section-title">
                  <span>{section + 1}</span>
                  {explanation.sections[section].heading}
                </h3>
                <Body text={explanation.sections[section].body} />
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

            {tab === 'data' && sql && <CodeBlock snippet={{ title: 'Schema (PostgreSQL)', language: 'sql', source: sql }} />}

            {explanation.related.length > 0 && (
              <p className="related">
                Learn next: {explanation.related.join(' · ')}
              </p>
            )}
          </div>
        </section>

        <aside className="card takeaways" aria-label="Key takeaways">
          <h2>
            <Lightbulb size={18} /> Key takeaways
          </h2>
          <ol>
            {topic.takeaways.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
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
