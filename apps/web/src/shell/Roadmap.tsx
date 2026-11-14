import { BookOpen, BookOpenText, CheckCircle2, Circle, ExternalLink, Hammer, Play, Route, Sparkles } from 'lucide-react'
import { readiness, toggleRoadmapStep, updateTopic, useProgress } from '../learn/progress'
import {
  currentArea,
  LEVEL_TAGLINE,
  levelGroups,
  nextStep,
  partDone,
  partsOf,
  ROADMAP,
  type RoadmapPart,
  type RoadmapStep,
  stepDone,
  unplacedTopics,
} from '../learn/roadmap'
import { areaById, AREAS, type AreaId } from '../topics/areas'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import { AREA_ICON, AreaChips } from './Areas'
import type { Guide } from '../topics/library'
import { useLibrary } from '../topics/useLibrary'
import { topicIcon } from './topicIcons'

const topicById = new Map(TOPICS.map((t) => [t.id, t]))
type Library = NonNullable<ReturnType<typeof useLibrary>>
// Readings appear once the library has loaded (it isn't part of the start-up bundle).
const guidesOf = (step: RoadmapStep, lib: Library | null): Guide[] =>
  lib ? (step.guides ?? []).map((s) => lib.LIBRARY.guides.find((g) => g.slug === s)).filter((g): g is Guide => Boolean(g)) : []

const jump = (partId: string) => document.getElementById(`part-${partId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

/** "Infra · Part 2", or "Final project" for the part that spans every area. */
function partLabel(part: RoadmapPart): string {
  if (!part.area) return part.title
  return `${areaById(part.area).title} · Part ${partsOf(part.area).indexOf(part) + 1}`
}

function toggle(step: RoadmapStep) {
  if (step.topic) updateTopic(step.topic, (p) => ({ completed: !p.completed, completedAt: p.completed ? undefined : Date.now() }))
  else toggleRoadmapStep(step.id)
}

/**
 * The roadmap page: a track per area (Development, Infra, Databases, AI) and a final
 * project. All shows every track in turn; picking an area shows only its track.
 */
export function Roadmap({
  area,
  onArea,
  onOpen,
  onRead,
}: {
  area: AreaId | null
  onArea: (area: AreaId | null) => void
  onOpen: (topic: TopicMeta) => void
  onRead: (topic: TopicMeta) => void
}) {
  const progress = useProgress()
  const parts = area ? partsOf(area) : ROADMAP
  const steps = parts.flatMap((part) => part.steps)
  const done = steps.filter((step) => stepDone(step, progress)).length
  // On All, "next" is the next step in the track you're on, then anything left anywhere.
  const next = area ? nextStep(progress, area) : (nextStep(progress, currentArea(progress)) ?? nextStep(progress))
  const extra = unplacedTopics(TOPICS, area ?? undefined)
  const a = area ? areaById(area) : null
  // On All, each area's parts start under the area's own heading.
  const startsArea = (part: RoadmapPart, i: number) => !area && part.area !== (i > 0 ? parts[i - 1].area : undefined)

  return (
    <div className="roadmap">
      <AreaChips value={area} onChange={onArea} label="Tracks" />
      <header className="card roadmap-head">
        <p className="eyebrow">
          <Route size={15} aria-hidden /> Roadmap
        </p>
        <h1>{a ? `${a.title} roadmap` : 'Where to start'}</h1>
        {a ? (
          <p>
            {a.tagline}. {parts.length} {parts.length === 1 ? 'part' : 'parts'} in the order they build on each other: {parts.map((p) => p.title).join(' → ')}. Each step
            opens a topic or a reading. Tick it off when you're done; a topic counts once you mark it complete.
          </p>
        ) : (
          <p>
            Four tracks, one per area: {AREAS.map((x) => x.title).join(', ')}, then a final project that uses them all. Each track is in the order
            its parts build on each other, from Basics to Advanced where it applies. Follow the track you're on, or pick one below. Each step opens a
            topic or a reading; tick it off when you're done.
          </p>
        )}
        <div className="roadmap-total">
          <span className="progress-bar" aria-hidden>
            <span style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
          </span>
          <span>
            {done} of {steps.length} steps
          </span>
        </div>
        {next ? (
          <NextUp part={next.part} step={next.step} onOpen={onOpen} />
        ) : (
          <p className="roadmap-finished">
            <Sparkles size={16} aria-hidden /> You've finished {a ? `the ${a.title} track` : 'the whole roadmap'}.
          </p>
        )}
      </header>

      <nav className="roadmap-nav" aria-label="Parts">
        {parts.map((part) => {
          const d = partDone(part, progress)
          const Icon = part.area ? AREA_ICON[part.area] : Hammer
          return (
            <button key={part.id} type="button" className={`${part.area ? `area-is-${part.area}` : ''}${d === part.steps.length ? ' is-done' : ''}`} onClick={() => jump(part.id)}>
              <span className="roadmap-nav-num">{d === part.steps.length ? <CheckCircle2 size={14} aria-label="Done" /> : <Icon size={14} aria-hidden />}</span>
              {part.title}
              <small>
                {d}/{part.steps.length}
              </small>
            </button>
          )
        })}
      </nav>

      <ol className="roadmap-parts">
        {parts.map((part, i) => {
          const d = partDone(part, progress)
          const AreaIcon = part.area ? AREA_ICON[part.area] : Hammer
          const number = part.area ? partsOf(part.area).indexOf(part) + 1 : null
          return (
            <li key={part.id} id={`part-${part.id}`} className={`card roadmap-part${part.area ? ` area-is-${part.area}` : ''}${d === part.steps.length ? ' is-done' : ''}`}>
              {startsArea(part, i) && (
                <p className="roadmap-area-head">
                  <AreaIcon size={16} aria-hidden /> {part.area ? `${areaById(part.area).title} track` : 'Putting it together'}
                  {part.area && (
                    <button type="button" className="link-btn" onClick={() => onArea(part.area)}>
                      Only {areaById(part.area).title}
                    </button>
                  )}
                </p>
              )}
              <header>
                <span className="roadmap-num" aria-hidden>
                  {number ?? <Hammer size={18} />}
                </span>
                <div>
                  <p className="roadmap-tagline">
                    {partLabel(part)} · {part.tagline}
                    {part.optional && <span className="roadmap-optional">Optional</span>}
                  </p>
                  <h2>{part.title}</h2>
                </div>
                <span className="roadmap-count">
                  {d}/{part.steps.length}
                </span>
              </header>
              <p className="roadmap-why">{part.why}</p>
              <span className="progress-bar" aria-hidden>
                <span style={{ width: `${(d / part.steps.length) * 100}%` }} />
              </span>
              {levelGroups(part).map((group) => (
                <section key={group.steps[0].id} className={group.level ? 'roadmap-level' : undefined}>
                  {group.level && (
                    <h3>
                      {group.level} <span>{LEVEL_TAGLINE[group.level]}</span>
                      <small>
                        {group.steps.filter((s) => stepDone(s, progress)).length}/{group.steps.length}
                      </small>
                    </h3>
                  )}
                  <ol className="roadmap-steps">
                    {group.steps.map((step) => (
                      <Step key={step.id} step={step} isNext={next?.step.id === step.id} onOpen={onOpen} onRead={onRead} />
                    ))}
                  </ol>
                </section>
              ))}
            </li>
          )
        })}
        {extra.length > 0 && (
          <li id="part-more" className="card roadmap-part">
            <header>
              <span className="roadmap-num" aria-hidden>
                +
              </span>
              <div>
                <p className="roadmap-tagline">New since the roadmap was written</p>
                <h2>More topics</h2>
              </div>
            </header>
            <ol className="roadmap-steps">
              {extra.map((t) => (
                <Step key={t.id} step={{ id: `topic-${t.id}`, title: t.title, detail: t.blurb, topic: t.id }} isNext={false} onOpen={onOpen} onRead={onRead} />
              ))}
            </ol>
          </li>
        )}
      </ol>
    </div>
  )
}

function NextUp({ part, step, onOpen }: { part: RoadmapPart; step: RoadmapStep; onOpen: (topic: TopicMeta) => void }) {
  const topic = step.topic ? topicById.get(step.topic) : undefined
  const guide = guidesOf(step, useLibrary())[0]
  return (
    <div className="roadmap-next">
      <span className="roadmap-next-label">
        Next up · {partLabel(part)}: {part.title}
      </span>
      <strong>{step.title}</strong>
      <span>{step.detail}</span>
      <div className="roadmap-next-actions">
        {topic ? (
          <button type="button" className="btn btn-primary btn-wrap" onClick={() => onOpen(topic)}>
            <Play size={15} fill="currentColor" /> Open {topic.title}
          </button>
        ) : guide ? (
          <a className="btn btn-primary btn-wrap" href={guide.url} target="_blank" rel="noreferrer">
            <BookOpen size={15} /> Read: {guide.title}
          </a>
        ) : null}
        <button type="button" className="btn" onClick={() => jump(part.id)}>
          Go to {part.title}
        </button>
      </div>
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
