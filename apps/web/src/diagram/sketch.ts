import rough from 'roughjs'
import type { Drawable, Options } from 'roughjs/bin/core'

// Hand-drawn shapes for the 2D diagram, made with rough.js. The generator returns plain
// SVG path data, so React draws them like any other path. Every shape gets a fixed seed
// from its id, so it looks the same on every render instead of wobbling.

const gen = rough.generator()

export interface SketchPath {
  d: string
  stroke: string
  strokeWidth: number
  fill?: string
  /** Hachure lines (drawn faint) or the outline. */
  kind: 'fill' | 'stroke'
}

/** A stable rough.js seed from a string. */
export function seedOf(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 2147483646) + 1
}

function toPaths(drawable: Drawable, kind: SketchPath['kind']): SketchPath[] {
  return gen.toPaths(drawable).map((p) => ({ d: p.d, stroke: p.stroke, strokeWidth: p.strokeWidth, fill: p.fill, kind }))
}

/** Outline plus faint hachure shading, both from the same shape. */
function shaded(make: (o: Options) => Drawable, color: string, seed: number, stroke: Options = {}): SketchPath[] {
  return [
    ...toPaths(make({ seed, stroke: 'none', fill: color, fillStyle: 'hachure', hachureGap: 8, hachureAngle: -41, fillWeight: 1.1, roughness: 1.2 }), 'fill'),
    ...toPaths(make({ seed, stroke: color, strokeWidth: 2, roughness: 1.15, bowing: 1, ...stroke }), 'stroke'),
  ]
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2)
  return `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`
}

function cloudPath(x: number, y: number, w: number, h: number): string {
  const p = (fx: number, fy: number) => `${(x + fx * w).toFixed(1)},${(y + fy * h).toFixed(1)}`
  const rx = (0.17 * w).toFixed(1)
  const ry = (0.3 * h).toFixed(1)
  return [
    `M${p(0.14, 0.92)}`,
    `A${rx},${ry} 0 0 1 ${p(0.1, 0.46)}`,
    `A${rx},${ry} 0 0 1 ${p(0.36, 0.16)}`,
    `A${rx},${ry} 0 0 1 ${p(0.68, 0.12)}`,
    `A${rx},${ry} 0 0 1 ${p(0.92, 0.44)}`,
    `A${rx},${ry} 0 0 1 ${p(0.86, 0.92)}`,
    'Z',
  ].join(' ')
}

export type NodeShape = 'rectangle' | 'ellipse' | 'diamond' | 'hexagon' | 'cloud' | 'cylinder'

/** The same shape as nodeSketch draws, smooth, for the solid fill under it. */
export function shapePath(shape: NodeShape, x: number, y: number, w: number, h: number): string {
  switch (shape) {
    case 'ellipse': {
      const rx = (w * 1.06) / 2
      const ry = (h * 1.18) / 2
      const cx = x + w / 2
      const cy = y + h / 2
      return `M${cx - rx},${cy} A${rx},${ry} 0 1 0 ${cx + rx},${cy} A${rx},${ry} 0 1 0 ${cx - rx},${cy} Z`
    }
    case 'cloud':
      return cloudPath(x - w * 0.06, y - h * 0.18, w * 1.12, h * 1.32)
    case 'diamond':
    case 'hexagon': {
      const k = Math.min(22, w / 6)
      return `M${x + k},${y} H${x + w - k} L${x + w},${y + h / 2} L${x + w - k},${y + h} H${x + k} L${x},${y + h / 2} Z`
    }
    case 'cylinder': {
      const ry = 8
      return `M${x},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + h - ry} V${y + ry} A${w / 2},${ry} 0 0 0 ${x},${y + ry} Z`
    }
    default:
      return roundedRectPath(x, y, w, h, 14)
  }
}

/**
 * A box's hand-drawn outline and shading. Actors are ovals, the internet a cloud,
 * decisions an arrow-ended box, data stores a cylinder; everything else a rounded box.
 */
export function nodeSketch(id: string, shape: NodeShape, x: number, y: number, w: number, h: number, color: string): SketchPath[] {
  const seed = seedOf(id)
  switch (shape) {
    case 'ellipse':
      return shaded((o) => gen.ellipse(x + w / 2, y + h / 2, w * 1.06, h * 1.18, o), color, seed)
    case 'cloud':
      return shaded((o) => gen.path(cloudPath(x - w * 0.06, y - h * 0.18, w * 1.12, h * 1.32), o), color, seed)
    case 'diamond':
    case 'hexagon': {
      const k = Math.min(22, w / 6)
      const pts: [number, number][] = [
        [x + k, y],
        [x + w - k, y],
        [x + w, y + h / 2],
        [x + w - k, y + h],
        [x + k, y + h],
        [x, y + h / 2],
      ]
      return shaded((o) => gen.polygon(pts, o), color, seed)
    }
    case 'cylinder': {
      const ry = 8
      const body = `M${x},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + h - ry} V${y + ry}`
      return [
        ...shaded((o) => gen.path(`${body} A${w / 2},${ry} 0 0 0 ${x},${y + ry} Z`, o), color, seed),
        ...toPaths(gen.ellipse(x + w / 2, y + ry, w, ry * 2, { seed: seed + 1, stroke: color, strokeWidth: 2, roughness: 1.1 }), 'stroke'),
      ]
    }
    default:
      return shaded((o) => gen.path(roundedRectPath(x, y, w, h, 14), o), color, seed)
  }
}

/** A hand-drawn arrow along a bezier curve, ending in a chevron pointing along the curve's last stretch. */
export function edgeSketch(
  key: string,
  d: string,
  end: { x: number; y: number },
  towards: { x: number; y: number },
  color: string,
  dashed: boolean,
): SketchPath[] {
  const seed = seedOf(key)
  const line: Options = { seed, stroke: color, strokeWidth: 2, roughness: 0.9, bowing: 0.6, ...(dashed ? { strokeLineDash: [7, 7] } : {}) }
  const angle = Math.atan2(end.y - towards.y, end.x - towards.x)
  const len = 13
  const spread = 0.5
  const wing = (s: number): [number, number] => [end.x - len * Math.cos(angle + s * spread), end.y - len * Math.sin(angle + s * spread)]
  return [
    ...toPaths(gen.path(d, line), 'stroke'),
    ...toPaths(gen.linearPath([wing(1), [end.x, end.y], wing(-1)], { seed: seed + 7, stroke: color, strokeWidth: 2.2, roughness: 0.7 }), 'stroke'),
  ]
}

/** A group's dashed, hand-drawn border with a faint wash. */
export function groupSketch(id: string, x: number, y: number, w: number, h: number): SketchPath[] {
  return toPaths(
    gen.path(roundedRectPath(x, y, w, h, 18), {
      seed: seedOf(id),
      stroke: 'rgba(41, 45, 50, 0.38)',
      strokeWidth: 1.4,
      strokeLineDash: [9, 8],
      roughness: 1.4,
      fill: 'rgba(41, 45, 50, 0.03)',
      fillStyle: 'solid',
    }),
    'stroke',
  )
}
