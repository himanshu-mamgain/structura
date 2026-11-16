import data from '../topics/askedAt.json'

// Which companies asked each topic in interviews (src/topics/askedAt.json), from public
// candidate reports. Every report links to where it was reported, so a learner can check it.
// A "similar" report is a close variant of the topic's design (a news feed for the Twitter
// timeline, top-K trending for the sales rank), not the same question.

export interface Report {
  company: string
  /** The question as the candidate reported it. */
  question: string
  url: string
  /** A key of `sources`: where the report was found. */
  source: string
  /** When it was reported (YYYY-MM-DD), if the source says. */
  date?: string
  similar?: boolean
}

export interface AskedCompany {
  id: string
  name: string
  reports: Report[]
  /** Only close variants were reported here, not the question itself. */
  similarOnly: boolean
}

const companies: Record<string, string> = data.companies
const topics = data.topics as Record<string, Report[]>
const sources: Record<string, { name: string; about: string }> = data.sources
// Companies are listed in this order: the best known first.
const ORDER = Object.keys(companies)

/** When the reports were last searched for. */
export const CHECKED: string = data.checked

export const companyName = (id: string) => companies[id] ?? id
export const sourceOf = (report: Report) => sources[report.source] ?? { name: report.source, about: '' }

/** The companies that asked this topic: those that asked the question itself first. */
export function askedAt(topicId: string): AskedCompany[] {
  const byCompany = new Map<string, Report[]>()
  for (const report of topics[topicId] ?? []) byCompany.set(report.company, [...(byCompany.get(report.company) ?? []), report])
  return [...byCompany]
    .map(([id, reports]) => ({ id, name: companyName(id), reports, similarOnly: reports.every((r) => r.similar) }))
    .sort((a, b) => Number(a.similarOnly) - Number(b.similarOnly) || ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
}

/** The topics a company asked, for a company's prep guide. */
export function topicsAskedAt(company: string): string[] {
  return Object.keys(topics).filter((id) => topics[id].some((r) => r.company === company))
}

/** "Aug 2026" for a report's date. */
export function monthOf(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
