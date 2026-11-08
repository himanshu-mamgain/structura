// The shape of the Notion notes the build writes to /notion/ (scripts/notion.ts)
// and the app reads (learn/notes.ts), and the encryption both use when the
// notes are locked with a passphrase. Web Crypto only, so it runs in Node and
// in the browser alike.

/** A run of text: [text, marks, link]. Marks are letters: b bold, i italic, s strikethrough, u underline, c code. */
export type Rich = [text: string, marks?: string, href?: string]

export interface ListItem {
  r: Rich[]
  c?: Block[]
  done?: boolean
}

export type Block =
  | { t: 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'toggle'; r: Rich[]; c?: Block[] }
  | { t: 'ul' | 'ol' | 'todo'; items: ListItem[] }
  | { t: 'callout'; r: Rich[]; icon?: string; c?: Block[] }
  | { t: 'code'; text: string; lang: string; caption?: string }
  | { t: 'hr' }
  | { t: 'table'; rows: Rich[][][]; head: boolean }
  | { t: 'img'; src: string; caption?: Rich[] }
  | { t: 'link'; url: string; title: string }
  | { t: 'page'; id: string; title: string }
  | { t: 'eq'; text: string }

export interface NoteMeta {
  id: string
  title: string
  /** An emoji, or an image URL. */
  icon?: string
  /** The page in Notion. */
  url: string
  /** Last edited in Notion (ISO time). */
  edited: string
  /** The note this one sits under, or null for the top level. */
  parent: string | null
  /** The first lines, for lists and search. */
  summary: string
  words: number
}

export interface NotesIndex {
  /** The Notion page the notes come from. */
  title: string
  url: string
  /** When the site was built (ISO time). */
  built: string
  notes: NoteMeta[]
}

export interface NoteFile {
  id: string
  blocks: Block[]
}

/** /notion/index.json: the index in the clear, or sealed with a passphrase. */
export interface PublishedIndex {
  v: 1
  index?: NotesIndex
  locked?: { salt: string; iter: number; data: string }
}

// ─── Encryption: PBKDF2 (SHA-256) → AES-256-GCM, a fresh 12-byte IV per file ───

export const PBKDF2_ITERATIONS = 310_000

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  // Extractable, so the browser can remember the key (not the passphrase) after unlocking.
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

export const exportKey = async (key: CryptoKey) => toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)))

export const importKey = (raw: string) => crypto.subtle.importKey('raw', fromBase64(raw), 'AES-GCM', true, ['encrypt', 'decrypt'])

/** IV followed by the ciphertext. */
export async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return out
}

/** Throws if the key is wrong or the data was changed. */
export async function unseal(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, key, sealed.subarray(12)))
}
