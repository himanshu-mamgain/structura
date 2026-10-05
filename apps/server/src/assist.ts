import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { AssistReplySchema, type AssistReply, type AssistRequest } from '@structura/shared'

const client = new Anthropic()

const SYSTEM = `You are Structura's design assistant. The user talks to you by voice while editing a tldraw canvas, and your reply is read aloud.

You receive a screenshot of the canvas and a JSON list of its shapes. Shape x/y/w/h are page-space bounds (x/y is the top-left corner); the JSON is authoritative for ids and positions, the screenshot shows how it looks.

Help the user fix and improve their designs: alignment, spacing, consistent sizes, hierarchy, color, contrast, labels, layout of diagrams and wireframes. When they ask for a change, return the edits in "actions":
- update: set "id" and only the fields that change; leave the rest null.
- create: set "kind" (geo, text or note), x, y, and for geo also w, h and geo.
- delete: set "id" only.
Snap positions and sizes to a grid of 8. Do not touch shapes the request doesn't concern. If the request is only a question, answer it and return no actions.

Keep "reply" to one to three short spoken sentences with no markdown, saying what you changed or suggest.`

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
  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  if (req.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.image } })
  }
  content.push({
    type: 'text',
    text: [
      `Screenshot covers page bounds: ${JSON.stringify(req.imageBounds)}`,
      `Shapes: ${JSON.stringify(req.shapes)}`,
      `User said: ${req.transcript}`,
    ].join('\n\n'),
  })

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...req.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user', content },
  ]

  const stream = client.beta.messages.stream(
    {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(AssistReplySchema) },
      system: SYSTEM,
      messages,
    },
    { signal },
  )

  let lastReply = ''
  stream.on('text', (_delta, snapshot) => {
    const reply = extractPartialReply(snapshot)
    if (reply !== lastReply) {
      lastReply = reply
      onReply(reply)
    }
  })

  const response = await stream.finalMessage()
  if (response.stop_reason === 'refusal') {
    return { reply: "Sorry, I can't help with that request.", actions: [] }
  }
  if (!response.parsed_output) {
    throw new Error(`No structured output (stop_reason: ${response.stop_reason})`)
  }
  return response.parsed_output
}
