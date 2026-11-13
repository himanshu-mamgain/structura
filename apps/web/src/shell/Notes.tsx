import { type FormEvent, Fragment, type ReactNode, useEffect, useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, FileText, KeyRound, Link2, Loader2, Lock, NotebookPen, Send } from 'lucide-react'
import { ago } from '../learn/progress'
import { canSave, imageSrc, isSealed, loadNote, lockNotes, noteIdIn, notesFor, saveNote, topicsFor, unlock, useNotes } from '../learn/notes'
import type { Block, NoteFile, NoteMeta, NotesIndex, Rich } from '../learn/notesFormat'
import { TOPICS, type TopicMeta } from '../topics/catalog'
import { topicIcon } from './topicIcons'

// The owner's Notion notes in the app: a shelf in Explore, a reader
// (?note=<id>), and the matching notes on each topic.

const edited = (iso: string) => ago(Date.parse(iso))

function NoteIcon({ note, size = 20 }: { note: NoteMeta; size?: number }) {
  if (!note.icon) return <FileText size={size} aria-hidden />
  if (/^https?:/.test(note.icon)) return <img src={note.icon} alt="" width={size} height={size} />
  return <span style={{ fontSize: size }}>{note.icon}</span>
}

function UnlockForm() {
  const notes = useNotes()
  const [pass, setPass] = useState('')
  const [wrong, setWrong] = useState(false)
  const checking = notes.status === 'locked' && notes.checking

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!pass) return
    const ok = await unlock(pass)
    setWrong(!ok)
    if (ok) setPass('')
  }

  return (
    <form className="card notes-lock" onSubmit={(e) => void submit(e)}>
      <span className="notes-lock-icon" aria-hidden>
        <Lock size={20} />
      </span>
      <div>
        <strong>Your Notion notes are locked</strong>
        <span>Enter the passphrase set in Netlify. This browser remembers it.</span>
        <div className="notes-lock-row">
          <input type="password" value={pass} onChange={(e) => (setPass(e.target.value), setWrong(false))} placeholder="Passphrase" aria-label="Passphrase" autoComplete="current-password" />
          <button type="submit" className="btn btn-primary" disabled={!pass || checking}>
            <KeyRound size={16} /> {checking ? 'Checking…' : 'Unlock'}
          </button>
        </div>
        {wrong && (
          <span className="notes-lock-error" role="status">
            That passphrase didn't open them.
          </span>
        )}
      </div>
    </form>
  )
}

/** Explore: every note, with the newest edits first. */
export function NotesShelf({ onNote }: { onNote: (id: string) => void }) {
  const notes = useNotes()
  const [all, setAll] = useState(false)
  if (notes.status === 'loading' || notes.status === 'none') return null
  if (notes.status === 'locked') return <section className="notes-shelf">{<UnlockForm />}</section>

  const { index } = notes
  const top = index.notes.filter((n) => !n.parent)
  const shown = all ? top : top.slice(0, 6)
  return (
    <section className="notes-shelf" aria-label="Your notes">
      <div className="section-head">
        <h2>
          <NotebookPen size={19} /> Your notes
        </h2>
        <a className="see-all" href={index.url} target="_blank" rel="noreferrer">
          {index.title} in Notion <ArrowUpRight size={14} aria-hidden />
        </a>
      </div>
      <ul className="note-list">
        {shown.map((n) => (
          <li key={n.id}>
            <button type="button" className="note-row" onClick={() => onNote(n.id)}>
              <span className="note-row-icon">
                <NoteIcon note={n} />
              </span>
              <span className="note-row-text">
                <strong>{n.title}</strong>
                <span>{n.summary || `${n.words} words`}</span>
              </span>
              <ChevronRight size={18} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {top.length > shown.length && (
        <button type="button" className="btn btn-ghost notes-more" onClick={() => setAll(true)}>
          Show all {top.length} notes
        </button>
      )}
    </section>
  )
}

/** On a topic page, under the takeaways: the notes about it, if there are any. */
export function TopicNotes({ topic, onNote }: { topic: TopicMeta; onNote: (id: string) => void }) {
  const notes = useNotes()
  if (notes.status !== 'ready') return null
  const mine = notesFor(topic, notes.index)
  if (!mine.length) return null
  return (
    <>
      <h3 className="deeper-title">
        <NotebookPen size={15} aria-hidden /> Your notes
      </h3>
      <ul className="deeper topic-notes">
        {mine.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onNote(n.id)}>
              <NoteIcon note={n} size={15} /> <span>{n.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

const draftKey = (topic: TopicMeta) => `structura:note-draft:${topic.id}`

/**
 * Under a topic's takeaways, for the owner once his notes are unlocked: write a
 * note and save it to the topic's page in Notion. The draft is kept in this
 * browser until it's saved.
 */
export function NoteBox({ topic }: { topic: TopicMeta }) {
  const notes = useNotes()
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey(topic)) ?? ''
    } catch {
      return ''
    }
  })
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; url: string } | { kind: 'error'; message: string }>({ kind: 'idle' })
  if (notes.status !== 'ready' || !canSave()) return null

  function edit(next: string) {
    setText(next)
    if (state.kind !== 'saving') setState({ kind: 'idle' })
    try {
      if (next) localStorage.setItem(draftKey(topic), next)
      else localStorage.removeItem(draftKey(topic))
    } catch {
      // Not kept; still saved when sent.
    }
  }

  async function save() {
    setState({ kind: 'saving' })
    try {
      const url = await saveNote(topic, text)
      edit('')
      setState({ kind: 'saved', url })
    } catch (error) {
      setState({ kind: 'error', message: (error as Error).message })
    }
  }

  return (
    <div className="note-box">
      <h3 className="deeper-title">
        <NotebookPen size={15} aria-hidden /> Write a note
      </h3>
      <textarea
        value={text}
        onChange={(e) => edit(e.target.value)}
        placeholder="What clicked, what to revise, an interview answer… Start lines with - for bullets."
        rows={4}
        maxLength={6000}
        aria-label={`Note on ${topic.title}`}
      />
      <div className="note-box-row">
        <button type="button" className="btn btn-primary" disabled={!text.trim() || state.kind === 'saving'} onClick={() => void save()}>
          {state.kind === 'saving' ? <Loader2 size={16} className="spin" /> : <Send size={16} />} Save to Notion
        </button>
        {state.kind === 'saved' && (
          <span className="note-box-status" role="status">
            <Check size={15} /> Saved ·{' '}
            <a href={state.url} target="_blank" rel="noreferrer">
              Open in Notion
            </a>
          </span>
        )}
      </div>
      {state.kind === 'error' && (
        <p className="note-box-error" role="status">
          {state.message}
        </p>
      )}
    </div>
  )
}

/** Search results for notes (titles and summaries). */
export function searchNotes(index: NotesIndex, query: string): NoteMeta[] {
  const q = query.trim().toLowerCase()
  return q ? index.notes.filter((n) => `${n.title} ${n.summary}`.toLowerCase().includes(q)).slice(0, 6) : []
}

// ─── The reader ──────────────────────────────────────────────────────────────

export function NoteView({ id, onNote, onOpen }: { id: string; onNote: (id: string) => void; onOpen: (topic: TopicMeta) => void }) {
  const notes = useNotes()
  const [file, setFile] = useState<NoteFile | null>(null)
  const [failed, setFailed] = useState(false)
  const index = notes.status === 'ready' ? notes.index : null
  const note = index?.notes.find((n) => n.id === id)

  useEffect(() => {
    if (!note) return
    let live = true
    setFile(null)
    setFailed(false)
    loadNote(note.id).then(
      (f) => live && setFile(f),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [note])

  if (notes.status === 'loading') return <p className="practice-empty">Loading your notes…</p>
  if (notes.status === 'locked') return <UnlockForm />
  if (!index || !note) return <p className="practice-empty">This note isn't here. It may have been removed or left out in Notion.</p>

  const parent = note.parent ? index.notes.find((n) => n.id === note.parent) : null
  const children = index.notes.filter((n) => n.parent === note.id)
  const topics = topicsFor(note, TOPICS, index)

  return (
    <article className="note">
      {parent && (
        <button type="button" className="note-crumb" onClick={() => onNote(parent.id)}>
          <NoteIcon note={parent} size={14} /> {parent.title}
        </button>
      )}
      <header className="note-head">
        <span className="note-head-icon">
          <NoteIcon note={note} size={34} />
        </span>
        <h1>{note.title}</h1>
        <p className="note-meta">
          Edited {edited(note.edited)} · {note.words.toLocaleString()} words ·{' '}
          <a href={note.url} target="_blank" rel="noreferrer">
            Open in Notion <ArrowUpRight size={13} aria-hidden />
          </a>
          {isSealed() && (
            <>
              {' · '}
              <button type="button" className="link-btn" onClick={lockNotes} title="Lock your notes in this browser">
                Lock
              </button>
            </>
          )}
        </p>
        {topics.length > 0 && (
          <div className="note-topics">
            {topics.map((t) => {
              const Icon = topicIcon(t.id)
              return (
                <button key={t.id} type="button" className="chip-btn" onClick={() => onOpen(t)}>
                  <Icon size={14} /> {t.title}
                </button>
              )
            })}
          </div>
        )}
      </header>

      {children.length > 0 && (
        <ul className="note-list note-children">
          {children.map((n) => (
            <li key={n.id}>
              <button type="button" className="note-row" onClick={() => onNote(n.id)}>
                <span className="note-row-icon">
                  <NoteIcon note={n} />
                </span>
                <span className="note-row-text">
                  <strong>{n.title}</strong>
                  {n.summary && <span>{n.summary}</span>}
                </span>
                <ChevronRight size={18} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {failed ? (
        <p className="practice-empty">Couldn't load this note. Check your connection and try again.</p>
      ) : !file ? (
        <p className="practice-empty">Loading…</p>
      ) : (
        <div className="note-body">
          <Blocks blocks={file.blocks} index={index} onNote={onNote} />
        </div>
      )}
    </article>
  )
}

function Text({ r, index, onNote }: { r: Rich[]; index?: NotesIndex; onNote: (id: string) => void }) {
  return (
    <>
      {r.map(([text, marks = '', href], i) => {
        let el: ReactNode = text
        if (marks.includes('c')) el = <code>{el}</code>
        if (marks.includes('b')) el = <strong>{el}</strong>
        if (marks.includes('i')) el = <em>{el}</em>
        if (marks.includes('s')) el = <s>{el}</s>
        if (marks.includes('u')) el = <u>{el}</u>
        // Links to /?topic=… stay in the app (read mode handles the click).
        if (href?.startsWith('/?')) el = <a href={href}>{el}</a>
        else if (href) {
          const target = index ? noteIdIn(href, index) : null
          el = target ? (
            <a
              href={`/?note=${target}`}
              onClick={(e) => {
                e.preventDefault()
                onNote(target)
              }}
            >
              {el}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">
              {el}
            </a>
          )
        }
        return <Fragment key={i}>{el}</Fragment>
      })}
    </>
  )
}

function NoteImage({ src, caption, index, onNote }: { src: string; caption?: Rich[]; index?: NotesIndex; onNote: (id: string) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    imageSrc(src).then(
      (u) => live && setUrl(u),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [src])
  return (
    <figure className="note-figure">
      {url ? <img src={url} alt={caption ? caption.map(([t]) => t).join('') : ''} loading="lazy" /> : <span className="note-figure-wait" />}
      {caption && caption.length > 0 && (
        <figcaption>
          <Text r={caption} index={index} onNote={onNote} />
        </figcaption>
      )}
    </figure>
  )
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Note blocks, as Notion notes and topics' deep notes both use them. */
export function Blocks({ blocks, index, onNote = () => {} }: { blocks: Block[]; index?: NotesIndex; onNote?: (id: string) => void }) {
  const sub = (c?: Block[]) => (c?.length ? <Blocks blocks={c} index={index} onNote={onNote} /> : null)
  const text = (r: Rich[]) => <Text r={r} index={index} onNote={onNote} />
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p':
            return (
              <Fragment key={i}>
                <p>{text(b.r)}</p>
                {b.c && <div className="note-indent">{sub(b.c)}</div>}
              </Fragment>
            )
          case 'h1':
          case 'h2':
          case 'h3': {
            // The page title is the h1, so Notion's headings step down one level.
            const H = b.t === 'h1' ? 'h2' : b.t === 'h2' ? 'h3' : 'h4'
            return b.c ? (
              <details key={i} className="note-toggle is-heading">
                <summary>
                  <H>{text(b.r)}</H>
                </summary>
                {sub(b.c)}
              </details>
            ) : (
              <H key={i}>{text(b.r)}</H>
            )
          }
          case 'quote':
            return (
              <blockquote key={i}>
                {text(b.r)}
                {sub(b.c)}
              </blockquote>
            )
          case 'toggle':
            return (
              <details key={i} className="note-toggle">
                <summary>{text(b.r)}</summary>
                {sub(b.c)}
              </details>
            )
          case 'ul':
          case 'ol': {
            const L = b.t
            return (
              <L key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    {text(item.r)}
                    {sub(item.c)}
                  </li>
                ))}
              </L>
            )
          }
          case 'todo':
            return (
              <ul key={i} className="note-todo">
                {b.items.map((item, j) => (
                  <li key={j} className={item.done ? 'is-done' : ''}>
                    <input type="checkbox" checked={Boolean(item.done)} readOnly tabIndex={-1} aria-label={item.done ? 'Done' : 'Not done'} />
                    <span>
                      {text(item.r)}
                      {sub(item.c)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          case 'callout':
            return (
              <div key={i} className="note-callout">
                {b.icon && <span aria-hidden>{b.icon}</span>}
                <div>
                  {text(b.r)}
                  {sub(b.c)}
                </div>
              </div>
            )
          case 'code':
            return (
              <figure key={i} className="note-code">
                <pre data-lang={b.lang}>
                  <code>{b.text}</code>
                </pre>
                {b.caption && <figcaption>{b.caption}</figcaption>}
              </figure>
            )
          case 'hr':
            return <hr key={i} />
          case 'eq':
            return (
              <p key={i} className="note-eq">
                <code>{b.text}</code>
              </p>
            )
          case 'table':
            return (
              <div key={i} className="note-table">
                <table>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => {
                          const Cell = b.head && r === 0 ? 'th' : 'td'
                          return <Cell key={c}>{text(cell)}</Cell>
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'img':
            return <NoteImage key={i} src={b.src} caption={b.caption} index={index} onNote={onNote} />
          case 'link':
            return (
              <a key={i} className="note-link" href={b.url} target="_blank" rel="noreferrer">
                <Link2 size={16} aria-hidden />
                <span>
                  <strong>{b.title === b.url ? host(b.url) : b.title}</strong>
                  <small>{host(b.url)}</small>
                </span>
              </a>
            )
          case 'page': {
            const target = index?.notes.find((n) => n.id === b.id)
            return target ? (
              <button key={i} type="button" className="note-page-link" onClick={() => onNote(target.id)}>
                <NoteIcon note={target} size={16} /> {target.title}
              </button>
            ) : null
          }
        }
      })}
    </>
  )
}
