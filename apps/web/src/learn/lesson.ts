import type { StaticTopic } from '../topics/types'
import { splitSentences } from './text'

// A topic as a spoken lesson, for Commute mode: chapters of sentences, with
// pauses where the listener should think. The audio itself is generated ahead
// of time (scripts/lessons.ts) so it plays offline, screen off, in a pocket.

/** A sentence to say, or a silence in seconds. */
export type LessonItem = { say: string } | { pause: number }

export interface LessonChapter {
  id: string
  title: string
  items: LessonItem[]
}

const say = (text: string): LessonItem[] => splitSentences(text).map((s) => ({ say: s }))
const pause = (seconds: number): LessonItem => ({ pause: seconds })

/** Interview questions from the "Interview follow-ups" section, one per bullet. */
function followUps(topic: StaticTopic): string[] {
  const section = topic.explanation.sections.find((s) => /interview/i.test(s.heading))
  return section ? section.body.split('\n').map((l) => l.replace(/^\s*[-•*]\s+/, '').trim()).filter(Boolean) : []
}

export function lessonChapters(topic: StaticTopic, next?: StaticTopic): LessonChapter[] {
  const e = topic.explanation
  const trace = e.trace
  // The walkthrough tells the step-by-step story better than its text summary; follow-ups become practice.
  const sections = e.sections.filter((s) => !/interview/i.test(s.heading) && !(trace && /step by step/i.test(s.heading)))
  const chapters: LessonChapter[] = []

  chapters.push({
    id: 'intro',
    title: 'Introduction',
    items: [
      ...say(`${topic.title}.`),
      pause(0.6),
      ...say(e.summary),
      pause(0.6),
      ...say(`In this lesson: ${sections.map((s) => s.heading.toLowerCase()).join(', ')}${trace ? ', a request walked through step by step' : ''}, the key takeaways, and interview practice.`),
    ],
  })

  for (const [i, s] of sections.entries()) {
    chapters.push({ id: `section-${i}`, title: s.heading, items: [...say(`${s.heading}.`), pause(0.5), ...say(s.body)] })
  }

  if (trace) {
    chapters.push({
      id: 'walkthrough',
      title: 'Walkthrough',
      items: [
        ...say(`Let's follow one request through the design: ${trace.input}.`),
        pause(0.8),
        ...trace.steps.flatMap((step, i) => [...say(`Step ${i + 1}. ${step.text}`), pause(0.7)]),
      ],
    })
  }

  chapters.push({
    id: 'takeaways',
    title: 'Key takeaways',
    items: [...say('Key takeaways.'), pause(0.5), ...topic.takeaways.flatMap((t, i) => [...say(`${i + 1}. ${t}`), pause(0.6)])],
  })

  const questions = followUps(topic)
  if (questions.length) {
    chapters.push({
      id: 'practice',
      title: 'Interview practice',
      items: [
        ...say("Interview practice. I'll ask a question, then pause so you can answer it in your head, or out loud if the carriage is empty."),
        pause(1),
        ...questions.flatMap((q, i) => [...say(`Question ${i + 1}. ${q}`), pause(8)]),
        ...say(`That's ${topic.title}.${next ? ` Next up: ${next.title}.` : ' Well done.'}`),
      ],
    })
  }
  return chapters
}
