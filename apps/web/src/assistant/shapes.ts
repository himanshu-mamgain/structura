import {
  createShapeId,
  getFontFamily,
  renderPlaintextFromRichText,
  toRichText,
  type Editor,
  type TLArrowBinding,
  type TLShapeId,
} from 'tldraw'

// tldraw's geo label metrics (LABEL_FONT_SIZES and LABEL_PADDING).
const LABEL_FONT_SCALES = { s: 1.125, m: 1.375 } as const
export const LABEL_PADDING = 16
const MIN_NODE_WIDTH = 160
const MAX_NODE_WIDTH = 360

/** `value` if it's a usable size, otherwise `fallback`. tldraw rejects zero, negative and NaN sizes. */
export function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Size of one line of text in a geo label. Defaults to tldraw's default label style (size m, draw font). */
export function measureLabel(
  editor: Editor,
  text: string,
  style: { font?: 'draw' | 'mono'; size?: keyof typeof LABEL_FONT_SCALES } = {},
): { w: number; h: number } {
  const { font = 'draw', size = 'm' } = style
  const theme = editor.getCurrentTheme()
  const fontSize = positive(theme.fontSize, 16) * LABEL_FONT_SCALES[size]
  const lineHeight = positive(theme.lineHeight, 1.35)
  // Rough fallback for when the browser can't measure (fonts not ready, element not laid out).
  const estimate = { w: text.length * fontSize * 0.55, h: fontSize * lineHeight }
  try {
    const size = editor.textMeasure.measureText(text, {
      fontStyle: 'normal',
      fontWeight: 'normal',
      fontFamily: getFontFamily(theme, font),
      fontSize,
      lineHeight,
      maxWidth: null,
      padding: '0px',
    })
    return { w: positive(size.w, estimate.w), h: positive(size.h, estimate.h) }
  } catch {
    return estimate
  }
}

// Ellipses, diamonds and hexagons have less room for text than their bounding box.
const TEXT_AREA_RATIO: Record<string, number> = { ellipse: 1.3, diamond: 1.45, hexagon: 1.2, cloud: 1.35 }

/**
 * Width a geo shape needs so its label never breaks mid-word, and short
 * labels stay on one line. Long labels wrap at word boundaries.
 */
export function labelWidth(editor: Editor, text: string, geo = 'rectangle'): number {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return MIN_NODE_WIDTH
  const longestWord = Math.max(...words.map((word) => measureLabel(editor, word).w))
  const fullLine = measureLabel(editor, text).w
  const pad = LABEL_PADDING * 2 + 16
  const needed = Math.max(longestWord + pad, Math.min(fullLine + pad, MAX_NODE_WIDTH))
  const ratio = TEXT_AREA_RATIO[geo] ?? 1
  return positive(Math.ceil(Math.max(MIN_NODE_WIDTH, needed * ratio) / 8) * 8, MIN_NODE_WIDTH)
}

/** Widens a geo shape if its label would wrap mid-word. Never shrinks it. */
export function fitGeoToLabel(editor: Editor, id: TLShapeId) {
  const shape = editor.getShape(id)
  if (!shape || shape.type !== 'geo') return
  const props = shape.props as { w: number; geo: string; richText: Parameters<typeof renderPlaintextFromRichText>[1] }
  const text = renderPlaintextFromRichText(editor, props.richText)
  const w = labelWidth(editor, text, props.geo)
  if (w > props.w) editor.updateShape({ id, type: 'geo', props: { w } })
}

/** Draws a real arrow bound to both shapes, so it follows them when they move. */
export function connectShapes(
  editor: Editor,
  fromId: TLShapeId,
  toId: TLShapeId,
  opts: { label?: string | null; dashed?: boolean; color?: string } = {},
): TLShapeId | null {
  const from = editor.getShapePageBounds(fromId)
  const to = editor.getShapePageBounds(toId)
  if (!from || !to || fromId === toId) return null

  const id = createShapeId()
  editor.createShape({
    id,
    type: 'arrow',
    x: from.center.x,
    y: from.center.y,
    props: {
      start: { x: 0, y: 0 },
      end: { x: to.center.x - from.center.x, y: to.center.y - from.center.y },
      color: (opts.color ?? 'black') as 'black',
      dash: opts.dashed ? 'dashed' : 'draw',
      richText: toRichText(opts.label ?? ''),
    },
  })
  const binding = (terminal: 'start' | 'end', target: TLShapeId) => ({
    type: 'arrow' as const,
    fromId: id,
    toId: target,
    props: {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: 'none' as const,
    },
  })
  editor.createBindings<TLArrowBinding>([binding('start', fromId), binding('end', toId)])
  return id
}
