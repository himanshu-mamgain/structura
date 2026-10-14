import { renderPlaintextFromRichText, type Editor, type TLArrowBinding, type TLShapeId, type TLShapePartial } from 'tldraw'
import { fitBeside } from './diagram'
import type { Explanation } from '@structura/shared'

export interface WalkStep {
  text: string
  /** The example data at this step (request, row, response), if any. */
  data: string | null
  /** Boxes (and the arrows between them) to highlight. */
  shapeIds: TLShapeId[]
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Labels of the boxes on the current page; a table's label is its first line (the table name). */
function labelledShapes(editor: Editor) {
  return editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type === 'geo')
    .map((shape) => {
      const text = renderPlaintextFromRichText(editor, (shape.props as { richText: Parameters<typeof renderPlaintextFromRichText>[1] }).richText)
      return { id: shape.id, label: normalize(text.split('\n')[0] ?? '') }
    })
    .filter((s) => s.label)
}

/** Adds the arrows that connect two of the given boxes, so the flow between them lights up too. */
function withConnectingArrows(editor: Editor, ids: TLShapeId[]): TLShapeId[] {
  const set = new Set(ids)
  const arrows = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type === 'arrow')
    .filter((arrow) => {
      const ends = editor.getBindingsFromShape<TLArrowBinding>(arrow, 'arrow').map((b) => b.toId)
      return ends.length === 2 && ends.every((id) => set.has(id))
    })
    .map((arrow) => arrow.id)
  return [...ids, ...arrows]
}

/**
 * The steps to play: the card's end-to-end trace if it has one (each step names
 * its boxes), otherwise the numbered lines of its "Step by step" section, matched
 * to boxes by the labels they mention.
 */
export function buildSteps(editor: Editor, explanation: Explanation): WalkStep[] {
  const shapes = labelledShapes(editor)
  const find = (label: string) => {
    const want = normalize(label)
    return shapes.find((s) => s.label === want) ?? shapes.find((s) => s.label.includes(want) || want.includes(s.label))
  }

  if (explanation.trace?.steps.length) {
    return explanation.trace.steps.map((step) => {
      const ids = step.nodes.map(find).filter((s) => s !== undefined).map((s) => s.id)
      return { text: step.text, data: step.data, shapeIds: withConnectingArrows(editor, [...new Set(ids)]) }
    })
  }

  const section = explanation.sections.find((s) => /step/i.test(s.heading))
  if (!section) return []
  // Longest labels first, so "Redis Cache" wins over a shorter label it contains.
  const byLength = [...shapes].sort((a, b) => b.label.length - a.label.length)
  return section.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+[.)]\s/.test(line))
    .map((line) => {
      const text = line.replace(/^\d+[.)]\s*/, '')
      const lower = normalize(text)
      const ids = byLength.filter((s) => s.label.length > 2 && lower.includes(s.label)).map((s) => s.id)
      return { text, data: null, shapeIds: withConnectingArrows(editor, ids) }
    })
}

// How visible the shapes outside the current step are.
const DIM = 0.15
// Page-space margin kept around a step's shapes when zooming in, for context.
const FOCUS_MARGIN = 140

/**
 * Dims everything except the current step's shapes. Opacity changes skip the
 * undo history, and clear() restores every shape's original opacity.
 *
 * tldraw multiplies a shape's opacity by its parents', so frames that contain
 * focused shapes stay fully visible (with their other children dimmed one by
 * one), and frames with nothing focused are dimmed as a whole.
 */
export class Spotlight {
  private readonly original = new Map<TLShapeId, number>()

  constructor(private readonly editor: Editor) {}

  focus(ids: TLShapeId[]) {
    const { editor } = this
    const focused = new Set(ids)
    const keep = new Set<TLShapeId>(ids)
    for (const id of ids) for (const ancestor of editor.getShapeAncestors(id)) keep.add(ancestor.id)

    const updates: TLShapePartial[] = []
    const set = (id: TLShapeId, factor: number) => {
      const shape = editor.getShape(id)
      if (!shape) return
      if (!this.original.has(id)) this.original.set(id, shape.opacity)
      const opacity = this.original.get(id)! * factor
      if (shape.opacity !== opacity) updates.push({ id, type: shape.type, opacity })
    }
    const restoreSubtree = (id: TLShapeId) => {
      for (const child of editor.getSortedChildIdsForParent(id)) {
        set(child, 1)
        restoreSubtree(child)
      }
    }
    const visit = (id: TLShapeId) => {
      if (focused.has(id)) {
        set(id, 1)
        restoreSubtree(id)
      } else if (keep.has(id)) {
        set(id, 1)
        for (const child of editor.getSortedChildIdsForParent(id)) visit(child)
      } else {
        set(id, DIM)
        restoreSubtree(id) // children inherit this shape's dimming
      }
    }
    for (const id of editor.getSortedChildIdsForParent(editor.getCurrentPageId())) visit(id)
    if (updates.length) editor.run(() => editor.updateShapes(updates), { history: 'ignore' })
  }

  clear() {
    const { editor } = this
    const updates = [...this.original]
      .map(([id, opacity]): TLShapePartial | null => {
        const shape = editor.getShape(id)
        return shape && shape.opacity !== opacity ? { id, type: shape.type, opacity } : null
      })
      .filter((u): u is TLShapePartial => u !== null)
    this.original.clear()
    if (updates.length) editor.run(() => editor.updateShapes(updates), { history: 'ignore' })
  }
}

/**
 * Puts a step in focus: dims everything else and zooms to its shapes (with some
 * context around them), beside the explanation card. A step that names no
 * shapes shows the whole diagram.
 */
export function focusStep(editor: Editor, spotlight: Spotlight, step: WalkStep, leftInset: number) {
  editor.selectNone()
  const ids = step.shapeIds.filter((id) => editor.getShape(id))
  const bounds = ids.length ? editor.getShapesPageBounds(ids) : null
  if (!bounds) {
    spotlight.clear()
    showWholeDiagram(editor, leftInset)
    return
  }
  spotlight.focus(ids)
  fitBeside(
    editor,
    { x: bounds.x - FOCUS_MARGIN, y: bounds.y - FOCUS_MARGIN, w: bounds.w + FOCUS_MARGIN * 2, h: bounds.h + FOCUS_MARGIN * 2 },
    leftInset,
  )
}

/** Zooms out to the whole page, beside the explanation card. */
export function showWholeDiagram(editor: Editor, leftInset: number) {
  const bounds = editor.getCurrentPageBounds()
  if (bounds) fitBeside(editor, bounds, leftInset)
}
