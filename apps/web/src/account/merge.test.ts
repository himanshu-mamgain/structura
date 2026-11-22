// npm run test:sync: merging two devices' progress keeps both devices' work.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Progress } from '../learn/progress'
import { mergeProgress, stable } from './merge'

test('work done on either device is kept', () => {
  const phone: Progress = { topics: { 'rate-limiter': { sectionsRead: [0, 1], walked: true, updatedAt: 100 } }, quizBest: 7 }
  const laptop: Progress = { topics: { 'rate-limiter': { sectionsRead: [1, 2, 3], lessonDone: true, lessonScore: 2, updatedAt: 200 }, kafka: { storyRead: true, updatedAt: 50 } }, quizBest: 9 }
  const merged = mergeProgress(phone, laptop)
  assert.deepEqual(merged.topics['rate-limiter'].sectionsRead, [0, 1, 2, 3])
  assert.equal(merged.topics['rate-limiter'].walked, true)
  assert.equal(merged.topics['rate-limiter'].lessonDone, true)
  assert.equal(merged.topics.kafka.storyRead, true)
  assert.equal(merged.quizBest, 9)
})

test('a switch turned off later stays off', () => {
  const before: Progress = { topics: { cdn: { bookmarked: true, updatedAt: 100 } } }
  const after: Progress = { topics: { cdn: { bookmarked: false, updatedAt: 300 } } }
  assert.equal(mergeProgress(before, after).topics.cdn.bookmarked, false)
  assert.equal(mergeProgress(after, before).topics.cdn.bookmarked, false)
})

test('the video position comes from the device that watched last', () => {
  const a: Progress = { topics: { kafka: { videoTime: 40, videoDuration: 120, lastWatchedAt: 500, updatedAt: 900 } } }
  const b: Progress = { topics: { kafka: { videoTime: 100, videoDuration: 120, lastWatchedAt: 800, updatedAt: 600 } } }
  assert.equal(mergeProgress(a, b).topics.kafka.videoTime, 100)
})

test('completed keeps the first time it was completed', () => {
  const a: Progress = { topics: { pastebin: { completed: true, completedAt: 1000, updatedAt: 1000 } } }
  const b: Progress = { topics: { pastebin: { completed: true, completedAt: 3000, updatedAt: 3000 } } }
  assert.equal(mergeProgress(a, b).topics.pastebin.completedAt, 1000)
})

test('reels and roadmap ticks from both are kept', () => {
  const a: Progress = { topics: {}, reels: { r1: { time: 10, duration: 60, at: 5 } }, roadmap: { 'sd-ids': 10 } }
  const b: Progress = { topics: {}, reels: { r1: { time: 30, duration: 60, at: 9 }, r2: { time: 5, duration: 50, at: 1 } }, roadmap: { 'sd-chat': 20, 'sd-ids': 30 } }
  const m = mergeProgress(a, b)
  assert.equal(m.reels?.r1.time, 30)
  assert.ok(m.reels?.r2)
  assert.deepEqual(m.roadmap, { 'sd-chat': 20, 'sd-ids': 10 })
})

test('merging is the same either way round, and merging again changes nothing', () => {
  const a: Progress = { topics: { x: { sectionsRead: [2], updatedAt: 1, bookmarked: true }, y: { walked: true, updatedAt: 3 } }, quizBest: 4 }
  const b: Progress = { topics: { x: { sectionsRead: [1], updatedAt: 2 }, z: { lessonStep: 3, updatedAt: 5 } }, reels: { r: { time: 1, duration: 2, at: 3 } } }
  const ab = mergeProgress(a, b)
  assert.equal(stable(ab), stable(mergeProgress(b, a)))
  assert.equal(stable(mergeProgress(ab, b)), stable(ab))
  assert.equal(stable(mergeProgress(ab, a)), stable(ab))
})
