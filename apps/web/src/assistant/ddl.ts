import type { CodeSnippet, Erd, Explanation } from '@structura/shared'

type Table = Erd['tables'][number]

/** Orders tables so every table comes after the tables its foreign keys reference. */
function dependencyOrder(tables: Table[]): Table[] {
  const byName = new Map(tables.map((t) => [t.name, t]))
  const done = new Set<string>()
  const out: Table[] = []
  const visit = (table: Table, path: Set<string>) => {
    if (done.has(table.name) || path.has(table.name)) return // cycles: keep original order
    path.add(table.name)
    for (const column of table.columns) {
      const target = column.fk ? byName.get(column.fk.split('.')[0]) : undefined
      if (target && target !== table) visit(target, path)
    }
    done.add(table.name)
    out.push(table)
  }
  for (const table of tables) visit(table, new Set())
  return out
}

/**
 * Index notes like "(user_id, created_at)", "unique (resource, action)" or
 * "(role_id) — who has this role" become CREATE INDEX statements.
 */
function indexSql(table: Table, note: string): string {
  const match = note.match(/^\s*(unique\s+)?\(([^)]+)\)\s*(.*)$/i)
  if (!match) return `-- index on ${table.name}: ${note}`
  const [, unique, columnList, rest] = match
  const columns = columnList.split(',').map((c) => c.trim())
  const name = `${table.name}_${columns.map((c) => c.replace(/\W+/g, '_')).join('_')}_${unique ? 'key' : 'idx'}`
  const comment = rest.replace(/^[—–-]\s*/, '').trim()
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table.name} (${columns.join(', ')});${comment ? ` -- ${comment}` : ''}`
}

/** PostgreSQL DDL for a schema, generated from the same data that draws the diagram. */
export function erdToSql(erd: Erd): string {
  return dependencyOrder(erd.tables)
    .map((table) => {
      const pks = table.columns.filter((c) => c.pk).map((c) => c.name)
      const lines = table.columns.map((column) => {
        const parts = [`  ${column.name} ${column.type}`]
        if (pks.length === 1 && column.pk) parts.push('PRIMARY KEY')
        else if (!column.nullable) parts.push('NOT NULL')
        if (column.unique && !column.pk) parts.push('UNIQUE')
        if (column.fk) {
          const [refTable, refColumn = 'id'] = column.fk.split('.')
          parts.push(`REFERENCES ${refTable} (${refColumn})`)
        }
        return parts.join(' ')
      })
      if (pks.length > 1) lines.push(`  PRIMARY KEY (${pks.join(', ')})`)
      const indexes = table.indexes.map((note) => indexSql(table, note))
      return [`CREATE TABLE ${table.name} (\n${lines.join(',\n')}\n);`, ...indexes].join('\n')
    })
    .join('\n\n')
}

/** The explanation with the generated schema SQL as its first code snippet. */
export function withSchemaSql(explanation: Explanation, erd: Erd): Explanation {
  const sql: CodeSnippet = { title: 'PostgreSQL schema (generated)', language: 'sql', source: erdToSql(erd) }
  return { ...explanation, code: [sql, ...explanation.code.filter((c) => c.title !== sql.title)] }
}
