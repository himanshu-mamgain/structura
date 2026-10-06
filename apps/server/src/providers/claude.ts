import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { AssistReplySchema } from '@structura/shared'
import { promptText, SYSTEM } from '../prompt'
import type { Provider } from './types'

let client: Anthropic | undefined

export const streamClaude: Provider = async (req, onSnapshot, signal) => {
  client ??= new Anthropic()

  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  if (req.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.image } })
  }
  content.push({ type: 'text', text: promptText(req) })

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...req.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user', content },
  ]

  const stream = client.beta.messages.stream(
    {
      model: process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(AssistReplySchema) },
      system: SYSTEM,
      messages,
    },
    { signal },
  )
  stream.on('text', (_delta, snapshot) => onSnapshot(snapshot))

  const response = await stream.finalMessage()
  if (response.stop_reason === 'refusal') {
    return { reply: "Sorry, I can't help with that request.", actions: [], diagram: null, erd: null, explanation: null }
  }
  if (!response.parsed_output) {
    throw new Error(`No structured output (stop_reason: ${response.stop_reason})`)
  }
  return response.parsed_output
}
