import { ArrowLeft, ArrowRight, BookOpen, BookOpenText, CheckCircle2, ChevronRight, Circle, Database, ExternalLink, Hammer, Sparkles } from 'lucide-react'
import { ECOSYSTEM } from '../ecosystem'
import { readiness, toggleRoadmapStep, updateTopic, useProgress } from '../learn/progress'
import {
  currentArea,
  nextPart,
  nextStep,
  partById,
  partDone,
  partsOf,
  ROADMAP,
  type RoadmapPart,
  type RoadmapStep,
  STAGES,
  stepDone,
  unplacedTopics,
} from '../learn/roadmap'
import { areaById, AREAS, type AreaId } from '../topics/areas'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import type { Guide } from '../topics/library'
import { useLibrary } from '../topics/useLibrary'
import { AREA_ICON, AreaChips } from './Areas'
import { topicIcon } from './topicIcons'

// The roadmap, laid out like Schemata's: each area's track in four stages
// (Foundations → Intermediate → Advanced → Expert), each stage a few small module
// cards with a step count. A card opens its module (?page=roadmap&part=<id>): the
// steps, each a topic or a reading, ticked off as you go.

const topicById = new Map(TOPICS.map((t) => [t.id, t]))
type Library = NonNullable<ReturnType<typeof useLibrary>>
// Readings appear once the library has loaded (it isn't part of the start-up bundle).
const guidesOf = (step: RoadmapStep, lib: Library | null): Guide[] =>
  lib ? (step.guides ?? []).map((s) => lib.LIBRARY.guides.find((g) => g.slug === s)).filter((g): g is Guide => Boolean(g)) : []

const schemata = ECOSYSTEM.find((a) => a.id === 'schemata')

function toggle(step: RoadmapStep) {
  if (step.topic) updateTopic(step.topic, (p) => ({ completed: !p.completed, completedAt: p.completed ? undefined : Date.now() }))
  else toggleRoadmapStep(step.id)
}

/** "Infra · Foundations", or "Final project". */
const placeOf = (part: RoadmapPart) => (part.area ? `${areaById(part.area).title} · ${part.stage}` : 'Final project')

export function Roadmap({
  area,
  partId,
  onArea,
  onPart,
  onOpen,
  onRead,
}: {
  area: AreaId | null
  partId: string | null
  onArea: (area: AreaId | null) => void
  onPart: (id: string) => void
  onOpen: (topic: TopicMeta) => void
  onRead: (topic: TopicMeta) => void
}) {
  const part = partById(partId)
  if (part) return <Module part={part} onArea={onArea} onPart={onPart} onOpen={onOpen} onRead={onRead} />
  return <Overview area={area} onArea={onArea} onPart={onPart} onOpen={onOpen} onRead={onRead} />
}

/** Every track (or one), stage by stage, as cards. */
function Overview({
  area,
  onArea,
  onPart,
  onOpen,
  onRead,
}: {
  area: AreaId | null
  onArea: (area: AreaId | null) => void
  onPart: (id: string) => void
  onOpen: (topic: TopicMeta) => void
  onRead: (topic: TopicMeta) => void
}) {
  const progress = useProgress()
  const a = area ? areaById(area) : null
  const parts = area ? partsOf(area) : ROADMAP
  const steps = parts.flatMap((p) => p.steps)
  const done = steps.filter((s) => stepDone(s, progress)).length
  // On All, "next" is the next step in the track you're on, then anything left anywhere.
  const next = area ? nextStep(progress, area) : (nextStep(progress, currentArea(progress)) ?? nextStep(progress))
  const extra = unplacedTopics(TOPICS, area ?? undefined)
  const tracks = area ? [area] : AREAS.map((x) => x.id)

  return (
    <div className="roadmap">
      <header className="roadmap-intro">
        <h1>{a ? `${a.title} roadmap` : 'Roadmap'}</h1>
        <p>
          {a
            ? `${a.tagline}, from Foundations to Expert. Open a card for its steps.`
            : 'Development, Infra, Databases and AI, each from Foundations to Expert. Open a card for its steps; each step is a topic or a reading.'}
        </p>
      </header>

      <AreaChips value={area} onChange={onArea} label="Tracks" />

      <div className="roadmap-summary">
        <span className="progress-bar" aria-hidden>
          <span style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
        </span>
        <span>
          {done} of {steps.length} steps
        </span>
      </div>

      {next ? (
        <button type="button" className="card roadmap-continue" onClick={() => onPart(next.part.id)}>
          <span className="roadmap-continue-label">Next up · {placeOf(next.part)}</span>
          <strong>{next.step.title}</strong>
          <span>{next.part.title}</span>
          <ChevronRight size={18} aria-hidden />
        </button>
      ) : (
        <p className="roadmap-finished">
          <Sparkles size={16} aria-hidden /> You've finished {a ? `the ${a.title} track` : 'the whole roadmap'}.
        </p>
      )}

      {tracks.map((id) => (
        <Track key={id} area={id} titled={!area} nextId={next?.part.id} onPart={onPart} onArea={onArea} />
      ))}

      {!area && (
        <section className="roadmap-track">
          <h2 className="roadmap-track-title">
            <Hammer size={18} aria-hidden /> Final project
          </h2>
          <div className="roadmap-cards">
            {partsOf(null).map((p) => (
              <ModuleCard key={p.id} part={p} isNext={next?.part.id === p.id} onPart={onPart} />
            ))}
          </div>
        </section>
      )}

      {extra.length > 0 && (
        <section className="roadmap-track">
          <h2 className="roadmap-track-title">More topics</h2>
          <p className="roadmap-track-note">New since the roadmap was written.</p>
          <ol className="card roadmap-steps">
            {extra.map((t) => (
              <Step key={t.id} step={{ id: `topic-${t.id}`, title: t.title, detail: t.blurb, topic: t.id }} isNext={false} onOpen={onOpen} onRead={onRead} />
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

/** One area's stages and their cards. */
function Track({
  area,
  titled,
  nextId,
  onPart,
  onArea,
}: {
  area: AreaId
  titled: boolean
  nextId?: string
  onPart: (id: string) => void
  onArea: (area: AreaId) => void
}) {
  const progress = useProgress()
  const a = areaById(area)
  const Icon = AREA_ICON[area]
  const parts = partsOf(area)
  const steps = parts.flatMap((p) => p.steps)
  const done = steps.filter((s) => stepDone(s, progress)).length
  return (
    <section className={`roadmap-track area-is-${area}`} aria-label={`${a.title} track`}>
      {titled && (
        <div className="roadmap-track-head">
          <h2 className="roadmap-track-title">
            <Icon size={19} aria-hidden /> {a.title}
            <small>
              {done}/{steps.length}
            </small>
          </h2>
          <button type="button" className="link-btn" onClick={() => onArea(area)}>
            Only {a.title}
          </button>
        </div>
      )}
      {STAGES.map((stage) => {
        const inStage = parts.filter((p) => p.stage === stage)
        if (!inStage.length) return null
        return (
          <div key={stage} className="roadmap-stage">
            <h3>{stage}</h3>
            <div className="roadmap-cards">
              {inStage.map((p) => (
                <ModuleCard key={p.id} part={p} isNext={nextId === p.id} onPart={onPart} />
              ))}
            </div>
          </div>
        )
      })}
      {area === 'databases' && schemata && (
        <a className="card roadmap-schemata" href={`${schemata.url}/?page=roadmap`} target="_blank" rel="noreferrer">
          <Database size={20} aria-hidden />
          <span>
            <strong>SQL, from your first query to window functions</strong>
            <span>Practise it in {schemata.name}: real Postgres in your browser, with interview questions.</span>
          </span>
          <ExternalLink size={15} aria-hidden />
        </a>
      )}
    </section>
  )
}

/** A module as a small card: title, one line, how many of its steps are done. */
function ModuleCard({ part, isNext, onPart }: { part: RoadmapPart; isNext: boolean; onPart: (id: string) => void }) {
  const progress = useProgress()
  const d = partDone(part, progress)
  const all = d === part.steps.length
  return (
    <button type="button" className={`roadmap-card-module${all ? ' is-done' : ''}${isNext ? ' is-next' : ''}`} onClick={() => onPart(part.id)}>
      <strong>
        {part.title}
        {all && <CheckCircle2 size={16} aria-label="Done" />}
        {isNext && !all && <span className="roadmap-next-tag">Next</span>}
      </strong>
      <span>{part.why}</span>
      <small>
        {d}/{part.steps.length} {part.steps.length === 1 ? 'step' : 'steps'}
      </small>
    </button>
  )
}

/** One module: its steps, ticked off as you go, and the way on to the next. */
function Module({
  part,
  onArea,
  onPart,
  onOpen,
  onRead,
}: {
  part: RoadmapPart
  onArea: (area: AreaId | null) => void
  onPart: (id: string) => void
  onOpen: (topic: TopicMeta) => void
  onRead: (topic: TopicMeta) => void
}) {
  const progress = useProgress()
  const d = partDone(part, progress)
  const firstUndone = part.steps.find((s) => !stepDone(s, progress))
  const after = nextPart(part)
  const Icon = part.area ? AREA_ICON[part.area] : Hammer
  return (
    <div className={`roadmap roadmap-module${part.area ? ` area-is-${part.area}` : ''}`}>
      <button type="button" className="btn btn-ghost roadmap-back" onClick={() => onArea(part.area)}>
        <ArrowLeft size={16} aria-hidden /> {part.area ? `${areaById(part.area).title} roadmap` : 'Roadmap'}
      </button>
      <header className="roadmap-intro">
        <p className="roadmap-module-place">
          <Icon size={15} aria-hidden /> {placeOf(part)}
        </p>
        <h1>{part.title}</h1>
        <p>{part.why}</p>
        <div className="roadmap-summary">
          <span className="progress-bar" aria-hidden>
            <span style={{ width: `${(d / part.steps.length) * 100}%` }} />
          </span>
          <span>
            {d} of {part.steps.length} {part.steps.length === 1 ? 'step' : 'steps'}
          </span>
        </div>
      </header>
      <ol className="card roadmap-steps">
        {part.steps.map((step) => (
          <Step key={step.id} step={step} isNext={firstUndone?.id === step.id} onOpen={onOpen} onRead={onRead} />
        ))}
      </ol>
      {after && (
        <button type="button" className="card roadmap-continue" onClick={() => onPart(after.id)}>
          <span className="roadmap-continue-label">Next module · {placeOf(after)}</span>
          <strong>{after.title}</strong>
          <span>{after.why}</span>
          <ArrowRight size={18} aria-hidden />
        </button>
      )}
    </div>
  )
}

function Step({ step, isNext, onOpen, onRead }: { step: RoadmapStep; isNext: boolean; onOpen: (topic: TopicMeta) => void; onRead: (topic: TopicMeta) => void }) {
  const progress = useProgress()
  const lib = useLibrary()
  const topic = step.topic ? topicById.get(step.topic) : undefined
  const done = stepDone(step, progress)
  const Icon = topic ? topicIcon(topic.id) : null
  return (
    <li className={`roadmap-step${done ? ' is-done' : ''}${isNext ? ' is-next' : ''}`}>
      <button
        type="button"
        className="roadmap-check"
        aria-pressed={done}
        title={topic ? (done ? 'Mark the topic not complete' : 'Mark the topic complete') : done ? 'Mark not done' : 'Mark done'}
        onClick={() => toggle(step)}
      >
        {done ? <CheckCircle2 size={22} aria-label="Done" /> : <Circle size={22} aria-label="Not done" />}
      </button>
      <div className="roadmap-step-body">
        {topic ? (
          <button type="button" className="roadmap-step-title" onClick={() => onOpen(topic)}>
            {step.title}
          </button>
        ) : (
          <strong className="roadmap-step-title">{step.title}</strong>
        )}
        {isNext && <span className="roadmap-next-tag">Next</span>}
        <p>{step.detail}</p>
        <div className="roadmap-links">
          {topic && Icon && (
            <button type="button" className="roadmap-topic" onClick={() => onOpen(topic)}>
              <Icon size={15} aria-hidden /> {topic.title}
              <span>{readiness(topic, progress.topics[topic.id])}% ready</span>
            </button>
          )}
          {topic && (
            <button type="button" className="roadmap-read" onClick={() => onRead(topic)} title={`Read ${topic.title} as an article`}>
              <BookOpenText size={14} aria-hidden /> Read
            </button>
          )}
          {step.practice && (
            <span className="roadmap-practice">
              <Hammer size={13} aria-hidden /> Build it yourself
            </span>
          )}
          {guidesOf(step, lib).map((g) => (
            <a key={g.slug} className="roadmap-guide" href={g.url} target="_blank" rel="noreferrer" title={`${g.title} (${lib?.sourceOf(g)?.name ?? g.source})`}>
              <BookOpen size={13} aria-hidden /> {g.title} <ExternalLink size={11} aria-hidden />
            </a>
          ))}
        </div>
      </div>
    </li>
  )
}
