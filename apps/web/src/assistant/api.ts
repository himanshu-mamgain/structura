import type { AssistRequest, AssistStreamEvent } from '@structura/shared'

// Empty in development (Vite proxies /api). In production, the API server's origin.
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

/** Posts to /api/assist and calls onEvent for each server-sent event. */
export async function streamAssist(
  body: AssistRequest,
  onEvent: (event: AssistStreamEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`${API_URL}/api/assist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? `Server error ${res.status}`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let end
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      if (data) onEvent(JSON.parse(data) as AssistStreamEvent)
    }
  }
}
