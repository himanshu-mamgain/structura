import type { Block, ListItem, Rich } from './notesFormat'

// Turns a topic's deep notes (src/topics/notes/<id>.md) into the same blocks the
// Notion notes use, so both render with one component. It reads the small part of
// Markdown the notes are written in:
//
//   # Title                 the article's title (optional, first line)
//   ## Section              a numbered section in read mode
//   ### Sub-heading, #### smaller
//   > 💡 **TL;DR** …         a blockquote that starts with an emoji is a callout
//   > text                  a quote
//   - item / 1. item        lists; indent two spaces to nest
//   | a | b |               a table (the first row is the header)
//   ```lang … ```           code
//   ---                     a rule
//   **bold**, *italic*, `code`, [text](url)
//
// A link to /?topic=<id> (add &read for its article) stays inside the app.

export interface Markdown {
  title?: string
  blocks: Block[]
}

const EMOJI = /^(\p{Extended_Pictographic}️?)\s+/u

/** Inline text: **bold**, *italic*, `code` and [links](url), nested as far as the notes need. */
export function inline(text: string, marks = '', href?: string): Rich[] {
  const out: Rich[] = []
  let plain = ''
  const flush = () => {
    if (plain) out.push(rich(plain, marks, href))
    plain = ''
  }
  for (let i = 0; i < text.length; ) {
    const rest = text.slice(i)
    if (rest[0] === '\\' && rest.length > 1) {
      plain += rest[1]
      i += 2
      continue
    }
    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1)
      if (end > 0) {
        flush()
        out.push(rich(rest.slice(1, end), marks + 'c', href))
        i += end + 1
        continue
      }
    }
    if (rest[0] === '[' && !href) {
      const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/)
      if (link) {
        flush()
        out.push(...inline(link[1], marks, link[2]))
        i += link[0].length
        continue
      }
    }
    if (rest.startsWith('**')) {
      const end = rest.indexOf('**', 2)
      if (end > 2) {
        flush()
        out.push(...inline(rest.slice(2, end), marks + 'b', href))
        i += end + 2
        continue
      }
    }
    // A single * opens italics only before a word, so "5 * 3" and "*.md" stay as they are.
    if (rest[0] === '*' && /^\*[^\s*]/.test(rest)) {
      const end = rest.slice(1).search(/[^\s*]\*(?!\*)/)
      if (end >= 0) {
        flush()
        out.push(...inline(rest.slice(1, end + 2), marks + 'i', href))
        i += end + 3
        continue
      }
    }
    plain += rest[0]
    i++
  }
  flush()
  return out
}

function rich(text: string, marks: string, href?: string): Rich {
  const m = [...new Set(marks)].join('')
  return href ? [text, m, href] : m ? [text, m] : [text]
}

const indentOf = (line: string) => line.match(/^ */)![0].length
const LIST = /^(\s*)(?:[-*]|(\d+)\.)\s+(.*)$/
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

/** Lists from `lines` starting at `at`, nested by indentation. Returns the blocks and the next line. */
function list(lines: string[], at: number, indent: number): [Block, number] {
  const ordered = Boolean(lines[at].match(LIST)![2])
  const items: ListItem[] = []
  let i = at
  while (i < lines.length) {
    const m = lines[i].match(LIST)
    if (!m || m[1].length < indent) break
    if (m[1].length > indent) {
      // A deeper list belongs to the item before it.
      const [sub, next] = list(lines, i, m[1].length)
      const parent = items.at(-1)
      if (parent) parent.c = [...(parent.c ?? []), sub]
      i = next
      continue
    }
    if (Boolean(m[2]) !== ordered) break
    let text = m[3]
    i++
    // Wrapped lines of the same item.
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && indentOf(lines[i]) > indent) text += ' ' + lines[i++].trim()
    items.push({ r: inline(text) })
  }
  return [{ t: ordered ? 'ol' : 'ul', items }, i]
}

export function parseMarkdown(source: string): Markdown {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let title: string | undefined
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    const fence = trimmed.match(/^```(\w*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++])
      i++
      blocks.push({ t: 'code', text: body.join('\n'), lang: fence[1] || 'text' })
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      if (level === 1 && !title && !blocks.length) title = heading[2]
      else blocks.push({ t: level <= 2 ? 'h1' : level === 3 ? 'h2' : 'h3', r: inline(heading[2]) })
      i++
      continue
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) quoted.push(lines[i++].trim().replace(/^>\s?/, ''))
      const inner = parseMarkdown(quoted.join('\n')).blocks
      const first = inner[0]
      const emoji = first?.t === 'p' ? first.r[0]?.[0].match(EMOJI) : null
      if (emoji && first?.t === 'p') {
        const r = [...first.r]
        r[0] = [r[0][0].slice(emoji[0].length), r[0][1], r[0][2]] as Rich
        blocks.push({ t: 'callout', icon: emoji[1], r: r.filter(([t]) => t), c: inner.slice(1) })
      } else if (first?.t === 'p') {
        blocks.push({ t: 'quote', r: first.r, c: inner.slice(1) })
      } else {
        blocks.push(...inner)
      }
      continue
    }

    if (trimmed.startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++])
      const head = rows.length > 1 && /^\|?\s*:?-{3,}/.test(rows[1].trim())
      const body = head ? [rows[0], ...rows.slice(2)] : rows
      blocks.push({ t: 'table', head, rows: body.map((row) => cells(row).map((c) => inline(c))) })
      continue
    }

    if (LIST.test(line)) {
      const [block, next] = list(lines, i, indentOf(line))
      blocks.push(block)
      i = next
      continue
    }

    // A paragraph runs until a blank line or the start of another block.
    const text: string[] = []
    while (i < lines.length) {
      const l = lines[i].trim()
      if (!l || /^(```|#{1,4}\s|>|\||-{3,}$)/.test(l) || (text.length && LIST.test(lines[i]))) break
      text.push(l)
      i++
    }
    blocks.push({ t: 'p', r: inline(text.join(' ')) })
  }
  return { title, blocks }
}

/** The plain text of some blocks, for word counts and search. */
export function plainText(blocks: Block[]): string {
  const parts: string[] = []
  const r = (rs: Rich[]) => parts.push(rs.map(([t]) => t).join(''))
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if ('r' in b) r(b.r)
      if ('c' in b && b.c) walk(b.c)
      if ('items' in b) for (const item of b.items) (r(item.r), item.c && walk(item.c))
      if (b.t === 'code') parts.push(b.text)
      if (b.t === 'table') for (const row of b.rows) for (const cell of row) r(cell)
    }
  }
  walk(blocks)
  return parts.join(' ')
}
