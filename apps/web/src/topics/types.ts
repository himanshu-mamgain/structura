import type { Diagram, Erd, Explanation } from '@structura/shared'
import type { Simulator } from './simulator'

/**
 * A hand-written learning topic: drawn instantly, the same every time, with no
 * AI involved. Content follows the same schemas the AI produces, so the same
 * drawing code and explanation card render both.
 */
export interface StaticTopic {
  kind: 'static'
  id: string
  title: string
  /** One line shown in the topic list. */
  blurb: string
  architecture: Diagram
  database: Erd | null
  explanation: Explanation
  /** Lets the walkthrough run on the user's own input. */
  simulator?: Simulator
}

/** A topic the AI designs on demand (slower, and different each time). */
export interface AiTopic {
  kind: 'ai'
  id: string
  title: string
  blurb: string
  /** What the assistant is asked. */
  prompt: string
}

export type Topic = StaticTopic | AiTopic
