import type { Erd } from '@structura/shared'
import type { LayoutDiagram } from './diagram'

const RELATION_LABELS: Record<Erd['relations'][number]['kind'], string> = {
  'one-to-one': '1 : 1',
  'one-to-many': 'N : 1',
  'many-to-many': 'N : M',
}

type Column = Erd['tables'][number]['columns'][number]

/** "user_id  uuid  FK → users.id", with "?" marking nullable types. */
function columnLine(column: Column, nameWidth: number): string {
  const tags = [column.pk && 'PK', column.unique && !column.pk && 'UQ', column.fk && `FK → ${column.fk}`].filter(Boolean)
  const type = `${column.type}${column.nullable ? '?' : ''}`
  return [column.name.padEnd(nameWidth), type, ...tags].join('  ').trimEnd()
}

/**
 * Turns a database schema into a diagram the builder can lay out: one table
 * node per table (columns as monospace lines), one labeled arrow per relation,
 * pointing from the table holding the foreign key to the one it references.
 */
export function erdToDiagram(erd: Erd): LayoutDiagram {
  const tableIds = new Set(erd.tables.map((t) => t.id))
  return {
    replace: erd.replace,
    direction: 'right',
    groups: [],
    nodes: erd.tables.map((table) => {
      const nameWidth = Math.max(0, ...table.columns.map((c) => c.name.length))
      const lines = [table.name, ...table.columns.map((c) => columnLine(c, nameWidth))]
      if (table.indexes.length) lines.push('', ...table.indexes.map((index) => `index ${index}`))
      return {
        id: table.id,
        label: table.name,
        shape: 'rectangle' as const,
        color: table.columns.some((c) => c.fk) ? ('blue' as const) : ('violet' as const),
        group: null,
        table: { lines },
      }
    }),
    edges: erd.relations
      .filter((r) => tableIds.has(r.from) && tableIds.has(r.to))
      .map((relation) => ({
        from: relation.from,
        to: relation.to,
        label: relation.label ? `${RELATION_LABELS[relation.kind]}  ${relation.label}` : RELATION_LABELS[relation.kind],
        dashed: false,
      })),
  }
}
