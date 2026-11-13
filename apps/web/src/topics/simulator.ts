import type { Trace } from '@structura/shared'

/**
 * Runs a topic's flow on the user's own input, in the browser, and returns the
 * trace the walkthrough plays: real computed values, not a canned example.
 */
export interface Simulator {
  fields: { id: string; label: string; placeholder?: string; options?: string[] }[]
  /** The example the topic opens with. */
  defaults: Record<string, string>
  run(values: Record<string, string>): Trace
}

const defaults = new WeakMap<Simulator, Trace>()

/**
 * A topic's opening walkthrough, worked out the first time it's needed. Topics use it
 * as a getter (get trace() { return defaultTrace(simulator) }) so that importing every
 * topic at start-up doesn't run every simulator.
 */
export function defaultTrace(simulator: Simulator): Trace {
  let trace = defaults.get(simulator)
  if (!trace) {
    trace = simulator.run(simulator.defaults)
    defaults.set(simulator, trace)
  }
  return trace
}

/** base64url without padding, as used inside JWTs. */
export function base64url(text: string): string {
  return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A small, stable hash, so the same input always produces the same example values. */
export function stableHash(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

export const json = (value: unknown) => JSON.stringify(value, null, 2)
