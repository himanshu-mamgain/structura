import { Building2, ChevronDown, ExternalLink } from 'lucide-react'
import { askedAt, CHECKED, monthOf, sourceOf } from '../learn/askedAt'

// "Asked at Amazon, Google, Meta…" under a topic's title. Tapping it lists each report:
// the question as the candidate wrote it, where it was reported and when, with a link.

const SHOWN = 4

export function AskedAt({ topicId }: { topicId: string }) {
  const companies = askedAt(topicId)
  if (!companies.length) return null
  const more = companies.length - SHOWN
  return (
    <details className="asked-at">
      <summary>
        <span className="asked-label">
          <Building2 size={15} aria-hidden /> Asked at
        </span>
        {companies.slice(0, SHOWN).map((c) => (
          <span key={c.id} className={`asked-chip${c.similarOnly ? ' is-similar' : ''}`}>
            {c.name}
          </span>
        ))}
        {more > 0 && <span className="asked-more">+{more}</span>}
        <ChevronDown className="asked-toggle" size={16} aria-hidden />
      </summary>
      <ul className="asked-list">
        {companies.map((c) => (
          <li key={c.id}>
            <strong>{c.name}</strong>
            {c.reports.map((r) => (
              <a key={r.url} href={r.url} target="_blank" rel="noreferrer">
                <span className="asked-question">
                  “{r.question}”{r.similar && <span className="asked-similar">similar</span>}
                </span>
                <small>
                  {sourceOf(r).name}
                  {r.date ? `, ${monthOf(r.date)}` : ''} <ExternalLink size={12} aria-hidden />
                </small>
              </a>
            ))}
          </li>
        ))}
      </ul>
      <p className="asked-note">
        From candidates' own interview reports, as they wrote them. <em>Similar</em> means a close variant of this design. Checked{' '}
        {new Date(`${CHECKED}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}.
      </p>
    </details>
  )
}
