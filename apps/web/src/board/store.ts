import type { ComponentStats } from '../sim/engine'
import { boundsOf, emptyPage, newId, type Bounds, type Page } from './types'

const STORAGE_KEY = 'structura:board:v1'
const MAX_UNDO = 50

interface Saved {
  pages: Page[]
  currentId: string
}

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null
    if (saved?.pages?.length && saved.pages.some((p) => p.id === saved.currentId)) return saved
  } catch {
    // Storage blocked or corrupt: start fresh.
  }
  const first = emptyPage(newId('page'), 'Page 1')
  return { pages: [first], currentId: first.id }
}

/** A request for the 3D view to frame something. */
export interface FitRequest {
  bounds: Bounds
  /** Extra board units of context around it. */
  margin: number
}

/**
 * The design being worked on: pages of boxes, frames and arrows, with undo,
 * selection, and what the 3D view should highlight.
 * Pages are saved in this browser.
 */
export class Board {
  private pages: Page[]
  private currentId: string
  private undoStack: Page[] = []
  private redoStack: Page[] = []
  private listeners = new Set<() => void>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private version = 0

  /** Selected box ids (click in 3D; "explain selected"). */
  selection: ReadonlySet<string> = new Set()
  /** Ids of boxes and arrows in focus during a walkthrough; others are dimmed. */
  focus: ReadonlySet<string> | null = null
  /** Load-test results by component label (lower case), shown on the boxes. */
  stats: ReadonlyMap<string, ComponentStats> | null = null
  /** The same, at the topic's default settings: the "usual" shown beside current numbers. */
  baseline: ReadonlyMap<string, ComponentStats> | null = null
  /** Latest framing request; the 3D view animates to it. */
  fit: FitRequest | null = null

  constructor() {
    const saved = load()
    this.pages = saved.pages
    this.currentId = saved.currentId
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Changes whenever anything on the board changes (for useSyncExternalStore). */
  getVersion = () => this.version

  private emit(save = false) {
    this.version++
    if (save) {
      clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ pages: this.pages, currentId: this.currentId }))
        } catch {
          // Storage full or blocked; the board still works for this session.
        }
      }, 300)
    }
    this.listeners.forEach((listener) => listener())
  }

  get page(): Page {
    return this.pages.find((p) => p.id === this.currentId) ?? this.pages[0]
  }

  get pageList(): { id: string; name: string }[] {
    return this.pages.map(({ id, name }) => ({ id, name }))
  }

  /** Records the current page so the next change can be undone. */
  mark() {
    this.undoStack.push(structuredClone(this.page))
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
  }

  /** Replaces the current page's contents. Call mark() first to make it undoable. */
  update(change: (page: Page) => Page) {
    const next = change(this.page)
    this.pages = this.pages.map((p) => (p.id === this.currentId ? next : p))
    const ids = new Set(next.nodes.map((n) => n.id))
    if ([...this.selection].some((id) => !ids.has(id))) this.selection = new Set([...this.selection].filter((id) => ids.has(id)))
    this.emit(true)
  }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous || previous.id !== this.currentId) return false
    this.redoStack.push(structuredClone(this.page))
    this.update(() => previous)
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next || next.id !== this.currentId) return false
    this.undoStack.push(structuredClone(this.page))
    this.update(() => next)
    return true
  }

  /** Switches to the page with this name, creating it if needed. Returns true if it existed. */
  goToPage(name: string, topicId?: string): boolean {
    const existing = this.pages.find((p) => p.name === name)
    if (existing) {
      this.switchTo(existing.id)
      return true
    }
    const page = emptyPage(newId('page'), name, topicId)
    this.pages = [...this.pages, page]
    this.switchTo(page.id)
    return false
  }

  switchTo(id: string) {
    if (!this.pages.some((p) => p.id === id) || id === this.currentId) return
    this.currentId = id
    this.undoStack = []
    this.redoStack = []
    this.selection = new Set()
    this.focus = null
    this.stats = null
    this.baseline = null
    this.fitAll()
    this.emit(true)
  }

  newPage(): string {
    const page = emptyPage(newId('page'), `Page ${this.pages.length + 1}`)
    this.pages = [...this.pages, page]
    this.switchTo(page.id)
    return page.id
  }

  deletePage(id: string) {
    if (this.pages.length === 1) return
    this.pages = this.pages.filter((p) => p.id !== id)
    if (this.currentId === id) this.switchTo(this.pages[0].id)
    else this.emit(true)
  }

  setSelection(ids: Iterable<string>) {
    this.selection = new Set(ids)
    this.emit()
  }

  setFocus(ids: Iterable<string> | null) {
    this.focus = ids ? new Set(ids) : null
    this.emit()
  }

  setStats(stats: ReadonlyMap<string, ComponentStats> | null, baseline?: ReadonlyMap<string, ComponentStats> | null) {
    this.stats = stats
    if (baseline !== undefined) this.baseline = baseline
    this.emit()
  }

  /** Asks the 3D view to frame these bounds (with some context around them). */
  frame(bounds: Bounds, margin = 80) {
    this.fit = { bounds, margin }
    this.emit()
  }

  /** Frames the last framed area again, e.g. after a panel opened and the free space changed. */
  refit() {
    if (this.fit) this.frame(this.fit.bounds, this.fit.margin)
  }

  /** Frames everything on the page. */
  fitAll() {
    const bounds = boundsOf([...this.page.nodes, ...this.page.frames])
    if (bounds) this.frame(bounds)
  }

  /** Bounds of the page's contents, or null when it is empty. */
  contentBounds(): Bounds | null {
    return boundsOf([...this.page.nodes, ...this.page.frames])
  }
}

export const board = new Board()
