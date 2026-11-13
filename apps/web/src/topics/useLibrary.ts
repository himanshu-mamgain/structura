import { useEffect, useState } from 'react'

// The library (library.json, ~1,400 guides, 370 KB) loads the first time something
// shows it, not at start-up: Explore's list, search results and the roadmap's readings.

type Library = typeof import('./library')
let loaded: Library | null = null
let loading: Promise<Library> | null = null

export function loadLibrary(): Promise<Library> {
  loading ??= import('./library').then((m) => (loaded = m))
  return loading
}

/** The library module once it has loaded (null until then); pass false to hold off. */
export function useLibrary(enabled = true): Library | null {
  const [lib, setLib] = useState(loaded)
  useEffect(() => {
    if (!enabled || lib) return
    let alive = true
    void loadLibrary().then((m) => alive && setLib(m))
    return () => {
      alive = false
    }
  }, [enabled, lib])
  return lib
}
