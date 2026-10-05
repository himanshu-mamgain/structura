import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import type { AssistRequest, AssistStreamEvent, HealthResponse } from '@structura/shared'
import { assist } from './assist'

const app = express()
const port = Number(process.env.PORT ?? 3001)

app.use(cors())
// Canvas screenshots arrive as base64, so allow larger bodies.
app.use(express.json({ limit: '15mb' }))

app.get('/api/health', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'structura-server',
    time: new Date().toISOString(),
  }
  res.json(body)
})

function errorMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'Claude API credentials are missing or invalid'
  if (error instanceof Anthropic.RateLimitError) return 'Rate limited by Claude API, try again shortly'
  if (error instanceof Anthropic.APIError) {
    const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message
    return `Claude API request failed (${error.status ?? 'network'})${detail ? `: ${detail}` : ''}`
  }
  return 'Assistant failed'
}

// Streams server-sent events: "reply" while the answer is generated, then "done" or "error".
app.post('/api/assist', async (req, res) => {
  const body = req.body as AssistRequest
  if (!body?.transcript?.trim()) {
    res.status(400).json({ error: 'transcript is required' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (event: AssistStreamEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`)

  // Stop generating (and paying for tokens) if the browser goes away.
  const abort = new AbortController()
  res.on('close', () => abort.abort())

  try {
    const result = await assist(body, (reply) => send({ type: 'reply', reply }), abort.signal)
    send({ type: 'done', ...result })
  } catch (error) {
    if (abort.signal.aborted) return
    console.error(error)
    send({ type: 'error', error: errorMessage(error) })
  } finally {
    res.end()
  }
})

app.listen(port, () => {
  console.log(`Structura server listening on http://localhost:${port}`)
})
