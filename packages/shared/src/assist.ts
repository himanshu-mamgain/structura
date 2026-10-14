import { z } from 'zod'

export const SHAPE_COLORS = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white',
] as const
export const SHAPE_FILLS = ['none', 'semi', 'solid', 'pattern'] as const
export const SHAPE_GEOS = [
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'star',
  'cloud',
  'arrow-right',
  'arrow-left',
  'arrow-up',
  'arrow-down',
  'check-box',
  'x-box',
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
    .describe(
      'Existing shape id. Required for update and delete; for connect, the shape the arrow starts at; null for create.',
    ),
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

// Length and count limits keep answers well-formed. Local models enforce them while
// generating (so a small model can't, say, draw ASCII art inside a label); hosted
// models get them as guidance and the answer is validated against them.
export const CODE_LANGUAGES = ['typescript', 'javascript', 'python', 'sql', 'go', 'java', 'bash'] as const

const ID = z.string().max(32)
const LABEL = z.string().max(48)

/**
 * A diagram described as a graph. The app computes the layout, so the model
 * only decides structure: what the boxes are, how they connect, how they group.
 */
export const DiagramSchema = z.object({
  replace: z
    .boolean()
    .describe(
      'True to clear the canvas and draw this instead (redoing the current diagram); false to add it beside existing shapes.',
    ),
  direction: z.enum(['right', 'down']).describe('Main flow direction.'),
  groups: z
    .array(
      z.object({
        id: ID,
        label: LABEL.describe('Frame title, 1 to 4 words, e.g. "Auth Server" or "JWT".'),
      }),
    )
    .max(6),
  nodes: z
    .array(
      z.object({
        id: ID.describe('Short unique id, e.g. "client".'),
        label: LABEL.describe('Box text, 1 to 5 words.'),
        shape: z
          .enum(NODE_SHAPES)
          .describe(
            'rectangle for components/steps, diamond for decisions, ellipse for start/end or actors, hexagon for external services, cloud for networks/internet.',
          ),
        color: z.enum(SHAPE_COLORS),
        group: ID.nullable().describe('Id of the group this node belongs to, or null.'),
      }),
    )
    .min(5)
    .max(16),
  edges: z
    .array(
      z.object({
        from: ID.describe('Node id.'),
        to: ID.describe('Node id.'),
        label: LABEL.nullable().describe('What flows or happens, e.g. "sends JWT". Under 5 words.'),
        dashed: z.boolean().describe('True for optional, async or return flows.'),
      }),
    )
    .max(24),
})
export type Diagram = z.infer<typeof DiagramSchema>

/** A database schema, drawn as an entity-relationship diagram. */
export const ErdSchema = z.object({
  replace: z
    .boolean()
    .describe('True to clear the canvas and draw this instead; false to add it beside existing shapes.'),
  tables: z
    .array(
      z.object({
        id: ID.describe('Short unique id, usually the table name.'),
        name: ID.describe('Table name, snake_case plural, e.g. "orders".'),
        columns: z
          .array(
            z.object({
              name: ID,
              type: ID.describe('SQL type, e.g. "uuid", "bigint", "text", "timestamptz", "numeric(10,2)".'),
              pk: z.boolean(),
              fk: z.string().nullable().describe('Referenced "table.column" for foreign keys, else null.'),
              nullable: z.boolean(),
              unique: z.boolean(),
            }),
          )
          .min(1)
          .max(24),
        indexes: z
          .array(LABEL)
          .max(8)
          .describe('Secondary indexes worth having, e.g. "(user_id, created_at)". Empty if none.'),
      }),
    )
    .min(1)
    .max(14),
  relations: z
    .array(
      z.object({
        from: ID.describe('Table id holding the foreign key (or one side of a join).'),
        to: ID.describe('Referenced table id.'),
        kind: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
        label: LABEL.nullable().describe('Optional short meaning, e.g. "places".'),
      }),
    )
    .max(24),
})
export type Erd = z.infer<typeof ErdSchema>

/**
 * One concrete input followed end to end, step by step: which boxes it passes
 * through and what the data looks like at each point. Drives the walkthrough.
 */
export const TraceSchema = z.object({
  input: z.string().max(200).describe('The example input traced end to end, e.g. a real URL, request or user action.'),
  steps: z
    .array(
      z.object({
        text: z.string().describe('What happens at this step, in one or two sentences.'),
        nodes: z.array(LABEL).max(4).describe('Exact labels of the boxes this step involves.'),
        data: z
          .string()
          .nullable()
          .describe('The example data at this step: a request, row, cache entry or response. Short; null if nothing new.'),
      }),
    )
    .min(2)
    .max(12),
})
export type Trace = z.infer<typeof TraceSchema>

/** An in-depth explanation of one concept, shown as a readable card next to the canvas. */
export const ExplanationSchema = z.object({
  title: z.string().max(80).describe('The concept, e.g. "Consistent hashing".'),
  summary: z.string().describe('One or two plain sentences.'),
  sections: z
    .array(
      z.object({
        heading: LABEL,
        body: z.string().describe('Plain text. Separate paragraphs with a blank line; start bullet lines with "- ".'),
      }),
    )
    .min(1)
    .max(9),
  trace: TraceSchema.nullable().describe('One concrete example followed end to end through the diagram, or null.'),
  code: z
    .array(
      z.object({
        title: LABEL.describe('What the snippet shows, e.g. "Base62 encoding".'),
        language: z.enum(CODE_LANGUAGES),
        source: z.string().describe('Short, runnable code for the core logic, under 40 lines, with brief comments.'),
      }),
    )
    .max(4)
    .describe('Code for the core logic. Empty when code would not help.'),
  related: z.array(LABEL).max(6).describe('Related concepts worth learning next.'),
})
export type Explanation = z.infer<typeof ExplanationSchema>
export type CodeSnippet = Explanation['code'][number]

export const AssistReplySchema = z.object({
  reply: z.string().describe('Spoken reply, no markdown.'),
  actions: z
    .array(CanvasActionSchema)
    .describe('Small edits to existing shapes. Empty when drawing a diagram or only answering.'),
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
