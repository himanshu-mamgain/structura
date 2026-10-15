import type { Trace } from '@structura/shared'
import type { StaticTopic } from '../topics'

// What the component inspector shows for a box: its responsibility (read from
// the topic's own "Components" section, so no extra data to maintain), its
// connections, and the walkthrough steps that pass through it.

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()

/** Labels match loosely: "Memory Cache (Redis)" matches "memory cache". */
export function sameComponent(a: string, b: string): boolean {
  const x = normalize(a)
  const y = normalize(b)
  return x === y || (x.length > 3 && y.length > 3 && (x.startsWith(y) || y.startsWith(x)))
}

/** The "- Name: what it does" line about a box in the Components section, if there is one. */
export function responsibility(topic: StaticTopic, label: string): string | null {
  const section = topic.explanation.sections.find((s) => /component/i.test(s.heading))
  if (!section) return null
  for (const line of section.body.split('\n')) {
    const m = line.match(/^\s*-\s*([^:]+):\s*(.+)$/)
    if (m && sameComponent(m[1], label)) return m[2].charAt(0).toUpperCase() + m[2].slice(1)
  }
  return null
}

/** Indexes of the walkthrough steps that involve a box. */
export function stepsThrough(trace: Trace | null, label: string): number[] {
  if (!trace) return []
  return trace.steps.flatMap((step, i) => (step.nodes.some((n) => sameComponent(n, label)) ? [i] : []))
}

/** What happens when a box is down, in one line: caches degrade, everything else fails. */
export function failureEffect(label: string, broken: number, total: number): string {
  if (/cache|redis|cdn/i.test(label)) {
    return `With the cache off, every read falls through to the database: slower responses and much more database load. ${broken} of ${total} steps lose their shortcut.`
  }
  if (/queue|kafka|stream/i.test(label)) {
    return `Producers can't hand off work: requests either wait, buffer, or drop events. ${broken} of ${total} steps stall.`
  }
  if (/replica|read/i.test(label)) return `Reads move to the remaining copies, which now carry more load. ${broken} of ${total} steps are affected.`
  return `Requests that need it fail or time out: ${broken} of ${total} steps break. Redundancy (more instances, failover) is what keeps this from being an outage.`
}
