// Typed access to the Rust load simulator (packages/sim), compiled to WebAssembly
// and run in a Web Worker (sim.worker.ts).

export type Step =
  | { kind: 'visit'; component: string }
  | { kind: 'branch'; probability: number; then: Step[]; otherwise?: Step[] }

/** Mirrors SimConfig in packages/sim/src/model.rs. */
export interface SimConfig {
  seed?: number
  /** New client requests per second. */
  rate: number
  durationS?: number
  warmupS?: number
  components: {
    id: string
    /** Matches the box's label on the canvas, so results can be shown on it. */
    label: string
    servers: number
    serviceMs: number
    cv?: number
    queueLimit?: number | null
  }[]
  flows: { id: string; weight: number; steps: Step[] }[]
  client?: { timeoutMs: number | null; retries: number; backoffMs: number }
}

export interface ComponentStats {
  id: string
  label: string
  utilization: number
  throughputPerS: number
  meanQueue: number
  maxQueue: number
  meanWaitMs: number
  rejected: number
}

/** Mirrors SimResult in packages/sim/src/model.rs. */
export interface SimResult {
  offeredPerS: number
  attemptsPerS: number
  goodputPerS: number
  successRate: number
  timedOut: number
  rejected: number
  latency: { meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }
  components: ComponentStats[]
  truncated: boolean
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (output: string) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; output: string }>) => {
      pending.get(event.data.id)?.(event.data.output)
      pending.delete(event.data.id)
    }
  }
  return worker
}

/**
 * Runs the simulation in the background. Simulated time is scaled to the load,
 * so every run covers a similar number of requests and stays quick at any
 * traffic level.
 */
export function runSimulation(config: SimConfig): Promise<SimResult> {
  const durationS = config.durationS ?? Math.min(30, Math.max(2, 60_000 / config.rate))
  const payload = JSON.stringify({ ...config, durationS, warmupS: config.warmupS ?? durationS / 4 })
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, (output) => {
      const parsed = JSON.parse(output)
      if ('error' in parsed) reject(new Error(parsed.error))
      else resolve(parsed as SimResult)
    })
    getWorker().postMessage({ id, config: payload })
  })
}
