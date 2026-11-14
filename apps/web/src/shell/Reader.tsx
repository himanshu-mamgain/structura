import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, CheckCircle2, Circle, ExternalLink, Footprints, Headphones, Lightbulb, Move, Network, Pause } from 'lucide-react'
import { Diagram2D } from '../diagram/Diagram2D'
import { responsibility, subtitleOf } from '../diagram/inspect'
import { LESSONS, playTopic, toggle, useCommute } from '../learn/commute'
import { Body, CodeBlock } from '../learn/content'
import { erdToSql } from '../learn/ddl'
import { type Markdown, plainText } from '../learn/markdown'
import type { Block } from '../learn/notesFormat'
import { updateTopic, useProgress } from '../learn/progress'
import { ROADMAP } from '../learn/roadmap'
import { StoryView } from '../learn/story'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import { hasDeepNote, loadDeepNote } from '../topics/deepNotes'
import { guidesFor, sourceOf } from '../topics/library'
import type { StaticTopic } from '../topics/types'
import type { AreaId } from '../topics/areas'
import { AreaTag } from './Areas'
import { Blocks } from './Notes'
import { topicIcon } from './topicIcons'

// Read mode: a topic as one article, top to bottom, like a guide or a newsletter
// issue. The same content as the topic page (explanation, a request step by step,
// code, takeaways, the story), laid out for reading rather than exploring. A topic
// with deep notes (src/topics/notes/<id>.md) reads those instead of its explanation
// and code: the notes go further and carry their own code.

const SIZES = [16, 17.5, 19, 21] as const
const SIZE_KEY = 'structura:reader-size'
const WORDS_A_MINUTE = 220

function savedSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY))
    return SIZES.includes(n as (typeof SIZES)[number]) ? n : SIZES[1]
  } catch {
    return SIZES[1]
  }
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length
const anchor = (s: string) => `read-${s.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

/** A deep note's blocks before its first section, and its sections. */
function sectionsOf(note: Markdown) {
  const intro: Block[] = []
  const sections: { heading: string; blocks: Block[] }[] = []
  for (const block of note.blocks) {
    if (block.t === 'h1') sections.push({ heading: block.r.map(([t]) => t).join(''), blocks: [] })
    else if (sections.length) sections.at(-1)!.blocks.push(block)
    // A rule just before the first section only separates it from the intro.
    else if (block.t !== 'hr') intro.push(block)
  }
  // Same for a rule closing each section: the next heading already starts a new one.
  for (const s of sections) if (s.blocks.at(-1)?.t === 'hr') s.blocks.pop()
  return { intro, sections }
}

/** The next topic after this one in its roadmap part, to keep reading in order. */
function nextInRoadmap(id: string): TopicMeta | null {
  for (const part of ROADMAP) {
    const at = part.steps.findIndex((s) => s.topic === id)
    if (at < 0) continue
    const next = part.steps.slice(at + 1).find((s) => s.topic)
    return next?.topic ? (TOPICS.find((t) => t.id === next.topic) ?? null) : null
  }
  return null
}

export function Reader({
  topic,
  onExit,
  onRead,
  onOpen,
  onArea,
}: {
  topic: StaticTopic
  onExit: () => void
  onRead: (next: TopicMeta) => void
  onOpen: (next: TopicMeta) => void
  onArea?: (area: AreaId) => void
}) {
  const progress = useProgress().topics[topic.id]
  const commute = useCommute()
  const [size, setSize] = useState(savedSize)
  const [scrolled, setScrolled] = useState(0)
  const [liveDiagram, setLiveDiagram] = useState(false)
  const article = useRef<HTMLElement>(null)
  const end = useRef<HTMLElement>(null)
  const Icon = topicIcon(topic.id)
  const explanation = topic.explanation
  const trace = explanation.trace
  const sql = useMemo(() => (topic.database ? erdToSql(topic.database) : null), [topic])
  const lesson = LESSONS.topics[topic.id]
  const next = nextInRoadmap(topic.id)
  const playing = commute.topicId === topic.id && commute.playing
  const deep = hasDeepNote(topic.id)
  const [note, setNote] = useState<ReturnType<typeof sectionsOf> & { title?: string; words: number }>()

  useEffect(() => {
    if (!deep) return
    let live = true
    loadDeepNote(topic.id).then(
      (md) => md && live && setNote({ ...sectionsOf(md), title: md.title, words: words(plainText(md.blocks)) }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [topic.id, deep])

  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
  const architecture = useMemo(() => (narrow ? { ...topic.architecture, direction: 'down' as const } : topic.architecture), [topic, narrow])
  const subtitles = useMemo(
    () => Object.fromEntries(topic.architecture.nodes.map((n) => [n.id, subtitleOf(responsibility(topic, n.label))]).filter(([, v]) => v)) as Record<string, string>,
    [topic],
  )

  const minutes = useMemo(() => {
    const text = [
      ...(deep ? [] : [explanation.summary, ...explanation.sections.map((s) => s.body)]),
      ...(trace?.steps.map((s) => s.text) ?? []),
      ...topic.takeaways,
      ...(topic.story?.chapters.map((c) => c.body) ?? []),
    ].join(' ')
    return Math.max(1, Math.round((words(text) + (note?.words ?? 0)) / WORDS_A_MINUTE))
  }, [topic, explanation, trace, deep, note])

  const contents = [
    ...(deep ? (note?.sections.map((s) => s.heading) ?? []) : explanation.sections.map((s) => s.heading)),
    ...(trace?.steps.length ? ['One request, step by step'] : []),
    ...(!deep && explanation.code.length ? ['Code'] : []),
    ...(!deep && sql ? ['Data model'] : []),
    'Key takeaways',
    ...(topic.story ? ['The story'] : []),
  ]

  // A deep note's section i stands in for the explanation section at the same point,
  // so reading the notes moves the interview-readiness score the same way.
  const sectionFor = (i: number, of: number) => Math.min(explanation.sections.length - 1, Math.floor((i * explanation.sections.length) / of))

  // Links in the notes to other topics open them here, without reloading the app.
  function followLink(e: MouseEvent) {
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
    if (!href?.startsWith('/?')) return
    const url = new URL(href, window.location.origin)
    const meta = TOPICS.find((t) => t.id === url.searchParams.get('topic'))
    if (!meta) return
    e.preventDefault()
    if (url.searchParams.has('read')) onRead(meta)
    else onOpen(meta)
  }

  function changeSize(delta: number) {
    const i = Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(size as (typeof SIZES)[number]) + delta))
    setSize(SIZES[i])
    try {
      localStorage.setItem(SIZE_KEY, String(SIZES[i]))
    } catch {
      // Storage blocked: the size just isn't remembered.
    }
  }

  // How far through the article the reader is, for the bar at the top.
  useEffect(() => {
    const onScroll = () => {
      const el = article.current
      if (!el) return
      const { top, height } = el.getBoundingClientRect()
      const total = height - window.innerHeight
      setScrolled(total > 0 ? Math.min(1, Math.max(0, -top / total)) : 1)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  // A section counts as read once its top has scrolled most of the way up the screen,
  // which feeds the same interview-readiness score as opening it on the topic page.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const index = Number((e.target as HTMLElement).dataset.section)
          updateTopic(topic.id, (p) => ({ sectionsRead: [...new Set([...(p.sectionsRead ?? []), index])] }))
          io.unobserve(e.target)
        }
      },
      { rootMargin: '0px 0px -55% 0px' },
    )
    article.current?.querySelectorAll('[data-section]').forEach((el) => io.observe(el))
    updateTopic(topic.id, { lastOpenedAt: Date.now() })
    return () => io.disconnect()
  }, [topic.id, note])

  // Reaching the end of the article counts every section as read, however fast the scroll.
  useEffect(() => {
    const el = end.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      updateTopic(topic.id, { sectionsRead: explanation.sections.map((_, i) => i) })
      io.disconnect()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [topic.id, explanation])

  const jump = (heading: string) => document.getElementById(anchor(heading))?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <article ref={article} className="reader" style={{ '--reader-size': `${size}px` } as CSSProperties} onClick={followLink}>
      <div className="reader-bar">
        <button type="button" className="btn btn-ghost" onClick={onExit} title="Back to the interactive topic page">
          <ArrowLeft size={16} /> <span>Interactive</span>
        </button>
        <div className="reader-size" role="group" aria-label="Text size">
          <button type="button" onClick={() => changeSize(-1)} disabled={size === SIZES[0]} aria-label="Smaller text">
            A−
          </button>
          <button type="button" onClick={() => changeSize(1)} disabled={size === SIZES[SIZES.length - 1]} aria-label="Larger text">
            A+
          </button>
        </div>
        {lesson && (
          <button type="button" className={`btn${playing ? ' is-on' : ''}`} onClick={() => (commute.topicId === topic.id ? toggle() : playTopic(topic.id))}>
            {playing ? <Pause size={16} /> : <Headphones size={16} />} <span>{playing ? 'Pause' : `Listen ${Math.round(lesson.duration / 60)} min`}</span>
          </button>
        )}
        <span className="reader-progress" aria-hidden>
          <span style={{ width: `${scrolled * 100}%` }} />
        </span>
      </div>

      <header className="reader-head">
        <p className="reader-kicker">
          <Icon size={16} aria-hidden /> <AreaTag topicId={topic.id} onArea={onArea} />{' '}
          <span className={`level is-${topic.difficulty.toLowerCase()}`}>{topic.difficulty}</span>
          {deep && <span className="reader-kind">Deep notes</span>} · {minutes} min read
        </p>
        <h1>{note?.title ?? topic.title}</h1>
        <p className="reader-dek">{topic.blurb}</p>
        {deep ? (
          note ? (
            <div className="note-body reader-intro">
              <Blocks blocks={note.intro} />
            </div>
          ) : null
        ) : (
          <p className="reader-summary">{explanation.summary}</p>
        )}
      </header>

      <figure className={`reader-figure${liveDiagram ? ' is-live' : ''}`}>
        <div className="reader-diagram">
          <Diagram2D diagram={architecture} focus={null} subtitles={subtitles} fitAll />
          {!liveDiagram && (
            <button type="button" className="reader-diagram-cover" onClick={() => setLiveDiagram(true)} aria-label="Move and zoom the diagram">
              <span>
                <Move size={15} aria-hidden /> Tap to move and zoom
              </span>
            </button>
          )}
        </div>
        <figcaption>
          <Network size={14} aria-hidden /> The architecture: {topic.architecture.nodes.length} parts.{' '}
          {liveDiagram ? (
            <button type="button" className="link-btn" onClick={() => setLiveDiagram(false)}>
              Done moving
            </button>
          ) : (
            <button type="button" className="link-btn" onClick={onExit}>
              Explore it on the topic page
            </button>
          )}
        </figcaption>
      </figure>

      <nav className="reader-toc" aria-label="In this guide">
        <h2>In this guide</h2>
        <ol>
          {contents.map((heading) => (
            <li key={heading}>
              <button type="button" onClick={() => jump(heading)}>
                {heading}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {deep
        ? note?.sections.map((s, i, all) => (
            <section key={s.heading} id={anchor(s.heading)} data-section={sectionFor(i, all.length)} className="reader-section">
              <h2>
                <span>{String(i + 1).padStart(2, '0')}</span>
                {s.heading}
              </h2>
              <div className="note-body">
                <Blocks blocks={s.blocks} />
              </div>
            </section>
          ))
        : explanation.sections.map((s, i) => (
            <section key={s.heading} id={anchor(s.heading)} data-section={i} className="reader-section">
              <h2>
                <span>{String(i + 1).padStart(2, '0')}</span>
                {s.heading}
              </h2>
              <Body text={s.body} />
            </section>
          ))}
      {deep && !note && <p className="reader-note">Loading the notes…</p>}

      {trace && trace.steps.length > 0 && (
        <section id={anchor('One request, step by step')} className="reader-section">
          <h2>
            <Footprints size={20} aria-hidden /> One request, step by step
          </h2>
          <p className="reader-note">{trace.input}</p>
          <ol className="reader-steps">
            {trace.steps.map((step, i) => (
              <li key={i}>
                <p>{step.text}</p>
                {step.nodes.length > 0 && <p className="reader-step-nodes">{step.nodes.join(' → ')}</p>}
                {step.data && <pre>{step.data}</pre>}
              </li>
            ))}
          </ol>
          {topic.simulator && (
            <p className="reader-note">
              <button type="button" className="link-btn" onClick={onExit}>
                Try it with your own input
              </button>{' '}
              on the topic page.
            </p>
          )}
        </section>
      )}

      {!deep && explanation.code.length > 0 && (
        <section id={anchor('Code')} className="reader-section">
          <h2>Code</h2>
          {explanation.code.map((snippet, i) => (
            <CodeBlock key={i} snippet={snippet} />
          ))}
        </section>
      )}

      {!deep && sql && (
        <section id={anchor('Data model')} className="reader-section">
          <h2>Data model</h2>
          <CodeBlock snippet={{ title: 'Schema (PostgreSQL)', language: 'sql', source: sql }} />
        </section>
      )}

      <aside id={anchor('Key takeaways')} className="reader-takeaways">
        <h2>
          <Lightbulb size={20} aria-hidden /> Key takeaways
        </h2>
        <ol>
          {topic.takeaways.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
      </aside>

      {topic.story && (
        <section id={anchor('The story')} className="reader-section reader-story">
          <p className="reader-label">
            <BookOpenText size={15} aria-hidden /> The story
          </p>
          <StoryView story={topic.story} onFinished={() => updateTopic(topic.id, { storyRead: true })} />
        </section>
      )}

      {guidesFor(topic).length > 0 && (
        <section className="reader-section reader-deeper">
          <h2>Go deeper</h2>
          <ul>
            {guidesFor(topic).map((g) => (
              <li key={g.slug}>
                <a href={g.url} target="_blank" rel="noreferrer">
                  {g.title} <ExternalLink size={13} aria-hidden />
                </a>
                <small>{sourceOf(g).name}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer ref={end} className="reader-foot">
        <button
          type="button"
          className={`btn${progress?.completed ? ' is-on' : ''}`}
          onClick={() => updateTopic(topic.id, (p) => ({ completed: !p.completed, completedAt: p.completed ? undefined : Date.now() }))}
          aria-pressed={Boolean(progress?.completed)}
        >
          {progress?.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />} {progress?.completed ? 'Completed' : 'Mark complete'}
        </button>
        {next && (
          <button type="button" className="btn btn-primary btn-wrap" onClick={() => onRead(next)}>
            <span>
              <small>Read next</small> {next.title}
            </span>
            <ArrowRight size={16} />
          </button>
        )}
      </footer>
    </article>
  )
}
