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

  constructor(private readonly editor: Editor) {}

  /** Draws the latest snapshot. Layouts run one at a time; stale snapshots are skipped. */
  update(diagram: LayoutDiagram): Promise<void> {
    this.pending = diagram
    this.queue = this.queue.then(() => this.flush())
    return this.queue
  }

  /** Draws the final diagram and returns how many shapes were created. */
  async finish(diagram: LayoutDiagram): Promise<number> {
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
    this.draw(diagram, laidOut)
  }

  private start(diagram: LayoutDiagram) {
    const { editor } = this
    editor.markHistoryStoppingPoint('assistant-diagram')
    const existing = editor.getCurrentPageBounds()
    this.origin = !existing
      ? { x: 0, y: 0 }
      : diagram.replace
        ? { x: existing.x, y: existing.y }
        : { x: existing.maxX + GAP_FROM_EXISTING, y: existing.y }
    if (diagram.replace) editor.deleteShapes([...editor.getCurrentPageShapeIds()])
  }

  private draw(diagram: LayoutDiagram, laidOut: ElkNode) {
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
          moves.push({ id: frameId, type: 'frame', x, y, props: { w, h } })
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

    if (moves.length) editor.animateShapes(moves, MOVE_ANIMATION)

    // Keep the growing diagram in view.
    const next = { x: origin.x, y: origin.y, w: laidOut.width ?? 0, h: laidOut.height ?? 0 }
    if (next.w !== this.bounds.w || next.h !== this.bounds.h) {
      this.bounds = next
      editor.zoomToBounds(next, { inset: 80, animation: { duration: 400 } })
    }
  }
}
