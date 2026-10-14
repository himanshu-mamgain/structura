import { ApiError, GoogleGenAI, type Content, type Part } from '@google/genai'
import { z } from 'zod'
import type { Provider } from './types'

let ai: GoogleGenAI | undefined

// One comma-separated string, tried in order when a model is overloaded. Only models that
// support generateContent work here; "-live" models are for the real-time Live API.
const MODELS = (process.env.GEMINI_MODEL ?? 'gemini-3.7-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
const RETRYABLE = new Set([429, 500, 503])

/**
 * The JSON schema without length and count limits. Gemini rejects schemas it
 * considers too complex ("invalid argument"), and those limits, multiplied across
 * nested arrays, push the database schema over that line.
 */
function withoutLimits(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutLimits)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minItems' || key === 'maxItems' || key === 'minLength' || key === 'maxLength') continue
    out[key] = withoutLimits(value)
  }
  return out
}

export const streamGemini: Provider = async (call, onSnapshot, signal) => {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

  const parts: Part[] = []
  if (call.image) parts.push({ inlineData: { mimeType: 'image/png', data: call.image } })
  parts.push({ text: call.prompt })
  const responseJsonSchema = withoutLimits(z.toJSONSchema(call.schema))

  const contents: Content[] = [
    ...call.history.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    })),
    { role: 'user', parts },
  ]

  // Free-tier models are often briefly overloaded (503) or out of quota (429), so try
  // each model in turn. Only failures before any text has streamed are retried.
  let lastError: unknown
  for (const model of MODELS) {
    let json = ''
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: call.system,
          responseMimeType: 'application/json',
          responseJsonSchema,
          abortSignal: signal,
        },
      })
      for await (const chunk of stream) {
        const text = chunk.text
        if (!text) continue
        json += text
        onSnapshot(json)
      }
    } catch (error) {
      if (json || signal.aborted || !(error instanceof ApiError) || !RETRYABLE.has(error.status)) throw error
      console.warn(`Gemini ${model} unavailable (${error.status}), trying next model`)
      lastError = error
      continue
    }

    const raw: unknown = JSON.parse(json || '{}')
    const parsed = call.schema.safeParse(raw)
    if (parsed.success) return parsed.data
    // Gemini wasn't sent the length/count limits, so an answer that only breaks
    // those (a slightly long label, one node too many) is still usable.
    if (parsed.error.issues.every((issue) => issue.code === 'too_big' || issue.code === 'too_small')) {
      console.warn(`Gemini answer exceeds schema limits; using it anyway (${parsed.error.issues.length} issues)`)
      return raw as ReturnType<typeof call.schema.parse>
    }
    throw new Error(`Gemini returned an invalid reply: ${parsed.error.message}`)
  }
  throw lastError
}
