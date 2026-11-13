import { ChevronRight, Route } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { nextStep, ROADMAP, ROADMAP_STEPS, stepDone } from '../learn/roadmap'

/** Home's and Explore's way in: how far along you are and what's next. */
export function RoadmapCard({ onRoadmap }: { onRoadmap: () => void }) {
  const progress = useProgress()
  const done = ROADMAP_STEPS.filter(({ step }) => stepDone(step, progress)).length
  const next = nextStep(progress)
  return (
    <button type="button" className="card roadmap-card" onClick={onRoadmap}>
      <span className="roadmap-card-icon" aria-hidden>
        <Route size={26} />
      </span>
      <span className="roadmap-card-text">
        <strong>{done ? 'Your roadmap' : 'Where to start'}</strong>
        <span>{ROADMAP.slice(0, 6).map((p) => p.title).join(' → ')}</span>
        {next && (
          <span className="roadmap-card-next">
            {done ? `${done} of ${ROADMAP_STEPS.length} steps · next: ${next.step.title}` : `Step 1: ${next.step.title}`}
          </span>
        )}
      </span>
      <ChevronRight size={20} aria-hidden />
    </button>
  )
}
