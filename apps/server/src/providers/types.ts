import type { z } from 'zod'
import type { AssistTurn } from '@structura/shared'

/** One request to a model: instructions, the user's turn, and the schema its JSON answer must match. */
export interface ModelCall<T> {
  system: string
  prompt: string
  schema: z.ZodType<T>
  /** PNG of the canvas, base64; providers may skip it (see OLLAMA_VISION). */
  image: string | null
  history: AssistTurn[]
}

/**
 * Streams one model call. Calls onSnapshot with the JSON generated so far (for
 * live UI) and resolves with the validated answer.
 */
export type Provider = <T>(call: ModelCall<T>, onSnapshot: (jsonSoFar: string) => void, signal: AbortSignal) => Promise<T>
