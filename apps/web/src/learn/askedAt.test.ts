// npm run test:asked
// "Asked at" is only worth showing if every entry can be checked: a known topic and
// company, a source, a link, and a real date when there is one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import data from '../topics/askedAt.json'
import { STATIC_TOPICS } from '../topics'
import { askedAt, topicsAskedAt } from './askedAt'

const topicIds = new Set(STATIC_TOPICS.map((t) => t.id))
const reports = Object.entries(data.topics as Record<string, { company: string; question: string; url: string; source: string; date?: string; similar?: boolean }[]>)

test('every entry is for a real topic and a listed company and source', () => {
  for (const [topic, list] of reports) {
    assert.ok(topicIds.has(topic), `no topic "${topic}"`)
    for (const r of list) {
      assert.ok(r.company in data.companies, `${topic}: company "${r.company}" isn't in companies`)
      assert.ok(r.source in data.sources, `${topic}: source "${r.source}" isn't in sources`)
      assert.match(r.url, /^https:\/\/\S+$/, `${topic}: ${r.company} needs a link`)
      assert.ok(r.question.trim().length > 5, `${topic}: ${r.company} needs the question as reported`)
      if (r.date) {
        assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/)
        assert.ok(!Number.isNaN(Date.parse(r.date)) && r.date <= data.checked, `${topic}: ${r.date} isn't a past date`)
      }
    }
  }
})

test('no report is listed twice for a topic', () => {
  for (const [topic, list] of reports) {
    const keys = list.map((r) => `${r.company} ${r.url}`)
    assert.equal(new Set(keys).size, keys.length, `${topic} repeats a report`)
  }
})

test('companies that asked the question itself come before close variants', () => {
  for (const [topic] of reports) {
    const similar = askedAt(topic).map((c) => c.similarOnly)
    assert.deepEqual(similar, [...similar].sort((a, b) => Number(a) - Number(b)), topic)
  }
})

test('a company lists the topics it asked', () => {
  assert.ok(topicsAskedAt('amazon').includes('url-shortener'))
  assert.ok(!topicsAskedAt('amazon').includes('pastebin'))
})
