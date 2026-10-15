import type { Board } from './store'
import { layout, type LayoutDiagram } from './layout'
import { newId, type BoardEdge, type BoardFrame, type BoardNode, type ShapeColor } from './types'

const GAP_FROM_EXISTING = 160

/**
 * Draws a diagram on the board while it is still being generated. Each update
 * re-lays out everything received so far and replaces what this builder drew
 * before; the 3D view animates boxes to their new places. One undo step.
 */
export class DiagramBuilder {
  /** Prefix for this build's ids, so its items can be replaced without touching others. */
  private readonly prefix = newId('d')
  private origin: { x: number; y: number } | null = null
  private pending: LayoutDiagram | null = null
  private queue: Promise<void> = Promise.resolve()
  private created = 0
  private lastSize = ''

  /** @param place - Where a diagram that doesn't replace the page goes: beside existing shapes or below them. */
  constructor(
    private readonly board: Board,
    private readonly place: 'right' | 'below' = 'right',
  ) {}

  /** Draws the latest snapshot. Layouts run one at a time; stale snapshots are skipped. */
  update(diagram: LayoutDiagram): Promise<void> {
    this.pending = diagram
    this.queue = this.queue.then(() => this.flush(false))
    return this.queue
  }

  /** Draws the final diagram and returns how many shapes it created. */
  async finish(diagram: LayoutDiagram): Promise<number> {
    this.pending = diagram
    this.queue = this.queue.then(() => this.flush(true))
    await this.queue
    return this.created
  }

  private async flush(final: boolean) {
    const diagram = this.pending
    if (!diagram?.nodes.length) return
    this.pending = null
    const placed = await layout(diagram)
    // A newer snapshot arrived while laying out; draw that one instead.
    if (this.pending && !final) return
    this.draw(diagram, placed, final)
  }

  private start(diagram: LayoutDiagram) {
    const { board } = this
    board.mark()
    const existing = board.contentBounds()
    if (diagram.replace || !existing) {
      this.origin = existing ? { x: existing.x, y: existing.y } : { x: 0, y: 0 }
      if (diagram.replace) board.update((page) => ({ ...page, nodes: [], frames: [], edges: [] }))
    } else {
      this.origin =
        this.place === 'below'
          ? { x: existing.x, y: existing.y + existing.h + GAP_FROM_EXISTING }
          : { x: existing.x + existing.w + GAP_FROM_EXISTING, y: existing.y }
    }
  }

  private draw(diagram: LayoutDiagram, placed: Awaited<ReturnType<typeof layout>>, final: boolean) {
    if (!this.origin) this.start(diagram)
    const { x: ox, y: oy } = this.origin!
    const id = (modelId: string) => `${this.prefix}:${modelId}`

    const frames: BoardFrame[] = diagram.groups.flatMap((group) => {
      const p = placed.groups.get(group.id)
      return p ? [{ id: id(`g:${group.id}`), label: group.label, x: ox + p.x, y: oy + p.y, w: p.w, h: p.h }] : []
    })
    const nodes: BoardNode[] = diagram.nodes.flatMap((node) => {
      const p = placed.nodes.get(node.id)
      if (!p) return []
      return [
        {
          id: id(node.id),
          label: node.label,
          shape: node.shape,
          color: node.color as ShapeColor,
          group: node.group && placed.groups.has(node.group) ? id(`g:${node.group}`) : null,
          x: ox + p.x,
          y: oy + p.y,
          w: p.w,
          h: p.h,
          ...(node.table ? { table: node.table } : {}),
        },
      ]
    })
    const drawn = new Set(nodes.map((n) => n.id))
    const edges: BoardEdge[] = diagram.edges.flatMap((edge, i) =>
      drawn.has(id(edge.from)) && drawn.has(id(edge.to)) && edge.from !== edge.to
        ? [{ id: id(`e:${i}`), from: id(edge.from), to: id(edge.to), label: edge.label, dashed: edge.dashed }]
        : [],
    )

    const mine = (item: { id: string }) => item.id.startsWith(`${this.prefix}:`)
    this.board.update((page) => ({
      ...page,
      nodes: [...page.nodes.filter((n) => !mine(n)), ...nodes],
      frames: [...page.frames.filter((f) => !mine(f)), ...frames],
      edges: [...page.edges.filter((e) => !mine(e)), ...edges],
    }))
    this.created = nodes.length + frames.length + edges.length

    // Keep the growing diagram in view.
    const size = `${placed.w}x${placed.h}`
    if (final || size !== this.lastSize) {
      this.lastSize = size
      this.board.frame({ x: ox, y: oy, w: placed.w, h: placed.h })
    }
  }
}
