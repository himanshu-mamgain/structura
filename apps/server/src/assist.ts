import { z } from 'zod'
import {
  CanvasActionSchema,
  DiagramSchema,
  ErdSchema,
  ExplanationSchema,
  type AssistReply,
  type AssistRequest,
  type Diagram,
  type Erd,
  type Explanation,
  type PartialDiagram,
  type Trace,
} from '@structura/shared'
import { promptText, SYSTEMS } from './prompt'
import { streamClaude } from './providers/claude'
import { streamGemini } from './providers/gemini'
import { streamOllama } from './providers/ollama'
import type { Provider } from './providers/types'

const providers: Record<string, Provider> = {
  claude: streamClaude,
  gemini: streamGemini,
  ollama: streamOllama,
}

/** AI_PROVIDER picks the model provider: a local Ollama model unless set to gemini or claude. */
export const providerName =
  process.env.AI_PROVIDER?.toLowerCase() ?? 'ollama'

if (!providers[providerName]) {
  throw new Error(`Unknown AI_PROVIDER "${providerName}" (expected: ${Object.keys(providers).join(', ')})`)
}

// The model's JSON arrives in chunks. These helpers read what has fully (or, for
// strings, partly) arrived, so the reply, drawings and explanation can be shown
// while the rest is still being generated.

/** The value of a string field so far, even if its closing quote hasn't arrived. */
function partialString(json: string, key: string, from = 0): string {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(json.slice(from))
  if (!start) return ''
  let out = ''
  for (let i = from + start.index + start[0].length; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"') break
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = json[i + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6)
      if (hex.length < 4) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 5
    } else {
      out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next
      i += 1
    }
  }
  return out
}

/**
 * Objects in a JSON array that may still be streaming: the complete ones, plus
 * where the incomplete last one starts (or -1).
 */
function arrayItems(json: string, from: number, key: string): { items: unknown[]; partialAt: number } {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(json.slice(from))
  if (!match) return { items: [], partialAt: -1 }
  const items: unknown[] = []
  let depth = 0
  let inString = false
  let itemStart = -1
  for (let i = from + match.index + match[0].length; i < json.length; i++) {
    const ch = json[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) itemStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && itemStart >= 0) {
        try {
          items.push(JSON.parse(json.slice(itemStart, i + 1)))
        } catch {
          // Malformed item; skip it.
        }
        itemStart = -1
      }
    } else if (ch === ']' && depth === 0) return { items, partialAt: -1 }
  }
  return { items, partialAt: itemStart }
}

const objectStart = (json: string, key: string) => json.search(new RegExp(`"${key}"\\s*:\\s*\\{`))
const flag = (json: string, at: number, key: string) => new RegExp(`"${key}"\\s*:\\s*true`).test(json.slice(at))

/** The diagram so far, built from the nodes, edges and groups that have fully streamed in. */
function partialDiagram(json: string): PartialDiagram | null {
  const at = objectStart(json, 'diagram')
  if (at < 0) return null
  const nodes = arrayItems(json, at, 'nodes').items as Diagram['nodes']
  if (!nodes.length) return null
  return repairDiagram({
    replace: flag(json, at, 'replace'),
    direction: /"direction"\s*:\s*"down"/.test(json.slice(at)) ? 'down' : 'right',
    groups: arrayItems(json, at, 'groups').items as Diagram['groups'],
    nodes,
    edges: arrayItems(json, at, 'edges').items as Diagram['edges'],
  })
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

/**
 * Fixes the slips small models make, so nothing silently disappears: groups
 * that nodes use but never defined are created, and arrows pointing at an
 * unknown id are matched to the node whose id or label fits (else dropped).
 */
export function repairDiagram(diagram: Diagram): Diagram {
  const groupIds = new Set(diagram.groups.map((g) => g.id))
  const missingGroups = [...new Set(diagram.nodes.map((n) => n.group).filter((g): g is string => !!g && !groupIds.has(g)))]
  const groups = [
    ...diagram.groups,
    ...missingGroups.map((id) => ({ id, label: id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })),
  ]

  const nodeIds = new Set(diagram.nodes.map((n) => n.id))
  const resolve = (ref: string): string | null => {
    if (nodeIds.has(ref)) return ref
    const want = slug(ref)
    const exact = diagram.nodes.find((n) => slug(n.id) === want || slug(n.label) === want)
    if (exact) return exact.id
    // Shared words, e.g. "check_role" -> "Verify Role?" (role), "db" -> "Users DB".
    const words = new Set(want.split('_').filter((w) => w.length > 1))
    let best: { id: string; score: number } | null = null
    for (const node of diagram.nodes) {
      const score = slug(`${node.id}_${node.label}`)
        .split('_')
        .filter((w) => words.has(w)).length
      if (score > (best?.score ?? 0)) best = { id: node.id, score }
    }
    return best?.id ?? null
  }
  const edges = diagram.edges.flatMap((edge) => {
    const from = resolve(edge.from)
    const to = resolve(edge.to)
    return from && to && from !== to ? [{ ...edge, from, to }] : []
  })
  return { ...diagram, groups, edges }
}

/** The database schema so far: the tables and relations that have fully streamed in. */
function partialErd(json: string): Erd | null {
  const at = objectStart(json, 'erd')
  if (at < 0) return null
  const tables = arrayItems(json, at, 'tables').items as Erd['tables']
  if (!tables.length) return null
  return { replace: flag(json, at, 'replace'), tables, relations: arrayItems(json, at, 'relations').items as Erd['relations'] }
}

/** The explanation so far, including the section currently being written. */
function partialExplanation(json: string): Explanation | null {
  const at = objectStart(json, 'explanation')
  if (at < 0) return null
  const title = partialString(json, 'title', at)
  if (!title) return null
  const { items, partialAt } = arrayItems(json, at, 'sections')
  const sections = items as Explanation['sections']
  if (partialAt >= 0) {
    const heading = partialString(json, 'heading', partialAt)
    if (heading) sections.push({ heading, body: partialString(json, 'body', partialAt) })
  }
  const code = arrayItems(json, at, 'code').items as Explanation['code']
  const traceAt = objectStart(json, 'trace')
  const steps = traceAt >= 0 ? (arrayItems(json, traceAt, 'steps').items as Trace['steps']) : []
  const trace = steps.length ? { input: partialString(json, 'input', traceAt), steps } : null
  return { title, summary: partialString(json, 'summary', at), sections, trace, code, related: [] }
}

/** Calls `emit` with the extracted value only when it changed since last time. */
function onChange<T>(extract: (json: string) => T | null, emit: (value: T) => void) {
  let last = ''
  return (json: string) => {
    const value = extract(json)
    if (value === null) return
    const key = JSON.stringify(value)
    if (key === last) return
    last = key
    emit(value)
  }
}

// One small schema per mode: the model can only produce what the mode needs.
const reply = z.string().describe('Spoken reply, no markdown.')
const MODE_SCHEMAS = {
  build: z.object({ reply, diagram: DiagramSchema }),
  erd: z.object({ reply, erd: ErdSchema }),
  explain: z.object({ reply, explanation: ExplanationSchema }),
  edit: z.object({ reply, actions: z.array(CanvasActionSchema) }),
}
const CardSchema = z.object({ explanation: ExplanationSchema })
const RouteSchema = z.object({ mode: z.enum(['build', 'erd', 'explain', 'edit']) })
type Mode = z.infer<typeof RouteSchema>['mode']

/**
 * Picks the mode from the words used, which is instant; only ambiguous requests
 * (like a bare topic, "role based authentication") cost a tiny model call.
 */
async function route(req: AssistRequest, signal: AbortSignal): Promise<Mode> {
  const text = req.transcript.toLowerCase()
  const hasShapes = req.shapes.length > 0
  if (/\b(explain|what is|what's|what are|how does|how do|why|understand|walk me through|tell me about|teach)\b/.test(text)) return 'explain'
  if (/\b(database|schema|tables?|erd|data ?model|sql|postgres|columns?)\b/.test(text)) return 'erd'
  if (hasShapes && /\b(move|recolou?r|colou?r|rename|relabel|align|connect|link|delete|remove|resize|bigger|smaller|wider|red|blue|green|yellow|orange|violet|grey|black)\b/.test(text)) return 'edit'
  if (/\b(design|draw|diagram|architecture|flow|build|create|system|redo|expand|sketch)\b/.test(text)) return 'build'

  const summary = `Canvas has ${req.shapes.length} shapes${req.shapes.some((s) => s.selected) ? ', some selected' : ''}. User said: ${req.transcript}`
  try {
    const { mode } = await call({ system: SYSTEMS.route, prompt: summary, schema: RouteSchema, image: null, history: [] }, () => {}, signal)
    return mode
  } catch (error) {
    if (signal.aborted) throw error
    console.warn('Routing call failed, defaulting to build', error)
    return 'build'
  }
}

const call: Provider = (modelCall, onSnapshot, signal) => providers[providerName](modelCall, onSnapshot, signal)

/** Feeds a model's streaming JSON to watchers that emit partial results to the client. */
const watchAll =
  (...watchers: ((json: string) => void)[]) =>
  (json: string) =>
    watchers.forEach((watch) => watch(json))

export async function assist(
  req: AssistRequest,
  on: {
    reply: (replySoFar: string) => void
    diagram: (diagramSoFar: PartialDiagram) => void
    erd: (erdSoFar: Erd) => void
    explanation: (explanationSoFar: Explanation) => void
  },
  signal: AbortSignal,
): Promise<AssistReply> {
  const empty: AssistReply = { reply: '', actions: [], diagram: null, erd: null, explanation: null }
  const turn = { prompt: promptText(req), image: req.image, history: req.history }
  const watchReply = onChange((json) => partialString(json, 'reply') || null, on.reply)
  const watchExplanation = onChange(partialExplanation, on.explanation)

  const mode = await route(req, signal)
  console.log(`[assist] mode: ${mode}`)

  if (mode === 'edit') {
    const result = await call({ system: SYSTEMS.edit, schema: MODE_SCHEMAS.edit, ...turn }, watchReply, signal)
    return { ...empty, ...result }
  }
  if (mode === 'explain') {
    const result = await call({ system: SYSTEMS.explain, schema: MODE_SCHEMAS.explain, ...turn }, watchAll(watchReply, watchExplanation), signal)
    return { ...empty, ...result }
  }

  // Build or database design: the drawing and its explanation card are two
  // requests. The card starts as soon as the boxes (or tables) are known, and
  // runs in parallel with the rest of the drawing, so it can name them exactly.
  const kind = mode === 'build' ? 'diagram' : 'erd'
  // The walkthrough finds boxes by their visible labels, but models sometimes
  // name them by id in the trace; translate ids to labels using the drawing.
  const labels = new Map<string, string>()
  const learnLabels = (drawing: PartialDiagram | Erd) => {
    const entries = 'nodes' in drawing ? drawing.nodes.map((n) => [n.id, n.label]) : drawing.tables.map((t) => [t.id, t.name])
    for (const [id, label] of entries) {
      labels.set(id, label)
      labels.set(slug(id), label)
    }
  }
  const withLabels = (explanation: Explanation): Explanation =>
    explanation.trace
      ? {
          ...explanation,
          trace: {
            ...explanation.trace,
            steps: explanation.trace.steps.map((step) => ({
              ...step,
              nodes: step.nodes.map((node) => labels.get(node) ?? labels.get(slug(node)) ?? node),
            })),
          },
        }
      : explanation
  const watchCard = onChange(partialExplanation, (explanation) => on.explanation(withLabels(explanation)))

  let card: Promise<Explanation | null> | null = null
  const startCard = (drawingSoFar: PartialDiagram | Erd) => {
    learnLabels(drawingSoFar)
    card ??= call(
      {
        system: kind === 'diagram' ? SYSTEMS.diagramCard : SYSTEMS.erdCard,
        prompt: `The user asked: ${req.transcript}\n\nThe ${kind === 'diagram' ? 'diagram' : 'schema'} so far:\n${JSON.stringify(drawingSoFar)}`,
        schema: CardSchema,
        image: null,
        history: [],
      },
      watchCard,
      signal,
    )
      .then((result) => withLabels(result.explanation))
      .catch((error) => {
        // The drawing still counts if the card fails.
        if (!signal.aborted) console.warn('Explanation card failed', error)
        return null
      })
  }
  // Nodes (or tables) come before edges (or relations) in the JSON, so once
  // the second list has started, every box is known.
  const watchDrawing =
    kind === 'diagram'
      ? onChange(partialDiagram, (diagram) => {
          on.diagram(diagram)
          if (diagram.edges.length) startCard(diagram)
        })
      : onChange(partialErd, (erd) => {
          on.erd(erd)
          if (erd.relations.length) startCard(erd)
        })

  if (kind === 'diagram') {
    const result = await call({ system: SYSTEMS.build, schema: MODE_SCHEMAS.build, ...turn }, watchAll(watchReply, watchDrawing), signal)
    const diagram = repairDiagram(result.diagram)
    startCard(diagram)
    return { ...empty, reply: result.reply, diagram, explanation: await card! }
  }
  const result = await call({ system: SYSTEMS.erd, schema: MODE_SCHEMAS.erd, ...turn }, watchAll(watchReply, watchDrawing), signal)
  startCard(result.erd)
  return { ...empty, reply: result.reply, erd: result.erd, explanation: await card! }
}

