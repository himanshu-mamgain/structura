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
  /** True when the user has this shape selected ("explain this"). */
  selected?: boolean
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

/** A database schema, drawn as an entity-relationship diagram. */
export const ErdSchema = z.object({
  replace: z.boolean().describe('True to clear the canvas and draw this instead; false to add it beside existing shapes.'),
  tables: z.array(
    z.object({
      id: z.string().describe('Short unique id, usually the table name.'),
      name: z.string().describe('Table name, snake_case plural, e.g. "orders".'),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.string().describe('SQL type, e.g. "uuid", "bigint", "text", "timestamptz", "numeric(10,2)".'),
          pk: z.boolean(),
          fk: z.string().nullable().describe('Referenced "table.column" for foreign keys, else null.'),
          nullable: z.boolean(),
          unique: z.boolean(),
        }),
      ),
      indexes: z.array(z.string()).describe('Secondary indexes worth having, e.g. "(user_id, created_at)". Empty if none.'),
    }),
  ),
  relations: z.array(
    z.object({
      from: z.string().describe('Table id holding the foreign key (or one side of a join).'),
      to: z.string().describe('Referenced table id.'),
      kind: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
      label: z.string().nullable().describe('Optional short meaning, e.g. "places".'),
    }),
  ),
})
export type Erd = z.infer<typeof ErdSchema>

/** An in-depth explanation of one concept, shown as a readable card next to the canvas. */
export const ExplanationSchema = z.object({
  title: z.string().describe('The concept, e.g. "Consistent hashing".'),
  summary: z.string().describe('One or two plain sentences.'),
  sections: z.array(
    z.object({
      heading: z.string(),
      body: z.string().describe('Plain text. Separate paragraphs with a blank line; start bullet lines with "- ".'),
    }),
  ),
  related: z.array(z.string()).describe('Related concepts worth learning next.'),
})
export type Explanation = z.infer<typeof ExplanationSchema>

export const AssistReplySchema = z.object({
  reply: z.string().describe('Spoken reply, no markdown.'),
  actions: z.array(CanvasActionSchema).describe('Small edits to existing shapes. Empty when drawing a diagram or only answering.'),
  diagram: DiagramSchema.nullable().describe('A full diagram to lay out and draw, or null.'),
  erd: ErdSchema.nullable().describe('A database schema to draw, or null.'),
  explanation: ExplanationSchema.nullable().describe('An in-depth explanation card, or null.'),
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

/** Server-sent events emitted by POST /api/assist. Partial events carry only fully arrived items. */
export type AssistStreamEvent =
  | { type: 'reply'; reply: string }
  | { type: 'diagram'; diagram: PartialDiagram }
  | { type: 'erd'; erd: Erd }
  | { type: 'explanation'; explanation: Explanation }
  | ({ type: 'done' } & AssistReply)
  | { type: 'error'; error: string }
