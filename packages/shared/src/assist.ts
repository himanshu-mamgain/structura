import { z } from 'zod'

export const SHAPE_COLORS = [
  'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
  'orange', 'green', 'light-green', 'light-red', 'red', 'white',
] as const
export const SHAPE_FILLS = ['none', 'semi', 'solid', 'pattern'] as const
export const SHAPE_GEOS = [
  'rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star', 'cloud',
  'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'check-box', 'x-box',
] as const

/** A canvas shape, flattened to what the assistant needs to see. */
export interface CanvasShape {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  text?: string
  color?: string
  fill?: string
  geo?: string
}

/**
 * One edit to apply to the canvas. Every field is present (null when unused)
 * so the schema works with strict structured outputs.
 */
export const CanvasActionSchema = z.object({
  op: z.enum(['create', 'update', 'delete']),
  id: z.string().nullable().describe('Existing shape id. Required for update and delete; null for create.'),
  kind: z.enum(['geo', 'text', 'note']).nullable().describe('Shape kind for create; null otherwise.'),
  geo: z.enum(SHAPE_GEOS).nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  text: z.string().nullable(),
  color: z.enum(SHAPE_COLORS).nullable(),
  fill: z.enum(SHAPE_FILLS).nullable(),
})
export type CanvasAction = z.infer<typeof CanvasActionSchema>

export const AssistReplySchema = z.object({
  reply: z.string().describe('Short spoken reply to the user: one to three sentences, no markdown.'),
  actions: z.array(CanvasActionSchema),
})
export type AssistReply = z.infer<typeof AssistReplySchema>

export interface AssistTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface AssistRequest {
  transcript: string
  shapes: CanvasShape[]
  /** PNG of the current page, base64 without the data: prefix. Null when the page is empty. */
  image: string | null
  /** Page-space bounds the image covers, so pixels can be mapped to coordinates. */
  imageBounds: { x: number; y: number; w: number; h: number } | null
  history: AssistTurn[]
}

/** Server-sent events emitted by POST /api/assist. */
export type AssistStreamEvent =
  | { type: 'reply'; reply: string }
  | ({ type: 'done' } & AssistReply)
  | { type: 'error'; error: string }
