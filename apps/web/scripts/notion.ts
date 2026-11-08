// Builds the owner's Notion notes into the site, after `vite build`:
// dist/notion/index.json lists them and dist/notion/<id>.json holds each one,
// with images saved beside them (Notion's own image links expire after an hour).
// The app shows them in Explore, on matching topics, and in a reader.
//
// Needs, in Netlify's environment variables (or the shell):
//   NOTION_TOKEN          an internal integration's secret (notion.so/profile/integrations)
//   NOTION_ROOT_PAGE_ID   the page whose sub-pages are the notes (its id or URL);
//                         share it with the integration (••• → Connections)
//   NOTION_PASSPHRASE     optional but recommended: the site is public, so with this
//                         every file is encrypted and the app asks for it once
//   NOTION_EXCLUDE        optional: comma-separated titles (or ids) to leave out
// Without a token it does nothing, and the app hides notes. A Notion error never
// fails the build: the deploy just goes out without notes, and the log says why.
//
//   npx tsx scripts/notion.ts   (run by `npm run build`)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Block,
  deriveKey,
  type ListItem,
  type NoteFile,
  type NoteMeta,
  type NotesIndex,
  PBKDF2_ITERATIONS,
  type PublishedIndex,
  type Rich,
  saltFor,
  seal,
  toBase64,
} from '../src/learn/notesFormat'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../dist/notion')
// node_modules survives between Netlify builds, so unchanged pages aren't fetched again.
const CACHE = join(here, '../../../node_modules/.cache/structura-notion')
const API = process.env.NOTION_API ?? 'https://api.notion.com/v1'
const MAX_DEPTH = 3
const MAX_IMAGE = 8 * 1024 * 1024

// ─── The Notion API, about three requests a second ───────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
interface RawBlock {
  id: string
  type: string
  has_children: boolean
  [type: string]: Json
  kids?: RawBlock[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let slot = 0
let requests = 0

async function api(token: string, path: string): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    // Each call takes the next free slot, 340 ms apart, however many run at once.
    const at = Math.max(slot, Date.now())
    slot = at + 340
    await sleep(at - Date.now())
    requests++
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' } })
    if (res.ok) return res.json()
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000)
      continue
    }
    throw new Error(`Notion answered ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`)
  }
}

async function children(token: string, id: string): Promise<RawBlock[]> {
  const out: RawBlock[] = []
  let cursor: string | undefined
  do {
    const page: Json = await api(token, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`)
    out.push(...page.results)
    cursor = page.has_more ? page.next_cursor : undefined
  } while (cursor)
  return out
}

/** A page's blocks with their nested blocks, stopping at sub-pages (they're notes of their own). */
async function tree(token: string, id: string, depth = 0): Promise<RawBlock[]> {
  const blocks = await children(token, id)
  await Promise.all(
    blocks.map(async (b) => {
      if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database' && depth < 8) b.kids = await tree(token, b.id, depth + 1)
    }),
  )
  return blocks
}

// ─── Notion blocks → the app's compact blocks ────────────────────────────────

const plain = (rich: Rich[]) => rich.map(([text]) => text).join('')

function rich(list: Json[] | undefined): Rich[] {
  return (list ?? []).map((x: Json): Rich => {
    const a = x.annotations ?? {}
    const marks = `${a.bold ? 'b' : ''}${a.italic ? 'i' : ''}${a.strikethrough ? 's' : ''}${a.underline ? 'u' : ''}${a.code ? 'c' : ''}`
    const text = x.type === 'equation' ? x.equation.expression : (x.plain_text ?? '')
    return x.href ? [text, marks, x.href] : marks ? [text, marks] : [text]
  })
}

const fileUrl = (v: Json): string | undefined => v?.file?.url ?? v?.external?.url

/** Converts blocks; sub-pages are reported to `found` (with their depth below the root). */
function convert(raw: RawBlock[], found: (id: string, title: string) => void): Block[] {
  const out: Block[] = []
  const push = (b: Block) => out.push(b)
  const list = (t: 'ul' | 'ol' | 'todo', item: ListItem) => {
    const last = out.at(-1)
    if (last && last.t === t) last.items.push(item)
    else push({ t, items: [item] })
  }
  for (const b of raw) {
    const v = b[b.type] ?? {}
    const c = b.kids?.length ? convert(b.kids, found) : undefined
    switch (b.type) {
      case 'paragraph': {
        const r = rich(v.rich_text)
        if (plain(r).trim() || c) push({ t: 'p', r, ...(c && { c }) })
        break
      }
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        push({ t: `h${b.type.at(-1)}` as 'h1' | 'h2' | 'h3', r: rich(v.rich_text), ...(c && { c }) })
        break
      case 'quote':
      case 'toggle':
        push({ t: b.type, r: rich(v.rich_text), ...(c && { c }) })
        break
      case 'bulleted_list_item':
        list('ul', { r: rich(v.rich_text), ...(c && { c }) })
        break
      case 'numbered_list_item':
        list('ol', { r: rich(v.rich_text), ...(c && { c }) })
        break
      case 'to_do':
        list('todo', { r: rich(v.rich_text), done: Boolean(v.checked), ...(c && { c }) })
        break
      case 'callout':
        push({ t: 'callout', r: rich(v.rich_text), ...(v.icon?.emoji && { icon: v.icon.emoji }), ...(c && { c }) })
        break
      case 'code':
        push({ t: 'code', text: plain(rich(v.rich_text)), lang: v.language ?? 'plain text', ...(v.caption?.length && { caption: plain(rich(v.caption)) }) })
        break
      case 'divider':
        push({ t: 'hr' })
        break
      case 'equation':
        push({ t: 'eq', text: v.expression ?? '' })
        break
      case 'table':
        push({ t: 'table', head: Boolean(v.has_column_header), rows: (b.kids ?? []).filter((r) => r.type === 'table_row').map((r) => (r.table_row.cells as Json[][]).map(rich)) })
        break
      case 'image': {
        const src = fileUrl(v)
        // Notion-hosted images get an id-based name; saveImages downloads them.
        if (src) push({ t: 'img', src: v.type === 'file' ? `notion-file:${b.id}|${src}` : src, ...(v.caption?.length && { caption: rich(v.caption) }) })
        break
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview':
      case 'video':
      case 'pdf':
      case 'file':
      case 'audio': {
        const url = v.url ?? (v.type === 'external' ? fileUrl(v) : undefined)
        // Uploaded files' links expire, so only lasting links are kept.
        if (url) push({ t: 'link', url, title: plain(rich(v.caption)) || v.name || url })
        break
      }
      case 'child_page':
        found(b.id, v.title ?? '')
        push({ t: 'page', id: b.id, title: v.title ?? '' })
        break
      case 'link_to_page':
        if (v.page_id) push({ t: 'page', id: v.page_id, title: '' })
        break
      case 'child_database':
        push({ t: 'link', url: `https://www.notion.so/${b.id.replace(/-/g, '')}`, title: `${v.title || 'Database'} (in Notion)` })
        break
      case 'column_list':
      case 'column':
      case 'synced_block':
        if (c) out.push(...c)
        break
      // table_of_contents, breadcrumb, template, unsupported: nothing to show.
    }
  }
  return out
}

/** Every bit of text in the blocks, for word counts and the summary. */
function texts(blocks: Block[]): string[] {
  const out: string[] = []
  const walk = (list: Block[]) => {
    for (const b of list) {
      if ('r' in b) out.push(plain(b.r))
      if ('items' in b) for (const i of b.items) (out.push(plain(i.r)), i.c && walk(i.c))
      if ('c' in b && b.c) walk(b.c)
      if (b.t === 'table') for (const row of b.rows) for (const cell of row) out.push(plain(cell))
      if (b.t === 'code') out.push(b.text)
    }
  }
  walk(blocks)
  return out
}

function summary(blocks: Block[]): string {
  const first = blocks.find((b) => (b.t === 'p' || b.t === 'callout' || b.t === 'quote') && plain(b.r).trim().length > 30)
  const text = first && 'r' in first ? plain(first.r).replace(/\s+/g, ' ').trim() : ''
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')}…` : text
}

// ─── The build ───────────────────────────────────────────────────────────────

/** The page id from an id or a Notion URL (the last 32 hex digits before any query). */
function pageIdOf(input: string): string | null {
  const hex = input.split('?')[0].replace(/-/g, '').match(/[0-9a-f]{32}/gi)?.at(-1)?.toLowerCase()
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null
}

function pageTitle(page: Json): string {
  const prop: Json = Object.values(page.properties ?? {}).find((p: Json) => p?.type === 'title')
  return plain(rich(prop?.title)) || 'Untitled'
}

const pageIcon = (page: Json): string | undefined => page.icon?.emoji ?? page.icon?.external?.url

interface Cached {
  edited: string
  raw: RawBlock[]
}

function readCache(id: string): Cached | null {
  try {
    return JSON.parse(readFileSync(join(CACHE, `${id}.json`), 'utf8')) as Cached
  } catch {
    return null
  }
}

async function main() {
  const token = process.env.NOTION_TOKEN?.trim()
  const root = pageIdOf(process.env.NOTION_ROOT_PAGE_ID ?? '')
  if (!token || !root) {
    console.log('notion: skipped (set NOTION_TOKEN and NOTION_ROOT_PAGE_ID to build notes)')
    return
  }
  const passphrase = process.env.NOTION_PASSPHRASE ?? ''
  const exclude = new Set((process.env.NOTION_EXCLUDE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  mkdirSync(CACHE, { recursive: true })

  const rootPage = await api(token, `/pages/${root}`)
  const notes: (NoteMeta & { blocks: Block[] })[] = []
  const left = new Set<string>()
  let reused = 0

  // Breadth first from the root, so the list follows Notion's order.
  let level: { id: string; parent: string | null }[] = [{ id: root, parent: null }]
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: { id: string; parent: string | null }[] = []
    const pages = await Promise.all(
      level.map(async ({ id, parent }) => {
        const page = depth === 0 ? rootPage : await api(token, `/pages/${id}`)
        const title = pageTitle(page)
        if (depth > 0 && (exclude.has(title.toLowerCase()) || exclude.has(id) || exclude.has(id.replace(/-/g, '')))) {
          left.add(id)
          return null
        }
        const cached = readCache(id)
        let raw: RawBlock[]
        // Pages that hold sub-pages are always read again: a new sub-page may not
        // change its parent's edit time. They're mostly lists, so it's cheap.
        if (cached && cached.edited === page.last_edited_time && !cached.raw.some((b) => b.type === 'child_page')) {
          raw = cached.raw
          reused++
        } else {
          raw = await tree(token, id)
          writeFileSync(join(CACHE, `${id}.json`), JSON.stringify({ edited: page.last_edited_time, raw }))
        }
        const found: { id: string; title: string }[] = []
        const blocks = convert(raw, (child, childTitle) => found.push({ id: child, title: childTitle }))
        if (depth < MAX_DEPTH) next.push(...found.map((f) => ({ id: f.id, parent: depth === 0 ? null : id })))
        if (depth === 0) return null // The root lists the notes; it isn't one itself.
        const words = texts(blocks).join(' ').split(/\s+/).filter(Boolean).length
        return { id, title, icon: pageIcon(page), url: page.url, edited: page.last_edited_time, parent, summary: summary(blocks), words, blocks }
      }),
    )
    notes.push(...pages.filter((p) => p !== null))
    level = next
  }

  // Sub-page links get their titles; links to pages outside the notes become Notion links.
  const byId = new Map(notes.map((n) => [n.id, n]))
  const fix = (blocks: Block[]): Block[] =>
    blocks.flatMap((b): Block[] => {
      if (b.t === 'page') {
        if (left.has(b.id)) return []
        const note = byId.get(b.id)
        return note ? [{ ...b, title: note.title }] : b.title ? [{ t: 'link', url: `https://www.notion.so/${b.id.replace(/-/g, '')}`, title: `${b.title} (in Notion)` }] : []
      }
      if ('c' in b && b.c) return [{ ...b, c: fix(b.c) }]
      if ('items' in b) return [{ ...b, items: b.items.map((i) => (i.c ? { ...i, c: fix(i.c) } : i)) }]
      return [b]
    })
  for (const n of notes) n.blocks = fix(n.blocks)

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'img'), { recursive: true })
  const salt = await saltFor(root)
  const key = passphrase ? await deriveKey(passphrase, salt, PBKDF2_ITERATIONS) : null
  const write = async (name: string, bytes: Uint8Array<ArrayBuffer>) => writeFileSync(join(OUT, key ? name.replace(/\.\w+$/, '.bin') : name), key ? await seal(key, bytes) : bytes)
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

  // Images: downloaded once (by block id) and kept in the cache.
  let images = 0
  const saveImages = async (blocks: Block[]): Promise<void> => {
    for (const b of blocks) {
      if (b.t === 'img' && b.src.startsWith('notion-file:')) {
        const [id, url] = b.src.slice('notion-file:'.length).split('|')
        const ext = (url.split('?')[0].match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1] ?? 'png').toLowerCase()
        const cached = join(CACHE, `img-${id}.${ext}`)
        try {
          if (!existsSync(cached)) {
            const res = await fetch(url)
            const bytes = new Uint8Array(await res.arrayBuffer())
            if (!res.ok || bytes.length > MAX_IMAGE) throw new Error(`image ${res.status}, ${bytes.length} bytes`)
            writeFileSync(cached, bytes)
          }
          await write(`img/${id}.${ext}`, new Uint8Array(readFileSync(cached)))
          b.src = `/notion/img/${id}.${key ? 'bin' : ext}`
          images++
        } catch (error) {
          console.warn(`notion: left out an image (${(error as Error).message})`)
          b.src = ''
        }
      }
      if ('c' in b && b.c) await saveImages(b.c)
      if ('items' in b) for (const i of b.items) if (i.c) await saveImages(i.c)
    }
  }

  for (const { blocks, ...meta } of notes) {
    await saveImages(blocks)
    const file: NoteFile = { id: meta.id, blocks: blocks.filter((b) => b.t !== 'img' || b.src) }
    await write(`${meta.id}.json`, json(file))
  }

  const index: NotesIndex = {
    title: pageTitle(rootPage),
    url: rootPage.url,
    built: new Date().toISOString(),
    notes: notes.map(({ blocks: _, ...meta }) => meta),
  }
  const published: PublishedIndex = key ? { v: 1, locked: { salt: toBase64(salt), iter: PBKDF2_ITERATIONS, data: toBase64(await seal(key, json(index))) } } : { v: 1, index }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(published))
  console.log(
    `notion: ${notes.length} notes and ${images} images from "${index.title}"${key ? ', locked with the passphrase' : ' (public: set NOTION_PASSPHRASE to lock them)'}; ${requests} requests, ${reused} pages unchanged`,
  )
}

main().catch((error: Error) => {
  rmSync(OUT, { recursive: true, force: true })
  console.warn(`notion: no notes this build. ${error.message}`)
})
