import { spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { font } from './theme'

// Isometric projection: X runs down-right, Y down-left, Z straight up.
const COS = Math.cos(Math.PI / 6)
const SIN = 0.5

export interface Origin {
  x: number
  y: number
}

const project = (o: Origin, X: number, Y: number, Z: number) => [o.x + (X - Y) * COS, o.y + (X + Y) * SIN - Z] as const

const points = (o: Origin, corners: [number, number, number][]) => corners.map(([X, Y, Z]) => project(o, X, Y, Z).join(',')).join(' ')

/** Darkens a hex colour, for the shaded sides of a box. */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16)
  const c = (shift: number) => Math.round(((n >> shift) & 255) * factor)
  return `rgb(${c(16)}, ${c(8)}, ${c(0)})`
}

/**
 * A box in isometric 3D, with its label printed on the front-left face. It
 * drops into place (and fades in) starting at frame `enter`.
 */
export function IsoBox({
  origin,
  x,
  y,
  z,
  w,
  d,
  h,
  color,
  label,
  enter = 0,
  labelSize = 26,
}: {
  origin: Origin
  x: number
  y: number
  z: number
  w: number
  d: number
  h: number
  color: string
  label?: string
  enter?: number
  labelSize?: number
}) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = spring({ frame: frame - enter, fps, config: { damping: 14, mass: 0.8 } })
  if (frame < enter) return null
  const lift = (1 - t) * 160 // drops from above
  const Z = z + lift

  const top = points(origin, [
    [x, y, Z + h],
    [x + w, y, Z + h],
    [x + w, y + d, Z + h],
    [x, y + d, Z + h],
  ])
  const left = points(origin, [
    [x, y + d, Z],
    [x + w, y + d, Z],
    [x + w, y + d, Z + h],
    [x, y + d, Z + h],
  ])
  const right = points(origin, [
    [x + w, y, Z],
    [x + w, y + d, Z],
    [x + w, y + d, Z + h],
    [x + w, y, Z + h],
  ])
  // Text on the front-left face: skewed to lie flat along the X axis.
  const [lx, ly] = project(origin, x + w / 2, y + d, Z + h / 2)
  return (
    <g opacity={Math.min(1, t * 1.4)}>
      <polygon points={left} fill={shade(color, 0.78)} />
      <polygon points={right} fill={shade(color, 0.6)} />
      <polygon points={top} fill={color} />
      {label && (
        <text
          transform={`matrix(${COS} ${SIN} 0 1 ${lx} ${ly})`}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#0b0d10"
          fontFamily={font}
          fontWeight={700}
          fontSize={Math.min(labelSize, h * 0.62)}
        >
          {label}
        </text>
      )}
    </g>
  )
}
