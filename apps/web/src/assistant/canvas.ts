import { renderPlaintextFromRichText, toRichText, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import type { CanvasAction, CanvasShape } from '@structura/shared'

// Claude's vision works best at up to ~1568px on the long edge.
const MAX_IMAGE_EDGE = 1568

function describeShape(editor: Editor, shape: TLShape): CanvasShape | null {
  const bounds = editor.getShapePageBounds(shape)
  if (!bounds) return null
  const props = shape.props as Record<string, unknown>
  const out: CanvasShape = {
    id: shape.id,
    type: shape.type,
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    w: Math.round(bounds.w),
    h: Math.round(bounds.h),
    rotation: Math.round((shape.rotation * 180) / Math.PI),
  }
  if (props.richText) {
    const text = renderPlaintextFromRichText(editor, props.richText as Parameters<typeof renderPlaintextFromRichText>[1])
    if (text) out.text = text
  }
  if (typeof props.color === 'string') out.color = props.color
  if (typeof props.fill === 'string') out.fill = props.fill
  if (typeof props.geo === 'string') out.geo = props.geo
  return out
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Snapshot of the current page: shape list plus a PNG of everything on it. */
export async function captureCanvas(editor: Editor) {
  const shapes = editor.getCurrentPageShapes()
  const described = shapes.map((s) => describeShape(editor, s)).filter((s): s is CanvasShape => s !== null)
  const bounds = editor.getCurrentPageBounds()
  if (!shapes.length || !bounds) return { shapes: described, image: null, imageBounds: null }

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bounds.w, bounds.h))
  const { blob } = await editor.toImage(shapes, { format: 'png', background: true, padding: 0, scale, pixelRatio: 1 })
  return {
    shapes: described,
    image: await blobToBase64(blob),
    imageBounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), w: Math.round(bounds.w), h: Math.round(bounds.h) },
  }
}

function textProps(text: string | null) {
  return text === null ? {} : { richText: toRichText(text) }
}

/** Applies Claude's edits as one undoable step. Returns how many were applied. */
export function applyActions(editor: Editor, actions: CanvasAction[]): number {
  if (!actions.length) return 0
  let applied = 0
  editor.markHistoryStoppingPoint('assistant')
  editor.run(() => {
    for (const action of actions) {
      try {
        if (action.op === 'delete' && action.id) {
          if (editor.getShape(action.id as TLShapeId)) {
            editor.deleteShapes([action.id as TLShapeId])
            applied++
          }
        } else if (action.op === 'update' && action.id) {
          if (applyUpdate(editor, action)) applied++
        } else if (action.op === 'create') {
          applyCreate(editor, action)
          applied++
        }
      } catch (error) {
        console.warn('Skipped assistant action', action, error)
      }
    }
  })
  return applied
}

function applyUpdate(editor: Editor, action: CanvasAction): boolean {
  const shape = editor.getShape(action.id as TLShapeId)
  if (!shape) return false
  const bounds = editor.getShapePageBounds(shape)
  const props: Record<string, unknown> = { ...textProps(action.text) }
  const has = (key: string) => key in (shape.props as object)

  if (action.color !== null && has('color')) props.color = action.color
  if (action.fill !== null && has('fill')) props.fill = action.fill
  if (action.geo !== null && has('geo')) props.geo = action.geo
  if (action.w !== null && has('w')) props.w = Math.max(1, action.w)
  if (action.h !== null && has('h')) props.h = Math.max(1, action.h)
  if (!has('richText')) delete props.richText

  // Positions are page-space bounds, so move by the difference from the current bounds.
  const dx = action.x !== null && bounds ? action.x - bounds.x : 0
  const dy = action.y !== null && bounds ? action.y - bounds.y : 0

  editor.updateShape({ id: shape.id, type: shape.type, x: shape.x + dx, y: shape.y + dy, props } as Parameters<Editor['updateShape']>[0])
  return true
}

function applyCreate(editor: Editor, action: CanvasAction) {
  const x = action.x ?? 0
  const y = action.y ?? 0
  const color = action.color ?? 'black'
  if (action.kind === 'text') {
    editor.createShape({ type: 'text', x, y, props: { color, ...textProps(action.text ?? '') } })
  } else if (action.kind === 'note') {
    editor.createShape({ type: 'note', x, y, props: { color, ...textProps(action.text ?? '') } })
  } else {
    editor.createShape({
      type: 'geo',
      x,
      y,
      props: {
        geo: action.geo ?? 'rectangle',
        w: Math.max(1, action.w ?? 160),
        h: Math.max(1, action.h ?? 96),
        color,
        fill: action.fill ?? 'none',
        ...textProps(action.text),
      },
    })
  }
}
