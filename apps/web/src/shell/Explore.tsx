import { useState } from 'react'
import { CheckCircle2, ChevronRight, Clapperboard, ExternalLink, Library, Route } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { partsOf } from '../learn/roadmap'
import { areaById, AREAS, type AreaId, LIBRARY_AREAS } from '../topics/areas'
import { fullCoverOnError, smallCover, TOPICS, type TopicMeta } from '../topics/catalog'
import { useLibrary } from '../topics/useLibrary'
import { AREA_ICON, AreaChips, topicsIn } from './Areas'
import { NotesShelf } from './Notes'
import { RoadmapCard } from './RoadmapCard'
import { SearchBox } from './Search'
import { topicIcon } from './topicIcons'

/**
 * The Explore tab, like Instagram's: search at the top, then the four areas
 * (Development, Infra, Databases, AI), each a grid of tiles (the ones with a reel show
 * its cover), then the library. Picking an area shows only its topics and reading.
 */
export function Explore({
  onOpen,
  onRead,
  onNote,
  area,
  onArea,
  category,
  onCategory,
  onRoadmap,
}: {
  onOpen: (topic: TopicMeta) => void
  onRead: (topic: TopicMeta) => void
  onNote: (id: string) => void
  area: AreaId | null
  onArea: (area: AreaId | null) => void
  category: string | null
  onCategory: (id: string | null) => void
  onRoadmap: (area?: AreaId) => void
}) {
  const [query, setQuery] = useState('')

  return (
    <div className="explore">
      <SearchBox inline onOpen={onOpen} onRead={onRead} onNote={onNote} query={query} onQuery={setQuery} />
      {!query.trim() && (
        <>
          <AreaChips value={area} onChange={onArea} />
          {area ? (
            <AreaIntro area={area} onRoadmap={() => onRoadmap(area)} />
          ) : (
            <>
              <RoadmapCard onRoadmap={() => onRoadmap()} />
              <NotesShelf onNote={onNote} />
            </>
          )}
          {(area ? [areaById(area)] : AREAS).map((a) => (
            <AreaTopics key={a.id} area={a.id} only={Boolean(area)} onOpen={onOpen} onArea={onArea} />
          ))}
          <LibraryList area={area} category={category} onCategory={onCategory} onOpen={onOpen} />
        </>
      )}
    </div>
  )
}

/** The top of an area's page: what's in it, how far you are, and its roadmap track. */
function AreaIntro({ area, onRoadmap }: { area: AreaId; onRoadmap: () => void }) {
  const progress = useProgress()
  const a = areaById(area)
  const Icon = AREA_ICON[area]
  const topics = topicsIn(area)
  const done = topics.filter((t) => progress.topics[t.id]?.completed).length
  const parts = partsOf(area)
  return (
    <header className={`card area-intro area-is-${area}`}>
      <span className="area-card-icon" aria-hidden>
        <Icon size={24} />
      </span>
      <div>
        <h1>{a.title}</h1>
        <p>{a.tagline}.</p>
        <p className="area-intro-count">
          {topics.length} topics · {done} completed
        </p>
      </div>
      {parts.length > 0 && (
        <button type="button" className="btn btn-wrap area-intro-roadmap" onClick={onRoadmap}>
          <Route size={16} aria-hidden /> {a.title} roadmap: {parts.map((p) => p.title).join(' → ')} <ChevronRight size={16} aria-hidden />
        </button>
      )}
    </header>
  )
}

/** One area's topics as tiles, under its heading. */
function AreaTopics({ area, only, onOpen, onArea }: { area: AreaId; only: boolean; onOpen: (topic: TopicMeta) => void; onArea: (area: AreaId) => void }) {
  const progress = useProgress()
  const a = areaById(area)
  const Icon = AREA_ICON[area]
  const topics = topicsIn(area)
  return (
    <section className={`explore-area area-is-${area}`} aria-label={`${a.title} topics`}>
      <div className="explore-area-head">
        <h2 className="explore-title">
          <Icon size={19} aria-hidden /> {only ? 'Topics' : a.title} <small>{topics.length}</small>
        </h2>
        {!only && (
          <button type="button" className="link-btn" onClick={() => onArea(area)}>
            Only {a.title}
          </button>
        )}
      </div>
      {!only && <p className="explore-area-tagline">{a.tagline}</p>}
      <div className="explore-grid">
        {topics.map((t) => {
          const TopicIcon = topicIcon(t.id)
          const done = progress.topics[t.id]?.completed
          return (
            <button key={t.id} type="button" className={`explore-tile is-${t.difficulty.toLowerCase()}`} onClick={() => onOpen(t)}>
              {t.video ? <img src={smallCover(t.video)} alt="" loading="lazy" onError={fullCoverOnError} /> : <TopicIcon className="explore-tile-icon" size={34} aria-hidden />}
              {t.video && <Clapperboard className="explore-tile-reel" size={16} aria-label="Has a reel" />}
              {done && <CheckCircle2 className="explore-tile-done" size={16} aria-label="Completed" />}
              <span className="explore-tile-title">{t.title}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The whole syllabus: every guide and chapter, filterable by category, linking to the original. */
function LibraryList({
  area,
  category,
  onCategory,
  onOpen,
}: {
  area: AreaId | null
  category: string | null
  onCategory: (id: string | null) => void
  onOpen: (topic: TopicMeta) => void
}) {
  const lib = useLibrary()
  if (!lib) {
    return (
      <section className="library home-section" id="library" aria-label="Library" aria-busy="true">
        <h2>
          <Library size={20} /> Library
        </h2>
      </section>
    )
  }
  return <LibraryGuides key={area ?? 'all'} lib={lib} area={area} category={category} onCategory={onCategory} onOpen={onOpen} />
}

function LibraryGuides({
  lib: { LIBRARY, sourceOf, topicForGuide },
  area,
  category,
  onCategory,
  onOpen,
}: {
  lib: NonNullable<ReturnType<typeof useLibrary>>
  area: AreaId | null
  category: string | null
  onCategory: (id: string | null) => void
  onOpen: (topic: TopicMeta) => void
}) {
  // Phones start with a shorter list; "Show more" loads the rest.
  const [limit, setLimit] = useState(() => (window.innerWidth < 640 ? 24 : 60))
  // An area shows only its own categories of reading.
  const inArea = (id: string) => !area || LIBRARY_AREAS[area].includes(id)
  const categories = LIBRARY.categories.filter((c) => inArea(c.id))
  const guides = (category ? LIBRARY.guides.filter((g) => g.categories.includes(category)) : LIBRARY.guides).filter((g) => g.categories.some(inArea))
  return (
    <section className="library home-section" id="library" aria-label="Library">
      <header className="library-head">
        <h2>
          <Library size={20} /> Library
        </h2>
        <p>
          {area
            ? `${guides.length} guides and chapters about ${areaById(area).title.toLowerCase()} from open system design collections. `
            : `${LIBRARY.guides.length} guides and chapters from open system design collections, our syllabus. `}
          Titles link to the originals; the ones marked Interactive are already Structura topics.
        </p>
      </header>
      <div className="library-cats">
        <button type="button" aria-pressed={!category} onClick={() => onCategory(null)}>
          All
        </button>
        {categories.map((c) => (
          <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => onCategory(c.id)}>
            {c.title}
          </button>
        ))}
      </div>
      <ul className="guides">
        {guides.slice(0, limit).map((g) => {
          const covered = topicForGuide(TOPICS, g.slug)
          return (
            <li key={g.slug} className="guide">
              <a href={g.url} target="_blank" rel="noreferrer">
                {g.title} <ExternalLink size={13} aria-hidden />
              </a>
              <span className="guide-tags">{[sourceOf(g).name.split(' (')[0], ...g.tags.slice(0, 3)].join(' · ')}</span>
              {covered && (
                <button type="button" className="guide-interactive" onClick={() => onOpen(covered)}>
                  Interactive: {covered.title}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {guides.length > limit && (
        <button type="button" className="btn btn-ghost library-more" onClick={() => setLimit(limit + 90)}>
          Show more ({guides.length - limit} left)
        </button>
      )}
      <ul className="library-note">
        {Object.values(LIBRARY.sources).map((s) => (
          <li key={s.repo}>
            <a href={s.repo} target="_blank" rel="noreferrer">
              {s.name}
            </a>
            : {s.license}
          </li>
        ))}
      </ul>
    </section>
  )
}
