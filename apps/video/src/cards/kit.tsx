import { createContext, type CSSProperties, type ReactNode, useContext } from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { TimedLine, Words } from '../timeline'
import { clamp, type Progress, VoiceClips } from '../ui'
import { mono, sans } from './fonts'

// The "UI card" reel look: deep navy with a faint grid, a segmented progress bar,
// a header with a live status pill, a numbered eyebrow over a big title, glowing
// cards that look like real app and terminal UI, and karaoke captions in a pill.
// Colour carries meaning: cyan normal, green done, amber unknown, red failed,
// violet active.

export const ink = {
  bg: '#060a14',
  grid: 'rgba(110, 150, 220, 0.06)',
  panel: 'rgba(12, 19, 35, 0.94)',
  inset: 'rgba(4, 8, 18, 0.85)',
  border: 'rgba(130, 160, 220, 0.2)',
  text: '#eef3fb',
  muted: '#8d9ab3',
  dim: '#55627d',
  cyan: '#3ed8f6',
  green: '#34d399',
  amber: '#fbbf24',
  red: '#ff5c74',
  violet: '#a78bfa',
}

export type Tone = 'cyan' | 'green' | 'amber' | 'red' | 'violet' | 'muted'
export const toneColor = (tone: Tone) => (tone === 'muted' ? ink.muted : ink[tone])

const normalize = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Word timings for the whole video, from the voice manifest. */
export const WordsContext = createContext<Words>(null)

/**
 * Cues for a scene's animations, in scene frames: when a line starts, or when a
 * word in it is spoken (`nth` picks a later occurrence). Animations follow the
 * voice instead of fixed frame numbers.
 */
export function useCue(lines: TimedLine[]) {
  const words = useContext(WordsContext)
  const { fps } = useVideoConfig()
  return (id: string, word?: string, nth = 0) => {
    const line = lines.find((l) => l.id === id)
    if (!line) throw new Error(`No narration line "${id}"`)
    if (!word) return line.from
    const target = normalize(word)
    const timed = words?.[id]
    if (timed) {
      const hits = timed.filter(([w]) => normalize(w) === target)
      if (hits[nth]) return line.from + Math.round(hits[nth][1] * fps)
    }
    // No timings yet: estimate from the word's place in the line.
    const list = line.text.split(/\s+/)
    const index = list.map((w, i) => (normalize(w) === target ? i : -1)).filter((i) => i >= 0)[nth] ?? 0
    return line.from + Math.round((index / list.length) * (line.speech || (line.to - line.from) * 0.8))
  }
}

/** 0 → 1 spring from `enter`. */
export function useEnter(enter: number, damping = 15) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return frame < enter ? 0 : spring({ frame: frame - enter, fps, config: { damping } })
}

// ─── Frame: background, progress, header ─────────────────────────────────────

export function NavyBackground() {
  const frame = useCurrentFrame()
  const x = 50 + Math.sin(frame / 110) * 20
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at ${x}% 42%, rgba(46, 110, 230, 0.16), transparent 50%), ${ink.bg}` }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${ink.grid} 2px, transparent 2px), linear-gradient(90deg, ${ink.grid} 2px, transparent 2px)`,
          backgroundSize: '54px 54px',
          maskImage: 'radial-gradient(ellipse at 50% 45%, black 45%, transparent 90%)',
        }}
      />
    </AbsoluteFill>
  )
}

/** One thin segment per scene along the top, filling as the video plays. */
export function SegmentBar({ progress, scenes }: { progress: Progress; scenes: number }) {
  return (
    <div style={{ position: 'absolute', top: 26, left: 36, right: 36, display: 'flex', gap: 10 }}>
      {Array.from({ length: scenes }, (_, i) => {
        const fill = i < progress.scene ? 1 : i === progress.scene ? progress.fraction : 0
        return (
          <div key={i} style={{ flex: 1, height: 7, borderRadius: 4, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
            <div style={{ width: `${fill * 100}%`, height: '100%', background: `linear-gradient(90deg, #2f7bff, ${ink.cyan})`, boxShadow: `0 0 12px ${ink.cyan}` }} />
          </div>
        )
      })}
    </div>
  )
}

/** The Structura mark (as in the app's favicon). */
export function Logo({ size = 76 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ borderRadius: size * 0.22, boxShadow: `0 0 0 2px ${ink.border}, 0 0 24px rgba(129, 140, 248, 0.35)` }}>
      <rect width="32" height="32" rx="7" fill="#1e1b4b" />
      <rect x="7" y="7" width="11" height="7" rx="1.5" fill="#a5b4fc" />
      <rect x="14" y="16" width="11" height="9" rx="1.5" fill="#818cf8" />
      <path d="M12.5 14v5.5H14" fill="none" stroke="#a5b4fc" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Header() {
  return (
    <div style={{ position: 'absolute', top: 78, left: 56, display: 'flex', alignItems: 'center', gap: 22 }}>
      <Logo />
      <div>
        <div style={{ fontFamily: sans, fontWeight: 900, fontSize: 34, letterSpacing: '0.06em', color: ink.text }}>STRUCTURA</div>
        <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 20, letterSpacing: '0.14em', color: ink.muted, marginTop: 2 }}>SYSTEM DESIGN, VISUALISED</div>
      </div>
    </div>
  )
}

/** A status at the top right that changes with the story: [cue frame, label, tone]. */
export function StatusPill({ steps }: { steps: [at: number, label: string, tone: Tone][] }) {
  const frame = useCurrentFrame()
  const index = steps.reduce((found, [at], i) => (frame >= at ? i : found), -1)
  const pop = useEnter(index >= 0 ? steps[index][0] : 0, 12)
  if (index < 0) return null
  const [, label, tone] = steps[index]
  const color = toneColor(tone)
  const blink = 0.55 + 0.45 * Math.abs(Math.sin(frame / 9))
  return (
    <div
      style={{
        position: 'absolute',
        top: 96,
        right: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 20px',
        borderRadius: 999,
        border: `2px solid ${color}`,
        background: `${color}1a`,
        boxShadow: `0 0 26px ${color}55`,
        fontFamily: mono,
        fontWeight: 800,
        fontSize: 22,
        letterSpacing: '0.08em',
        color,
        transform: `scale(${0.9 + 0.1 * pop})`,
        transformOrigin: 'right center',
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, opacity: blink, boxShadow: `0 0 10px ${color}` }} />
      {label}
    </div>
  )
}

// ─── Scene shell ─────────────────────────────────────────────────────────────

/**
 * Everything a scene has besides its cards: the numbered eyebrow, the title (an
 * optional second line in a tone), the status pill, karaoke captions and the
 * voice, and a quick fade at the end.
 */
export function CardScene({
  lines,
  number,
  eyebrow,
  title,
  accent,
  accentTone = 'red',
  status,
  children,
}: {
  lines: TimedLine[]
  number?: string
  eyebrow: string
  title: string
  accent?: string
  accentTone?: Tone
  status: [at: number, label: string, tone: Tone][]
  children: ReactNode
}) {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const t = useEnter(0, 18)
  const t2 = useEnter(8, 18)
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], clamp)
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: out }}>
        <StatusPill steps={status} />
        <div style={{ position: 'absolute', top: 214, left: 56, right: 56, opacity: t, transform: `translateY(${(1 - t) * 24}px)` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: mono, fontWeight: 700, fontSize: 27, letterSpacing: '0.16em', color: ink.cyan }}>
            {number && <span style={{ padding: '2px 12px', borderRadius: 8, border: `2px solid ${ink.cyan}88`, letterSpacing: '0.04em' }}>{number}</span>}
            {eyebrow}
          </div>
          <div style={{ marginTop: 18, fontFamily: sans, fontWeight: 900, fontSize: 78, lineHeight: 1.04, letterSpacing: '-0.025em', color: ink.text }}>{title}</div>
          {accent && (
            <div style={{ fontFamily: sans, fontWeight: 900, fontSize: 78, lineHeight: 1.04, letterSpacing: '-0.025em', color: toneColor(accentTone), opacity: t2, textShadow: `0 0 34px ${toneColor(accentTone)}55` }}>
              {accent}
            </div>
          )}
        </div>
        {children}
      </AbsoluteFill>
      {/* Captions don't fade with the scene: the last word may still be spoken. */}
      <Karaoke lines={lines} />
      <VoiceClips lines={lines} />
    </AbsoluteFill>
  )
}

// ─── Cards ───────────────────────────────────────────────────────────────────

/** A glowing panel that rises in at `enter`; the border and glow follow its tone. */
export function GlowCard({ enter, tone = 'cyan', children, style, dim = false }: { enter: number; tone?: Tone; children: ReactNode; style?: CSSProperties; dim?: boolean }) {
  const t = useEnter(enter)
  const color = toneColor(tone)
  return (
    <div
      style={{
        position: 'absolute',
        left: 56,
        right: 56,
        padding: '26px 30px',
        borderRadius: 26,
        background: ink.panel,
        border: `2.5px solid ${dim ? ink.border : color}`,
        boxShadow: dim ? 'none' : `0 0 0 1px ${color}22, 0 0 46px ${color}38, inset 0 0 40px ${color}10`,
        opacity: t * (dim ? 0.5 : 1),
        transform: `translateY(${(1 - t) * 40}px) scale(${0.97 + 0.03 * t})`,
        fontFamily: sans,
        color: ink.text,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** A small rounded label inside cards, e.g. "NO RESPONSE" or "SAFE". */
export function Chip({ tone, children, style }: { tone: Tone; children: ReactNode; style?: CSSProperties }) {
  const color = toneColor(tone)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        borderRadius: 10,
        border: `2px solid ${color}aa`,
        background: `${color}1c`,
        color,
        fontFamily: mono,
        fontWeight: 800,
        fontSize: 20,
        letterSpacing: '0.08em',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** A line of mono text, as in a terminal or a request. */
export function Mono({ children, color = ink.text, size = 26, style }: { children: ReactNode; color?: string; size?: number; style?: CSSProperties }) {
  return <div style={{ fontFamily: mono, fontWeight: 500, fontSize: size, lineHeight: 1.5, color, whiteSpace: 'pre', ...style }}>{children}</div>
}

/** A dark well inside a card, for code, logs and rows. */
export function Inset({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ marginTop: 18, padding: '16px 20px', borderRadius: 16, background: ink.inset, border: `1.5px solid ${ink.border}`, ...style }}>{children}</div>
}

/** A row that types itself in from `enter`, one character per frame-ish. */
export function Typed({ enter, text, color = ink.text, size = 26, speed = 2.2 }: { enter: number; text: string; color?: string; size?: number; speed?: number }) {
  const frame = useCurrentFrame()
  const shown = Math.max(0, Math.floor((frame - enter) * speed))
  if (frame < enter) return <Mono size={size}> </Mono>
  return (
    <Mono color={color} size={size}>
      {text.slice(0, shown)}
      {shown < text.length && <span style={{ background: color, opacity: 0.8 }}> </span>}
    </Mono>
  )
}

// ─── Captions ────────────────────────────────────────────────────────────────

/** Splits a line's timed words into on-screen chunks: up to 3 words, breaking after punctuation. */
function chunks(words: [string, number, number][]) {
  const out: [string, number, number][][] = []
  let current: [string, number, number][] = []
  for (const word of words) {
    current.push(word)
    const chars = current.reduce((n, [w]) => n + w.length + 1, 0)
    if (current.length >= 3 || chars > 18 || /[,.;:!?]$/.test(word[0])) {
      out.push(current)
      current = []
    }
  }
  if (current.length) out.push(current)
  return out
}

/**
 * Reel captions: two to three words at a time in a pill near the bottom, the
 * word being spoken glowing cyan. Uses the voice's word timings when it has them.
 */
export function Karaoke({ lines }: { lines: TimedLine[] }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const words = useContext(WordsContext)
  const line = lines.find((l) => frame >= l.from && frame < l.to)
  if (!line) return null
  const timed: [string, number, number][] =
    words?.[line.id] ??
    (() => {
      // No voice: spread the words over most of the line.
      const list = line.text.split(/\s+/)
      const span = (line.to - line.from) / fps / list.length
      return list.map((w, i) => [w, i * span * 0.85, (i + 1) * span * 0.85] as [string, number, number])
    })()
  const t = (frame - line.from) / fps
  const groups = chunks(timed)
  const index = groups.reduce((found, g, i) => (t >= g[0][1] ? i : found), 0)
  const group = groups[index]
  const pop = interpolate(t - group[0][1], [0, 0.12], [0.92, 1], clamp)
  // Long words make long chunks: shrink those so the pill stays inside the frame.
  const chars = group.reduce((n, [w]) => n + w.length + 1, 0)
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 300, display: 'flex', justifyContent: 'center' }}>
      <div
        style={{
          maxWidth: 960,
          padding: '20px 40px 22px',
          borderRadius: 28,
          background: 'rgba(8, 13, 26, 0.9)',
          border: `2px solid ${ink.border}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          textAlign: 'center',
          fontFamily: sans,
          fontWeight: 900,
          fontSize: chars > 20 ? 56 : 66,
          lineHeight: 1.12,
          letterSpacing: '-0.01em',
          textTransform: 'uppercase',
          transform: `scale(${pop})`,
        }}
      >
        {group.map(([word, start], i) => {
          const next = group[i + 1]?.[1] ?? Infinity
          const current = t >= start && t < next
          return (
            <span key={i} style={{ color: current ? ink.cyan : ink.text, textShadow: current ? `0 0 26px ${ink.cyan}, 0 0 6px ${ink.cyan}` : 'none', marginRight: i < group.length - 1 ? 18 : 0 }}>
              {word.replace(/[,.;:]$/, '')}
            </span>
          )
        })}
      </div>
    </div>
  )
}
