import { BrainCircuit, ChevronRight, Cloud, CodeXml, Database, LayoutGrid, type LucideIcon } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { ROADMAP_STEPS } from '../learn/roadmap'
import { AREA_OF, AREAS, areaById, type AreaId } from '../topics/areas'
import { TOPICS } from '../topics/catalog'

// The four areas in the app shell: filter chips, the cards on Home, and the small tag
// on a topic. Colours live in CSS (.area-is-<id>).

export const AREA_ICON: Record<AreaId, LucideIcon> = {
  development: CodeXml,
  infra: Cloud,
  databases: Database,
  ai: BrainCircuit,
}

// Topics in the order the roadmap teaches them; any it doesn't mention yet go last.
const roadmapOrder = new Map<string, number>()
for (const { step } of ROADMAP_STEPS) if (step.topic && !roadmapOrder.has(step.topic)) roadmapOrder.set(step.topic, roadmapOrder.size)
const byRoadmap = [...TOPICS].sort((a, b) => (roadmapOrder.get(a.id) ?? Infinity) - (roadmapOrder.get(b.id) ?? Infinity))

/** An area's topics, in roadmap order. */
export const topicsIn = (area: AreaId) => byRoadmap.filter((t) => AREA_OF[t.id] === area)

/** A row of chips: All, then each area with its topic count. */
export function AreaChips({ value, onChange, label = 'Areas' }: { value: AreaId | null; onChange: (area: AreaId | null) => void; label?: string }) {
  return (
    <div className="area-chips" role="group" aria-label={label}>
      <button type="button" aria-pressed={!value} onClick={() => onChange(null)}>
        <LayoutGrid size={15} aria-hidden /> All
      </button>
      {AREAS.map((a) => {
        const Icon = AREA_ICON[a.id]
        return (
          <button key={a.id} type="button" className={`area-is-${a.id}`} aria-pressed={value === a.id} onClick={() => onChange(value === a.id ? null : a.id)}>
            <Icon size={15} aria-hidden /> {a.title}
            <small>{topicsIn(a.id).length}</small>
          </button>
        )
      })}
    </div>
  )
}

/** Home's way into the four areas, with how much of each you've completed. */
export function AreaCards({ onArea }: { onArea: (area: AreaId) => void }) {
  const progress = useProgress()
  return (
    <section className="home-section" aria-label="Areas">
      <h2>Browse by area</h2>
      <div className="area-cards">
        {AREAS.map((a) => {
          const Icon = AREA_ICON[a.id]
          const topics = topicsIn(a.id)
          const done = topics.filter((t) => progress.topics[t.id]?.completed).length
          return (
            <button key={a.id} type="button" className={`card area-card area-is-${a.id}`} onClick={() => onArea(a.id)}>
              <span className="area-card-icon" aria-hidden>
                <Icon size={22} />
              </span>
              <strong>{a.title}</strong>
              <span className="area-card-tagline">{a.tagline}</span>
              <span className="area-card-count">
                {topics.length} topics{done ? ` · ${done} done` : ''} <ChevronRight size={15} aria-hidden />
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** A topic's area, as a small tag; tapping it opens the area in Explore. */
export function AreaTag({ topicId, onArea }: { topicId: string; onArea?: (area: AreaId) => void }) {
  const id = AREA_OF[topicId]
  if (!id) return null
  const Icon = AREA_ICON[id]
  const content = (
    <>
      <Icon size={13} aria-hidden /> {areaById(id).title}
    </>
  )
  return onArea ? (
    <button type="button" className={`area-tag area-is-${id}`} onClick={() => onArea(id)} title={`More ${areaById(id).title} topics`}>
      {content}
    </button>
  ) : (
    <span className={`area-tag area-is-${id}`}>{content}</span>
  )
}
