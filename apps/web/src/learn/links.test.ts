// npm run test:links
// Deep links (links.ts) are written by hand, so these check that each one lands somewhere
// real: the topic exists, and so does the Read-mode section it names. Then a few cases of
// what should and shouldn't become a link.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { STATIC_TOPICS } from '../topics'
import { anchor, hrefOf, LINK_RULES, linkText, type Linked } from './links'
import { parseMarkdown } from './markdown'

const topics = new Map(STATIC_TOPICS.map((t) => [t.id, t]))

/** The headings Read mode shows for a topic: its deep note's sections, or its explanation's. */
function readHeadings(id: string): string[] {
  const file = new URL(`../topics/notes/${id}.md`, import.meta.url)
  if (existsSync(file)) {
    return parseMarkdown(readFileSync(file, 'utf8'))
      .blocks.filter((b) => b.t === 'h1')
      .map((b) => (b.t === 'h1' ? b.r.map(([text]) => text).join('') : ''))
  }
  return topics.get(id)?.explanation.sections.map((s) => s.heading) ?? []
}

for (const rule of LINK_RULES) {
  test(`${rule.terms[0]} → ${rule.topic}${rule.section ? ` › ${rule.section}` : ''}`, () => {
    assert.ok(topics.has(rule.topic), `no topic "${rule.topic}"`)
    assert.ok(rule.terms.length > 0)
    if (rule.section) assert.ok(readHeadings(rule.topic).includes(rule.section), `"${rule.section}" isn't a heading in ${rule.topic}'s Read mode`)
    if (rule.inTopic) assert.ok(rule.section, 'a link within its own topic needs a section to go to')
  })
}

const links = (parts: Linked[]) => parts.filter((p) => p.rule).map((p) => `${p.text} → ${p.rule!.topic}${p.rule!.section ? `#${p.rule!.section}` : ''}`)
const link = (text: string, from = 'url-shortener', here?: string) => links(linkText(text, from, new Set(), here))

test('links the first mention in a section only', () => {
  const used = new Set<string>()
  assert.deepEqual(links(linkText('Put a rate limiter in front.', 'url-shortener', used)), ['rate limiter → rate-limiter'])
  assert.deepEqual(links(linkText('The rate limiter uses a token bucket.', 'url-shortener', used)), [])
})

test('never links a topic to itself', () => {
  assert.deepEqual(link('Sentinel promotes a replica.', 'redis-replication'), [])
  assert.deepEqual(link('A rate limiter with a token bucket.', 'rate-limiter'), [])
})

test('links a topic to its own Read-mode section, but not from that section', () => {
  assert.deepEqual(link('The Rules Store is cached locally.', 'rate-limiter'), ['Rules Store → rate-limiter#How rules are stored'])
  assert.deepEqual(link('The Rules Store is cached locally.', 'rate-limiter', 'How rules are stored'), [])
  assert.deepEqual(link('If Redis is down, fail open or use the Local Fallback Limiter.', 'rate-limiter'), [
    'Redis → redis-basics',
    'fail open → rate-limiter#Fail open or fail closed',
    'Local Fallback Limiter → rate-limiter#The fallback limiter',
  ])
})

test('the longer term wins', () => {
  assert.deepEqual(link('An Application Load Balancer spreads the traffic.'), ['Application Load Balancer → aws-alb'])
  assert.deepEqual(link('Use Redis Sentinel for failover.'), ['Redis Sentinel → redis-replication#Sentinel: automatic failover'])
})

test('words that mean something else elsewhere need their context', () => {
  assert.deepEqual(link('Add a read replica to Postgres.'), ['read replica → scaling-aws'])
  assert.deepEqual(link('Redis copies writes to a replica.'), ['Redis → redis-basics', 'replica → redis-replication#How replication works'])
  assert.deepEqual(link('A rolling deploy with a circuit breaker on rollback.'), [])
})

test('leaves file names, paths and hash tags alone', () => {
  assert.deepEqual(link('See rate-limiter.ts and /topic/redis-basics/.'), [])
  assert.deepEqual(link('Name the key cart:{Redis} so it hashes once.'), [])
})

test('links go to the section in Read mode', () => {
  const rule = LINK_RULES.find((r) => r.section === 'Fail open or fail closed')!
  assert.equal(hrefOf(rule, false), `/topic/rate-limiter/?read#${anchor('Fail open or fail closed')}`)
  assert.equal(anchor('Fail open or fail closed'), 'read-fail-open-or-fail-closed')
  assert.equal(hrefOf({ topic: 'kafka-basics', terms: ['Kafka'] }, false), '/topic/kafka-basics/')
  assert.equal(hrefOf({ topic: 'kafka-basics', terms: ['Kafka'] }, true), '/topic/kafka-basics/?read')
})
