import { useThree } from '@react-three/fiber'
import { ThreeCanvas } from '@remotion/three'
import { spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { PerspectiveCamera, Vector3 } from 'three'
import { colors, font, HEIGHT, mono, WIDTH } from './theme'

// A small 3D city drawn with three.js (through @remotion/three), in the same
// style as the app's board: services are buildings, connections are roads, and
// requests are glowing packets driving between them.

export interface Building {
  id: string
  label: string
  x: number
  z: number
  color: string
  height?: number
  /** Scene frame the building rises in. */
  enter?: number
}

/** A packet that drives along `path` (building ids) between frames `start` and `end`. */
export interface Trip {
  path: string[]
  start: number
  end: number
  color?: string
}

export interface Shot {
  position: [number, number, number]
  target: [number, number, number]
  fov?: number
}

export type Status = 'active' | 'ok' | 'bad'

const STATUS_COLOR: Record<Status, string> = { active: '#fde047', ok: '#34d399', bad: '#f87171' }
const WIDTH_3D = 1.7
const DEPTH_3D = 1.3

/** Camera between two shots: t = 0 is `a`, 1 is `b`. */
export function between(a: Shot, b: Shot, t: number): Shot {
  const mix = (p: number[], q: number[]) => p.map((v, i) => v + (q[i] - v) * t) as [number, number, number]
  return { position: mix(a.position, b.position), target: mix(a.target, b.target), fov: (a.fov ?? 40) + ((b.fov ?? 40) - (a.fov ?? 40)) * t }
}

function camera(shot: Shot): PerspectiveCamera {
  const cam = new PerspectiveCamera(shot.fov ?? 40, WIDTH / HEIGHT, 0.1, 200)
  cam.position.set(...shot.position)
  cam.lookAt(...shot.target)
  cam.updateMatrixWorld()
  return cam
}

/** Screen pixels of a point in the city, as the shot's camera sees it. */
function toScreen(cam: PerspectiveCamera, x: number, y: number, z: number) {
  const v = new Vector3(x, y, z).project(cam)
  return { left: ((v.x + 1) / 2) * WIDTH, top: ((1 - v.y) / 2) * HEIGHT, visible: v.z < 1 }
}

/** Points the canvas camera like the shot, every frame. */
function Rig({ shot }: { shot: Shot }) {
  const cam = useThree((s) => s.camera) as PerspectiveCamera
  cam.fov = shot.fov ?? 40
  cam.position.set(...shot.position)
  cam.lookAt(...shot.target)
  cam.updateProjectionMatrix()
  return null
}

function Road({ a, b }: { a: Building; b: Building }) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const length = Math.hypot(dx, dz)
  const angle = -Math.atan2(dz, dx)
  return (
    <group position={[(a.x + b.x) / 2, 0.01, (a.z + b.z) / 2]} rotation={[0, angle, 0]}>
      <mesh>
        <boxGeometry args={[length, 0.03, 0.5]} />
        <meshStandardMaterial color="#17191d" />
      </mesh>
      {[-0.27, 0.27].map((side) => (
        <mesh key={side} position={[0, 0.02, side]}>
          <boxGeometry args={[length, 0.03, 0.05]} />
          <meshStandardMaterial color="#5b6472" emissive="#5b6472" emissiveIntensity={0.4} />
        </mesh>
      ))}
    </group>
  )
}

function Tower({ b, status }: { b: Building; status?: Status }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const rise = spring({ frame: frame - (b.enter ?? 0), fps, config: { damping: 14 } })
  if (frame < (b.enter ?? 0)) return null
  const h = (b.height ?? 1.1) * Math.max(0.02, rise)
  const glow = status ? STATUS_COLOR[status] : null
  return (
    <group position={[b.x, 0, b.z]}>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[WIDTH_3D, h, DEPTH_3D]} />
        <meshStandardMaterial color={b.color} roughness={0.6} />
      </mesh>
      {/* A bright cap, like the role colour on the app's buildings. */}
      <mesh position={[0, h + 0.03, 0]}>
        <boxGeometry args={[WIDTH_3D, 0.06, DEPTH_3D]} />
        <meshStandardMaterial color={glow ?? b.color} emissive={glow ?? b.color} emissiveIntensity={glow ? 1.2 : 0.45} />
      </mesh>
      {glow && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.25, 1.45, 48]} />
          <meshBasicMaterial color={glow} transparent opacity={0.85} />
        </mesh>
      )}
    </group>
  )
}

/** Where a trip's packet is at `frame`, or null when it isn't driving. */
function packetAt(trip: Trip, byId: Map<string, Building>, frame: number): [number, number, number] | null {
  if (frame < trip.start || frame > trip.end) return null
  const points = trip.path.map((id) => byId.get(id)!)
  const t = ((frame - trip.start) / Math.max(1, trip.end - trip.start)) * (points.length - 1)
  const i = Math.min(points.length - 2, Math.floor(t))
  const f = t - i
  const ease = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2
  const a = points[i]
  const b = points[i + 1]
  return [a.x + (b.x - a.x) * ease, 0.32, a.z + (b.z - a.z) * ease]
}

export interface CityProps {
  buildings: Building[]
  roads: [string, string][]
  shot: Shot
  trips?: Trip[]
  status?: Record<string, Status | undefined>
  /** Small tags under a building's label, like "HIT" or "403". */
  tags?: Record<string, { text: string; color: string } | undefined>
  /** Ground colour; darker for the reel look. */
  ground?: string
}

export function City({ buildings, roads, shot, trips = [], status = {}, tags = {}, ground = '#2b2e34' }: CityProps) {
  const frame = useCurrentFrame()
  const byId = new Map(buildings.map((b) => [b.id, b]))
  const cam = camera(shot)
  return (
    <>
      <ThreeCanvas width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Rig shot={shot} />
        <hemisphereLight args={['#c7d2fe', '#1b1d22', 0.8]} />
        <directionalLight position={[6, 12, 8]} intensity={1.6} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
          <planeGeometry args={[80, 80]} />
          <meshStandardMaterial color={ground} />
        </mesh>
        {roads.map(([a, b]) => {
          const from = byId.get(a)!
          const to = byId.get(b)!
          if (frame < Math.max(from.enter ?? 0, to.enter ?? 0)) return null
          return <Road key={`${a}-${b}`} a={from} b={to} />
        })}
        {buildings.map((b) => (
          <Tower key={b.id} b={b} status={status[b.id]} />
        ))}
        {trips.map((trip, i) => {
          const at = packetAt(trip, byId, frame)
          if (!at) return null
          return (
            <mesh key={i} position={at}>
              <sphereGeometry args={[0.24, 24, 16]} />
              <meshStandardMaterial color={trip.color ?? '#60a5fa'} emissive={trip.color ?? '#60a5fa'} emissiveIntensity={1.4} />
            </mesh>
          )
        })}
      </ThreeCanvas>
      {/* Labels are HTML on top, placed where each building appears on screen. */}
      {buildings.map((b) => {
        if (frame < (b.enter ?? 0) + 8) return null
        const p = toScreen(cam, b.x, (b.height ?? 1.1) + 0.35, b.z)
        if (!p.visible) return null
        const tag = tags[b.id]
        return (
          <div
            key={b.id}
            style={{
              position: 'absolute',
              left: p.left,
              top: p.top,
              transform: 'translate(-50%, -100%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              fontFamily: font,
              whiteSpace: 'nowrap',
            }}
          >
            {tag && (
              <span style={{ padding: '4px 12px', borderRadius: 999, background: tag.color, color: '#0b0d10', fontFamily: mono, fontWeight: 800, fontSize: 26 }}>
                {tag.text}
              </span>
            )}
            <span
              style={{
                padding: '6px 16px',
                borderRadius: 999,
                background: 'rgba(15,17,21,0.88)',
                border: `2px solid ${status[b.id] ? STATUS_COLOR[status[b.id]!] : 'rgba(255,255,255,0.18)'}`,
                color: colors.text,
                fontSize: 30,
                fontWeight: 700,
              }}
            >
              {b.label}
            </span>
          </div>
        )
      })}
    </>
  )
}
