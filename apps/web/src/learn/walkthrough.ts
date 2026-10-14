import type { Explanation } from '@structura/shared'
import type { Board } from '../board/store'
import { boundsOf } from '../board/types'

export interface WalkStep {
  text: string
  /** The example data at this step (request, row, response), if any. */
  data: string | null
  /** Boxes (and the arrows between them) to put in focus. */
  shapeIds: string[]
}

// Board units of context kept around a step's boxes when zooming in.
const FOCUS_MARGIN = 140

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Adds the arrows that connect two of the given boxes, so the flow between them lights up too. */
function withConnectingArrows(board: Board, ids: string[]): string[] {
  const set = new Set(ids)
  return [...ids, ...board.page.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => e.id)]
}

/**
 * The steps to play: the card's end-to-end trace if it has one (each step names
 * its boxes), otherwise the numbered lines of its "Step by step" section, matched
 * to boxes by the labels they mention. A table's label is its name.
 */
export function buildSteps(board: Board, explanation: Explanation): WalkStep[] {
  const shapes = board.page.nodes
    .map((n) => ({ id: n.id, label: normalize(n.table?.lines[0] ?? n.label) }))
    .filter((s) => s.label)
  const find = (label: string) => {
    const want = normalize(label)
    return shapes.find((s) => s.label === want) ?? shapes.find((s) => s.label.includes(want) || want.includes(s.label))
  }

  if (explanation.trace?.steps.length) {
    return explanation.trace.steps.map((step) => {
      const ids = step.nodes.map(find).filter((s) => s !== undefined).map((s) => s.id)
      return { text: step.text, data: step.data, shapeIds: withConnectingArrows(board, [...new Set(ids)]) }
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
      return { text, data: null, shapeIds: withConnectingArrows(board, ids) }
    })
}

/**
 * Puts a step in focus: the 3D view dims everything else and flies to the
 * step's boxes (with some context around them). A step that names no boxes
 * shows the whole diagram.
 */
export function focusStep(board: Board, step: WalkStep) {
  const ids = new Set(step.shapeIds)
  const bounds = boundsOf(board.page.nodes.filter((n) => ids.has(n.id)))
  if (!bounds) {
    showWholeDiagram(board)
    return
  }
  board.setFocus(ids)
  board.frame(bounds, FOCUS_MARGIN)
}

/** Ends the focus and frames the whole page. */
export function showWholeDiagram(board: Board) {
  board.setFocus(null)
  board.fitAll()
}
