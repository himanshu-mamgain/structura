import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { CodeLanguage, CodeSnippet } from '@structura/shared'
import type { Simulator } from '../topics/simulator'

// Building blocks for a topic's written content: section text, code blocks and
// the "try it with your own input" form.

/** Renders a section body: paragraphs split by blank lines, "- " lines as bullet lists. */
export function Body({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  text.split(/\n\s*\n/).forEach((block, b) => {
    const lines = block.split('\n').filter((line) => line.trim())
    let bullets: string[] = []
    const flush = () => {
      if (bullets.length) blocks.push(<ul key={`${b}-${blocks.length}`}>{bullets.map((item, i) => <li key={i}>{item}</li>)}</ul>)
      bullets = []
    }
    for (const line of lines) {
      const bullet = line.match(/^\s*[-•*]\s+(.*)/)
      if (bullet) {
        bullets.push(bullet[1])
      } else {
        flush()
        blocks.push(<p key={`${b}-${blocks.length}`}>{line}</p>)
      }
    }
    flush()
  })
  return <>{blocks}</>
}

// The language a learner picked on any code block. Every block on the page follows it,
// so choosing Java once shows Java everywhere it exists.
const LANGUAGE_KEY = 'structura:code-language'
const ORDER: CodeLanguage[] = ['javascript', 'java', 'typescript', 'python', 'go', 'sql', 'bash']
const NAMES: Record<CodeLanguage, string> = {
  javascript: 'JavaScript',
  java: 'Java',
  typescript: 'TypeScript',
  python: 'Python',
  go: 'Go',
  sql: 'SQL',
  bash: 'Bash',
}
const listeners = new Set<() => void>()
let picked: CodeLanguage = (() => {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY) as CodeLanguage | null
    return saved && ORDER.includes(saved) ? saved : 'javascript'
  } catch {
    return 'javascript'
  }
})()

function pickLanguage(language: CodeLanguage) {
  picked = language
  try {
    localStorage.setItem(LANGUAGE_KEY, language)
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function CodeBlock({ snippet }: { snippet: CodeSnippet }) {
  const [copied, setCopied] = useState(false)
  const preferred = useSyncExternalStore(subscribe, () => picked, () => picked)
  const versions = [{ language: snippet.language, source: snippet.source }, ...(snippet.versions ?? [])].sort(
    (a, b) => ORDER.indexOf(a.language) - ORDER.indexOf(b.language),
  )
  const shown = versions.find((v) => v.language === preferred) ?? versions[0]
  async function copy() {
    try {
      await navigator.clipboard.writeText(shown.source)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked (e.g. plain http on another device); the code is still selectable.
    }
  }
  return (
    <figure className="code">
      <figcaption>
        <span>{snippet.title}</span>
        {versions.length === 1 && <span className="code-lang">{NAMES[shown.language]}</span>}
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      {versions.length > 1 && (
        <div className="code-tabs" role="tablist" aria-label={`${snippet.title}: language`}>
          {versions.map((v) => (
            <button
              key={v.language}
              type="button"
              role="tab"
              aria-selected={v === shown}
              className={v === shown ? 'is-on' : undefined}
              onClick={() => pickLanguage(v.language)}
            >
              {NAMES[v.language]}
            </button>
          ))}
        </div>
      )}
      <pre>
        <code>{shown.source}</code>
      </pre>
    </figure>
  )
}

/** "Try it with your own input": fields for a hand-written topic's simulator. */
export function SimulatorForm({ simulator, onRun }: { simulator: Simulator; onRun: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState(simulator.defaults)
  function submit(e: FormEvent) {
    e.preventDefault()
    onRun(values)
  }
  return (
    <form className="simulate" onSubmit={submit}>
      <h3>Try it with your own input</h3>
      {simulator.fields.map((field) => (
        <label key={field.id}>
          <span>{field.label}</span>
          {field.options ? (
            <select value={values[field.id]} onChange={(e) => setValues({ ...values, [field.id]: e.target.value })}>
              {field.options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ) : (
            <input
              value={values[field.id] ?? ''}
              placeholder={field.placeholder}
              onChange={(e) => setValues({ ...values, [field.id]: e.target.value })}
            />
          )}
        </label>
      ))}
      <button type="submit" className="assistant-chip">
        ▶ Run it through the system
      </button>
    </form>
  )
}
