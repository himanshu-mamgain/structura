import { useState, type FormEvent, type ReactNode } from 'react'
import type { CodeSnippet } from '@structura/shared'
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

export function CodeBlock({ snippet }: { snippet: CodeSnippet }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet.source)
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
        <span className="code-lang">{snippet.language}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{snippet.source}</code>
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
