// A topic's lesson (Lesson mode, ?topic=<id>&learn): short cards in simple English,
// each lighting up part of the topic's diagram, then three quick questions.
// One file per topic in ./lessons/<id>.ts. Writing rules are in CLAUDE.md
// ("Simple English"); scripts/export-catalog.ts checks every `focus` label exists.

export interface LessonCard {
  /** A few words. */
  title: string
  /** Two to four short sentences in simple English. Terms are explained the first time. */
  text: string
  /** Exact labels of the diagram boxes this card is about; they light up. */
  focus?: string[]
  /** A tiny real example: a command, a request, a number. */
  example?: string
  /** One line worth remembering. */
  remember?: string
}

export interface LessonQuestion {
  question: string
  options: string[]
  /** Index of the right option. */
  answer: number
  /** Why that answer is right, in one or two sentences. */
  why: string
}

export interface Lesson {
  cards: LessonCard[]
  quiz: LessonQuestion[]
}
