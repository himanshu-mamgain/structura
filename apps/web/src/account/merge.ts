import type { Progress, TopicProgress } from '../learn/progress'

// Merges two copies of a learner's progress, e.g. this phone's and the one saved in
// their account. Anything that only grows (sections read, a lesson finished, the best
// score) is combined, so no device's work is lost. Switches the learner can turn off
// again (bookmarked, completed) come from whichever copy changed that topic last.

const max = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b))
const min = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b))

export function mergeTopic(a: TopicProgress | undefined, b: TopicProgress | undefined): TopicProgress {
  if (!a) return b ?? {}
  if (!b) return a
  const [older, newer] = (a.updatedAt ?? 0) <= (b.updatedAt ?? 0) ? [a, b] : [b, a]
  // The video position comes from the copy that watched last.
  const watched = (a.lastWatchedAt ?? 0) >= (b.lastWatchedAt ?? 0) ? a : b
  const merged: TopicProgress = {
    ...older,
    ...newer,
    sectionsRead: [...new Set([...(a.sectionsRead ?? []), ...(b.sectionsRead ?? [])])].sort((x, y) => x - y),
    storyRead: a.storyRead || b.storyRead || undefined,
    walked: a.walked || b.walked || undefined,
    lessonDone: a.lessonDone || b.lessonDone || undefined,
    lessonScore: max(a.lessonScore, b.lessonScore),
    videoTime: watched.videoTime,
    videoDuration: watched.videoDuration ?? newer.videoDuration,
    lastWatchedAt: max(a.lastWatchedAt, b.lastWatchedAt),
    lastOpenedAt: max(a.lastOpenedAt, b.lastOpenedAt),
    updatedAt: max(a.updatedAt, b.updatedAt),
  }
  if (merged.completed) merged.completedAt = min(a.completed ? a.completedAt : undefined, b.completed ? b.completedAt : undefined) ?? newer.completedAt
  if (!merged.sectionsRead?.length) delete merged.sectionsRead
  // Leave out empty fields, so equal progress gives equal JSON.
  for (const key of Object.keys(merged) as (keyof TopicProgress)[]) if (merged[key] === undefined) delete merged[key]
  return merged
}

export function mergeProgress(a: Progress, b: Progress): Progress {
  const topics: Record<string, TopicProgress> = {}
  for (const id of new Set([...Object.keys(a.topics ?? {}), ...Object.keys(b.topics ?? {})])) topics[id] = mergeTopic(a.topics?.[id], b.topics?.[id])
  const reels = { ...a.reels }
  for (const [id, r] of Object.entries(b.reels ?? {})) if (!reels[id] || r.at > reels[id].at) reels[id] = r
  const merged: Progress = { ...a, ...b, topics }
  if (Object.keys(reels).length) merged.reels = reels
  const quizBest = max(a.quizBest, b.quizBest)
  if (quizBest !== undefined) merged.quizBest = quizBest
  // Ticked roadmap steps: kept from both (the earliest tick).
  const roadmap: Record<string, number> = { ...b.roadmap }
  for (const [id, at] of Object.entries(a.roadmap ?? {})) roadmap[id] = min(at, roadmap[id])!
  if (Object.keys(roadmap).length) merged.roadmap = roadmap
  return merged
}

/** The same progress, written the same way: for "has anything changed?". */
export function stable(p: Progress): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v
  return JSON.stringify(sort(p))
}
