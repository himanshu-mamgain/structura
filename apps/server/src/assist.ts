import type { AssistReply, AssistRequest, Diagram, Erd, Explanation, PartialDiagram } from '@structura/shared'
import { streamClaude } from './providers/claude'
import { streamGemini } from './providers/gemini'
import type { Provider } from './providers/types'

const providers: Record<string, Provider> = {
  claude: streamClaude,
  gemini: streamGemini,
}

/** AI_PROVIDER picks the model provider; without it, Gemini is used when its key is set. */
export const providerName =
  process.env.AI_PROVIDER?.toLowerCase() ?? (process.env.GEMINI_API_KEY ? 'gemini' : 'claude')

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
  return {
    replace: flag(json, at, 'replace'),
    direction: /"direction"\s*:\s*"down"/.test(json.slice(at)) ? 'down' : 'right',
    groups: arrayItems(json, at, 'groups').items as Diagram['groups'],
    nodes,
    edges: arrayItems(json, at, 'edges').items as Diagram['edges'],
  }
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
  return { title, summary: partialString(json, 'summary', at), sections, related: [] }
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
  const watchers = [
    onChange((json) => partialString(json, 'reply') || null, on.reply),
    onChange(partialDiagram, on.diagram),
    onChange(partialErd, on.erd),
    onChange(partialExplanation, on.explanation),
  ]
  return providers[providerName](req, (json) => watchers.forEach((watch) => watch(json)), signal)
}

