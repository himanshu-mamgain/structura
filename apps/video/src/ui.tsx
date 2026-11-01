import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, Html5Audio, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { Captions } from './Caption'
import { colors, font, HEIGHT, mono, WIDTH } from './theme'
import { type Narration, sceneFrames, sceneLines, type TimedLine, type Voice, type Words } from './timeline'

// Building blocks shared by every video: entrances, headings, callouts, cards,
// narrated captions and the scene timeline.

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export interface SceneProps {
  lines: TimedLine[]
}

export interface VideoProps extends Record<string, unknown> {
  /** Spoken seconds per line; null renders captions only. */
  voice: Voice
  /** When each word is spoken, for word-by-word captions (Kokoro voices only). */
  words?: Words
}

/** Fades and slides children in at `enter` (scene frames). */
export function Appear({ enter, children, style }: { enter: number; children: ReactNode; style?: CSSProperties }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = spring({ frame: frame - enter, fps, config: { damping: 16 } })
  return <div style={{ ...style, opacity: frame < enter ? 0 : t, transform: `translateY(${(1 - t) * 30}px)` }}>{children}</div>
}

export function Heading({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <Appear enter={0} style={{ position: 'absolute', top: 150, left: 80, right: 80, fontFamily: font, color: colors.text }}>
      <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.02em' }}>{children}</div>
      {sub && <div style={{ marginTop: 18, fontSize: 36, color: colors.muted, fontWeight: 500 }}>{sub}</div>}
    </Appear>
  )
}

/** A dark callout card with a big number, like "16 mph · usual here: 65". */
export function Callout({ enter, x, y, big, unit, small, hot }: { enter: number; x: number; y: number; big: string; unit: string; small: string; hot?: boolean }) {
  return (
    <Appear enter={enter} style={{ position: 'absolute', left: x, top: y }}>
      <div
        style={{
          padding: '18px 26px 20px',
          borderRadius: 22,
          background: hot ? 'rgba(80, 18, 22, 0.94)' : colors.card,
          border: `2px solid ${hot ? 'rgba(248, 113, 113, 0.8)' : 'rgba(255, 255, 255, 0.14)'}`,
          color: colors.text,
          fontFamily: font,
          boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
        }}
      >
        <span style={{ fontSize: 64, fontWeight: 800, letterSpacing: '-0.02em' }}>{big}</span>
        <span style={{ fontSize: 30, fontWeight: 600, marginLeft: 10 }}>{unit}</span>
        <div style={{ marginTop: 6, fontFamily: mono, fontSize: 24, color: 'rgba(255,255,255,0.72)' }}>{small}</div>
      </div>
    </Appear>
  )
}

/** A bordered card with a title and bullet points that appear one by one. */
export function Card({ enter, title, color, items }: { enter: number; title: string; color: string; items: string[] }) {
  return (
    <Appear enter={enter} style={{ padding: '30px 36px', borderRadius: 28, background: 'rgba(15, 17, 21, 0.75)', border: `3px solid ${color}`, marginBottom: 34 }}>
      <div style={{ fontSize: 48, fontWeight: 800, color }}>{title}</div>
      {items.map((item, i) => (
        <Appear key={item} enter={enter + 12 + i * 12}>
          <div style={{ fontSize: 36, marginTop: 14 }}>• {item}</div>
        </Appear>
      ))}
    </Appear>
  )
}

export function Background() {
  return <AbsoluteFill style={{ background: `linear-gradient(${colors.backgroundTop}, ${colors.background} 55%)` }} />
}

/** Full-frame SVG canvas for drawn scenes. */
export function Svg({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0, ...style }}>
      {children}
    </svg>
  )
}

/** The scene's captions, each with its voice clip when the narration has been generated. */
export function Narrated({ lines }: SceneProps) {
  return (
    <>
      <Captions lines={lines} />
      <VoiceClips lines={lines} />
    </>
  )
}

/** Plays each line's voice clip at the line's start. */
export function VoiceClips({ lines }: SceneProps) {
  return (
    <>
      {lines.map(
        (line) =>
          line.audio && (
            <Sequence key={line.id} from={line.from} durationInFrames={line.to - line.from} layout="none">
              <Html5Audio src={staticFile(line.audio)} />
            </Sequence>
          ),
      )}
    </>
  )
}

/** A scene: its component, planned frames, and its key in the narration file (null if silent). */
export type Scene = [component: (props: SceneProps) => ReactNode, frames: number, narration: string | null]

/** Total length in frames, with every scene stretched to fit its narration. */
export function totalFrames(video: string, narration: Narration, scenes: Scene[], voice: Voice): number {
  return scenes.reduce((total, [, planned, key]) => total + sceneFrames(video, narration, key, planned, voice), 0)
}

/** Where the video is: which scene, and how far through it (0–1). Drives overlays like a chapter bar. */
export interface Progress {
  scene: number
  fraction: number
}

/** Plays the scenes back to back over a background, with an optional overlay drawn on top of every scene. */
export function Timeline({
  video,
  narration,
  scenes,
  voice,
  background = <Background />,
  overlay,
}: {
  video: string
  narration: Narration
  scenes: Scene[]
  voice: Voice
  background?: ReactNode
  overlay?: (progress: Progress) => ReactNode
}) {
  const frame = useCurrentFrame()
  const lengths = scenes.map(([, planned, key]) => sceneFrames(video, narration, key, planned, voice))
  let start = 0
  let progress: Progress = { scene: scenes.length - 1, fraction: 1 }
  for (let i = 0; i < lengths.length; i++) {
    if (frame < start + lengths[i]) {
      progress = { scene: i, fraction: (frame - start) / lengths[i] }
      break
    }
    start += lengths[i]
  }
  let from = 0
  return (
    <AbsoluteFill style={{ background: colors.background }}>
      {background}
      {scenes.map(([Component, planned, key]) => {
        const start = from
        const frames = sceneFrames(video, narration, key, planned, voice)
        from += frames
        return (
          <Sequence key={start} from={start} durationInFrames={frames}>
            <Component lines={key ? sceneLines(video, narration, key, voice) : []} />
          </Sequence>
        )
      })}
      {overlay?.(progress)}
    </AbsoluteFill>
  )
}
