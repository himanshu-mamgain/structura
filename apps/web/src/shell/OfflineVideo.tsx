import { useEffect, useState } from 'react'
import { CheckCircle2, Download, Loader2, Trash2 } from 'lucide-react'

// Saves a topic's video into the service worker's video cache, so the installed
// app can play it with no connection (vite.config.ts serves /videos/*.mp4 from
// that cache, seeking included).

const CACHE = 'structura-videos'

type State = 'unsupported' | 'checking' | 'online' | 'saving' | 'saved' | 'failed'

export function OfflineVideoButton({ src }: { src: string }) {
  const [state, setState] = useState<State>('caches' in window ? 'checking' : 'unsupported')

  useEffect(() => {
    if (!('caches' in window)) return
    void caches
      .open(CACHE)
      .then((cache) => cache.match(src))
      .then((hit) => setState(hit ? 'saved' : 'online'))
  }, [src])

  async function save() {
    setState('saving')
    try {
      // A full (non-range) request, so the whole file is cached in one piece.
      const res = await fetch(src)
      if (!res.ok) throw new Error(String(res.status))
      await (await caches.open(CACHE)).put(src, res)
      setState('saved')
    } catch {
      setState('failed')
    }
  }

  async function remove() {
    await (await caches.open(CACHE)).delete(src)
    setState('online')
  }

  if (state === 'unsupported' || state === 'checking') return null
  if (state === 'saved') {
    return (
      <button type="button" className="badge offline-btn is-saved" onClick={() => void remove()} title="Saved for offline. Click to remove.">
        <CheckCircle2 size={13} /> Offline
        <Trash2 size={12} aria-hidden />
      </button>
    )
  }
  return (
    <button type="button" className="badge offline-btn" onClick={() => void save()} disabled={state === 'saving'}>
      {state === 'saving' ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
      {state === 'saving' ? 'Saving…' : state === 'failed' ? 'Retry save' : 'Save offline'}
    </button>
  )
}
