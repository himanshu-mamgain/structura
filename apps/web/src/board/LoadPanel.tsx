import { useEffect, useState } from 'react'
import type { Board } from './store'
import { runSimulation, type SimResult } from '../sim/engine'
import { defaults, perSecond, type LoadParam, type LoadTest, type LoadValues } from '../sim/loadtest'

/** Maps a 0..1000 slider position to a value on a log scale, and back. */
const toLog = (p: LoadParam & { kind: 'range' }, pos: number) => p.min * (p.max / p.min) ** (pos / 1000)
const fromLog = (p: LoadParam & { kind: 'range' }, value: number) => (1000 * Math.log(value / p.min)) / Math.log(p.max / p.min)

function Control({ param, value, onChange }: { param: LoadParam; value: number | boolean; onChange: (v: number | boolean) => void }) {
  if (param.kind === 'toggle') {
    return (
      <label className="load-toggle" title={param.hint}>
        <input type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
        <span>{param.label}</span>
      </label>
    )
  }
  const n = value as number
  return (
    <label className="load-range">
      <span>
        {param.label} <strong>{param.format(n)}</strong>
      </span>
      <input
        type="range"
        min={param.log ? 0 : param.min}
        max={param.log ? 1000 : param.max}
        step={param.log ? 1 : (param.step ?? 1)}
        value={param.log ? fromLog(param, n) : n}
        onChange={(e) => {
          const raw = Number(e.target.value)
          onChange(param.log ? Math.round(toLog(param, raw)) : raw)
        }}
      />
    </label>
  )
}

/** Settings from a scenario link, e.g. ?topic=url-shortener&load&rate=5000&hit=0&retries=true. */
function fromLink(test: LoadTest): LoadValues {
  const query = new URLSearchParams(window.location.search)
  const values: LoadValues = {}
  for (const param of test.params) {
    const raw = query.get(param.id)
    if (raw === null) continue
    if (param.kind === 'toggle') values[param.id] = raw === 'true' || raw === '1'
    else if (Number.isFinite(Number(raw))) values[param.id] = Math.min(param.max, Math.max(param.min, Number(raw)))
  }
  return values
}

/**
 * Puts real load through the topic's design: the Rust simulator runs in the
 * background and the results show on the 3D blocks (height and colour = how
 * busy, cubes = queue, dots = traffic).
 */
export function LoadPanel({ board, test, onClose }: { board: Board; test: LoadTest; onClose: () => void }) {
  const [values, setValues] = useState<LoadValues>(() => ({ ...defaults(test), ...fromLink(test) }))
  const [result, setResult] = useState<SimResult | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      setRunning(true)
      runSimulation(test.build(values))
        .then((r) => {
          if (!current) return
          setResult(r)
          setError('')
          board.setStats(new Map(r.components.map((c) => [c.label.toLowerCase(), c])))
        })
        .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => current && setRunning(false))
    }, 120)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [board, test, values])

  // The topic at its default settings is the "usual" that busy components are compared with.
  useEffect(() => {
    let current = true
    runSimulation(test.build(defaults(test)))
      .then((r) => current && board.setStats(board.stats, new Map(r.components.map((c) => [c.label.toLowerCase(), c]))))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [board, test])

  // Leaving the load test puts the boxes back to normal. Opening or closing the
  // panel changes the free space, so the view is re-framed both times.
  useEffect(() => {
    requestAnimationFrame(() => board.fitAll())
    return () => {
      board.setStats(null, null)
      requestAnimationFrame(() => board.fitAll())
    }
  }, [board])

  const bottleneck = result && [...result.components].sort((a, b) => b.utilization - a.utilization)[0]
  const retrying = result && result.attemptsPerS > result.offeredPerS * 1.05

  return (
    <aside className="card load" aria-label="Load test">
      <header>
        <h2>⚡ Load test</h2>
        {running && <span className="load-running">simulating…</span>}
        <button type="button" className="assistant-icon-btn" onClick={onClose} aria-label="Close load test">
          ×
        </button>
      </header>
      {test.params.map((param) => (
        <Control key={param.id} param={param} value={values[param.id]} onChange={(v) => setValues({ ...values, [param.id]: v })} />
      ))}

      {error && <p className="assistant-error">{error}</p>}
      {result && (
        <>
          <div className="load-stats">
            <div>
              <span>Served</span>
              <strong>{perSecond(result.goodputPerS)}</strong>
              <small>of {perSecond(result.offeredPerS)}</small>
            </div>
            <div className={result.successRate < 0.99 ? 'is-bad' : ''}>
              <span>Success</span>
              <strong>{(result.successRate * 100).toFixed(result.successRate > 0.999 ? 0 : 1)}%</strong>
            </div>
            <div>
              <span>p50</span>
              <strong>{result.goodputPerS ? `${result.latency.p50Ms.toFixed(0)} ms` : '—'}</strong>
            </div>
            <div>
              <span>p99</span>
              <strong>{result.goodputPerS ? `${result.latency.p99Ms.toFixed(0)} ms` : '—'}</strong>
            </div>
          </div>
          {bottleneck && (
            <p className="load-note">
              Busiest: <strong>{bottleneck.label}</strong> at {Math.round(bottleneck.utilization * 100)}%
              {bottleneck.utilization > 0.95 && ' — saturated; requests queue, time out or get rejected.'}
            </p>
          )}
          {retrying && (
            <p className="load-note is-warn">
              Retries: {perSecond(result.attemptsPerS)} attempts for {perSecond(result.offeredPerS)} of real traffic.
            </p>
          )}
          {result.truncated && <p className="load-note is-warn">Overloaded beyond recovery; the run was cut short.</p>}
        </>
      )}
      <p className="load-legend">
        <span className="dot is-ok" /> relaxed <span className="dot is-warm" /> busy <span className="dot is-hot" /> saturated · height = how
        busy · cubes = queue · hover a block for details. Typical numbers, not a benchmark.
      </p>
    </aside>
  )
}
