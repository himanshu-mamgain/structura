// Text measurement for layout, using the browser's canvas text metrics.

const LABEL_FONT = '22px system-ui, sans-serif'
const TABLE_FONT = '18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const LABEL_PADDING = 16
const MIN_NODE_WIDTH = 160
const MAX_NODE_WIDTH = 360

let context: CanvasRenderingContext2D | null | undefined

/** `value` if it's a usable size, otherwise `fallback` (no zero, negative or NaN sizes). */
export const positive = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

/** Width of one line of text, in board units. */
export function textWidth(text: string, mono = false): number {
  context ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  // Rough fallback where there is no canvas (tests, server).
  const estimate = text.length * (mono ? 10.8 : 11.5)
  if (!context) return estimate
  context.font = mono ? TABLE_FONT : LABEL_FONT
  return positive(context.measureText(text).width, estimate)
}

// Ellipses, diamonds and hexagons have less room for text than their bounding box.
const TEXT_AREA_RATIO: Record<string, number> = { ellipse: 1.3, diamond: 1.45, hexagon: 1.2, cloud: 1.35 }

/** Width a box needs so short labels fit on one line and long ones wrap at word boundaries. */
export function labelWidth(text: string, shape = 'rectangle'): number {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return MIN_NODE_WIDTH
  const longestWord = Math.max(...words.map((word) => textWidth(word)))
  const pad = LABEL_PADDING * 2 + 16
  const needed = Math.max(longestWord + pad, Math.min(textWidth(text) + pad, MAX_NODE_WIDTH))
  return positive(Math.ceil(Math.max(MIN_NODE_WIDTH, needed * (TEXT_AREA_RATIO[shape] ?? 1)) / 8) * 8, MIN_NODE_WIDTH)
}

/** Footprint of a database table box: its widest column line by its line count. */
export function tableSize(lines: string[]): { w: number; h: number } {
  const widest = Math.max(...lines.map((line) => textWidth(line, true)))
  return {
    w: positive(Math.ceil((widest + LABEL_PADDING * 2 + 24) / 8) * 8, 240),
    h: positive(Math.ceil((lines.length * 26 + LABEL_PADDING * 2 + 8) / 8) * 8, 160),
  }
}
