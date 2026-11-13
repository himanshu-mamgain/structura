import { useState } from 'react'
import { CheckCircle2, Clapperboard, ExternalLink, Library, Shapes } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { STATIC_TOPICS, type StaticTopic } from '../topics'
import { LIBRARY, sourceOf, topicForGuide } from '../topics/library'
import { NotesShelf } from './Notes'
import { RoadmapCard } from './Roadmap'
import { SearchBox } from './Search'
import { topicIcon } from './topicIcons'

/**
 * The Explore tab, like Instagram's: search at the top, your Notion notes,
 * every topic as a grid of tiles (the ones with a reel show its cover), then
 * the whole library.
 */
export function Explore({
  onOpen,
  onNote,
  category,
  onCategory,
  onRoadmap,
}: {
  onOpen: (topic: StaticTopic) => void
  onNote: (id: string) => void
  category: string | null
  onCategory: (id: string | null) => void
  onRoadmap: () => void
}) {
  const [query, setQuery] = useState('')
  const progress = useProgress()

  return (
    <div className="explore">
      <SearchBox inline onOpen={onOpen} onNote={onNote} query={query} onQuery={setQuery} />
      {!query.trim() && (
        <>
          <RoadmapCard onRoadmap={onRoadmap} />
          <NotesShelf onNote={onNote} />
          <h2 className="explore-title">
            <Shapes size={19} aria-hidden /> Topics
          </h2>
          <section className="explore-grid" aria-label="Topics">
            {STATIC_TOPICS.map((t) => {
              const Icon = topicIcon(t.id)
              const done = progress.topics[t.id]?.completed
              return (
                <button key={t.id} type="button" className={`explore-tile is-${t.difficulty.toLowerCase()}`} onClick={() => onOpen(t)}>
                  {t.video ? <img src={t.video.replace(/\.mp4$/, '.jpg')} alt="" loading="lazy" /> : <Icon className="explore-tile-icon" size={34} aria-hidden />}
                  {t.video && <Clapperboard className="explore-tile-reel" size={16} aria-label="Has a reel" />}
                  {done && <CheckCircle2 className="explore-tile-done" size={16} aria-label="Completed" />}
                  <span className="explore-tile-title">{t.title}</span>
                </button>
              )
            })}
          </section>
          <LibraryList category={category} onCategory={onCategory} onOpen={onOpen} />
        </>
      )}
    </div>
  )
}

/** The whole syllabus: every guide and chapter, filterable by category, linking to the original. */
function LibraryList({ category, onCategory, onOpen }: { category: string | null; onCategory: (id: string | null) => void; onOpen: (topic: StaticTopic) => void }) {
  // Phones start with a shorter list; "Show more" loads the rest.
  const [limit, setLimit] = useState(() => (window.innerWidth < 640 ? 24 : 60))
  const guides = category ? LIBRARY.guides.filter((g) => g.categories.includes(category)) : LIBRARY.guides
  return (
    <section className="library home-section" id="library" aria-label="Library">
      <header className="library-head">
        <h2>
          <Library size={20} /> Library
        </h2>
        <p>
          {LIBRARY.guides.length} guides and chapters from open system design collections, our syllabus. Titles link to the originals; the ones
          marked Interactive are already Structura topics.
        </p>
      </header>
      <div className="library-cats">
        <button type="button" aria-pressed={!category} onClick={() => onCategory(null)}>
          All
        </button>
        {LIBRARY.categories.map((c) => (
          <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => onCategory(c.id)}>
            {c.title}
          </button>
        ))}
      </div>
      <ul className="guides">
        {guides.slice(0, limit).map((g) => {
          const covered = topicForGuide(STATIC_TOPICS, g.slug)
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
