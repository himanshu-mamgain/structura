import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { layout, type Layout, type LayoutDiagram, type Placed } from '../board/layout'
import { iconFor } from './icons'

// A flat, crisp drawing of a diagram: the same ELK layout the 3D view uses,
// drawn as SVG boxes with icons and labelled arrows. Pans with a drag, zooms
// with the buttons or ctrl + wheel, and dims everything but the boxes in focus.

const COLORS: Record<string, string> = {
  black: '#9ca3af',
  grey: '#94a3b8',
  'light-violet': '#c4b5fd',
  violet: '#a78bfa',
  blue: '#60a5fa',
  'light-blue': '#7dd3fc',
  yellow: '#facc15',
  orange: '#fb923c',
  green: '#34d399',
  'light-green': '#86efac',
  'light-red': '#fca5a5',
  red: '#f87171',
  white: '#e5e7eb',
}

const PAD = 40
/** Never zoom out further than this on its own: past it, labels get too small to read. */
const MIN_READABLE = 0.72
/** Space at the bottom of the card taken by the walkthrough caption. */
const CAPTION_SPACE = 130
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Where an arrow leaves or enters a box: the middle of the side facing the other box. */
function sides(a: Placed, b: Placed) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  const horizontal = Math.abs(dx) * 0.6 > Math.abs(dy)
  if (horizontal) {
    const s = Math.sign(dx) || 1
    return { from: { x: ac.x + (s * a.w) / 2, y: ac.y }, to: { x: bc.x - (s * b.w) / 2, y: bc.y }, horizontal }
  }
  const s = Math.sign(dy) || 1
  return { from: { x: ac.x, y: ac.y + (s * a.h) / 2 }, to: { x: bc.x, y: bc.y - (s * b.h) / 2 }, horizontal }
}

/** An S-shaped curve between two side midpoints, and the point halfway along it (for the label). */
function curve(from: { x: number; y: number }, to: { x: number; y: number }, horizontal: boolean) {
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const c1 = horizontal ? { x: mx, y: from.y } : { x: from.x, y: my }
  const c2 = horizontal ? { x: mx, y: to.y } : { x: to.x, y: my }
  return { d: `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`, mid: { x: mx, y: my } }
}

export interface Diagram2DProps {
  diagram: LayoutDiagram
  /** Labels of the boxes in focus (e.g. the walkthrough step); null shows everything. */
  focus: string[] | null
  /** Zoom controls render into the card header through this callback's return. */
  className?: string
}

export function Diagram2D({ diagram, focus, className = '' }: Diagram2DProps) {
  const [placed, setPlaced] = useState<Layout | null>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let alive = true
    setPlaced(null)
    // Lay out in whichever direction suits the card's shape, with snug gaps.
    const el = host.current
    const fitRatio = el && el.clientHeight ? el.clientWidth / el.clientHeight : 1.6
    void layout(diagram, { fitRatio, maxLayerGap: 220 }).then((result) => alive && setPlaced(result))
    return () => {
      alive = false
    }
  }, [diagram])

  /**
   * Shows the whole diagram if it fits at a readable size; a bigger one starts
   * at the beginning of its flow and pans.
   */
  function fit() {
    if (!placed || !host.current) return
    const { clientWidth: w, clientHeight: h } = host.current
    const fullW = placed.w + PAD * 2
    const fullH = placed.h + PAD * 2
    const scale = Math.max(MIN_READABLE, Math.min(1.1, w / fullW, h / fullH))
    // Too big to show whole: start where the flow starts (the first box), within the edges.
    const first = placed.nodes.get(diagram.nodes[0]?.id ?? '')
    const along = (size: number, full: number, start: number) =>
      full * scale <= size ? (size - full * scale) / 2 : Math.min(0, Math.max(size - full * scale, size / 2 - start * scale))
    const x = along(w, fullW, first ? first.x + first.w / 2 + PAD : 0)
    const y = along(h, fullH, first ? first.y + first.h / 2 + PAD : 0)
    setView({ scale, x, y })
  }

  /** Centres the boxes in focus at a readable size, leaving room for the step caption below. */
  function frameFocus(labels: string[]) {
    if (!placed || !host.current) return
    const wanted = new Set(labels.map(normalize))
    const hits = diagram.nodes
      .filter((n) => {
        const l = normalize(n.table?.lines[0] ?? n.label)
        return [...wanted].some((f) => f === l || l.includes(f) || f.includes(l))
      })
      .map((n) => placed.nodes.get(n.id))
      .filter((p): p is Placed => Boolean(p))
    if (!hits.length) return fit()
    const minX = Math.min(...hits.map((p) => p.x))
    const minY = Math.min(...hits.map((p) => p.y))
    const maxX = Math.max(...hits.map((p) => p.x + p.w))
    const maxY = Math.max(...hits.map((p) => p.y + p.h))
    const w = host.current.clientWidth
    const h = host.current.clientHeight - CAPTION_SPACE
    const scale = Math.min(1.1, Math.max(0.55, Math.min(w / (maxX - minX + 200), h / (maxY - minY + 160))))
    const cx = (minX + maxX) / 2 + PAD
    const cy = (minY + maxY) / 2 + PAD
    setView({ scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale })
  }

  const focusKey = focus?.join('|') ?? ''
  useEffect(() => {
    if (focus?.length) frameFocus(focus)
    else fit()
  }, [placed, focusKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(() => (focus?.length ? frameFocus(focus) : fit()))
    observer.observe(el)
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }) // re-binds with the latest `placed`

  function zoom(factor: number) {
    const el = host.current
    if (!el) return
    setView((v) => {
      const scale = Math.min(2.5, Math.max(0.3, v.scale * factor))
      // Zoom around the middle of the card.
      const cx = el.clientWidth / 2
      const cy = el.clientHeight / 2
      return { scale, x: cx - ((cx - v.x) / v.scale) * scale, y: cy - ((cy - v.y) / v.scale) * scale }
    })
  }

  function onPointerDown(e: ReactPointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
  }

  const inFocus = focus ? new Set(focus.map(normalize)) : null
  const nodeFocused = (label: string, tableName?: string) => {
    if (!inFocus) return true
    const l = normalize(tableName ?? label)
    return [...inFocus].some((f) => f === l || l.includes(f) || f.includes(l))
  }

  return (
    <div className={`d2 ${className}`}>
      <div
        ref={host}
        className="d2-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => ((drag.current = null), setDragging(false))}
        onPointerCancel={() => ((drag.current = null), setDragging(false))}
      >
        {!placed && <p className="d2-loading">Laying out…</p>}
        {placed && (
          <svg
            className={dragging ? 'is-dragging' : ''}
            width={placed.w + PAD * 2}
            height={placed.h + PAD * 2}
            viewBox={`${-PAD} ${-PAD} ${placed.w + PAD * 2} ${placed.h + PAD * 2}`}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            <defs>
              <marker id="d2-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            </defs>

            {diagram.groups.map((group) => {
              const p = placed.groups.get(group.id)
              if (!p) return null
              return (
                <g key={group.id} className="d2-group">
                  <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={18} />
                  <text x={p.x + 18} y={p.y + 30}>
                    {group.label.toUpperCase()}
                  </text>
                </g>
              )
            })}

            {diagram.edges.map((edge, i) => {
              const a = placed.nodes.get(edge.from)
              const b = placed.nodes.get(edge.to)
              if (!a || !b) return null
              const from = diagram.nodes.find((n) => n.id === edge.from)!
              const to = diagram.nodes.find((n) => n.id === edge.to)!
              const lit = nodeFocused(from.label, from.table?.lines[0]) && nodeFocused(to.label, to.table?.lines[0])
              const { from: p, to: q, horizontal } = sides(a, b)
              const { d, mid } = curve(p, q, horizontal)
              const width = edge.label ? edge.label.length * 7.4 + 18 : 0
              return (
                <g key={i} className={`d2-edge${edge.dashed ? ' is-dashed' : ''}${inFocus ? (lit ? ' is-lit' : ' is-dim') : ''}`}>
                  <path d={d} markerEnd="url(#d2-arrow)" />
                  {edge.label && (
                    <g transform={`translate(${mid.x} ${mid.y})`}>
                      <rect x={-width / 2} y={-13} width={width} height={26} rx={13} />
                      <text textAnchor="middle" dy="4.5">
                        {edge.label}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}

            {diagram.nodes.map((node) => {
              const p = placed.nodes.get(node.id)
              if (!p) return null
              const color = COLORS[node.color] ?? COLORS.grey
              const lit = nodeFocused(node.label, node.table?.lines[0])
              const cls = `d2-node${inFocus ? (lit ? ' is-lit' : ' is-dim') : ''}`
              if (node.table) {
                const [name, ...columns] = node.table.lines
                return (
                  <foreignObject key={node.id} x={p.x} y={p.y} width={p.w} height={p.h} className={cls}>
                    <div className="d2-table" style={{ borderColor: color }}>
                      <strong style={{ background: `${color}26` }}>{name}</strong>
                      {columns.map((line, i) => (
                        <code key={i}>{line}</code>
                      ))}
                    </div>
                  </foreignObject>
                )
              }
              const Icon = iconFor(node.label)
              return (
                <foreignObject key={node.id} x={p.x} y={p.y} width={p.w} height={p.h} className={cls}>
                  <div className={`d2-box is-${node.shape}`} style={{ borderColor: color, background: `${color}1a`, color }}>
                    <Icon size={22} strokeWidth={2} aria-hidden />
                    <span>{node.label}</span>
                  </div>
                </foreignObject>
              )
            })}
          </svg>
        )}
      </div>
      <div className="d2-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoom(1.2)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fit} aria-label="Fit diagram">
          ⤢
        </button>
      </div>
    </div>
  )
}
