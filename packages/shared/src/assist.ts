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
/** Node shapes for generated diagrams (no decorative arrow shapes: edges are real arrows). */
export const NODE_SHAPES = ['rectangle', 'ellipse', 'diamond', 'hexagon', 'cloud'] as const

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
  /** Frame the shape sits in, if any. */
  parent?: string
  /** For arrows: the shapes they connect. */
  from?: string
  to?: string
}

/**
 * One edit to apply to the canvas. Every field is present (null when unused)
 * so the schema works with strict structured outputs.
 */
export const CanvasActionSchema = z.object({
  op: z.enum(['create', 'update', 'delete', 'connect']),
  id: z
    .string()
    .nullable()
    .describe('Existing shape id. Required for update and delete; for connect, the shape the arrow starts at; null for create.'),
  to: z.string().nullable().describe('For connect: the shape the arrow points to. Null otherwise.'),
  kind: z.enum(['geo', 'text', 'note']).nullable().describe('Shape kind for create; null otherwise.'),
  geo: z.enum(SHAPE_GEOS).nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  text: z.string().nullable().describe('Label text. For connect, the arrow label (or null).'),
  color: z.enum(SHAPE_COLORS).nullable(),
  fill: z.enum(SHAPE_FILLS).nullable(),
})
export type CanvasAction = z.infer<typeof CanvasActionSchema>

/**
 * A diagram described as a graph. The app computes the layout, so the model
 * only decides structure: what the boxes are, how they connect, how they group.
 */
export const DiagramSchema = z.object({
  replace: z.boolean().describe('True to clear the canvas and draw this instead (redoing the current diagram); false to add it beside existing shapes.'),
  direction: z.enum(['right', 'down']).describe('Main flow direction.'),
  groups: z.array(
    z.object({
      id: z.string(),
      label: z.string().describe('Frame title, e.g. "Auth Server" or "JWT".'),
    }),
  ),
  nodes: z.array(
    z.object({
      id: z.string().describe('Short unique id, e.g. "client".'),
      label: z.string().describe('Box text, a few words.'),
      shape: z.enum(NODE_SHAPES).describe('rectangle for components/steps, diamond for decisions, ellipse for start/end or actors, hexagon for external services, cloud for networks/internet.'),
      color: z.enum(SHAPE_COLORS),
      group: z.string().nullable().describe('Id of the group this node belongs to, or null.'),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().describe('Node id.'),
      to: z.string().describe('Node id.'),
      label: z.string().nullable().describe('What flows or happens, e.g. "sends JWT". Keep under 5 words.'),
      dashed: z.boolean().describe('True for optional, async or return flows.'),
    }),
  ),
})
export type Diagram = z.infer<typeof DiagramSchema>

export const AssistReplySchema = z.object({
  reply: z.string().describe('Spoken reply, no markdown.'),
  actions: z.array(CanvasActionSchema).describe('Small edits to existing shapes. Empty when drawing a diagram or only answering.'),
  diagram: DiagramSchema.nullable().describe('A full diagram to lay out and draw, or null.'),
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

/** A diagram still being generated: only the nodes, edges and groups that have fully arrived. */
export type PartialDiagram = Diagram

/** Server-sent events emitted by POST /api/assist. */
export type AssistStreamEvent =
  | { type: 'reply'; reply: string }
  | { type: 'diagram'; diagram: PartialDiagram }
  | ({ type: 'done' } & AssistReply)
  | { type: 'error'; error: string }
