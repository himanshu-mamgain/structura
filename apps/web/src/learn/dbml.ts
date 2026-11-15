import type { CodeSnippet, Erd } from '@structura/shared'
import type { ParsedSchema, RelationInfo } from 'dbml-erd-viewer'

// A topic's data model, two ways: DBML text (to read, copy, or paste into dbdiagram.io)
// and the schema the DBML viewer draws. Both come from one reading of the Erd, so they
// always agree, and the browser never needs the DBML parser.

type Table = Erd['tables'][number]
type Column = Table['columns'][number]

interface Ref {
  from: { table: string; column: string } // the table holding the foreign key
  to: { table: string; column: string }
  oneToOne: boolean
  note: string | null // the relation's label, e.g. "places"
}

interface Model {
  tables: Table[]
  refs: Ref[]
  /** Foreign keys whose target isn't drawn: "references categories.category_id". */
  outside: Map<string, string>
  /** Links with no columns to draw them by, kept as comments: "trie_snapshots built from query_counts". */
  loose: string[]
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLAIN_TYPE = /^[A-Za-z_]\w*(\(\d+(\s*,\s*\d+)?\))?(\[\])?$/
const key = (table: string, column: string) => `${table}\u0000${column}`

function readErd(erd: Erd): Model {
  const tables = erd.tables
  const byId = new Map(tables.map((t) => [t.id, t]))
  const find = (ref: string) => byId.get(ref) ?? tables.find((t) => t.name === ref)
  const relationBetween = (a: string, b: string) =>
    erd.relations.find((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a))

  const refs: Ref[] = []
  const outside = new Map<string, string>()
  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.fk) continue
      const dot = column.fk.lastIndexOf('.')
      const target = find(column.fk.slice(0, dot))
      const targetColumn = column.fk.slice(dot + 1)
      if (!target || !target.columns.some((c) => c.name === targetColumn)) {
        outside.set(key(table.id, column.name), `references ${column.fk}`)
        continue
      }
      const relation = relationBetween(table.id, target.id)
      refs.push({
        from: { table: table.id, column: column.name },
        to: { table: target.id, column: targetColumn },
        oneToOne: relation?.kind === 'one-to-one',
        note: relation?.label ?? null,
      })
    }
  }

  // Relations no foreign key explains: link them by a shared key column if there is one.
  const loose: string[] = []
  for (const relation of erd.relations) {
    const from = byId.get(relation.from)
    const to = byId.get(relation.to)
    if (!from || !to) continue
    if (refs.some((r) => (r.from.table === from.id && r.to.table === to.id) || (r.from.table === to.id && r.to.table === from.id))) continue
    const shared = from.columns.find((c) => to.columns.some((d) => d.name === c.name && d.pk))
    if (shared) {
      refs.push({ from: { table: from.id, column: shared.name }, to: { table: to.id, column: shared.name }, oneToOne: relation.kind === 'one-to-one', note: relation.label })
    } else {
      loose.push(`${from.id} ${relation.label ?? 'relates to'} ${to.id}`)
    }
  }
  return { tables, refs, outside, loose }
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const note = (s: string) => `note: '${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const tableRef = (table: Table) => (IDENT.test(table.id) ? table.id : quote(table.id))

/** "(user_id, created_at DESC) — history" → a DBML index line, or null if it isn't a plain column index. */
function indexLine(text: string, table: Table): string | null {
  const m = text.match(/^(unique\s+)?\(([^()]+)\)\s*(unique)?\s*(.*)$/i)
  if (!m) return null
  const columns = m[2].split(',').map((c) => c.trim().replace(/\s+(asc|desc)$/i, ''))
  if (!columns.every((c) => table.columns.some((col) => col.name === c))) return null
  const settings = [(m[1] || m[3]) && 'unique', (/\b(asc|desc)\b/i.test(m[2]) || m[4]) && note(text)].filter(Boolean)
  const target = columns.length === 1 ? columns[0] : `(${columns.join(', ')})`
  return settings.length ? `${target} [${settings.join(', ')}]` : target
}

/** The Erd as DBML (https://dbml.dbdiagram.io). */
export function erdToDbml(erd: Erd): string {
  const model = readErd(erd)
  const out: string[] = []
  for (const table of model.tables) {
    const pks = table.columns.filter((c) => c.pk)
    const name = table.name === table.id && IDENT.test(table.id) ? table.id : `${quote(table.name)} as ${tableRef(table)}`
    out.push(`Table ${name} {`)
    for (const column of table.columns) {
      const ref = model.refs.find((r) => r.from.table === table.id && r.from.column === column.name)
      const target = ref && model.tables.find((t) => t.id === ref.to.table)!
      const settings = [
        column.pk && pks.length === 1 && 'pk',
        !column.pk && !column.nullable && 'not null',
        column.unique && !column.pk && 'unique',
        ref && target && !ref.oneToOne && `ref: > ${tableRef(target)}.${ref.to.column}`,
        (ref?.note || model.outside.get(key(table.id, column.name))) && note((ref?.note || model.outside.get(key(table.id, column.name)))!),
      ].filter(Boolean)
      const type = PLAIN_TYPE.test(column.type) ? column.type : quote(column.type)
      out.push(`  ${IDENT.test(column.name) ? column.name : quote(column.name)} ${type}${settings.length ? ` [${settings.join(', ')}]` : ''}`)
    }
    const indexes = pks.length > 1 ? [`(${pks.map((c) => c.name).join(', ')}) [pk]`] : []
    const comments: string[] = []
    for (const index of table.indexes) {
      const line = indexLine(index, table)
      if (line) indexes.push(line)
      else comments.push(`  // index: ${index}`)
    }
    if (indexes.length) out.push('', '  indexes {', ...indexes.map((i) => `    ${i}`), '  }')
    if (comments.length) out.push('', ...comments)
    out.push('}', '')
  }
  // One-to-one refs go on their own line: written there, the parser keeps the
  // foreign key's side first (written on the column, it would flip them).
  const byId = new Map(model.tables.map((t) => [t.id, t]))
  for (const ref of model.refs.filter((r) => r.oneToOne)) {
    out.push(`Ref: ${tableRef(byId.get(ref.from.table)!)}.${ref.from.column} - ${tableRef(byId.get(ref.to.table)!)}.${ref.to.column}`)
  }
  for (const loose of model.loose) out.push(`// ${loose}`)
  return out.join('\n').trimEnd() + '\n'
}

/** The Erd as the viewer's schema: what parsing erdToDbml(erd) gives, without the parser. */
export function erdToSchema(erd: Erd): ParsedSchema {
  const model = readErd(erd)
  const fkColumns = new Set(model.refs.map((r) => key(r.from.table, r.from.column)))
  const columnOf = (table: string, column: string) =>
    model.tables.find((t) => t.id === table)!.columns.find((c) => c.name === column)!
  return {
    tables: model.tables.map((table) => ({
      id: table.name,
      name: table.name,
      columns: table.columns.map((column: Column) => {
        const ref = model.refs.find((r) => r.from.table === table.id && r.from.column === column.name)
        const text = ref?.note || model.outside.get(key(table.id, column.name))
        return {
          name: column.name,
          type: column.type,
          pk: column.pk,
          notNull: column.pk || !column.nullable,
          unique: column.unique && !column.pk,
          increment: false,
          ...(text && { note: text }),
          isForeignKey: fkColumns.has(key(table.id, column.name)),
        }
      }),
    })),
    // In the order the parser lists them: refs written on columns, then the Ref: lines.
    relations: [...model.refs.filter((r) => !r.oneToOne), ...model.refs.filter((r) => r.oneToOne)].map((ref): RelationInfo => {
      const fromName = model.tables.find((t) => t.id === ref.from.table)!.name
      const toName = model.tables.find((t) => t.id === ref.to.table)!.name
      const fk = columnOf(ref.from.table, ref.from.column)
      return {
        id: `${fromName}.${ref.from.column}__${toName}.${ref.to.column}`,
        kind: fk.pk ? 'identifying' : 'non-identifying',
        from: { tableId: fromName, columns: [ref.from.column], relation: ref.oneToOne ? '1' : '*' },
        to: { tableId: toName, columns: [ref.to.column], relation: '1', optional: !(fk.pk || !fk.nullable) },
      }
    }),
  }
}

/** The schema code block: PostgreSQL first, and the same tables as DBML in the next tab. */
export const schemaSnippet = (sql: string, dbml: string | null): CodeSnippet => ({
  title: 'Schema',
  language: 'sql',
  source: sql,
  ...(dbml && { versions: [{ language: 'dbml', source: `// Paste this into https://dbdiagram.io to draw and edit it.\n\n${dbml}` }] }),
})
