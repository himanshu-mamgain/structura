import type { ReactNode } from 'react'
import type { Explanation } from '@structura/shared'

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

/** The in-depth explanation of a concept, shown beside the canvas while it streams in. */
export function ExplanationCard({
  explanation,
  streaming,
  onAsk,
  onClose,
}: {
  explanation: Explanation
  streaming: boolean
  onAsk: (question: string) => void
  onClose: () => void
}) {
  return (
    <aside className="explain" aria-label={`Explanation: ${explanation.title}`}>
      <header className="explain-header">
        <h2>{explanation.title}</h2>
        <button type="button" className="assistant-icon-btn" onClick={onClose} aria-label="Close explanation">
          ×
        </button>
      </header>
      <div className="explain-scroll">
        {explanation.summary && <p className="explain-summary">{explanation.summary}</p>}
        {explanation.sections.map((section, i) => (
          <section key={i}>
            <h3>{section.heading}</h3>
            <Body text={section.body} />
          </section>
        ))}
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
