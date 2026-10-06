import { ApiError, GoogleGenAI, type Content, type Part } from '@google/genai'
import { z } from 'zod'
import { AssistReplySchema } from '@structura/shared'
import { promptText, SYSTEM } from '../prompt'
import type { Provider } from './types'

let ai: GoogleGenAI | undefined
const responseJsonSchema = z.toJSONSchema(AssistReplySchema)

// One comma-separated string, tried in order when a model is overloaded. Only models that
// support generateContent work here; "-live" models are for the real-time Live API.
const MODELS = (process.env.GEMINI_MODEL ?? 'gemini-3.7-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
const RETRYABLE = new Set([429, 500, 503])

export const streamGemini: Provider = async (req, onSnapshot, signal) => {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

  const parts: Part[] = []
  if (req.image) parts.push({ inlineData: { mimeType: 'image/png', data: req.image } })
  parts.push({ text: promptText(req) })

  const contents: Content[] = [
    ...req.history.map((turn) => ({
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
          systemInstruction: SYSTEM,
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

    const parsed = AssistReplySchema.safeParse(JSON.parse(json || '{}'))
    if (!parsed.success) throw new Error(`Gemini returned an invalid reply: ${parsed.error.message}`)
    return parsed.data
  }
  throw lastError
}
