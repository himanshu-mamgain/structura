import type { SimConfig } from './engine'

/** A knob in the 3D lab: a slider or a switch. */
export type LoadParam =
  | {
      kind: 'range'
      id: string
      label: string
      min: number
      max: number
      default: number
      /** Logarithmic slider, for values spanning orders of magnitude (traffic). */
      log?: boolean
      step?: number
      format: (value: number) => string
    }
  | { kind: 'toggle'; id: string; label: string; default: boolean; hint?: string }

export type LoadValues = Record<string, number | boolean>

/**
 * How a topic is load-tested: the knobs, and the system they describe.
 * Component labels match the boxes on the canvas, so results show on them.
 */
export interface LoadTest {
  params: LoadParam[]
  build(values: LoadValues): SimConfig
}

export const defaults = (test: LoadTest): LoadValues =>
  Object.fromEntries(test.params.map((p) => [p.id, p.default]))

export const perSecond = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k/s` : `${Math.round(n)}/s`)
