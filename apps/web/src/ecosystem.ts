/**
 * Himanshu's learning apps, linked to each other. Each keeps its own data on the
 * device; they connect through links only (no shared accounts, no API calls).
 * Same list and link formats as DSA Atlas's packages/shared/src/ecosystem.ts
 * (see its docs/ecosystem.md). Keep the links stable: the other app builds them.
 */

export type EcoAppId = 'structura' | 'dsa-atlas'

export interface EcoApp {
  id: EcoAppId
  name: string
  url: string
  tagline: string
  /** Accent for the app's tile in the switcher. */
  color: string
}

export const ECOSYSTEM: EcoApp[] = [
  { id: 'structura', name: 'Structura', url: 'https://structura-web.netlify.app', tagline: 'System design you can see working', color: '#a78bfa' },
  { id: 'dsa-atlas', name: 'DSA Atlas', url: 'https://dsa-atz.netlify.app', tagline: 'DSA notes: brute force → optimal, complexity, revision', color: '#34d399' },
]

const urlOf = (id: EcoAppId) => ECOSYSTEM.find((a) => a.id === id)!.url

export const ecoLinks = {
  /** DSA Atlas problems the learner linked to this Structura topic. */
  dsaProblemsForTopic: (topicId: string) => `${urlOf('dsa-atlas')}/?page=problems&structura=${encodeURIComponent(topicId)}`,
}
