import { z } from 'zod'
import type { Provider } from './types'

// A local model served by Ollama (https://ollama.com), through its own HTTP API.
const BASE_URL = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen3.5:2b-q4_K_M'
// The system prompt and shape list alone are a few thousand tokens, so ask for a
// bigger context than Ollama's 2048-token default.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192)
// Images and "thinking" make small local models much slower; the shape list
// already describes the canvas, so both are opt-in.
const SEND_IMAGE = process.env.OLLAMA_VISION === 'true'
const THINK = process.env.OLLAMA_THINK === 'true'
// Small models occasionally loop; cap each answer's length so a runaway reply
// ends with an error instead of running for minutes.
const NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT ?? 3000)

/** An Ollama failure with a message that's safe and useful to show the user. */
export class OllamaError extends Error {}

interface ChatChunk {
  message?: { content?: string }
  done?: boolean
  error?: string
}

export const streamOllama: Provider = async (call, onSnapshot, signal) => {
  const messages = [
    { role: 'system', content: call.system },
    ...call.history.map((turn) => ({ role: turn.role, content: turn.text })),
    {
      role: 'user',
      content: call.prompt,
      ...(SEND_IMAGE && call.image ? { images: [call.image] } : {}),
    },
  ]
  // Ollama constrains generation to this schema, so the answer always parses.
  const format = z.toJSONSchema(call.schema)

  let res: Response
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        format,
        think: THINK,
        // Keep the model loaded between requests; loading it again takes seconds.
        // (num_ctx must stay the same for every call: changing it reloads the model.)
        keep_alive: '30m',
        options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT, temperature: 0.4 },
      }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new OllamaError(`Can't reach Ollama at ${BASE_URL}. Is it running? (ollama serve)`)
  }
  if (!res.ok || !res.body) {
    const detail = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
    if (res.status === 404) throw new OllamaError(`Ollama model "${MODEL}" isn't installed. Run: ollama pull ${MODEL}`)
    throw new OllamaError(`Ollama request failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  // The response is newline-delimited JSON, one chunk of the reply per line.
  let json = ''
  let buffer = ''
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      const chunk = JSON.parse(line) as ChatChunk
      if (chunk.error) throw new OllamaError(`Ollama: ${chunk.error}`)
      const text = chunk.message?.content
      if (text) {
        json += text
        onSnapshot(json)
      }
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new OllamaError(`${MODEL} stopped before finishing its answer. Try again, or raise OLLAMA_NUM_CTX.`)
  }
  const parsed = call.schema.safeParse(raw)
  if (!parsed.success) throw new OllamaError(`${MODEL} returned an invalid reply: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
  return parsed.data
}
