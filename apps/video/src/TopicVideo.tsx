import type { ReactNode } from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { TOPIC_VIDEOS } from './data/topics'
import { EpisodeBar, GridBackground, Panel, reel, Rise, Tag, Voiced } from './reel/kit'
import type { Narration, TimedLine } from './timeline'
import { clamp, type Scene, type SceneProps, Timeline, totalFrames, type VideoProps } from './ui'

// The automatic topic video: any Structura topic (exported by
// apps/web/scripts/export-videos.ts) as a narrated vertical video. The neon
// architecture builds itself, the camera follows the request step by step with
// a packet travelling the arrows and the step's data on a card, then the
// takeaways. Voiced with Kokoro (src/narration/topic-<id>.json).

type TopicData = (typeof TOPIC_VIDEOS)[keyof typeof TOPIC_VIDEOS]['data']
type Placed = { x: number; y: number; w: number; h: number }

const COLORS: Record<string, string> = {
  black: '#9ca3af', grey: '#94a3b8', 'light-violet': '#c4b5fd', violet: '#a78bfa', blue: '#60a5fa', 'light-blue': '#7dd3fc',
  yellow: '#facc15', orange: '#fb923c', green: '#34d399', 'light-green': '#86efac', 'light-red': '#fca5a5', red: '#f87171', white: '#e5e7eb',
}
const ICON: [RegExp, string][] = [
  [/user|client|browser|rider|driver app|producer/i, '◉'],
  [/cache|redis/i, '⚡'],
  [/kafka|queue|stream|offsets|dlq/i, '☰'],
  [/database|\bdb\b|store|sql|index|snippets|links|crawled/i, '⛁'],
  [/web$|internet/i, '☁'],
  [/broker|server|api|service|processor|consumer|crawler|engine/i, '▣'],
  [/controller|gateway|policy|partitioner|similar|\?/i, '◆'],
]
const glyph = (label: string) => ICON.find(([re]) => re.test(label))?.[1] ?? '▢'

/** The diagram's box: x, y within the frame. */
const STAGE = { left: 40, top: 220, width: 1000, height: 860 }
const PAD = 60

function sides(a: Placed, b: Placed) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const horizontal = Math.abs(bc.x - ac.x) * 0.6 > Math.abs(bc.y - ac.y)
  if (horizontal) {
    const s = Math.sign(bc.x - ac.x) || 1
    return [{ x: ac.x + (s * a.w) / 2, y: ac.y }, { x: bc.x - (s * b.w) / 2, y: bc.y }, horizontal] as const
  }
  const s = Math.sign(bc.y - ac.y) || 1
  return [{ x: ac.x, y: ac.y + (s * a.h) / 2 }, { x: bc.x, y: bc.y - (s * b.h) / 2 }, horizontal] as const
}

/** Control points of the S-curve between two side midpoints (as in the app's 2D diagram). */
function controls(p: { x: number; y: number }, q: { x: number; y: number }, horizontal: boolean) {
  const mx = (p.x + q.x) / 2
  const my = (p.y + q.y) / 2
  return horizontal ? [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q] : [p, { x: p.x, y: my }, { x: q.x, y: my }, q]
}

const bezier = (pts: { x: number; y: number }[], t: number) => {
  const u = 1 - t
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return { x: pts.reduce((s, p, i) => s + p.x * k[i], 0), y: pts.reduce((s, p, i) => s + p.y * k[i], 0) }
}

/** Camera that fits `bounds` into the stage, never closer than 1.15× nor further than 0.28×. */
function fitCamera(b: Placed) {
  const scale = Math.max(0.28, Math.min(1.15, STAGE.width / (b.w + PAD * 2), STAGE.height / (b.h + PAD * 2)))
  return { scale, x: STAGE.width / 2 - (b.x + b.w / 2) * scale, y: STAGE.height / 2 - (b.y + b.h / 2) * scale }
}

function boundsOf(nodes: Placed[]): Placed {
  const x = Math.min(...nodes.map((n) => n.x))
  const y = Math.min(...nodes.map((n) => n.y))
  return { x, y, w: Math.max(...nodes.map((n) => n.x + n.w)) - x, h: Math.max(...nodes.map((n) => n.y + n.h)) - y }
}

const same = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  return n(a) === n(b) || n(a).startsWith(n(b)) || n(b).startsWith(n(a))
}

/** The neon architecture: cards, flowing arrows, a packet on the arrows in focus. */
function Diagram({ data, reveal, focus, camera }: { data: TopicData; reveal: number; focus: Set<string> | null; camera: { x: number; y: number; scale: number } }) {
  const frame = useCurrentFrame()
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const shownCount = Math.ceil(reveal * data.nodes.length)
  const shown = new Set(data.nodes.slice(0, shownCount).map((n) => n.id))
  const lit = (id: string) => !focus || focus.has(id)
  return (
    <div style={{ position: 'absolute', ...STAGE, overflow: 'hidden', borderRadius: 32 }}>
      <svg
        width={data.width}
        height={data.height}
        style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', transformOrigin: '0 0', transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
      >
        {data.groups.map((g) => (
          <g key={g.id} opacity={reveal > 0.2 ? 1 : 0}>
            <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={22} fill="rgba(148,163,184,0.04)" stroke="rgba(148,163,184,0.3)" strokeDasharray="8 8" />
            <text x={g.x + 20} y={g.y + 34} fill="#8a93a6" fontFamily={reel.mono} fontSize={18} fontWeight={700} letterSpacing={2}>
              {g.label.toUpperCase()}
            </text>
          </g>
        ))}
        {data.edges.map((e, i) => {
          const a = byId.get(e.from)
          const b = byId.get(e.to)
          if (!a || !b || !shown.has(a.id) || !shown.has(b.id)) return null
          const [p, q, horizontal] = sides(a, b)
          const pts = controls(p, q, horizontal)
          const d = `M${pts[0].x},${pts[0].y} C${pts[1].x},${pts[1].y} ${pts[2].x},${pts[2].y} ${pts[3].x},${pts[3].y}`
          const on = lit(a.id) && lit(b.id)
          const color = COLORS[a.color] ?? COLORS.grey
          const packet = focus && on ? bezier(pts, ((frame + i * 9) % 36) / 36) : null
          const mid = bezier(pts, 0.5)
          return (
            <g key={i} opacity={focus && !on ? 0.15 : 1}>
              <path d={d} fill="none" stroke={color} strokeWidth={on && focus ? 9 : 6} opacity={0.14} />
              <path d={d} fill="none" stroke={color} strokeWidth={on && focus ? 3.4 : 2.4} strokeDasharray={e.dashed ? '4 9' : '9 9'} strokeDashoffset={-frame * (on && focus ? 1.6 : 0.8)} />
              {packet && <circle cx={packet.x} cy={packet.y} r={8} fill="#fff" style={{ filter: `drop-shadow(0 0 10px ${color})` }} />}
              {e.label && (
                <text x={mid.x} y={mid.y - 10} textAnchor="middle" fill="#c9d1e4" fontFamily={reel.sans} fontSize={17} fontWeight={600} stroke="#05060a" strokeWidth={6} paintOrder="stroke">
                  {e.label}
                </text>
              )}
            </g>
          )
        })}
        {data.nodes.map((n, i) => {
          if (!shown.has(n.id)) return null
          const color = COLORS[n.color] ?? COLORS.grey
          const on = lit(n.id)
          const pop = Math.min(1, (reveal * data.nodes.length - i) * 1.4)
          return (
            <foreignObject key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} opacity={focus && !on ? 0.22 : 1} style={{ overflow: 'visible' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  boxSizing: 'border-box',
                  height: '100%',
                  padding: '10px 16px',
                  borderRadius: n.shape === 'ellipse' ? 999 : 16,
                  border: `3px ${n.shape === 'diamond' ? 'dashed' : 'solid'} ${color}`,
                  background: '#0b1020',
                  boxShadow: `0 0 ${focus && on ? 46 : 24}px ${color}${focus && on ? 'cc' : '66'}`,
                  transform: `scale(${0.9 + 0.1 * pop})`,
                  opacity: pop,
                }}
              >
                <span style={{ display: 'grid', placeItems: 'center', flex: 'none', width: 46, height: 46, borderRadius: 12, background: `${color}33`, color, fontSize: 26 }}>
                  {glyph(n.label)}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <strong style={{ color: '#f1f5ff', fontFamily: reel.sans, fontSize: 21, lineHeight: 1.2 }}>{n.label}</strong>
                  {n.subtitle && <small style={{ color: '#aab3c8', fontFamily: reel.sans, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.subtitle}</small>}
                </span>
              </div>
            </foreignObject>
          )
        })}
      </svg>
    </div>
  )
}

const sceneEnd = (lines: TimedLine[]) => lines[lines.length - 1]?.to ?? 1

export function topicVideo(id: keyof typeof TOPIC_VIDEOS) {
  const { data, narration: narrationJson } = TOPIC_VIDEOS[id]
  const narration = narrationJson as Narration
  const VIDEO = `topic-${id}`
  const whole = fitCamera({ x: 0, y: 0, w: data.width, h: data.height })
  const stepNodes = data.steps.map((s) => data.nodes.filter((n) => s.nodes.some((l) => same(l, n.label))))

  function Title() {
    const frame = useCurrentFrame()
    return (
      <AbsoluteFill style={{ justifyContent: 'center', padding: 80, fontFamily: reel.sans, color: reel.text }}>
        <Rise enter={4}>
          <Tag>SYSTEM DESIGN · {data.difficulty.toUpperCase()}</Tag>
        </Rise>
        <Rise enter={12}>
          <div style={{ marginTop: 34, fontSize: 112, fontWeight: 900, lineHeight: 1.02, letterSpacing: '-0.03em', transform: `scale(${interpolate(frame, [0, 110], [1, 1.04], clamp)})`, transformOrigin: 'left' }}>
            {data.title}
          </div>
        </Rise>
        <Rise enter={26}>
          <div style={{ marginTop: 34, fontSize: 40, color: reel.muted, lineHeight: 1.35 }}>{data.blurb}</div>
        </Rise>
      </AbsoluteFill>
    )
  }

  /** The architecture builds itself while the summary is read. */
  function Intro({ lines }: SceneProps) {
    const frame = useCurrentFrame()
    const end = sceneEnd(lines)
    const reveal = interpolate(frame, [10, end * 0.75], [0, 1], clamp)
    // While it builds, frame the newest few components (readable); then pull back to the whole.
    const count = Math.max(1, Math.ceil(reveal * data.nodes.length))
    const recent = fitCamera(boundsOf(data.nodes.slice(Math.max(0, count - 4), count)))
    const back = interpolate(frame, [end * 0.78, end * 0.95], [0, 1], clamp)
    const camera = { scale: recent.scale + (whole.scale - recent.scale) * back, x: recent.x + (whole.x - recent.x) * back, y: recent.y + (whole.y - recent.y) * back }
    return (
      <>
        <Diagram data={data} reveal={reveal} focus={null} camera={camera} />
        <Voiced lines={lines} bottom={250} size={60} />
      </>
    )
  }

  /** The request, step by step: camera on the step's boxes, packets on its arrows, its data on a card. */
  function Walk({ lines }: SceneProps) {
    const frame = useCurrentFrame()
    const { fps } = useVideoConfig()
    const stepOf = (l: TimedLine) => Number(l.id.match(/^step(\d+)-/)?.[1] ?? 0)
    const current = lines.find((l) => frame >= l.from && frame < l.to) ?? lines[lines.length - 1]
    const index = stepOf(current)
    const stepStart = lines.find((l) => stepOf(l) === index)?.from ?? 0
    const step = data.steps[index]
    const target = stepNodes[index].length ? fitCamera(boundsOf(stepNodes[index])) : whole
    const previous = index > 0 && stepNodes[index - 1].length ? fitCamera(boundsOf(stepNodes[index - 1])) : whole
    const t = spring({ frame: frame - stepStart, fps, config: { damping: 22, stiffness: 90 } })
    const camera = { scale: previous.scale + (target.scale - previous.scale) * t, x: previous.x + (target.x - previous.x) * t, y: previous.y + (target.y - previous.y) * t }
    const typed = Math.floor(interpolate(frame - stepStart, [8, 50], [0, 1], clamp) * (step.data?.length ?? 0))
    return (
      <>
        <Diagram data={data} reveal={1} focus={new Set(stepNodes[index].map((n) => n.id))} camera={camera} />
        <div style={{ position: 'absolute', left: 60, right: 60, top: 1100, display: 'flex', alignItems: 'center', gap: 18, fontFamily: reel.sans }}>
          <Tag solid>
            STEP {index + 1}/{data.steps.length}
          </Tag>
          <span key={index} style={{ fontSize: 40, fontWeight: 800, color: reel.text, opacity: interpolate(frame - stepStart, [0, 10], [0, 1], clamp) }}>
            {step.title}
          </span>
        </div>
        {step.data && (
          <Panel glow={reel.cyan} style={{ position: 'absolute', left: 60, right: 60, top: 1180, maxHeight: 250, overflow: 'hidden', padding: '20px 26px' }}>
            <pre style={{ margin: 0, fontFamily: reel.mono, fontSize: 23, lineHeight: 1.45, color: '#cfe8ff', whiteSpace: 'pre-wrap' }}>
              {step.data.slice(0, typed).split('\n').slice(0, 8).join('\n')}
              <span style={{ color: reel.cyan, opacity: Math.floor(frame / 15) % 2 }}>▍</span>
            </pre>
          </Panel>
        )}
        <Voiced lines={lines} bottom={230} size={60} />
      </>
    )
  }

  function Takeaways({ lines }: SceneProps) {
    const frame = useCurrentFrame()
    return (
      <>
        <div style={{ position: 'absolute', top: 260, left: 70, right: 70, fontFamily: reel.sans }}>
          <div style={{ fontSize: 68, fontWeight: 900, color: reel.text, marginBottom: 34 }}>Key takeaways</div>
          {data.takeaways.map((text, i) => {
            const enter = lines.find((l) => l.id.startsWith(`take-${i}-`))?.from ?? 9999
            const said = frame >= enter
            return (
              <Rise key={text} enter={enter}>
                <Panel glow={reel.lime} style={{ display: 'flex', gap: 22, alignItems: 'flex-start', marginBottom: 22, padding: '22px 26px', opacity: said ? 1 : 0 }}>
                  <span style={{ fontSize: 40, color: reel.lime, lineHeight: 1 }}>✓</span>
                  <span style={{ fontSize: 34, lineHeight: 1.35, color: reel.text }}>{text}</span>
                </Panel>
              </Rise>
            )
          })}
        </div>
        <Voiced lines={lines} bottom={230} size={60} />
      </>
    )
  }

  function Outro({ lines }: SceneProps) {
    return (
      <>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 80, textAlign: 'center', fontFamily: reel.sans, color: reel.text }}>
          <Rise enter={4}>
            <div style={{ fontSize: 72, fontWeight: 900, lineHeight: 1.1 }}>Explore it yourself</div>
          </Rise>
          <Rise enter={16}>
            <div style={{ marginTop: 30, fontSize: 40, color: reel.cyan, fontFamily: reel.mono }}>structura-web.netlify.app</div>
          </Rise>
          {data.credit && (
            <Rise enter={30}>
              <div style={{ marginTop: 60, fontSize: 26, color: reel.muted, lineHeight: 1.4 }}>{data.credit}</div>
            </Rise>
          )}
        </AbsoluteFill>
        <Voiced lines={lines} bottom={230} size={60} />
      </>
    )
  }

  const SCENES: Scene[] = [
    [Title, 100, null],
    [Intro, 300, 'intro'],
    [Walk, 600, 'walk'],
    [Takeaways, 300, 'takeaways'],
    [Outro, 150, 'outro'],
  ]
  const CHAPTERS = [null, 'INTRO', 'WALKTHROUGH', 'TAKEAWAYS', null]

  function TopicVideo({ voice }: VideoProps): ReactNode {
    return (
      <Timeline
        video={VIDEO}
        narration={narration}
        scenes={SCENES}
        voice={voice}
        background={<GridBackground />}
        overlay={(progress) => <EpisodeBar episode={data.difficulty.toUpperCase()} chapters={CHAPTERS} progress={progress} />}
      />
    )
  }

  return { VIDEO, Component: TopicVideo, duration: (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice) }
}
