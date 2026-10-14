import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { Provider } from './types'

let client: Anthropic | undefined

/** A request Claude declined for safety reasons (stop_reason "refusal"). */
export class ClaudeRefusal extends Error {}

export const streamClaude: Provider = async (call, onSnapshot, signal) => {
  client ??= new Anthropic()

  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  if (call.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: call.image } })
  }
  content.push({ type: 'text', text: call.prompt })

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...call.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user', content },
  ]

  const stream = client.beta.messages.stream(
    {
      model: process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(call.schema) },
      system: call.system,
      messages,
    },
    { signal },
  )
  stream.on('text', (_delta, snapshot) => onSnapshot(snapshot))

  const response = await stream.finalMessage()
  if (response.stop_reason === 'refusal') throw new ClaudeRefusal("Sorry, I can't help with that request.")
  if (!response.parsed_output) {
    throw new Error(`No structured output (stop_reason: ${response.stop_reason})`)
  }
  return response.parsed_output as Awaited<ReturnType<typeof call.schema.parse>>
}
