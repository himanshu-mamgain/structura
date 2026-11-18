// The checks every deep note (src/topics/notes/<id>.md) must pass: the parts a learner
// relies on are there, and no abbreviation is used before it is explained. The rules
// themselves are in CLAUDE.md, "Notes that explain everything"; `npm run catalog` (and so
// every build) stops on a failure, and `npm run test:notes` runs the same checks.

/** Sections every note ends with, so a reader always finds them. */
export const REQUIRED_SECTIONS = ['How to choose', '⚠️ Critical Mistakes', 'Interview Q&As', 'Related topics', 'Sources', 'Why This Matters']

/**
 * Abbreviations a learner already knows, or that are names rather than shortenings
 * (AMD, ARM, licence names, HTTP methods). Everything else is spelled out where it first appears.
 */
export const KNOWN_ABBREVIATIONS = new Set([
  'AI', 'API', 'ASCII', 'AWS', 'CPU', 'CSS', 'CSV', 'DB', 'DNS', 'GB', 'HTML', 'HTTP', 'HTTPS', 'ID', 'IP', 'JSON', 'JS', 'KB', 'MB',
  'OK', 'OS', 'PB', 'PDF', 'RAM', 'SQL', 'SSD', 'TB', 'TCP', 'TLS', 'SSL', 'UDP', 'UI', 'URL', 'URI', 'USB', 'UTC', 'UTF', 'XML', 'YAML',
  // names, not shortenings to decode
  'AMD', 'ARM', 'IBM', 'INR', 'USD', 'US', 'UK', 'EU', 'MIT', 'GPL', 'BSD', 'CC', 'BY', 'NC', 'ND', 'SA',
  // HTTP methods
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
])

/** Ways a note may explain an abbreviation where it first appears. */
function explained(line: string, start: number, end: number): boolean {
  const before = line.slice(0, start)
  const after = line.slice(end)
  // "ENI (a network card…)", "a NAT gateway (…)" (up to two words in between), or "elastic network interface (ENI)"
  if (/^(\s+[\w-]+){0,2}\s\(/.test(after) || (before.endsWith('(') && after.startsWith(')'))) return true
  if (/^ (is|are|means|stands for)\b/.test(after)) return true // "IAM is who can do what"
  if (before.lastIndexOf('⟪') > before.lastIndexOf('⟫')) return true // inside a link to the topic that teaches it
  // A table cell that is just the term, as in an "at a glance" table: "| ECR | AWS's private Docker registry |"
  return /\|\s*$/.test(before) && /^\s*\|/.test(after)
}

/** Problems with one note, in reading order; empty when it passes. */
export function checkNote(markdown: string): string[] {
  const problems: string[] = []
  const lines = markdown.split('\n')
  const text = lines.map((l) => l.trim())
  const firstText = text.findIndex((l) => l)
  if (!text[firstText]?.startsWith('# ')) problems.push('The note must start with "# Title".')
  const afterTitle = text.slice(firstText + 1).find((l) => l)
  if (!afterTitle?.startsWith('> 💡 **TL;DR**')) problems.push('A "> 💡 **TL;DR**:" callout must come straight after the title.')

  const headings = text.map((l, i) => [l, i] as const).filter(([l]) => /^## /.test(l))
  const names = headings.map(([l]) => l.slice(3).trim())
  // "## How to choose: container, VM or serverless?" counts as "How to choose".
  for (const s of REQUIRED_SECTIONS) if (!names.some((n) => n === s || n.startsWith(`${s}:`) || n.startsWith(`${s} `))) problems.push(`Missing "## ${s}".`)
  headings.forEach(([l, i], k) => {
    const end = headings[k + 1]?.[1] ?? text.length
    if (!text.slice(i + 1, end).some((x) => x && x !== '---')) problems.push(`"${l}" is empty.`)
  })
  const qa = headings.findIndex(([l]) => l === '## Interview Q&As')
  if (qa >= 0) {
    const body = text.slice(headings[qa][1] + 1, headings[qa + 1]?.[1] ?? text.length).filter((l) => l)
    const questions = body.filter((l) => l.startsWith('**Q:')).length
    const answers = body.filter((l) => l.startsWith('A:')).length
    if (questions < 3) problems.push(`"## Interview Q&As" has ${questions} questions (at least 3).`)
    if (answers !== questions) problems.push(`"## Interview Q&As" has ${questions} questions but ${answers} answers ("A: …").`)
  }

  // Abbreviations: explained where they first appear in the text a learner reads. Code,
  // headings, link addresses and the Sources list (other people's titles) don't count.
  const seen = new Set<string>()
  let fence = false
  let section = ''
  lines.forEach((raw, n) => {
    if (raw.trim().startsWith('```')) fence = !fence
    if (fence || raw.trim().startsWith('```')) return
    if (raw.startsWith('#')) {
      section = raw.replace(/^#+\s*/, '')
      return
    }
    if (section === 'Sources') return
    const line = raw
      .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
      .replace(/\[([^\]]*)\]\((?:\/\?topic=|\/topic\/)[^)]*\)/g, '⟪$1⟫') // a link to a Structura topic
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|\*|_/g, '')
      .replace(/TL;DR/g, '')
    for (const m of line.matchAll(/(?<![\w/.@-])([A-Z][A-Z0-9]{1,6})(s?)(?![\w/@-])/g)) {
      const word = m[1]
      if (!/[A-Z].*[A-Z0-9]/.test(word) || KNOWN_ABBREVIATIONS.has(word) || seen.has(word)) continue
      seen.add(word)
      const start = m.index! + m[0].length - m[1].length - m[2].length
      if (!explained(line, start, start + word.length + m[2].length)) {
        problems.push(`Line ${n + 1}: "${word}" isn't explained where it first appears. Write it out or say what it is in brackets, e.g. "${word} (…)".`)
      }
    }
  })
  return problems
}
