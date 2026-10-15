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
  /** The few points worth remembering, shown beside the explanation. */
  takeaways: string[]
  /** Related guides in the library (ByteByteGo slugs), for going deeper. */
  guides?: string[]
}
