import { useSyncExternalStore } from 'react'
import type { StaticTopic } from '../topics'
import { exportKey, fromBase64, importKey, deriveKey, type NoteFile, type NoteMeta, type NotesIndex, type PublishedIndex, seal, toBase64, unseal } from './notesFormat'

// The owner's Notion notes, built into the site by scripts/notion.ts. They're
// static files under /notion/, read only by this browser. When they're locked,
// the passphrase turns into a key here; the key (never the passphrase) is kept
// in this browser so it stays unlocked.

export type NotesState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'locked'; checking?: boolean }
  | { status: 'ready'; index: NotesIndex }

const KEY = 'structura:notes-key'
let state: NotesState = { status: 'loading' }
let sealed: PublishedIndex['locked'] | null = null
let key: CryptoKey | null = null
const listeners = new Set<() => void>()
const set = (next: NotesState) => {
  state = next
  listeners.forEach((l) => l())
}

async function readIndex(k: CryptoKey) {
  return JSON.parse(new TextDecoder().decode(await unseal(k, fromBase64(sealed!.data)))) as NotesIndex
}

let started = false
async function start() {
  if (started) return
  started = true
  try {
    const res = await fetch('/notion/index.json', { cache: 'no-cache' })
    // A site built without notes has no file (or answers with the app's page).
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return set({ status: 'none' })
    const published = (await res.json()) as PublishedIndex
    if (published.index) return set({ status: 'ready', index: published.index })
    if (!published.locked) return set({ status: 'none' })
    sealed = published.locked
    let saved: string | null = null
    try {
      saved = localStorage.getItem(KEY)
    } catch {
      // Storage blocked: ask for the passphrase each visit.
    }
    if (saved) {
      try {
        key = await importKey(saved)
        return set({ status: 'ready', index: await readIndex(key) })
      } catch {
        // A new passphrase since this browser unlocked: ask again.
        key = null
      }
    }
    set({ status: 'locked' })
  } catch {
    set({ status: 'none' })
  }
}

export function useNotes(): NotesState {
  void start()
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  )
}

/** Tries the passphrase; true if it opened the notes. */
export async function unlock(passphrase: string): Promise<boolean> {
  if (!sealed) return false
  set({ status: 'locked', checking: true })
  try {
    const k = await deriveKey(passphrase, fromBase64(sealed.salt), sealed.iter)
    const index = await readIndex(k)
    key = k
    try {
      localStorage.setItem(KEY, await exportKey(k))
    } catch {
      // Not remembered; unlocked for this visit.
    }
    set({ status: 'ready', index })
    return true
  } catch {
    set({ status: 'locked' })
    return false
  }
}

/** The notes came locked with a passphrase (so they can be locked again here). */
export const isSealed = () => sealed !== null

/** Locks the notes again in this browser. */
export function lockNotes() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing saved.
  }
  key = null
  if (sealed) set({ status: 'locked' })
}

/** Notes can be written back to Notion: they're locked, and unlocked here. */
export const canSave = () => sealed !== null && key !== null

/**
 * Appends a note to the topic's page in Notion (under "Notes from Structura"),
 * through /api/notion-note. The note is sealed with the notes key, which is
 * how the function knows it's the owner. Returns the page's URL.
 */
export async function saveNote(topic: StaticTopic, text: string): Promise<string> {
  if (!key) throw new Error('Unlock your notes first.')
  const note = { topicId: topic.id, topicTitle: topic.title, text, at: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  const data = toBase64(await seal(key, new TextEncoder().encode(JSON.stringify(note))))
  let res: Response
  try {
    res = await fetch('/api/notion-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  } catch {
    throw new Error("You're offline. Your note is kept here; save it when you're back online.")
  }
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!res.ok || !body.url) throw new Error(body.error ?? `Saving failed (${res.status}).`)
  return body.url
}

async function fetchBytes(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return key ? unseal(key, bytes) : bytes
}

const files = new Map<string, Promise<NoteFile>>()
export function loadNote(id: string): Promise<NoteFile> {
  let file = files.get(id)
  if (!file) {
    file = fetchBytes(`/notion/${id}.${key ? 'bin' : 'json'}`).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as NoteFile)
    file.catch(() => files.delete(id))
    files.set(id, file)
  }
  return file
}

const images = new Map<string, Promise<string>>()
/** An image's address: as is when the notes are public, a decrypted blob when they're locked. */
export function imageSrc(src: string): Promise<string> {
  if (!src.endsWith('.bin')) return Promise.resolve(src)
  let url = images.get(src)
  if (!url) {
    url = fetchBytes(src).then((bytes) => URL.createObjectURL(new Blob([bytes])))
    images.set(src, url)
  }
  return url
}

/** A Notion page id from a link, if it points at one of the notes. */
export function noteIdIn(href: string, index: NotesIndex): string | null {
  if (!/notion\.(so|site)|^\//.test(href)) return null
  const hex = href.split('?')[0].replace(/-/g, '').match(/[0-9a-f]{32}/gi)?.at(-1)?.toLowerCase()
  return index.notes.find((n) => n.id.replace(/-/g, '') === hex)?.id ?? null
}

// ─── Notes for a topic, by title ─────────────────────────────────────────────

// Words in a note's title that mean it's about the topic. Topic titles count too.
const ALIASES: Record<string, string[]> = {
  'url-shortener': ['url shortener', 'short link', 'tinyurl'],
  rbac: ['rbac', 'access control', 'authorization', 'permissions'],
  'uber-surge': ['surge', 'uber', 'ride'],
  'docker-vs-vm': ['docker', 'container', 'kubernetes', 'k8s', 'virtual machine'],
  'twitter-timeline': ['timeline', 'feed', 'twitter', 'fan-out', 'fan out'],
  'web-crawler': ['crawler', 'crawling'],
  kafka: ['kafka', 'message queue', 'message stream', 'event streaming', 'pub/sub'],
  'payment-idempotency': ['idempoten', 'deduplication', 'payment', 'exactly once'],
  pastebin: ['pastebin'],
  'key-value-store': ['key-value', 'key value', 'dynamo', 'cap theorem', 'consistency'],
  'social-graph': ['social graph', 'social network', 'graph'],
  'query-cache': ['caching', 'cache', 'redis'],
  'scaling-aws': ['scalab', 'scaling', 'load balanc', 'infrastructure', 'latency', 'proxies', 'proxy'],
  cdn: ['cdn', 'content delivery'],
  'chat-system': ['chat', 'websocket', 'real-time', 'sse'],
  'consistent-hashing': ['consistent hashing', 'sharding'],
  'notification-system': ['notification', 'push', 'otp', 'sms'],
  'proximity-service': ['proximity', 'geohash', 'location', 'nearby'],
  'rate-limiter': ['rate limit', 'throttl', 'abuse'],
  'search-autocomplete': ['autocomplete', 'typeahead', 'search system'],
  'unique-id-generator': ['id generation', 'snowflake', 'ulid', 'uuid', 'unique id'],
  'video-streaming': ['video', 'streaming'],
  'rag-pipeline': ['rag', 'retrieval', 'llm', 'chatbot', 'hallucinat', 'prompt'],
  'llm-gateway': ['llm gateway', 'ai gateway', 'model routing', 'litellm', 'token limit'],
  'ai-agent': ['agent', 'tool call', 'function calling', 'prompt injection', 'mcp'],
  'vector-database': ['vector', 'embedding', 'similarity search', 'nearest neighbo', 'hnsw', 'pgvector'],
  locking: ['lock', 'redlock', 'mvcc', 'transaction', 'isolation level', 'concurrency control', 'deadlock'],
}

export function notesFor(topic: StaticTopic, index: NotesIndex): NoteMeta[] {
  const words = [...(ALIASES[topic.id] ?? []), topic.title.toLowerCase().split(/[:(&]/)[0].trim()].filter((w) => w.length > 2)
  // From the start of a word, so "ride" doesn't match "override".
  const match = new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`, 'i')
  return index.notes.filter((n) => match.test(n.title))
}

export function topicsFor(note: NoteMeta, topics: StaticTopic[], index: NotesIndex): StaticTopic[] {
  return topics.filter((t) => notesFor(t, index).some((n) => n.id === note.id))
}
