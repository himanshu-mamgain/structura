// npm run test:prep
// Every interview question must point at topics that exist, and be complete.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATIC_TOPICS } from '../topics'
import { AGENTIC_QUESTIONS } from './agenticQuestions'

const topicIds = new Set(STATIC_TOPICS.map((t) => t.id))

test('every question is complete and links to real topics', () => {
  assert.equal(new Set(AGENTIC_QUESTIONS.map((q) => q.id)).size, AGENTIC_QUESTIONS.length, 'ids must be unique')
  for (const q of AGENTIC_QUESTIONS) {
    assert.match(q.id, /^[a-z0-9-]+$/, `${q.id}: id must be kebab-case (it is the #q- link)`)
    assert.ok(q.question.endsWith('?'), `${q.id}: a question ends with "?"`)
    assert.ok(q.answer.length > 120, `${q.id}: answer is too short`)
    assert.ok(q.points.length >= 2 && q.mistakes.length >= 2, `${q.id}: needs points and mistakes`)
    assert.ok(q.topics.length >= 1, `${q.id}: needs a topic`)
    for (const id of q.topics) assert.ok(topicIds.has(id), `${q.id}: no topic "${id}"`)
  }
})
