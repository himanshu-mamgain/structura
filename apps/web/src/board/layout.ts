import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { Diagram } from '@structura/shared'
import { labelWidth, positive, tableSize, textWidth } from './measure'

const NODE_HEIGHT = 80
const LINE_HEIGHT = 30
const FRAME_TITLE_SPACE = 56

/** A node to lay out. Table nodes (database tables) list one line per column. */
type DiagramNode = Diagram['nodes'][number] & { table?: { lines: string[] } }
/** What gets laid out: a model-generated diagram, or a database schema converted to one. */
export type LayoutDiagram = Omit<Diagram, 'nodes'> & { nodes: DiagramNode[] }

export interface Placed {
  x: number
  y: number
  w: number
  h: number
}

/** Positions relative to the layout's top-left corner. */
export interface Layout {
  nodes: Map<string, Placed>
  groups: Map<string, Placed>
  w: number
  h: number
}

const finite = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

function nodeSize(node: DiagramNode) {
  if (node.table) {
    const { w, h } = tableSize(node.table.lines)
    return { width: w, height: h }
  }
  const w = labelWidth(node.label, node.shape)
  // Estimate wrapped lines for long labels, then leave room for padding.
  const lines = Math.max(1, Math.ceil(textWidth(node.label) / (w - 48)))
  let h = Math.max(NODE_HEIGHT, lines * LINE_HEIGHT + 40)
  if (node.shape !== 'rectangle') h = Math.max(h, Math.round((w * 0.5) / 8) * 8, 112)
  // ELK turns a NaN size into 0, so never hand it one.
  return { width: positive(w, 160), height: positive(h, NODE_HEIGHT) }
}

export interface LayoutOptions {
  /**
   * Width-to-height ratio of the space the diagram will be shown in. When set,
   * both flow directions are tried and the one closer to this shape is kept.
   */
  fitRatio?: number
  /** Caps the gap between layers (normally sized to fit the longest arrow label). */
  maxLayerGap?: number
}

/** Positions the graph, choosing the flow direction that best fits the space when asked to. */
export async function layout(diagram: LayoutDiagram, options: LayoutOptions = {}): Promise<Layout> {
  if (!options.fitRatio) return layoutOnce(diagram, options)
  const [right, down] = await Promise.all([layoutOnce({ ...diagram, direction: 'right' }, options), layoutOnce({ ...diagram, direction: 'down' }, options)])
  const misfit = (l: Layout) => Math.abs(Math.log(l.w / l.h / options.fitRatio!))
  return misfit(right) <= misfit(down) ? right : down
}

/** Positions the graph with ELK's layered algorithm (the classic flowchart layout). */
async function layoutOnce(diagram: LayoutDiagram, options: LayoutOptions): Promise<Layout> {
  // Loaded on demand: the layout engine is large and only needed when drawing diagrams.
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js')

  const groupIds = new Set(diagram.groups.map((g) => g.id))
  const nodeIds = new Set(diagram.nodes.map((n) => n.id))

  // Arrows back to an earlier box (a reply to the user, say) are laid out as if
  // they pointed forward, so the flow starts where the topic lists its first box.
  // Only positions come from ELK; arrows are drawn with their real direction.
  const order = new Map(diagram.nodes.map((n, i) => [n.id, i]))
  const edges: ElkExtendedEdge[] = diagram.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to)
    .map((edge, i) => ({
      id: `edge:${i}`,
      ...(order.get(edge.to)! < order.get(edge.from)! ? { sources: [edge.to], targets: [edge.from] } : { sources: [edge.from], targets: [edge.to] }),
      // Give labels real size so ELK leaves room for them between layers.
      labels: edge.label ? [{ text: edge.label, width: textWidth(edge.label) + 16, height: 28 }] : [],
    }))

  // Left to right, leave room between columns for the longest arrow label. Top to
  // bottom, labels lie across the gap, so it only needs their height.
  const widestLabel = Math.max(0, ...edges.flatMap((e) => e.labels ?? []).map((l) => l.width ?? 0))
  const layerGap =
    diagram.direction === 'down' ? '110' : String(Math.min(options.maxLayerGap ?? 360, Math.max(96, Math.ceil(widestLabel + 64))))

  const toElkNode = (node: DiagramNode): ElkNode => ({ id: node.id, ...nodeSize(node) })
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
  const laidOut = await new ELK().layout(graph)

  // Flatten to absolute positions (ELK reports children relative to their group).
  const result: Layout = { nodes: new Map(), groups: new Map(), w: positive(laidOut.width, 1), h: positive(laidOut.height, 1) }
  const place = (elk: ElkNode, ox: number, oy: number, fallback: { w: number; h: number }): Placed => ({
    x: ox + finite(elk.x),
    y: oy + finite(elk.y),
    w: positive(elk.width, fallback.w),
    h: positive(elk.height, fallback.h),
  })
  for (const child of laidOut.children ?? []) {
    if (!child.id.startsWith('group:')) {
      result.nodes.set(child.id, place(child, 0, 0, { w: 160, h: NODE_HEIGHT }))
      continue
    }
    const group = place(child, 0, 0, { w: 240, h: 160 })
    result.groups.set(child.id.slice('group:'.length), group)
    for (const grandchild of child.children ?? []) result.nodes.set(grandchild.id, place(grandchild, group.x, group.y, { w: 160, h: NODE_HEIGHT }))
  }
  return result
}
