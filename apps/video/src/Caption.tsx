import { interpolate, useCurrentFrame } from 'remotion'
import { colors, font } from './theme'

export interface Line {
  /** Frames, relative to the scene. */
  from: number
  to: number
  text: string
  /** The phrase in `text` to colour, like the bold keyword in a reel caption. */
  highlight?: string
}

/** Big bold subtitles near the bottom, fading between lines, with one phrase highlighted. */
export function Captions({ lines }: { lines: Line[] }) {
  const frame = useCurrentFrame()
  const line = lines.find((l) => frame >= l.from && frame < l.to)
  if (!line) return null
  const opacity = interpolate(frame, [line.from, line.from + 8, line.to - 8, line.to], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const rise = interpolate(frame, [line.from, line.from + 10], [16, 0], { extrapolateRight: 'clamp' })
  const at = line.highlight ? line.text.indexOf(line.highlight) : -1
  const parts =
    at >= 0 ? [line.text.slice(0, at), line.highlight!, line.text.slice(at + line.highlight!.length)] : [line.text, '', '']
  return (
    <div
      style={{
        position: 'absolute',
        left: 70,
        right: 70,
        bottom: 250,
        opacity,
        transform: `translateY(${rise}px)`,
        textAlign: 'center',
        fontFamily: font,
        fontSize: 62,
        fontWeight: 800,
        lineHeight: 1.18,
        letterSpacing: '-0.01em',
        color: colors.text,
        // A dark outline keeps captions readable over anything, as in reels.
        WebkitTextStroke: '10px #0b0d10',
        paintOrder: 'stroke fill',
      }}
    >
      {parts[0]}
      <span style={{ color: colors.highlight }}>{parts[1]}</span>
      {parts[2]}
    </div>
  )
}
