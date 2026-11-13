import { Pause, Play, SkipForward } from 'lucide-react'
import { chaptersOf, next, toggle, useCommute } from '../learn/commute'
import { TOPICS } from '../topics/catalog'

// Kept apart from the Commute page (and its animation library), because it's on every page.

/** A slim player that follows you around the app while a lesson is loaded. */
export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const s = useCommute()
  const chapter = chaptersOf(s.topicId)[s.chapter]
  const topic = TOPICS.find((t) => t.id === s.topicId)
  if (!topic || !chapter || (!s.playing && s.time === 0)) return null
  return (
    <div className="mini-player">
      <span className="mini-progress" style={{ width: `${(s.time / (chapter.duration || 1)) * 100}%` }} />
      <button type="button" className="mini-text" onClick={onOpen}>
        <strong>{chapter.title}</strong>
        <span>{topic.title}</span>
      </button>
      <button type="button" className="mini-btn" onClick={() => toggle()} aria-label={s.playing ? 'Pause' : 'Play'}>
        {s.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <button type="button" className="mini-btn" onClick={() => next()} aria-label="Next chapter">
        <SkipForward size={20} />
      </button>
    </div>
  )
}
