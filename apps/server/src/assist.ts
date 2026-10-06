import type { AssistReply, AssistRequest } from '@structura/shared'
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

export async function assist(
  req: AssistRequest,
  onReply: (replySoFar: string) => void,
  signal: AbortSignal,
): Promise<AssistReply> {
  let lastReply = ''
  const onSnapshot = (json: string) => {
    const reply = extractPartialReply(json)
    if (reply !== lastReply) {
      lastReply = reply
      onReply(reply)
    }
  }
  return providers[providerName](req, onSnapshot, signal)
}
