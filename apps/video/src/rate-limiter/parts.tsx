import { Check, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useId } from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { mono, sans } from '../cards/fonts'
import { CardScene, GlowCard, ink, Logo, type Tone, toneColor, useEnter } from '../cards/kit'
import type { SceneProps } from '../ui'
import { clamp } from '../ui'

// Pieces shared by the four rate limiter reels: a two-minute time axis with stacks of
// requests on it, a row of counter slots, a bucket of tokens and the end card. Every
// number matches the Structura topic's simulator (apps/web/src/topics/rate-limiter.ts):
// 10 requests per 60 seconds for API key key_live_8f3a.

export const LIMIT = 10
export const WINDOW = 60
export const KEY = 'key_live_8f3a'

export const Row = ({ children, gap = 14, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap, ...style }}>{children}</div>
)

export const Label = ({ children, color = ink.muted, size = 21 }: { children: ReactNode; color?: string; size?: number }) => (
  <span style={{ fontFamily: mono, fontWeight: 700, fontSize: size, letterSpacing: '0.12em', color }}>{children}</span>
)

/** Centred, pops in at `enter`. */
export function Pop({ enter, children, style }: { enter: number; children: ReactNode; style?: CSSProperties }) {
  const t = useEnter(enter, 12)
  return <div style={{ position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: t, transform: `scale(${0.85 + 0.15 * t})`, ...style }}>{children}</div>
}

/** Fades in at `enter`. */
export function Show({ enter, children, style }: { enter: number; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ opacity: useEnter(enter), ...style }}>{children}</div>
}

// ─── The time axis ───────────────────────────────────────────────────────────

const X0 = 130
const X1 = 950
const SECONDS = 120
export const xAt = (s: number) => X0 + (s / SECONDS) * (X1 - X0)
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export interface Stack {
  /** Seconds from the start. */
  t: number
  /** How many requests, and how many of them pass (the rest are refused, drawn on top). */
  n: number
  ok: number
  enter: number
  /** Drawn faintly: requests that have left the window. */
  dim?: boolean
}

export interface Brace {
  from: number
  to: number
  label: string
  tone: Tone
  enter: number
}

const H = 520 // the card's height
const AXIS = 400 // the axis line, from the card's top
const SQUARE = 18
const STEP = 21

/**
 * Two minutes of time, left to right, with requests stacked where they arrive:
 * green passed, red refused. `minutes` shades the two fixed windows; `slide` draws
 * the last 60 seconds before a moment, `brace` marks a span with a label.
 */
export function Axis({
  top,
  enter,
  stacks,
  minutes,
  slide,
  brace,
  focus,
  tone = 'cyan',
}: {
  top: number
  enter: number
  stacks: Stack[]
  minutes?: { enter: number; labels?: [string, string]; dimFirst?: boolean }
  slide?: { at: number; enter: number; tone?: Tone }
  brace?: Brace
  /** Highlight the part of the first minute still inside a sliding window ending here. */
  focus?: { at: number; enter: number }
  tone?: Tone
}) {
  const frame = useCurrentFrame()
  const showMinutes = useEnter(minutes?.enter ?? 0)
  const showSlide = useEnter(slide?.enter ?? 0)
  const showBrace = useEnter(brace?.enter ?? 0, 12)
  const showFocus = useEnter(focus?.enter ?? 0)
  return (
    <>
      <GlowCard enter={enter} tone={tone} style={{ top, height: H, padding: 0 }}>
        <span />
      </GlowCard>
      <svg width={1080} height={H} style={{ position: 'absolute', top, left: 0, opacity: useEnter(enter) }}>
        {minutes &&
          [0, 1].map((m) => (
            <g key={m} opacity={showMinutes}>
              <rect
                x={xAt(m * 60) + 3}
                y={36}
                width={xAt(60) - xAt(0) - 6}
                height={AXIS - 36}
                rx={14}
                fill={m === 0 ? 'rgba(62, 216, 246, 0.07)' : 'rgba(167, 139, 250, 0.08)'}
                stroke={m === 0 ? `${ink.cyan}55` : `${ink.violet}55`}
                strokeWidth={2}
                strokeDasharray="8 8"
                opacity={minutes.dimFirst && m === 0 ? 0.5 : 1}
              />
              <text x={xAt(m * 60 + 30)} y={70} textAnchor="middle" fontFamily={mono} fontWeight={700} fontSize={25} fill={m === 0 ? ink.cyan : ink.violet} letterSpacing="0.08em">
                {minutes.labels?.[m] ?? `MINUTE ${m}`}
              </text>
            </g>
          ))}
        {focus && (
          <rect x={xAt(focus.at - 60)} y={92} width={xAt(60) - xAt(focus.at - 60)} height={AXIS - 92} fill={`${ink.amber}22`} stroke={ink.amber} strokeWidth={2.5} rx={8} opacity={showFocus} />
        )}
        {/* The axis and its clock times. */}
        <line x1={X0 - 20} y1={AXIS} x2={X1 + 20} y2={AXIS} stroke={ink.muted} strokeWidth={3} />
        {[0, 30, 60, 90, 120].map((s) => (
          <g key={s}>
            <line x1={xAt(s)} y1={AXIS - 8} x2={xAt(s)} y2={AXIS + 8} stroke={ink.muted} strokeWidth={3} />
            <text x={xAt(s)} y={AXIS + 48} textAnchor="middle" fontFamily={mono} fontWeight={700} fontSize={30} fill={ink.muted}>
              {clock(s)}
            </text>
          </g>
        ))}
        {stacks.map((stack) => {
          const shown = Math.min(stack.n, Math.max(0, Math.floor((frame - stack.enter) / 1.5) + 1))
          return (
            <g key={`${stack.t}-${stack.enter}`} opacity={stack.dim ? 0.28 : 1}>
              {Array.from({ length: shown }, (_, i) => {
                const ok = i < stack.ok
                const color = ok ? ink.green : ink.red
                return (
                  <rect
                    key={i}
                    x={xAt(stack.t) - 23}
                    y={AXIS - 6 - SQUARE - i * STEP}
                    width={46}
                    height={SQUARE}
                    rx={4}
                    fill={color}
                    style={{ filter: `drop-shadow(0 0 6px ${color})` }}
                  />
                )
              })}
              {shown > 0 && (
                <text x={xAt(stack.t)} y={AXIS + 90} textAnchor="middle" fontFamily={mono} fontWeight={800} fontSize={26} fill={stack.ok === stack.n ? ink.green : ink.red}>
                  {clock(stack.t)}
                </text>
              )}
            </g>
          )
        })}
        {slide && (
          <g opacity={showSlide}>
            <rect x={xAt(Math.max(0, slide.at - 60))} y={96} width={xAt(slide.at) - xAt(Math.max(0, slide.at - 60))} height={AXIS - 96} rx={8} fill={`${toneColor(slide.tone ?? 'amber')}14`} stroke={toneColor(slide.tone ?? 'amber')} strokeWidth={3} />
            <text x={(xAt(Math.max(0, slide.at - 60)) + xAt(slide.at)) / 2} y={134} textAnchor="middle" fontFamily={mono} fontWeight={800} fontSize={26} fill={toneColor(slide.tone ?? 'amber')} letterSpacing="0.06em">
              LAST 60 s
            </text>
          </g>
        )}
        {brace && (
          <g opacity={showBrace}>
            <path
              d={`M ${xAt(brace.from) - 28} 178 L ${xAt(brace.from) - 28} 160 L ${xAt(brace.to) + 28} 160 L ${xAt(brace.to) + 28} 178`}
              fill="none"
              stroke={toneColor(brace.tone)}
              strokeWidth={4}
              strokeLinejoin="round"
            />
            <text x={(xAt(brace.from) + xAt(brace.to)) / 2} y={144} textAnchor="middle" fontFamily={sans} fontWeight={900} fontSize={34} fill={toneColor(brace.tone)} style={{ filter: `drop-shadow(0 0 10px ${toneColor(brace.tone)})` }}>
              {brace.label}
            </text>
          </g>
        )}
      </svg>
    </>
  )
}

/** Where a sliding window ends, gliding from one second to another between two frames. */
export function useGlide(from: number, to: number, start: number, end: number) {
  const frame = useCurrentFrame()
  return Math.round(interpolate(frame, [start, end], [from, to], clamp))
}

// ─── Counter slots ───────────────────────────────────────────────────────────

/** Ten slots that fill as requests are counted; `refused` shows the 11th, in red. */
export function Slots({ count, refused = false }: { count: number; refused?: boolean }) {
  return (
    <Row gap={10} style={{ marginTop: 16 }}>
      {Array.from({ length: LIMIT }, (_, i) => {
        const on = i < count
        return (
          <div
            key={i}
            style={{
              width: 58,
              height: 58,
              borderRadius: 12,
              display: 'grid',
              placeItems: 'center',
              border: `2.5px solid ${on ? ink.green : ink.border}`,
              background: on ? `${ink.green}26` : 'transparent',
              boxShadow: on ? `0 0 14px ${ink.green}66` : 'none',
              fontFamily: mono,
              fontWeight: 800,
              fontSize: 24,
              color: on ? ink.green : ink.dim,
            }}
          >
            {i + 1}
          </div>
        )
      })}
      <div
        style={{
          width: 58,
          height: 58,
          borderRadius: 12,
          display: 'grid',
          placeItems: 'center',
          border: `2.5px solid ${refused ? ink.red : 'transparent'}`,
          background: refused ? `${ink.red}26` : 'transparent',
          boxShadow: refused ? `0 0 18px ${ink.red}88` : 'none',
          opacity: refused ? 1 : 0,
        }}
      >
        <X size={34} color={ink.red} strokeWidth={3} />
      </div>
    </Row>
  )
}

// ─── The bucket ──────────────────────────────────────────────────────────────

/**
 * A bucket of ten tokens, two rows of five; `level` may be fractional (0.5 shows half a
 * token). A drop falls in while `dripping`.
 */
export function Bucket({ level, dripping = false, size = 1 }: { level: number; dripping?: boolean; size?: number }) {
  const id = useId().replace(/:/g, '')
  const frame = useCurrentFrame()
  const drop = (frame % 36) / 36
  const r = 30
  const slots = Array.from({ length: LIMIT }, (_, i) => ({ i, x: 92 + (i % 5) * 72, y: 262 - Math.floor(i / 5) * 72 }))
  return (
    <svg width={480 * size} height={330 * size} viewBox="0 0 480 330">
      <defs>
        {slots.map(({ i, x, y }) => {
          const fill = Math.max(0, Math.min(1, level - i))
          return (
            <clipPath key={i} id={`${id}-t${i}`}>
              <rect x={x - r} y={y + r - 2 * r * fill} width={2 * r} height={2 * r * fill} />
            </clipPath>
          )
        })}
      </defs>
      {dripping && <circle cx={236} cy={-10 + drop * 120} r={11} fill={ink.cyan} opacity={1 - drop * 0.6} style={{ filter: `drop-shadow(0 0 8px ${ink.cyan})` }} />}
      <path d="M 40 110 L 70 310 L 410 310 L 440 110" fill="rgba(62, 216, 246, 0.05)" stroke={ink.cyan} strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" />
      {slots.map(({ i, x, y }) => (
        <g key={i}>
          <circle cx={x} cy={y} r={r} fill="none" stroke={ink.border} strokeWidth={3} strokeDasharray="6 6" />
          <circle cx={x} cy={y} r={r} fill={ink.amber} clipPath={`url(#${id}-t${i})`} style={{ filter: `drop-shadow(0 0 8px ${ink.amber}aa)` }} />
        </g>
      ))}
    </svg>
  )
}

// ─── Verdict chips and the end card ──────────────────────────────────────────

export function Verdict({ ok, children }: { ok: boolean; children: ReactNode }) {
  const color = ok ? ink.green : ink.red
  return (
    <Row gap={12}>
      {ok ? <Check size={34} color={color} strokeWidth={3} /> : <X size={34} color={color} strokeWidth={3} />}
      <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 30, color, letterSpacing: '0.04em' }}>{children}</span>
    </Row>
  )
}

/** A big number with a caption under it. */
export function Stat({ value, caption, tone = 'cyan' }: { value: string; caption: string; tone?: Tone }) {
  return (
    <div>
      <div style={{ fontFamily: sans, fontWeight: 900, fontSize: 76, letterSpacing: '-0.02em', color: toneColor(tone), lineHeight: 1.05 }}>{value}</div>
      <div style={{ fontSize: 28, color: ink.muted, marginTop: 6, lineHeight: 1.3 }}>{caption}</div>
    </div>
  )
}

export function TryIt({ lines, part, algorithm, hint }: SceneProps & { part: number; algorithm: string; hint: [string, string] }) {
  const frame = useCurrentFrame()
  const press = interpolate(frame % 50, [0, 8, 16], [1, 0.96, 1], clamp)
  return (
    <CardScene lines={lines} eyebrow={`RATE LIMITING · ${part} OF 4`} title="Try it" accent="yourself." accentTone="cyan" status={[[0, 'INTERACTIVE SIMULATOR', 'cyan']]}>
      <GlowCard enter={6} tone="cyan" style={{ top: 500, padding: '46px 40px', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Logo size={130} />
        </div>
        <div style={{ marginTop: 24, fontSize: 48, fontWeight: 900, letterSpacing: '0.05em' }}>STRUCTURA</div>
        <div style={{ fontFamily: mono, fontSize: 26, color: ink.cyan, marginTop: 6 }}>Rate Limiter · {algorithm}</div>
        <div style={{ fontSize: 30, color: ink.muted, marginTop: 22, lineHeight: 1.4 }}>
          {hint[0]}
          <br />
          {hint[1]}
        </div>
        <div
          style={{
            display: 'inline-block',
            marginTop: 34,
            padding: '20px 40px',
            borderRadius: 999,
            background: `linear-gradient(90deg, #2f7bff, ${ink.cyan})`,
            color: '#04101f',
            fontWeight: 900,
            fontSize: 30,
            letterSpacing: '0.06em',
            transform: `scale(${press})`,
            boxShadow: `0 0 40px ${ink.cyan}77`,
          }}
        >
          OPEN THE SIMULATOR
        </div>
        <div style={{ fontFamily: mono, fontSize: 26, color: ink.muted, marginTop: 26 }}>structura-web.netlify.app</div>
      </GlowCard>
    </CardScene>
  )
}
