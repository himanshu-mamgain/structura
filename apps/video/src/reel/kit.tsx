import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { TimedLine } from '../timeline'
import { clamp, type Progress, type SceneProps, VoiceClips } from '../ui'

// The reel look: black grid, neon accents, an episode bar with chapters, an
// interviewer card that types its question, word-by-word captions and big
// ticking numbers. Every episode in src/episodes uses these.

export const reel = {
  bg: '#05060a',
  grid: 'rgba(120, 140, 180, 0.07)',
  text: '#f5f7fb',
  dim: 'rgba(245, 247, 251, 0.32)',
  muted: '#8a93a6',
  lime: '#d4ff3f',
  cyan: '#4cc9f0',
  blue: '#5aa9ff',
  orange: '#ffb347',
  red: '#ff4d6d',
  green: '#3ddc97',
  panel: 'rgba(14, 17, 26, 0.92)',
  border: 'rgba(255, 255, 255, 0.12)',
  sans: '"Segoe UI", Inter, system-ui, sans-serif',
  mono: '"Cascadia Code", Consolas, "SFMono-Regular", Menlo, monospace',
}

/** Black with a faint blueprint grid and a soft glow that drifts. */
export function GridBackground() {
  const frame = useCurrentFrame()
  const glowX = 50 + Math.sin(frame / 90) * 18
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at ${glowX}% 38%, rgba(76, 110, 245, 0.16), transparent 45%), ${reel.bg}`,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${reel.grid} 2px, transparent 2px), linear-gradient(90deg, ${reel.grid} 2px, transparent 2px)`,
          backgroundSize: '60px 60px',
          maskImage: 'radial-gradient(circle at 50% 45%, black 40%, transparent 85%)',
        }}
      />
    </AbsoluteFill>
  )
}

/** "EP 01 · SYSTEM DESIGN" and one progress segment per chapter, filled as the reel plays. */
export function EpisodeBar({ episode, chapters, progress }: { episode: string; chapters: (string | null)[]; progress: Progress }) {
  // Scenes without a chapter (like the end card) count as the last chapter.
  const named = chapters.map((c, i) => c ?? chapters.slice(0, i).filter(Boolean).at(-1) ?? '')
  const labels = [...new Set(named.filter(Boolean))]
  const current = named[progress.scene]
  const currentIndex = labels.indexOf(current)
  // How far through the current chapter: average over the scenes that share its name.
  const scenesInChapter = named.map((n, i) => (n === current ? i : -1)).filter((i) => i >= 0)
  const within = (scenesInChapter.indexOf(progress.scene) + progress.fraction) / scenesInChapter.length
  return (
    <div style={{ position: 'absolute', top: 70, left: 60, right: 60, fontFamily: reel.mono }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 30, letterSpacing: '0.14em' }}>
        <span style={{ background: reel.lime, color: '#000', padding: '4px 14px', borderRadius: 8, fontWeight: 800 }}>{episode}</span>
        <span style={{ color: reel.muted }}>SYSTEM DESIGN</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 26 }}>
        {labels.map((label, i) => {
          const fill = i < currentIndex ? 1 : i === currentIndex ? within : 0
          return (
            <div key={label} style={{ flex: 1 }}>
              <div style={{ fontSize: 22, letterSpacing: '0.12em', color: i === currentIndex ? reel.lime : reel.muted, fontWeight: 700 }}>{label}</div>
              <div style={{ marginTop: 10, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
                <div style={{ width: `${fill * 100}%`, height: '100%', background: i === currentIndex ? reel.lime : 'rgba(255,255,255,0.55)' }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Fades and lifts children in at `enter`. */
export function Rise({ enter, children, style }: { enter: number; children: ReactNode; style?: CSSProperties }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = spring({ frame: frame - enter, fps, config: { damping: 15 } })
  return <div style={{ ...style, opacity: frame < enter ? 0 : t, transform: `translateY(${(1 - t) * 34}px) scale(${0.96 + t * 0.04})` }}>{children}</div>
}

/** A dark rounded panel with a thin border and glow, the reel's card style. */
export function Panel({ children, style, glow = reel.blue }: { children: ReactNode; style?: CSSProperties; glow?: string }) {
  return (
    <div
      style={{
        background: reel.panel,
        border: `2px solid ${reel.border}`,
        borderRadius: 28,
        boxShadow: `0 0 60px ${glow}22, inset 0 0 0 1px rgba(255,255,255,0.03)`,
        padding: '30px 36px',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/**
 * The interview hook: a recording card whose question types itself out, with a
 * countdown. The last line is the punchline, in the accent colour.
 */
export function InterviewerCard({ enter, lines, round, clock = 30 * 60, charsPerFrame = 0.9, top = 330 }: { enter: number; lines: string[]; round: string; clock?: number; charsPerFrame?: number; top?: number }) {
  const frame = useCurrentFrame()
  const typed = Math.max(0, Math.floor((frame - enter - 10) * charsPerFrame))
  const seconds = Math.max(0, clock - Math.floor(frame / 30))
  let left = typed
  const total = lines.join('').length
  return (
    <Rise enter={enter} style={{ position: 'absolute', top, left: 60, right: 60 }}>
      <Panel glow={reel.orange}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, fontFamily: reel.mono, fontSize: 28, letterSpacing: '0.12em', color: reel.muted }}>
          <span style={{ color: reel.red, fontWeight: 800, opacity: Math.floor(frame / 15) % 2 ? 1 : 0.35 }}>● REC</span>
          <span>{round}</span>
          <span style={{ marginLeft: 'auto', color: reel.text, fontWeight: 800 }}>
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </div>
        <div style={{ height: 2, background: reel.border, margin: '22px 0' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: reel.mono, fontSize: 28, letterSpacing: '0.14em', color: reel.orange, fontWeight: 700 }}>
          <span style={{ width: 46, height: 46, borderRadius: '50%', border: `3px solid ${reel.orange}`, display: 'grid', placeItems: 'center', fontSize: 24 }}>◉</span>
          INTERVIEWER
        </div>
        <div style={{ marginTop: 18, fontFamily: reel.sans, fontSize: 50, fontWeight: 800, lineHeight: 1.3, minHeight: lines.length * 65 }}>
          {lines.map((line, i) => {
            const shown = line.slice(0, Math.max(0, left))
            left -= line.length
            const last = i === lines.length - 1
            const typing = left < 0 && shown.length < line.length + 1 && typed < total
            return (
              <div key={i} style={{ color: last ? reel.orange : reel.text }}>
                {shown}
                {typing && shown.length > 0 && <span style={{ display: 'inline-block', width: 22, height: 50, marginLeft: 4, verticalAlign: 'middle', background: reel.orange }} />}
              </div>
            )
          })}
        </div>
      </Panel>
    </Rise>
  )
}

/** A big number that counts up between frames `from` and `to`, with a unit. */
export function Counter({
  from,
  to,
  start = 0,
  end,
  unit,
  color = reel.blue,
  size = 150,
  format = (n: number) => Math.round(n).toLocaleString('en-IN'),
  style,
}: {
  from: number
  to: number
  start?: number
  end: number
  unit?: string
  color?: string
  size?: number
  format?: (n: number) => string
  style?: CSSProperties
}) {
  const frame = useCurrentFrame()
  const t = interpolate(frame, [from, to], [0, 1], { ...clamp, easing: (x) => 1 - (1 - x) ** 3 })
  const value = start + (end - start) * t
  return (
    <div style={{ textAlign: 'center', fontFamily: reel.sans, ...style }}>
      <span style={{ fontSize: size, fontWeight: 900, color, letterSpacing: '-0.03em', textShadow: `0 0 40px ${color}66`, fontVariantNumeric: 'tabular-nums' }}>{format(value)}</span>
      {unit && <span style={{ marginLeft: 18, fontFamily: reel.mono, fontSize: size * 0.24, color: reel.muted }}>{unit}</span>}
    </div>
  )
}

/** A small pill label, e.g. "1 THREAD" or "COLLISION". */
export function Tag({ children, color = reel.lime, solid = false, style }: { children: ReactNode; color?: string; solid?: boolean; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '6px 16px',
        borderRadius: 10,
        border: `2px solid ${color}`,
        background: solid ? color : `${color}1f`,
        color: solid ? '#000' : color,
        fontFamily: reel.mono,
        fontWeight: 800,
        fontSize: 26,
        letterSpacing: '0.1em',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/**
 * Reel captions: one line at a time, words lighting up as they're spoken. Said
 * words are white, the current word glows, the rest wait dimmed. Words in the
 * line's highlight phrase glow in the accent colour.
 */
export function KineticCaptions({ lines, bottom = 300, size = 74 }: { lines: TimedLine[]; bottom?: number; size?: number }) {
  const frame = useCurrentFrame()
  const line = lines.find((l) => frame >= l.from && frame < l.to)
  if (!line) return null
  const words = line.text.split(/\s+/)
  // Time each word by its length; without voice, spread over most of the line.
  const speech = line.speech || (line.to - line.from) * 0.8
  const weights = words.map((w) => w.length + 2)
  const total = weights.reduce((a, b) => a + b, 0)
  const local = frame - line.from
  let acc = 0
  const starts = weights.map((w) => {
    const s = (acc / total) * speech
    acc += w
    return s
  })
  const hl = new Set((line.highlight ?? '').toLowerCase().split(/\s+/).filter(Boolean))
  const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const fadeOut = interpolate(frame, [line.to - 6, line.to], [1, 0], clamp)
  return (
    <div
      style={{
        position: 'absolute',
        left: 60,
        right: 60,
        bottom,
        textAlign: 'center',
        fontFamily: reel.sans,
        fontSize: size,
        fontWeight: 900,
        lineHeight: 1.15,
        letterSpacing: '-0.01em',
        opacity: fadeOut,
      }}
    >
      {words.map((word, i) => {
        const said = local >= starts[i]
        const current = said && (i === words.length - 1 || local < starts[i + 1])
        const key = hl.has(clean(word))
        const color = !said ? reel.dim : key ? reel.cyan : reel.text
        return (
          <span
            key={i}
            style={{
              color,
              display: 'inline-block',
              marginRight: 22,
              transform: `scale(${current ? 1.08 : 1})`,
              textShadow: current || (said && key) ? `0 0 28px ${key ? reel.cyan : '#ffffff'}aa` : 'none',
            }}
          >
            {word}
          </span>
        )
      })}
    </div>
  )
}

/** Kinetic captions plus the voice clips for a scene's lines. */
export function Voiced({ lines, bottom, size }: SceneProps & { bottom?: number; size?: number }) {
  return (
    <>
      <KineticCaptions lines={lines} bottom={bottom} size={size} />
      <VoiceClips lines={lines} />
    </>
  )
}
