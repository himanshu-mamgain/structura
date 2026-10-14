import type { NODE_SHAPES, SHAPE_COLORS } from '@structura/shared'

export type NodeShape = (typeof NODE_SHAPES)[number] | 'note' | 'text'
export type ShapeColor = (typeof SHAPE_COLORS)[number]

/** A box on the board. Coordinates are board units (the old canvas pixels), x/y top-left. */
export interface BoardNode {
  id: string
  label: string
  shape: NodeShape
  color: ShapeColor
  /** Frame this box belongs to, if any. */
  group: string | null
  x: number
  y: number
  w: number
  h: number
  /** Database tables list one line per column. */
  table?: { lines: string[] }
}

/** A labelled area grouping boxes (a service boundary, client vs server…). */
export interface BoardFrame {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}

export interface BoardEdge {
  id: string
  from: string
  to: string
  label: string | null
  dashed: boolean
}

export interface Page {
  id: string
  name: string
  /** Set when the page shows a hand-written topic (enables its load test). */
  topicId?: string
  nodes: BoardNode[]
  frames: BoardFrame[]
  edges: BoardEdge[]
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export const emptyPage = (id: string, name: string, topicId?: string): Page => ({
  id,
  name,
  topicId,
  nodes: [],
  frames: [],
  edges: [],
})

/** Bounds of a set of boxes and frames, or null if there are none. */
export function boundsOf(items: Bounds[]): Bounds | null {
  if (!items.length) return null
  const x = Math.min(...items.map((i) => i.x))
  const y = Math.min(...items.map((i) => i.y))
  const maxX = Math.max(...items.map((i) => i.x + i.w))
  const maxY = Math.max(...items.map((i) => i.y + i.h))
  return { x, y, w: maxX - x, h: maxY - y }
}

let counter = 0
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`
