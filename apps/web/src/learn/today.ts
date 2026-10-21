import type { StaticTopic } from '../topics'
import { type Progress, readiness, videoFraction } from './progress'

// "What should I study today?" without AI: a few plain rules over the learner's
// progress. Continue what's started, otherwise take the next topic by
// difficulty, and when everything is done, practise.

export interface TodayPlan {
  topic: StaticTopic | null
  headline: string
  reason: string
  steps: string[]
  /** What the voice guide says. */
  script: string
}

const LEVELS = ['Beginner', 'Intermediate', 'Advanced'] as const

function nextSteps(topic: StaticTopic, progress: Progress): string[] {
  const p = progress.topics[topic.id]
  const steps: string[] = []
  const unread = topic.explanation.sections.findIndex((_, i) => !p?.sectionsRead?.includes(i))
  if (topic.video && videoFraction(p) < 0.9) {
    steps.push(p?.videoTime ? 'Finish the narrated video' : 'Watch the narrated video')
  }
  if (!p?.walked && topic.explanation.trace) steps.push('Walk one request through the diagram')
  if (unread >= 0) steps.push(`Read "${topic.explanation.sections[unread].heading}"`)
  const followUps = topic.explanation.sections.find((s) => /interview/i.test(s.heading))
  if (followUps) steps.push('Answer the interview follow-ups out loud')
  if (!p?.completed) steps.push('Mark it complete')
  return steps.slice(0, 3)
}

function greeting(): string {
  const hour = new Date().getHours()
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
}

export function planToday(topics: StaticTopic[], progress: Progress, quizTotal: number): TodayPlan {
  const p = (t: StaticTopic) => progress.topics[t.id]

  const started = topics
    .filter((t) => p(t)?.lastOpenedAt && !p(t)?.completed)
    .sort((a, b) => (p(b)?.lastOpenedAt ?? 0) - (p(a)?.lastOpenedAt ?? 0))[0]
  if (started) {
    const ready = readiness(started, p(started))
    const steps = nextSteps(started, progress)
    return {
      topic: started,
      headline: `Continue ${started.title}`,
      reason: `You're ${ready}% interview ready on it. Finishing what you started sticks better than starting something new.`,
      steps,
      script: `${greeting()}. Today, let's finish ${started.title}. You're ${ready} percent interview ready on it. ${steps.map((s, i) => `Step ${i + 1}: ${s}.`).join(' ')} Tap start when you're ready.`,
    }
  }

  const fresh = LEVELS.flatMap((level) => topics.filter((t) => t.difficulty === level && !p(t)?.lastOpenedAt))[0]
  if (fresh) {
    const steps = nextSteps(fresh, progress)
    const anyDone = topics.some((t) => p(t)?.completed)
    return {
      topic: fresh,
      headline: `Start ${fresh.title}`,
      reason: `${fresh.difficulty} level: ${fresh.blurb}.${anyDone ? ' It builds on what you have already finished.' : ' A good first topic.'}`,
      steps,
      script: `${greeting()}. Today's pick is ${fresh.title}, a ${fresh.difficulty.toLowerCase()} topic about ${fresh.blurb.toLowerCase()}. ${steps.map((s, i) => `Step ${i + 1}: ${s}.`).join(' ')} Tap start when you're ready.`,
    }
  }

  const weakest = [...topics].sort((a, b) => readiness(a, p(a)) - readiness(b, p(b)))[0]
  const quiz = progress.quizBest
  return {
    topic: weakest ?? null,
    headline: 'Practise: test yourself',
    reason: `You've opened every topic.${quiz !== undefined ? ` Your best quiz score is ${quiz} out of ${quizTotal}.` : ''} Revisit your weakest topic, then take the quiz.`,
    steps: weakest ? [`Revisit ${weakest.title}`, 'Take the quiz', 'Explain one design out loud, start to finish'] : ['Take the quiz'],
    script: `${greeting()}. You've opened every topic, nice work. Today, revisit ${weakest?.title ?? 'your weakest topic'}, then take the quiz. Try explaining one design out loud from start to finish, like in an interview.`,
  }
}
