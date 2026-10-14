import { createShapeId, toRichText, type Editor, type TLRichText, type TLShapeId, type TLShapePartial } from 'tldraw'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { Diagram } from '@structura/shared'
import { connectShapes, LABEL_PADDING, labelWidth, measureLabel, positive } from './shapes'

const NODE_HEIGHT = 80
const LINE_HEIGHT = 30
const FRAME_TITLE_SPACE = 56
const GAP_FROM_EXISTING = 160
const MOVE_ANIMATION = { animation: { duration: 300 } }

/** A node to draw. Table nodes (database tables) list one line per column. */
type DiagramNode = Diagram['nodes'][number] & { table?: { lines: string[] } }
/** What the builder draws: a model-generated diagram, or a database schema converted to one. */
export type LayoutDiagram = Omit<Diagram, 'nodes'> & { nodes: DiagramNode[] }

// Tables read like code: monospace, smaller, top-left aligned.
const TABLE_STYLE = { font: 'mono', size: 's', align: 'start', verticalAlign: 'start' } as const
const TABLE_TEXT = { font: 'mono', size: 's' } as const

/** Table name in bold on the first line, then one line per column. */
function tableRichText(lines: string[]): TLRichText {
  return {
    type: 'doc',
    content: lines.map((line, i) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line, ...(i === 0 ? { marks: [{ type: 'bold' }] } : {}) }] : [],
    })),
  }
}

const finite = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

function nodeSize(editor: Editor, node: DiagramNode) {
  if (node.table) {
    const widest = Math.max(...node.table.lines.map((line) => measureLabel(editor, line, TABLE_TEXT).w))
    const lineHeight = measureLabel(editor, 'Mg', TABLE_TEXT).h
    const w = Math.ceil((widest + LABEL_PADDING * 2 + 24) / 8) * 8
    const h = Math.ceil((node.table.lines.length * lineHeight + LABEL_PADDING * 2 + 8) / 8) * 8
    return { width: positive(w, 240), height: positive(h, 160) }
  }
  const w = labelWidth(editor, node.label, node.shape)
  // Estimate wrapped lines for long labels, then leave room for the shape's padding.
  const lines = Math.max(1, Math.ceil(measureLabel(editor, node.label).w / (w - 48)))
  let h = Math.max(NODE_HEIGHT, lines * LINE_HEIGHT + 40)
  if (node.shape !== 'rectangle') h = Math.max(h, Math.round((w * 0.5) / 8) * 8, 112)
  // ELK turns a NaN size into 0, which tldraw rejects, so never hand it one.
  return { width: positive(w, 160), height: positive(h, NODE_HEIGHT) }
}

/** Positions the graph with ELK's layered algorithm (the classic flowchart layout). */
async function layout(editor: Editor, diagram: LayoutDiagram): Promise<ElkNode> {
  // Loaded on demand: the layout engine is large and only needed when drawing diagrams.
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js')

  const groupIds = new Set(diagram.groups.map((g) => g.id))
  const nodeIds = new Set(diagram.nodes.map((n) => n.id))

  const edges: ElkExtendedEdge[] = diagram.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to)
    .map((edge, i) => ({
      id: `edge:${i}`,
      sources: [edge.from],
      targets: [edge.to],
      // Give labels real size so ELK leaves room for them between layers.
      labels: edge.label ? [{ text: edge.label, width: measureLabel(editor, edge.label).w + 16, height: 28 }] : [],
    }))

  // tldraw wraps an arrow's label to the arrow's length, so the gap between
  // columns must fit the longest label on one line ("approved", not "approve/d").
  const widestLabel = Math.max(0, ...edges.flatMap((e) => e.labels ?? []).map((l) => l.width ?? 0))
  const layerGap = String(Math.min(360, Math.max(96, Math.ceil(widestLabel + 64))))

  const toElkNode = (node: DiagramNode): ElkNode => ({ id: node.id, ...nodeSize(editor, node) })
  const groups: ElkNode[] = diagram.groups.map((group) => ({
    id: `group:${group.id}`,
    layoutOptions: {
      'elk.padding': `[top=${FRAME_TITLE_SPACE},left=32,bottom=32,right=32]`,
      'elk.layered.spacing.nodeNodeBetweenLayers': layerGap,
    },
    children: diagram.nodes.filter((n) => n.group === group.id).map(toElkNode),
  }))
  const ungrouped = diagram.nodes.filter((n) => !n.group || !groupIds.has(n.group)).map(toElkNode)

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': diagram.direction === 'down' ? 'DOWN' : 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '56',
      'elk.layered.spacing.nodeNodeBetweenLayers': layerGap,
      'elk.spacing.edgeLabel': '8',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: [...groups.filter((g) => g.children?.length), ...ungrouped],
    edges,
  }
  return new ELK().layout(graph)
}

/**
 * Zooms so `bounds` fits the part of the screen not covered on the left
 * (`leftInset` screen pixels, e.g. by the explanation card).
 */
export function fitBeside(editor: Editor, bounds: { x: number; y: number; w: number; h: number }, leftInset = 0) {
  const screen = editor.getViewportScreenBounds()
  const inset = 64
  const left = Math.min(Math.max(0, leftInset), screen.w / 2)
  const availW = screen.w - left - inset * 2
  const availH = screen.h - inset * 2
  if (availW <= 0 || availH <= 0 || bounds.w <= 0 || bounds.h <= 0) return
  const z = Math.min(1, availW / bounds.w, availH / bounds.h)
  // tldraw's camera maps page to screen as (page + camera) * zoom.
  const screenX = left + inset + (availW - bounds.w * z) / 2
  const screenY = inset + (availH - bounds.h * z) / 2
  editor.setCamera({ x: screenX / z - bounds.x, y: screenY / z - bounds.y, z }, { animation: { duration: 400 } })
}

/**
 * Draws a diagram while it is still being generated. Each update re-lays out
 * everything received so far: new shapes appear, existing ones glide to their
 * new positions, and arrows attach once both ends exist. The whole build is
 * one undo step.
 */
export class DiagramBuilder {
  private readonly nodeShapes = new Map<string, TLShapeId>()
  private readonly frames = new Map<string, TLShapeId>()
  private readonly drawnEdges = new Set<string>()
  private origin: { x: number; y: number } | null = null
  private pending: LayoutDiagram | null = null
  private queue: Promise<void> = Promise.resolve()
  private bounds = { x: 0, y: 0, w: 0, h: 0 }
  private created = 0
  private finishing = false

  /**
   * @param leftInset - Screen pixels covered on the left (e.g. by the explanation
   *   card), so the final zoom fits the diagram into the visible area.
   * @param place - Where a diagram that doesn't replace the canvas goes: beside
   *   the existing shapes (default) or below them.
   */
  constructor(
    private readonly editor: Editor,
    private readonly leftInset: () => number = () => 0,
    private readonly place: 'right' | 'below' = 'right',
  ) {}

  /** Draws the latest snapshot. Layouts run one at a time; stale snapshots are skipped. */
  update(diagram: LayoutDiagram): Promise<void> {
    this.pending = diagram
    this.queue = this.queue.then(() => this.flush())
    return this.queue
  }

  /** Draws the final diagram, settles every shape in its final place, and returns how many shapes were created. */
  async finish(diagram: LayoutDiagram): Promise<number> {
    this.finishing = true
    await this.update(diagram)
    return this.created
  }

  private async flush() {
    const diagram = this.pending
    if (!diagram?.nodes.length) return
    this.pending = null
    const laidOut = await layout(this.editor, diagram)
    // A newer snapshot arrived while laying out; draw that one instead.
    if (this.pending) return
    this.draw(diagram, laidOut, this.finishing)
  }

  private fitView(bounds: { x: number; y: number; w: number; h: number }) {
    fitBeside(this.editor, bounds, this.leftInset())
  }

  private start(diagram: LayoutDiagram) {
    const { editor } = this
    editor.markHistoryStoppingPoint('assistant-diagram')
    const existing = editor.getCurrentPageBounds()
    this.origin = !existing
      ? { x: 0, y: 0 }
      : diagram.replace
        ? { x: existing.x, y: existing.y }
        : this.place === 'below'
          ? { x: existing.x, y: existing.maxY + GAP_FROM_EXISTING }
          : { x: existing.maxX + GAP_FROM_EXISTING, y: existing.y }
    if (diagram.replace) editor.deleteShapes([...editor.getCurrentPageShapeIds()])
  }

  /**
   * @param settle - Final draw: put every shape exactly in place (no animation),
   *   so nothing is left mid-animation if the tab was hidden or updates overlapped.
   */
  private draw(diagram: LayoutDiagram, laidOut: ElkNode, settle: boolean) {
    const { editor } = this
    if (!this.origin) this.start(diagram)
    const origin = this.origin!
    const nodesById = new Map(diagram.nodes.map((n) => [n.id, n]))
    const groupLabels = new Map(diagram.groups.map((g) => [`group:${g.id}`, g.label]))
    const moves: TLShapePartial[] = []

    const placeNode = (elk: ElkNode, parentId: TLShapeId | undefined, offset: { x: number; y: number }) => {
      const node = nodesById.get(elk.id)
      if (!node) return
      const x = offset.x + finite(elk.x)
      const y = offset.y + finite(elk.y)
      const existingId = this.nodeShapes.get(node.id)
      if (existingId) {
        moves.push({ id: existingId, type: 'geo', x, y })
        return
      }
      const id = createShapeId()
      editor.createShape({
        id,
        type: 'geo',
        parentId,
        x,
        y,
        props: {
          geo: node.shape,
          w: positive(elk.width, 160),
          h: positive(elk.height, NODE_HEIGHT),
          color: node.color,
          fill: 'semi',
          ...(node.table
            ? { ...TABLE_STYLE, richText: tableRichText(node.table.lines) }
            : { richText: toRichText(node.label) }),
        },
      })
      this.nodeShapes.set(node.id, id)
      this.created++
    }

    editor.run(() => {
      for (const child of laidOut.children ?? []) {
        if (!child.id.startsWith('group:')) {
          placeNode(child, undefined, origin)
          continue
        }
        const x = origin.x + finite(child.x)
        const y = origin.y + finite(child.y)
        const w = positive(child.width, 240)
        const h = positive(child.height, 160)
        let frameId = this.frames.get(child.id)
        if (frameId) {
          // Frames clip their children, so their size is applied immediately, never
          // animated: a frame left too small would hide the boxes inside it.
          editor.updateShape({ id: frameId, type: 'frame', x, y, props: { w, h } })
        } else {
          frameId = createShapeId()
          editor.createShape({ id: frameId, type: 'frame', x, y, props: { w, h, name: groupLabels.get(child.id) ?? '' } })
          this.frames.set(child.id, frameId)
          this.created++
        }
        // Children of a frame are positioned relative to it, which is also how ELK reports them.
        for (const grandchild of child.children ?? []) placeNode(grandchild, frameId, { x: 0, y: 0 })
      }

      diagram.edges.forEach((edge, i) => {
        const key = `${i}:${edge.from}->${edge.to}`
        const from = this.nodeShapes.get(edge.from)
        const to = this.nodeShapes.get(edge.to)
        if (this.drawnEdges.has(key) || !from || !to) return
        if (connectShapes(editor, from, to, { label: edge.label, dashed: edge.dashed })) this.created++
        this.drawnEdges.add(key)
      })
    })

    // Updating a shape directly also cancels any animation still running on it.
    if (settle) editor.updateShapes(moves)
    else if (moves.length) editor.animateShapes(moves, MOVE_ANIMATION)

    // Keep the growing diagram in view.
    const next = { x: origin.x, y: origin.y, w: positive(laidOut.width, 1), h: positive(laidOut.height, 1) }
    if (settle || next.w !== this.bounds.w || next.h !== this.bounds.h) {
      this.bounds = next
      this.fitView(next)
    }
  }
}
