import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { BookOpenText, Clapperboard, Volume2 } from 'lucide-react'
import type { Story } from '../topics/types'

// A topic's story: read like an article, chapter by chapter, with buttons that
// replay a chapter's moment on the diagram through the topic's simulator.

const WORDS_PER_MINUTE = 200

export function storyWords(story: Story): number {
  const text = [story.title, story.dek, ...story.chapters.flatMap((c) => [c.heading, c.body])].join(' ')
  return text.split(/\s+/).filter(Boolean).length
}

export const readingMinutes = (story: Story) => Math.max(1, Math.round(storyWords(story) / WORDS_PER_MINUTE))

/** The story as plain sentences, for reading aloud. */
export function storyText(story: Story): string {
  const plain = (s: string) => s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*(>|-)\s+/gm, '')
  return [story.title + '.', ...story.chapters.map((c) => `${c.heading}. ${plain(c.body)}`)].join('\n\n')
}

/** `code` and **bold** inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    return <Fragment key={i}>{part}</Fragment>
  })
}

function ChapterBody({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  text.split(/\n\s*\n/).forEach((block, b) => {
    // Within a block, runs of "- " lines are a list, "> " lines a pull quote, the rest a paragraph.
    let kind: 'p' | 'ul' | 'quote' | null = null
    let lines: string[] = []
    const flush = () => {
      if (!kind || !lines.length) return
      const key = `${b}-${blocks.length}`
      if (kind === 'ul')
        blocks.push(
          <ul key={key}>
            {lines.map((l, i) => (
              <li key={i}>{inline(l)}</li>
            ))}
          </ul>,
        )
      else if (kind === 'quote') blocks.push(<blockquote key={key}>{inline(lines.join(' '))}</blockquote>)
      else blocks.push(<p key={key}>{inline(lines.join(' '))}</p>)
      lines = []
    }
    for (const raw of block.split('\n').filter((l) => l.trim())) {
      const bullet = raw.match(/^\s*[-•]\s+(.*)/)
      const quote = raw.match(/^\s*>\s?(.*)/)
      const next = bullet ? 'ul' : quote ? 'quote' : 'p'
      if (next !== kind) flush()
      kind = next
      lines.push(bullet ? bullet[1] : quote ? quote[1] : raw)
    }
    flush()
  })
  return <>{blocks}</>
}

export function StoryView({
  story,
  onReplay,
  onListen,
  onFinished,
  listening,
}: {
  story: Story
  /** Plays a chapter's moment on the diagram; missing when the topic has no simulator. */
  onReplay?: (values: Record<string, string>) => void
  onListen?: () => void
  /** Called once when the reader reaches the end. */
  onFinished?: () => void
  /** Shown instead of the text while the story is read aloud. */
  listening?: ReactNode
}) {
  const end = useRef<HTMLDivElement>(null)
  const finished = useRef(onFinished)
  finished.current = onFinished

  useEffect(() => {
    const el = end.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        finished.current?.()
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [story])

  return (
    <article className="story">
      <header className="story-head">
        <p className="story-kicker">
          <BookOpenText size={15} aria-hidden /> Story · {readingMinutes(story)} min read
          {onListen && (
            <button type="button" className="listen-btn" onClick={onListen} title="Listen to the story">
              <Volume2 size={16} />
            </button>
          )}
        </p>
        <h2>{story.title}</h2>
        <p className="story-dek">{story.dek}</p>
        <ol className="story-toc">
          {story.chapters.map((c, i) => (
            <li key={c.heading}>
              <a
                href={`#story-${i + 1}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(`story-${i + 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                <span>Chapter {i + 1}</span> {c.heading}
              </a>
            </li>
          ))}
        </ol>
      </header>

      {listening ??
        story.chapters.map((c, i) => (
          <section key={c.heading} id={`story-${i + 1}`} className="story-chapter">
            <h3>
              <span>Chapter {i + 1}</span>
              {c.heading}
            </h3>
            <ChapterBody text={c.body} />
            {c.replay && onReplay && (
              <button type="button" className="story-replay" onClick={() => onReplay(c.replay!.values)}>
                <Clapperboard size={16} aria-hidden /> {c.replay.label}
              </button>
            )}
          </section>
        ))}
      <div ref={end} className="story-end" aria-hidden>
        ◆
      </div>
    </article>
  )
}
