import type { ReactNode } from 'react'
import { AbsoluteFill, interpolate, interpolateColors, random, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import narrationJson from './narration/uber-surge.json'
import { colors, font, mono } from './theme'
import type { Narration } from './timeline'
import { Appear, Callout, Card, clamp, Heading, Narrated, type Scene, type SceneProps, Svg, Timeline, totalFrames, type VideoProps } from './ui'

// "Uber surge and artificial scarcity", a ~80 second vertical explainer.
// The surge numbers are illustrative: a simple riders-to-drivers rule, not
// Uber's real pricing model.

export const VIDEO = 'uber-surge'
const narration: Narration = narrationJson

const rider = colors.engine
const driver = colors.highlight
const offline = '#6b7280'

/** Illustrative surge rule: 1× until riders outnumber drivers, capped at 3×. */
function surge(riders: number, drivers: number): number {
  const ratio = riders / Math.max(1, drivers)
  return Math.round(Math.min(3, Math.max(1, 1 + (ratio - 1) * 0.4)) * 10) / 10
}

// ─── Hexagon map ───────────────────────────────────────────────────────────

const R = 150 // hexagon radius in map units
const SQRT3 = Math.sqrt(3)
const MAP_W = 1080
const MAP_H = 900

/** Axial hexagon coordinates within three rings (the outer ones bleed off the frame) of the centre. */
const CELLS: [number, number][] = []
for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) if (Math.abs(q + r) <= 3) CELLS.push([q, r])

const cellCenter = (q: number, r: number) => ({ x: MAP_W / 2 + R * SQRT3 * (q + r / 2), y: MAP_H / 2 + R * 1.5 * r })

const hexPoints = (cx: number, cy: number, radius: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6
    return `${cx + radius * Math.cos(a)},${cy + radius * Math.sin(a)}`
  }).join(' ')

/** A stable spot inside the centre hexagon for the i-th car or rider. */
function spot(kind: string, i: number) {
  const angle = random(`${kind}-a-${i}`) * Math.PI * 2
  const dist = Math.sqrt(random(`${kind}-d-${i}`)) * R * 0.72
  return { x: MAP_W / 2 + Math.cos(angle) * dist, y: MAP_H / 2 + Math.sin(angle) * dist, angle }
}

function Car({ x, y, angle, color, opacity = 1 }: { x: number; y: number; angle: number; color: string; opacity?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${(angle * 180) / Math.PI})`} opacity={opacity}>
      <rect x={-13} y={-8} width={26} height={16} rx={5} fill={color} stroke="#0b0d10" strokeWidth={2.5} />
    </g>
  )
}

function Rider({ x, y, enter }: { x: number; y: number; enter: number }) {
  const frame = useCurrentFrame()
  if (frame < enter) return null
  const pulse = ((frame - enter) % 40) / 40
  return (
    <g>
      <circle cx={x} cy={y} r={10 + pulse * 18} fill="none" stroke={rider} strokeWidth={3} opacity={1 - pulse} />
      <circle cx={x} cy={y} r={10} fill={rider} stroke="#fff" strokeWidth={3} />
    </g>
  )
}

export interface CarState {
  /** Where the car is drawn this frame. */
  x: number
  y: number
  angle: number
  online: boolean
  opacity?: number
}

/**
 * The city as a tilted hexagon grid, like a ride app's map. The centre cell is
 * coloured by its surge and holds the cars and riders the scene animates.
 */
function HexCity({ cars, riders, multiplier, label }: { cars: CarState[]; riders: { enter: number }[]; multiplier: number; label?: string }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const hot = interpolateColors(multiplier, [1, 1.6, 2.4], ['#2c5f52', '#b7791f', '#b91c1c'])
  return (
    <div style={{ position: 'absolute', top: 340, left: 0, width: MAP_W, height: MAP_H, perspective: 1600 }}>
      <svg width={MAP_W} height={MAP_H} style={{ transform: 'rotateX(38deg)', transformOrigin: '50% 60%', overflow: 'visible' }}>
        {CELLS.map(([q, r]) => {
          const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r))
          const t = spring({ frame: frame - ring * 6, fps, config: { damping: 18 } })
          const { x, y } = cellCenter(q, r)
          const centre = ring === 0
          return (
            <g key={`${q},${r}`} opacity={t}>
              <polygon points={hexPoints(x, y, R - 4)} fill={centre ? hot : '#30343b'} stroke={centre ? '#fff' : '#454a52'} strokeWidth={centre ? 5 : 2} />
              {/* A couple of parked cars in every other cell, for life. */}
              {!centre &&
                [0, 1].map((i) => (
                  <Car
                    key={i}
                    x={x + (random(`amb-x-${q}-${r}-${i}`) - 0.5) * R * 0.9}
                    y={y + (random(`amb-y-${q}-${r}-${i}`) - 0.5) * R * 0.8 + Math.sin((frame + i * 40) / 30) * 4}
                    angle={random(`amb-a-${q}-${r}-${i}`) * 6}
                    color={driver}
                    opacity={0.55}
                  />
                ))}
            </g>
          )
        })}
        {riders.map((r, i) => {
          const p = spot('rider', i)
          return <Rider key={i} x={p.x} y={p.y} enter={r.enter} />
        })}
        {cars.map((c, i) => (
          <Car key={i} x={c.x} y={c.y} angle={c.angle} color={c.online ? driver : offline} opacity={c.opacity ?? (c.online ? 1 : 0.55)} />
        ))}
        {label && (
          <text x={MAP_W / 2} y={MAP_H / 2 - R - 22} textAnchor="middle" fill="#fff" fontFamily={font} fontWeight={800} fontSize={34}>
            {label}
          </text>
        )}
      </svg>
    </div>
  )
}

function Legend() {
  const dot = (color: string, text: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginRight: 30 }}>
      <span style={{ width: 22, height: 22, borderRadius: '50%', background: color, border: '3px solid #fff' }} />
      {text}
    </span>
  )
  return (
    <>
      {dot(rider, 'rider')}
      {dot(driver, 'driver')}
      {dot(offline, 'offline')}
    </>
  )
}

// ─── Scenes ────────────────────────────────────────────────────────────────

function Title() {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, 120], [1, 1.06], clamp)
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: font, color: colors.text }}>
      <div style={{ transform: `scale(${scale})`, textAlign: 'center', padding: 80 }}>
        <Appear enter={4}>
          <div style={{ fontSize: 40, fontWeight: 700, color: colors.highlight, letterSpacing: '0.12em' }}>SYSTEM DESIGN · UBER</div>
        </Appear>
        <Appear enter={14}>
          <div style={{ marginTop: 30, fontSize: 124, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.03em' }}>
            Surge pricing
            <br />
            <span style={{ color: colors.danger }}>& fake shortages</span>
          </div>
        </Appear>
        <Appear enter={34}>
          <div style={{ marginTop: 40, fontSize: 42, color: colors.muted }}>How drivers gamed it, and how to design it so they can't</div>
        </Appear>
      </div>
    </AbsoluteFill>
  )
}

/** Riders pile up in one hexagon, the price climbs, and drivers drive in. */
function Surge({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const riderCount = Math.floor(interpolate(frame, [140, 330], [1, 12], clamp))
  const riders = Array.from({ length: 12 }, (_, i) => ({ enter: 140 + (i * 190) / 11 }))
  // Four drivers from the start; seven more drive in once the price is up.
  const cars: CarState[] = Array.from({ length: 11 }, (_, i) => {
    const target = spot('car', i)
    if (i < 4) return { ...target, online: frame >= 20 }
    const t = interpolate(frame, [440 + (i - 4) * 10, 480 + (i - 4) * 10], [0, 1], { ...clamp, easing: (x) => 1 - (1 - x) ** 3 })
    const from = { x: MAP_W / 2 + Math.cos(target.angle) * R * 2.6, y: MAP_H / 2 + Math.sin(target.angle) * R * 2.6 }
    return { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t, angle: target.angle, online: true, opacity: t === 0 ? 0 : 1 }
  })
  const drivers = cars.filter((c) => c.online && c.opacity !== 0).length
  const m = frame < 140 ? 1 : surge(riderCount, drivers)
  return (
    <>
      <Heading sub={<Legend />}>How surge works</Heading>
      <HexCity cars={cars} riders={riders.slice(0, frame < 140 ? 0 : 12)} multiplier={m} />
      <Callout enter={140} x={70} y={1170} big={String(riderCount)} unit="riders" small={`${drivers} drivers free`} />
      <Callout enter={270} x={600} y={1170} big={`${m.toFixed(1)}×`} unit="price" small="riders ÷ drivers" hot={m >= 1.5} />
      <Narrated lines={lines} />
    </>
  )
}

/** Airport drivers switch off together, the price jumps, they switch back on. */
function Gaming({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const riders = Array.from({ length: 8 }, (_, i) => ({ enter: 10 + i * 6 }))
  const state = (f: number) =>
    Array.from({ length: 14 }, (_, i) => {
      const leaves = i < 12 ? 130 + i * 5 : Infinity
      const returns = 400 + i * 4
      return !(f >= leaves && f < returns)
    })
  const online = state(frame)
  const cars: CarState[] = online.map((on, i) => ({ ...spot('airport', i), online: on }))
  const onlineCount = online.filter(Boolean).length
  // Prices update from a snapshot a moment old, which is exactly what gets gamed.
  const m = surge(8, state(frame - 40).filter(Boolean).length)
  return (
    <>
      <Heading sub={<Legend />}>Gaming the surge</Heading>
      <HexCity cars={cars} riders={riders} multiplier={m} label="✈ Airport" />
      <Callout enter={20} x={70} y={1170} big={String(onlineCount)} unit="online" small="drivers · 8 riders waiting" hot={onlineCount < 5} />
      <Callout enter={260} x={600} y={1170} big={`${m.toFixed(1)}×`} unit="price" small="from a stale snapshot" hot={m >= 1.5} />
      <Callout enter={430} x={70} y={1340} big="8" unit="trips at 2.2×" small="taken before the price falls" hot />
      <Narrated lines={lines} />
    </>
  )
}

// Supply in the airport cell, one point a minute: steady, then the coordinated dip.
const MINUTES = 31
const raw = Array.from({ length: MINUTES }, (_, t) => (t >= 12 && t < 16 ? 2 : 14))
// Half the weight on the last 10 minutes here, half on the neighbouring cells (steady at 14).
const smoothed = raw.map((_, t) => {
  const window = raw.slice(Math.max(0, t - 9), t + 1)
  return 0.5 * (window.reduce((a, b) => a + b, 0) / window.length) + 0.5 * 14
})

/** Raw versus smoothed supply, drawn as two lines, with the price each would give. */
function Smooth({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const W = 880
  const H = 440
  const left = 100
  const top = 470
  const x = (t: number) => left + (t / (MINUTES - 1)) * W
  const y = (v: number) => top + H - (v / 16) * H
  const path = (series: number[]) => series.map((v, t) => `${t ? 'L' : 'M'}${x(t)},${y(v)}`).join(' ')
  const drawRaw = interpolate(frame, [20, 110], [0, 1], clamp)
  const drawSmooth = interpolate(frame, [130, 230], [0, 1], clamp)
  return (
    <>
      <Heading
        sub={
          <>
            <span style={{ color: colors.danger }}>━ snapshot</span> &nbsp; <span style={{ color: colors.highlight }}>━ smoothed</span> · drivers at the airport
          </>
        }
      >
        Fix 1: smooth the signal
      </Heading>
      <Svg>
        <rect x={x(12)} y={top} width={x(16) - x(12)} height={H} fill="rgba(248,113,113,0.12)" />
        <text x={(x(12) + x(16)) / 2} y={top - 14} textAnchor="middle" fill={colors.danger} fontFamily={font} fontSize={26} fontWeight={700}>
          drivers go offline
        </text>
        {[0, 4, 8, 12, 16].map((v) => (
          <g key={v}>
            <line x1={left} x2={left + W} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" />
            <text x={left - 16} y={y(v) + 9} textAnchor="end" fill={colors.muted} fontFamily={mono} fontSize={24}>
              {v}
            </text>
          </g>
        ))}
        <text x={left + W} y={top + H + 44} textAnchor="end" fill={colors.muted} fontFamily={font} fontSize={26}>
          minutes →
        </text>
        <path d={path(raw)} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - drawRaw} fill="none" stroke={colors.danger} strokeWidth={7} strokeLinejoin="round" />
        <path d={path(smoothed)} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - drawSmooth} fill="none" stroke={colors.highlight} strokeWidth={7} strokeLinejoin="round" />
      </Svg>
      <Callout enter={110} x={70} y={1040} big={`${surge(8, 2).toFixed(1)}×`} unit="price" small="from the snapshot (2 cars)" hot />
      <Callout enter={240} x={590} y={1040} big={`${surge(8, Math.min(...smoothed)).toFixed(1)}×`} unit="price" small={`smoothed (${Math.min(...smoothed).toFixed(1)} cars)`} />
      <Narrated lines={lines} />
    </>
  )
}

function Fixes({ lines }: SceneProps) {
  return (
    <>
      <Heading>More fixes</Heading>
      <div style={{ position: 'absolute', top: 310, left: 70, right: 70, fontFamily: font, color: colors.text }}>
        <Card enter={15} title="2 · Spot the pattern" color={colors.danger} items={['Many drivers offline, same hexagon, same minute', 'Leave them out of supply; review the accounts']} />
        <Card enter={180} title="3 · Lock the price" color={colors.engine} items={['Fixed when the rider taps Request', 'Later swings never change it']} />
        <Card enter={330} title="4 · Forecast and nudge" color={colors.highlight} items={['Flights landing, concerts ending, rain', 'Heatmaps send drivers before the rush']} />
      </div>
      <Narrated lines={lines} />
    </>
  )
}

const STAGES = [
  { title: 'Driver app', sub: 'GPS ping every few seconds', color: colors.engine, enter: 10 },
  { title: 'Kafka', sub: 'event stream', color: colors.hypervisor, enter: 70 },
  { title: 'Stream processor', sub: 'riders & drivers per H3 hexagon', color: colors.libs, enter: 180 },
  { title: 'Pricing service', sub: 'counts → smoothed → multiplier', color: colors.os, enter: 330 },
  { title: 'Rider app', sub: 'one locked, upfront price', color: colors.app, enter: 390 },
]
const STAGE_TOP = 340
const STAGE_STEP = 225
const STAGE_H = 150

/** The data path from a driver's phone to the price a rider sees, with packets flowing down. */
function Pipeline({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  return (
    <>
      <Heading>Under the hood</Heading>
      <Svg>
        {STAGES.slice(1).map((stage, i) => {
          const y1 = STAGE_TOP + i * STAGE_STEP + STAGE_H
          const y2 = y1 + STAGE_STEP - STAGE_H
          if (frame < stage.enter) return null
          return (
            <g key={stage.title}>
              <line x1={540} x2={540} y1={y1 + 6} y2={y2 - 6} stroke="rgba(255,255,255,0.35)" strokeWidth={4} />
              {[0, 1, 2].map((k) => {
                const t = ((frame - stage.enter + k * 12) % 36) / 36
                return <circle key={k} cx={540} cy={y1 + 6 + t * (y2 - y1 - 12)} r={8} fill={STAGES[i].color} />
              })}
            </g>
          )
        })}
      </Svg>
      {STAGES.map((stage, i) => (
        <Appear key={stage.title} enter={stage.enter} style={{ position: 'absolute', left: 130, right: 130, top: STAGE_TOP + i * STAGE_STEP, height: STAGE_H }}>
          <div
            style={{
              height: STAGE_H,
              boxSizing: 'border-box',
              padding: '24px 32px',
              borderRadius: 24,
              background: 'rgba(15, 17, 21, 0.85)',
              borderLeft: `14px solid ${stage.color}`,
              fontFamily: font,
              color: colors.text,
            }}
          >
            <div style={{ fontSize: 46, fontWeight: 800 }}>{stage.title}</div>
            <div style={{ marginTop: 6, fontSize: 30, color: colors.muted, fontFamily: mono }}>{stage.sub}</div>
          </div>
        </Appear>
      ))}
      <Narrated lines={lines} />
    </>
  )
}

function Outro() {
  const line = (enter: number, children: ReactNode) => (
    <Appear enter={enter}>
      <div style={{ marginTop: 40, fontSize: 60, fontWeight: 800, lineHeight: 1.2 }}>{children}</div>
    </Appear>
  )
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: 90, fontFamily: font, color: colors.text }}>
      {line(5, <><span style={{ color: colors.os }}>Surge</span> = riders ÷ drivers, per hexagon.</>)}
      {line(30, <><span style={{ color: colors.danger }}>Artificial scarcity</span> = faking low supply.</>)}
      {line(55, <><span style={{ color: colors.highlight }}>Fix</span>: smooth · detect · lock · forecast.</>)}
      <Appear enter={85}>
        <div style={{ marginTop: 70, fontSize: 36, color: colors.muted }}>Made with Structura · system design, explained</div>
      </Appear>
    </AbsoluteFill>
  )
}

// ─── Timeline ──────────────────────────────────────────────────────────────

const SCENES: Scene[] = [
  [Title, 120, null],
  [Surge, 570, 'surge'],
  [Gaming, 660, 'gaming'],
  [Smooth, 390, 'smooth'],
  [Fixes, 480, 'fixes'],
  [Pipeline, 480, 'pipeline'],
  [Outro, 150, null],
]

export const duration = (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice)

export function UberSurge({ voice }: VideoProps) {
  return <Timeline video={VIDEO} narration={narration} scenes={SCENES} voice={voice} />
}
