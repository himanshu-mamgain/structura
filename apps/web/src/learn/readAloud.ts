// Read the whole page aloud: the text a reader sees, in reading order, without code,
// tables, diagrams or buttons (they don't read well out loud). Spoken by learn/speech,
// so it uses the phone's own voice (or Kokoro, once downloaded), works offline and
// shows on the lock screen.

const SKIP = 'pre, code, table, svg, canvas, button, nav, figure, details, .reader-bar, .reader-kicker, .reader-toc, .reader-deeper, .asked-at, .diagram, .react-flow, [aria-hidden="true"], [data-no-read]'
const READ = 'h1, h2, h3, h4, p, li, blockquote, dt, dd, .note-callout > div'

export function readableText(root: HTMLElement): string {
  const parts: string[] = []
  root.querySelectorAll<HTMLElement>(READ).forEach((el) => {
    if (el.closest(SKIP)) return
    const clone = el.cloneNode(true) as HTMLElement
    // Blocks inside this one (a nested list, a quote's paragraphs) are read on their own turn.
    clone.querySelectorAll(READ).forEach((c) => c.remove())
    clone.querySelectorAll('ul, ol').forEach((c) => c.remove())
    clone.querySelectorAll(SKIP).forEach((c) => {
      // Inline code is part of the sentence ("run `npm install`"): keep its words; drop the rest.
      if (c.tagName === 'CODE' && !c.closest('pre')) c.replaceWith(c.textContent ?? '')
      else c.remove()
    })
    // Section numbers ("01") in headings aren't words.
    clone.querySelectorAll('span').forEach((sp) => {
      if (/^\s*\d+\s*$/.test(sp.textContent ?? '')) sp.remove()
    })
    let text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return
    // Headings and list items often don't end in a full stop; add one so the voice pauses.
    if (!/[.!?:;]$/.test(text)) text += '.'
    parts.push(text)
  })
  return parts.join(' ')
}
