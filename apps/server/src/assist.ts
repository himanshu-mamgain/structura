import type { AssistReply, AssistRequest, Diagram, PartialDiagram } from '@structura/shared'
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

/**
 * Pull the "reply" string out of partially streamed JSON, so it can be shown
 * and spoken before the rest of the response (the actions) has arrived.
 */
function extractPartialReply(json: string): string {
  const start = json.match(/"reply"\s*:\s*"/)
  if (!start || start.index === undefined) return ''
  let out = ''
  for (let i = start.index + start[0].length; i < json.length; i++) {
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
 * Complete objects in a JSON array that may still be streaming, e.g. the nodes
 * of a diagram whose later nodes haven't arrived yet. Partial objects are skipped.
 */
function completeArrayItems(json: string, from: number, key: string): unknown[] {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(json.slice(from))
  if (!match) return []
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
    } else if (ch === ']' && depth === 0) break
  }
  return items
}

/** The diagram so far, built from the nodes, edges and groups that have fully streamed in. */
function extractPartialDiagram(json: string): PartialDiagram | null {
  const at = json.search(/"diagram"\s*:\s*\{/)
  if (at < 0) return null
  const nodes = completeArrayItems(json, at, 'nodes') as Diagram['nodes']
  if (!nodes.length) return null
  const rest = json.slice(at)
  return {
    replace: /"replace"\s*:\s*true/.test(rest),
    direction: /"direction"\s*:\s*"down"/.test(rest) ? 'down' : 'right',
    groups: completeArrayItems(json, at, 'groups') as Diagram['groups'],
    nodes,
    edges: completeArrayItems(json, at, 'edges') as Diagram['edges'],
  }
}

export async function assist(
  req: AssistRequest,
  on: { reply: (replySoFar: string) => void; diagram: (diagramSoFar: PartialDiagram) => void },
  signal: AbortSignal,
): Promise<AssistReply> {
  let lastReply = ''
  let lastDiagramSize = 0
  const onSnapshot = (json: string) => {
    const reply = extractPartialReply(json)
    if (reply !== lastReply) {
      lastReply = reply
      on.reply(reply)
    }
    const diagram = extractPartialDiagram(json)
    const size = diagram ? diagram.nodes.length + diagram.edges.length + diagram.groups.length : 0
    if (diagram && size !== lastDiagramSize) {
      lastDiagramSize = size
      on.diagram(diagram)
    }
  }
  return providers[providerName](req, onSnapshot, signal)
}
