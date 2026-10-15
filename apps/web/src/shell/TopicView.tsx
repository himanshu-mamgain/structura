import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Box, ChevronLeft, ChevronRight, Code2, Database, ExternalLink, Footprints, Lightbulb, Pause, Play, Square, Video, Zap } from 'lucide-react'
import type { Trace } from '@structura/shared'
import { LoadPanel } from '../board/LoadPanel'
import { BoardCanvas } from '../board/react'
import type { Board } from '../board/store'
import { Diagram2D } from '../diagram/Diagram2D'
import { Body, CodeBlock, SimulatorForm } from '../learn/content'
import { erdToSql } from '../learn/ddl'
import { erdToDiagram } from '../learn/erd'
import { buildSteps, focusStep, showWholeDiagram } from '../learn/walkthrough'
import type { StaticTopic } from '../topics'
import { guidesFor, guideUrl, LIBRARY } from '../topics/library'
import { openStaticTopic } from '../topics/open'
import { topicIcon } from './topicIcons'

type Tab = 'explain' | 'walk' | 'code' | 'data'

/** Seconds a walkthrough step stays on screen: long enough to read it. */
const stepDuration = (text: string) => Math.max(3500, text.length * 60)
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
  const video = useRef<HTMLVideoElement>(null)
  const content = useRef<HTMLElement>(null)
  const Icon = topicIcon(topic.id)

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
    if (!walk.playing) return
    const timer = setTimeout(
      () => setWalk((w) => (w && w.index < steps.length - 1 ? { ...w, index: w.index + 1 } : w && { ...w, playing: false })),
      stepDuration(step.text),
    )
    return () => clearTimeout(timer)
  }, [walk, mode, board3d, board, steps, explanation, trace])

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

  const step = walk ? steps[walk.index] : null
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
          <p>{explanation.summary}</p>
        </div>
        {topic.video && (
          <button type="button" className="btn btn-primary" onClick={watch}>
            <Play size={16} fill="currentColor" /> Watch video{duration ? ` (${clock(duration)})` : ''}
          </button>
        )}
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

      <div className="topic-grid">
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
              <Diagram2D diagram={diagramView === 'data' && dataModel ? dataModel : architecture} focus={focus} />
            ) : (
              <BoardCanvas board={board} />
            )}
            {step && walk && (
              <div className="walk-caption" aria-live="polite">
                <span className="walk-count">
                  {walk.index + 1}/{steps.length}
                </span>
                <p>{step.text}</p>
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

        <aside className="side-col">
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
                src={`${topic.video}#t=2`}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                onTimeUpdate={(e) => setVideoTime(e.currentTarget.currentTime)}
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
              <h3 className="deeper-title">Go deeper · {LIBRARY.source.name}</h3>
              <ul className="deeper">
                {guidesFor(topic).map((g) => (
                  <li key={g.slug}>
                    <a href={guideUrl(g.slug)} target="_blank" rel="noreferrer">
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
