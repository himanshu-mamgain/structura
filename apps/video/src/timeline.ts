import type { Line } from './Caption'
import { FPS } from './theme'

/** One caption line of a narration file (src/narration/<video>.json). */
export interface NarrationLine {
  id: string
  text: string
  /** Spoken form where the caption reads badly aloud (VMs → "V Ms"). */
  say?: string
  highlight?: string
  /** Planned frames on screen; the voice can only stretch this. */
  frames: number
}

export interface Narration {
  voice: string
  /** Kokoro voices only: speaking speed (1 is the voice's natural pace). */
  speed?: number
  /** Frames of silence after each spoken line (default 14). Reels keep it tight. */
  gap?: number
  scenes: Record<string, NarrationLine[]>
}

/** Seconds of speech per line id, from public/voice/<video>/manifest.json (null when not generated). */
export type Voice = Record<string, number> | null

/** When each caption word is spoken, per line id: [word, start s, end s] (Kokoro voices only). */
export type Words = Record<string, [word: string, start: number, end: number][]> | null

export interface TimedLine extends Line {
  id: string
  /** The line's voice clip under public/, when it has one. */
  audio?: string
  /** Frames of actual speech (0 without voice), for word-by-word captions. */
  speech: number
}

/** Frames of silence after each spoken line before the caption changes. */
const GAP = 14

/**
 * Times a scene's captions. Each line keeps its planned start (the animations are
 * tuned to it) but is pushed later if the line before is still being spoken, and
 * stays up at least as long as its own voice clip.
 */
export function sceneLines(video: string, narration: Narration, scene: string, voice: Voice): TimedLine[] {
  let planned = 0
  let previousEnd = 0
  return narration.scenes[scene].map((line) => {
    const from = Math.max(planned, previousEnd)
    const gap = narration.gap ?? GAP
    const spoken = voice?.[line.id] ? Math.ceil(voice[line.id] * FPS) + gap : 0
    const to = from + Math.max(line.frames, spoken)
    planned += line.frames
    previousEnd = to
    return { id: line.id, audio: spoken > 0 ? `voice/${video}/${line.id}.wav` : undefined, speech: spoken > 0 ? spoken - gap : 0, from, to, text: line.text, highlight: line.highlight }
  })
}

/** A scene's length: its planned minimum, stretched to fit its narration. */
export function sceneFrames(video: string, narration: Narration, scene: string | null, planned: number, voice: Voice): number {
  if (!scene) return planned
  const lines = sceneLines(video, narration, scene, voice)
  return Math.max(planned, lines[lines.length - 1].to)
}
