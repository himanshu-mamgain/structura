import { CopyLink } from './Share'
import { Bot, Braces, Briefcase, CodeXml, ExternalLink, type LucideIcon, Network, Route } from 'lucide-react'
import { AGENTIC_QUESTIONS } from '../learn/agenticQuestions'
import { Body } from '../learn/content'
import { TOPICS } from '../topics/catalog'
import { ECOSYSTEM } from '../ecosystem'
import type { Guide } from '../topics/library'
import { useLibrary } from '../topics/useLibrary'

// Interview prep (?page=prep, in the Practice tab): the best open repositories for each
// round, from the library's prep-* categories (scripts/kb-sync.mjs). They're linked only;
// each keeps its own licence.

const GROUPS: { id: string; title: string; line: string; icon: LucideIcon }[] = [
  { id: 'prep-dsa', title: 'DSA', line: 'Algorithms, data structures and the problem lists most coding rounds draw from.', icon: Braces },
  { id: 'prep-system-design', title: 'System design', line: 'Concepts, worked designs and quick revision for the design round.', icon: Network },
  { id: 'prep-javascript', title: 'JavaScript and Node.js', line: 'Language questions and what senior Node.js rounds tend to probe.', icon: CodeXml },
  { id: 'prep-process', title: 'The whole process', line: 'Resume, behavioural rounds, study plans and negotiation.', icon: Briefcase },
]

const dsaAtlas = ECOSYSTEM.find((app) => app.id === 'dsa-atlas')

/** "owner/repo: what it is" → the repository and the description. */
function split(title: string): [string, string] {
  const at = title.indexOf(': ')
  if (at < 0) return [title, '']
  const what = title.slice(at + 2)
  return [title.slice(0, at), what.charAt(0).toUpperCase() + what.slice(1)]
}

export function Prep({ onRoadmap }: { onRoadmap: () => void }) {
  const lib = useLibrary()
  const inGroup = (id: string): Guide[] => lib?.LIBRARY.guides.filter((g) => g.categories.includes(id)) ?? []

  return (
    <div className="prep">
      <header className="prep-head">
        <h1>Interview prep</h1>
        <p>The best free repositories for each round of a technical interview. They open on GitHub.</p>
        <CopyLink className="btn btn-ghost page-copy" />
      </header>

      <AgenticQuestions />

      {!lib && <p className="practice-empty">Loading…</p>}

      {lib &&
        GROUPS.map(({ id, title, line, icon: Icon }) => (
          <section key={id} className="prep-group" aria-label={title}>
            <h2>
              <Icon size={19} aria-hidden /> {title}
            </h2>
            <p className="prep-line">{line}</p>
            <div className="prep-cards">
              {inGroup(id).map((g) => {
                const [repo, what] = split(g.title)
                return (
                  <a key={g.slug} className="card prep-card" href={g.url} target="_blank" rel="noreferrer">
                    <strong>{what || repo}</strong>
                    <code>{repo}</code>
                    {g.note && <span>{g.note}</span>}
                    <small>
                      {g.tags.join(' · ')} <ExternalLink size={12} aria-hidden />
                    </small>
                  </a>
                )
              })}
              {/* Practise in the owner's own apps alongside the reading. */}
              {id === 'prep-dsa' && dsaAtlas && (
                <a className="card prep-card is-own" href={dsaAtlas.url} target="_blank" rel="noreferrer">
                  <strong>Practise them in {dsaAtlas.name}</strong>
                  <code>your DSA notes</code>
                  <span>{dsaAtlas.tagline}.</span>
                  <small>
                    Your app <ExternalLink size={12} aria-hidden />
                  </small>
                </a>
              )}
              {id === 'prep-system-design' && (
                <button type="button" className="card prep-card is-own" onClick={onRoadmap}>
                  <strong>Follow Structura's roadmap</strong>
                  <code>here</code>
                  <span>Development, Infra, Databases and AI, from Foundations to Expert, with every design to try yourself.</span>
                  <small>
                    <Route size={12} aria-hidden /> Open the roadmap
                  </small>
                </button>
              )}
            </div>
          </section>
        ))}
    </div>
  )
}

const titleOf = (id: string) => TOPICS.find((t) => t.id === id)?.title ?? id

/**
 * Agentic AI interview questions (?page=prep#agentic): Structura's own answers, each with what
 * interviewers listen for, the usual mistakes, and the topics that teach it. Tap to open one;
 * #q-<id> opens that one directly.
 */
function AgenticQuestions() {
  const opened = typeof location !== 'undefined' ? location.hash.replace(/^#q-/, '') : ''
  return (
    <section id="agentic" className="prep-group prep-questions" aria-label="Agentic AI interview questions">
      <h2>
        <Bot size={19} aria-hidden /> Agentic AI interview questions
      </h2>
      <p className="prep-line">{AGENTIC_QUESTIONS.length} questions asked in AI engineering rounds. Think of your answer first, then open one.</p>
      <div className="prep-qs">
        {AGENTIC_QUESTIONS.map((q, i) => (
          <details key={q.id} id={`q-${q.id}`} className="card prep-q" open={opened === q.id}>
            <summary>
              <span className="prep-q-n">{i + 1}</span>
              <span className="prep-q-text">{q.question}</span>
              <span className={`prep-q-level is-${q.level.toLowerCase()}`}>{q.level}</span>
            </summary>
            <div className="prep-q-body">
              <Body text={q.answer} from="prep" />
              <h3>What interviewers listen for</h3>
              <ul>
                {q.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <h3>Weak answers</h3>
              <ul className="prep-q-mistakes">
                {q.mistakes.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
              <p className="prep-q-learn">
                Learn it in:{' '}
                {q.topics.map((id, j) => (
                  <span key={id}>
                    {j > 0 && ' · '}
                    <a href={`/topic/${id}/?read`} className="topic-link" data-topic-link>
                      {titleOf(id)}
                    </a>
                  </span>
                ))}
              </p>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
