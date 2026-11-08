import type { Config } from '@netlify/functions'
import { deriveKey, fromBase64, PBKDF2_ITERATIONS, saltFor, unseal } from '../../apps/web/src/learn/notesFormat'
import { FOLDER, noteBlocks, pageIdOf, parseNote } from '../lib/notion-save'

// /api/notion-note, called by the note box on a topic (apps/web/src/shell/Notes.tsx):
//   POST { data }  a note sealed with the notes key; appended to
//                  <root page> / Notes from Structura / <topic title> in Notion.
// Off unless NOTION_TOKEN, NOTION_ROOT_PAGE_ID and NOTION_PASSPHRASE are set. It
// writes only the owner's notes, only when he saves one; it never reads progress.

export const config: Config = { path: '/api/notion-note' }

const API = process.env.NOTION_API ?? 'https://api.notion.com/v1'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

// Deriving the key takes a moment, so a warm function keeps it.
let keyFor: { root: string; key: Promise<CryptoKey> } | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function notion(token: string, method: string, path: string, body?: unknown): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.ok) return res.json()
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 1) * 1000))
      continue
    }
    throw new Error(`Notion answered ${res.status}`)
  }
}

const pageUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, '')}`

/** The sub-page with this title, made if it isn't there yet. */
async function childPage(token: string, parent: string, title: string, emoji: string): Promise<string> {
  let cursor: string | undefined
  do {
    const page = await notion(token, 'GET', `/blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`)
    const found = page.results.find((b: Json) => b.type === 'child_page' && b.child_page?.title === title)
    if (found) return found.id
    cursor = page.has_more ? page.next_cursor : undefined
  } while (cursor)
  const made = await notion(token, 'POST', '/pages', {
    parent: { page_id: parent },
    icon: { type: 'emoji', emoji },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
  })
  return made.id
}

export default async (req: Request) => {
  const token = process.env.NOTION_TOKEN?.trim()
  const root = pageIdOf(process.env.NOTION_ROOT_PAGE_ID ?? '')
  const passphrase = process.env.NOTION_PASSPHRASE
  if (!token || !root || !passphrase) return json({ error: "Saving to Notion isn't set up on this site." }, 503)
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (Number(req.headers.get('content-length') ?? 0) > 64 * 1024) return json({ error: 'Too large' }, 413)

  const body = (await req.json().catch(() => null)) as { data?: unknown } | null
  if (typeof body?.data !== 'string') return json({ error: 'Expected a sealed note' }, 400)

  if (keyFor?.root !== root) keyFor = { root, key: saltFor(root).then((salt) => deriveKey(passphrase, salt, PBKDF2_ITERATIONS)) }
  let opened: unknown
  try {
    opened = JSON.parse(new TextDecoder().decode(await unseal(await keyFor.key, fromBase64(body.data))))
  } catch {
    return json({ error: 'Unlock your notes again: the passphrase has changed.' }, 401)
  }
  const note = parseNote(opened, Date.now())
  if ('error' in note) return json(note, 400)

  try {
    const folder = await childPage(token, root, FOLDER, '📝')
    const page = await childPage(token, folder, note.topicTitle, '🧩')
    await notion(token, 'PATCH', `/blocks/${page}/children`, { children: noteBlocks(note) })
    return json({ ok: true, url: pageUrl(page) })
  } catch (error) {
    return json({ error: `Couldn't save to Notion (${(error as Error).message}). Is the page still shared with the integration?` }, 502)
  }
}
