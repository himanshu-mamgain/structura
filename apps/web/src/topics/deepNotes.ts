import { type Markdown, parseMarkdown } from '../learn/markdown'

// A topic's deep notes: one Markdown file per topic in ./notes/<id>.md, written like a
// study note (TL;DR, tables, real code, the mistakes people make, interview Q&As,
// sources). When a topic has one, read mode shows it as the article. Each file is its
// own chunk, loaded when the article opens.

const files = import.meta.glob<string>('./notes/*.md', { query: '?raw', import: 'default' })

const path = (id: string) => `./notes/${id}.md`

export const hasDeepNote = (id: string) => path(id) in files

export async function loadDeepNote(id: string): Promise<Markdown | null> {
  const load = files[path(id)]
  return load ? parseMarkdown(await load()) : null
}
