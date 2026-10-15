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
/** Box shapes in diagrams: rectangle for components, diamond for decisions, ellipse for actors, hexagon for external services, cloud for networks. */
export const NODE_SHAPES = ['rectangle', 'ellipse', 'diamond', 'hexagon', 'cloud'] as const

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
