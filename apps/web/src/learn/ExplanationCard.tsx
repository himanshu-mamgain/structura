import { useState, type FormEvent, type ReactNode } from 'react'
import type { CodeSnippet, Explanation } from '@structura/shared'
import type { Simulator } from '../topics/simulator'
import type { WalkStep } from './walkthrough'

/** Renders a section body: paragraphs split by blank lines, "- " lines as bullet lists. */
function Body({ text }: { text: string }) {
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

function CodeBlock({ snippet }: { snippet: CodeSnippet }) {
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
function SimulatorForm({ simulator, onRun }: { simulator: Simulator; onRun: (values: Record<string, string>) => void }) {
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

export interface WalkState {
  index: number
  steps: WalkStep[]
  playing: boolean
}

/** The in-depth explanation of a concept, shown beside the canvas while it streams in. */
export function ExplanationCard({
  explanation,
  streaming,
  walk,
  canWalk,
  simulator,
  onAsk,
  onClose,
  onWalkStart,
  onWalkStep,
  onWalkToggle,
  onWalkStop,
  onSimulate,
}: {
  explanation: Explanation
  streaming: boolean
  walk: WalkState | null
  canWalk: boolean
  simulator?: Simulator
  onAsk: (question: string) => void
  onClose: () => void
  onWalkStart: () => void
  onWalkStep: (delta: number) => void
  onWalkToggle: () => void
  onWalkStop: () => void
  onSimulate: (values: Record<string, string>) => void
}) {
  const step = walk?.steps[walk.index]
  return (
    <aside className="explain" aria-label={`Explanation: ${explanation.title}`}>
      <header className="explain-header">
        <h2>{explanation.title}</h2>
        <button type="button" className="assistant-icon-btn" onClick={onClose} aria-label="Close explanation">
          ×
        </button>
      </header>

      {walk && step && (
        <div className="walk" aria-live="polite">
          <div className="walk-head">
            <span>
              Step {walk.index + 1} of {walk.steps.length}
            </span>
            <span className="walk-controls">
              <button type="button" onClick={() => onWalkStep(-1)} disabled={walk.index === 0} aria-label="Previous step">
                ⏮
              </button>
              <button type="button" onClick={onWalkToggle} aria-label={walk.playing ? 'Pause' : 'Play'}>
                {walk.playing ? '⏸' : '▶'}
              </button>
              <button
                type="button"
                onClick={() => onWalkStep(1)}
                disabled={walk.index === walk.steps.length - 1}
                aria-label="Next step"
              >
                ⏭
              </button>
              <button type="button" onClick={onWalkStop} aria-label="Stop walkthrough">
                ■
              </button>
            </span>
          </div>
          <p>{step.text}</p>
          {step.data && <pre className="walk-data">{step.data}</pre>}
        </div>
      )}

      <div className="explain-scroll">
        {explanation.summary && <p className="explain-summary">{explanation.summary}</p>}
        {canWalk && !walk && !streaming && (
          <button type="button" className="assistant-chip" onClick={onWalkStart}>
            ▶ Walk me through it
          </button>
        )}
        {simulator && !streaming && <SimulatorForm simulator={simulator} onRun={onSimulate} />}

        {explanation.sections.map((section, i) => (
          <section key={i}>
            <h3>{section.heading}</h3>
            <Body text={section.body} />
          </section>
        ))}

        {explanation.trace && explanation.trace.steps.length > 0 && (
          <section>
            <h3>End to end: {explanation.trace.input}</h3>
            <ol className="trace">
              {explanation.trace.steps.map((s, i) => (
                <li key={i} className={walk?.index === i ? 'is-current' : undefined}>
                  {s.text}
                  {s.data && <pre className="walk-data">{s.data}</pre>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {explanation.code.length > 0 && (
          <section>
            <h3>Code</h3>
            {explanation.code.map((snippet, i) => (
              <CodeBlock key={i} snippet={snippet} />
            ))}
          </section>
        )}

        {streaming && <p className="explain-streaming">Writing…</p>}
        {!streaming && explanation.related.length > 0 && (
          <section>
            <h3>Learn next</h3>
            <div className="explain-related">
              {explanation.related.map((topic) => (
                <button key={topic} type="button" onClick={() => onAsk(`Explain ${topic}`)}>
                  {topic}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
