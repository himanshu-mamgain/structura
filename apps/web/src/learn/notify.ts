import { useSyncExternalStore } from 'react'
import type { StaticTopic } from '../topics'
import { type Progress, readiness } from './progress'
import { planToday } from './today'

// Notifications, worked out in the browser from the learner's own progress:
//   - a daily study reminder (the "Today" plan) at a time the learner picks
//   - new topics since the last visit
//   - a nudge to finish a topic left half-done for 3 days
//   - review reminders 1, 3 and 7 days after finishing a topic
// They show in the bell inside the app. With phone notifications on, the
// upcoming ones are also handed to the push function (netlify/functions/push.mts),
// which sends each at its time; the learner's progress never leaves the browser.

export type NoticeKind = 'daily' | 'new' | 'nudge' | 'review'

export interface Notice {
  /** Stable, so the same reminder is never added or sent twice. */
  id: string
  kind: NoticeKind
  /** When it's due (ms since epoch). */
  at: number
  title: string
  body: string
  /** Where tapping it goes, e.g. "/?topic=kafka". */
  url: string
}

export interface NotifySettings {
  daily: boolean
  newTopics: boolean
  nudges: boolean
  reviews: boolean
  /** Local time for reminders, "HH:MM". */
  time: string
  /** Phone notifications are on (this browser is subscribed to push). */
  push: boolean
}

interface NotifyState {
  settings: NotifySettings
  /** Topic ids seen so far; null until the first visit, so nothing is "new" on day one. */
  known: string[] | null
  inbox: (Notice & { read?: boolean })[]
}

const KEY = 'structura:notify:v1'
const DAY = 24 * 60 * 60 * 1000
/** Reviews after finishing a topic, in days: spaced repetition. */
export const REVIEW_DAYS = [1, 3, 7]
/** A started topic untouched this long gets a nudge. */
export const NUDGE_AFTER_DAYS = 3
/** How far ahead reminders are scheduled; opening the app extends it. */
export const HORIZON_DAYS = 14
/** Reminders missed by more than this are dropped rather than shown late. */
const STALE = 2 * DAY

export const DEFAULT_SETTINGS: NotifySettings = { daily: true, newTopics: true, nudges: true, reviews: true, time: '19:00', push: false }

function load(): NotifyState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as NotifyState | null
    if (saved?.settings) return { settings: { ...DEFAULT_SETTINGS, ...saved.settings }, known: saved.known ?? null, inbox: saved.inbox ?? [] }
  } catch {
    // Unreadable: start fresh.
  }
  return { settings: DEFAULT_SETTINGS, known: null, inbox: [] }
}

let state = load()
const listeners = new Set<() => void>()

function save(next: NotifyState) {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: notifications just aren't remembered.
  }
  listeners.forEach((l) => l())
}

window.addEventListener('storage', (e) => {
  if (e.key === KEY) {
    state = load()
    listeners.forEach((l) => l())
  }
})

export function useNotify(): NotifyState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  )
}

export const notifySettings = () => state.settings

export function updateSettings(patch: Partial<NotifySettings>) {
  save({ ...state, settings: { ...state.settings, ...patch } })
}

/** The reminders still to come, for push. */
export const upcoming = (topics: StaticTopic[], progress: Progress, now: number, quizTotal: number) =>
  schedule(topics, progress, state.settings, now, quizTotal).filter((n) => n.at > now)

export function markRead(id?: string) {
  save({ ...state, inbox: state.inbox.map((n) => (id === undefined || n.id === id ? { ...n, read: true } : n)) })
}

// ─── Scheduling (pure, so it can be tested) ──────────────────────────────────

/** The reminder time on the day of `day` (local time), in ms. */
export function slotOn(day: number, time: string): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(day)
  d.setHours(h || 0, m || 0, 0, 0)
  return d.getTime()
}

const dateKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "A", "A and B", "A, B and C", or "A, B, C and 4 more". */
const list = (titles: string[]) =>
  titles.length > 3 ? `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more` : titles.length < 3 ? titles.join(' and ') : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`

/**
 * Every reminder from `now - STALE` to `HORIZON_DAYS` ahead, given the
 * learner's progress and settings, at most one study reminder (daily or nudge)
 * and one review per day. New topics aren't scheduled: see newTopicsNotice.
 */
export function schedule(topics: StaticTopic[], progress: Progress, settings: NotifySettings, now: number, quizTotal: number): Notice[] {
  const out: Notice[] = []
  const firstDay = now - STALE
  const lastDay = now + HORIZON_DAYS * DAY
  const p = (t: StaticTopic) => progress.topics[t.id]

  // Nudge: the most recently opened topic that isn't finished, once per absence.
  const nudgeDays = new Set<string>()
  if (settings.nudges) {
    const started = topics
      .filter((t) => p(t)?.lastOpenedAt && !p(t)?.completed)
      .sort((a, b) => (p(b)?.lastOpenedAt ?? 0) - (p(a)?.lastOpenedAt ?? 0))[0]
    if (started) {
      const opened = p(started)!.lastOpenedAt!
      const at = slotOn(opened + NUDGE_AFTER_DAYS * DAY, settings.time)
      if (at >= firstDay && at <= lastDay) {
        nudgeDays.add(dateKey(at))
        out.push({
          id: `nudge:${started.id}:${opened}`,
          kind: 'nudge',
          at,
          title: `You're ${readiness(started, p(started))}% ready on ${started.title}`,
          body: `It's been ${NUDGE_AFTER_DAYS} days. Pick up where you left off and finish it.`,
          url: `/?topic=${started.id}`,
        })
      }
    }
  }

  // Daily reminder: today's plan, from today on, on every day without a nudge.
  // (Yesterday's plan is out of date, so missed ones aren't shown late.)
  if (settings.daily) {
    const plan = planToday(topics, progress, quizTotal)
    for (let day = now; day <= lastDay; day += DAY) {
      const at = slotOn(day, settings.time)
      if (at > lastDay || nudgeDays.has(dateKey(at))) continue
      out.push({
        id: `daily:${dateKey(at)}`,
        kind: 'daily',
        at,
        title: `Today: ${plan.headline}`,
        body: plan.steps.length ? `${plan.steps.slice(0, 2).join(' · ')}` : plan.reason,
        url: plan.topic ? `/?topic=${plan.topic.id}` : '/?page=quiz',
      })
    }
  }

  // Reviews: 1, 3 and 7 days after finishing a topic; same-day reviews share one reminder.
  if (settings.reviews) {
    const byDay = new Map<string, { at: number; topics: StaticTopic[]; ids: string[] }>()
    for (const t of topics) {
      const done = p(t)?.completed ? p(t)?.completedAt : undefined
      if (!done) continue
      for (const days of REVIEW_DAYS) {
        const at = slotOn(done + days * DAY, settings.time)
        if (at < firstDay || at > lastDay) continue
        const key = dateKey(at)
        const entry = byDay.get(key) ?? { at, topics: [], ids: [] }
        entry.topics.push(t)
        entry.ids.push(`${t.id}:${days}`)
        byDay.set(key, entry)
      }
    }
    for (const [, { at, topics: due, ids }] of byDay) {
      out.push({
        id: `review:${ids.sort().join(',')}`,
        kind: 'review',
        // A minute after the study reminder, so the two don't collapse into one.
        at: at + 60_000,
        title: `Review: ${list(due.map((t) => t.title))}`,
        body: due.length === 1 ? 'Answer its interview follow-ups out loud, without looking.' : 'Answer their interview follow-ups out loud, without looking.',
        url: `/?topic=${due[0].id}&review`,
      })
    }
  }

  return out.sort((a, b) => a.at - b.at)
}

/** "New topics: …" for topics not seen before, or null. */
export function newTopicsNotice(topics: StaticTopic[], known: string[] | null, now: number): Notice | null {
  if (!known) return null
  const fresh = topics.filter((t) => !known.includes(t.id))
  if (!fresh.length) return null
  return {
    id: `new:${fresh.map((t) => t.id).join(',')}`,
    kind: 'new',
    at: now,
    title: fresh.length === 1 ? `New topic: ${fresh[0].title}` : `${fresh.length} new topics`,
    body: fresh.length === 1 ? fresh[0].blurb : list(fresh.map((t) => t.title)),
    url: `/?topic=${fresh[0].id}`,
  }
}

// ─── Keeping the inbox up to date ────────────────────────────────────────────

/**
 * Adds what's due to the inbox and returns the reminders still to come (for
 * push). Run when the app opens, every minute while it's open, and when
 * progress changes.
 */
export function refresh(topics: StaticTopic[], progress: Progress, now: number, quizTotal: number): Notice[] {
  const all = schedule(topics, progress, state.settings, now, quizTotal)
  const due = all.filter((n) => n.at <= now)
  const fresh = state.settings.newTopics ? newTopicsNotice(topics, state.known, now) : null
  if (fresh) due.push(fresh)

  const have = new Set(state.inbox.map((n) => n.id))
  const added = due.filter((n) => !have.has(n.id))
  const ids = topics.map((t) => t.id)
  const knownChanged = !state.known || ids.some((id) => !state.known!.includes(id))
  if (added.length || knownChanged) {
    // Newest first; keep two weeks, at most 30.
    const inbox = [...added, ...state.inbox].filter((n) => n.at > now - HORIZON_DAYS * DAY).sort((a, b) => b.at - a.at).slice(0, 30)
    save({ ...state, known: ids, inbox })
  }
  return all.filter((n) => n.at > now)
}
