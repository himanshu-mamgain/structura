import { ChevronRight, Route } from 'lucide-react'
import { useProgress } from '../learn/progress'
import { currentArea, nextStep, ROADMAP_STEPS, stepDone } from '../learn/roadmap'
import { areaById, AREAS } from '../topics/areas'

/** Home's and Explore's way in: how far along you are and what's next. */
export function RoadmapCard({ onRoadmap }: { onRoadmap: () => void }) {
  const progress = useProgress()
  const done = ROADMAP_STEPS.filter(({ step }) => stepDone(step, progress)).length
  // The next step in the track you're on (the area of the topic you opened last).
  const area = currentArea(progress)
  const next = nextStep(progress, area) ?? nextStep(progress)
  return (
    <button type="button" className="card roadmap-card" onClick={onRoadmap}>
      <span className="roadmap-card-icon" aria-hidden>
        <Route size={26} />
      </span>
      <span className="roadmap-card-text">
        <strong>{done ? 'Your roadmap' : 'Where to start'}</strong>
        <span>{AREAS.map((a) => a.title).join(' · ')}: a track for each</span>
        {next && (
          <span className="roadmap-card-next">
            {done ? `${done} of ${ROADMAP_STEPS.length} steps · ` : ''}next in {next.part.area ? areaById(next.part.area).title : 'the final project'}: {next.step.title}
          </span>
        )}
      </span>
      <ChevronRight size={20} aria-hidden />
    </button>
  )
}
