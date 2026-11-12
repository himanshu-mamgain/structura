import type { Diagram, Erd, Explanation } from '@structura/shared'
import type { LoadTest } from '../sim/loadtest'
import type { Simulator } from './simulator'

/**
 * A hand-written learning topic: drawn instantly, the same every time. Its
 * content follows the shared schemas (packages/shared), which the drawing code
 * and the explanation card render.
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
  /** Lets the 3D lab put real load through the design. */
  loadTest?: LoadTest
  /** A narrated explainer video (rendered by apps/video into public/videos). */
  video?: string
  /** The video's chapters: start second and title (from apps/video scripts/chapters.ts). */
  chapters?: [number, string][]
  /** A story to read first: a real-feeling incident told in chapters (learn/story.tsx renders it). */
  story?: Story
  /** The few points worth remembering, shown beside the explanation. */
  takeaways: string[]
  /** How much background the topic assumes. */
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced'
  /** Related guides in the library (slugs from library.json), for going deeper. */
  guides?: string[]
  /** Credit when the topic is adapted from an openly licensed work (required by CC BY). */
  adaptedFrom?: { title: string; author: string; url: string; license: string; licenseUrl: string }
}

/**
 * A topic told as a story: something breaks, and the design is how it gets
 * fixed. Chapter bodies are plain text: paragraphs split by blank lines,
 * "- " bullets, "> " for a pull quote, `code` and **bold** inline.
 */
export interface Story {
  /** The headline, like a magazine piece. */
  title: string
  /** One line under the headline. */
  dek: string
  chapters: {
    heading: string
    body: string
    /** Simulator inputs that replay this moment on the diagram. */
    replay?: { label: string; values: Record<string, string> }
  }[]
}
