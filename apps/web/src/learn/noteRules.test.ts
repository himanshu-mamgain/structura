// npm run test:notes: every deep note passes the rules in noteRules.ts, and the rules
// catch what they should.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkNote, REQUIRED_SECTIONS } from './noteRules'

const dir = new URL('../topics/notes/', import.meta.url)

for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  test(`notes/${file} explains what it uses`, () => {
    assert.deepEqual(checkNote(readFileSync(new URL(file, dir), 'utf8')), [])
  })
}

const tail = REQUIRED_SECTIONS.map((s) => (s === 'Interview Q&As' ? `## ${s}\n\n**Q: a?**\n\nA: a.\n\n**Q: b?**\n\nA: b.\n\n**Q: c?**\n\nA: c.` : `## ${s}\n\nText.`)).join('\n\n')
const note = (body: string) => `# Title\n\n> 💡 **TL;DR**: ${body}\n\n${tail}\n`

test('an abbreviation must be explained where it first appears', () => {
  assert.deepEqual(checkNote(note('Each task gets an ENI (elastic network interface: a network card).')), [])
  assert.deepEqual(checkNote(note('Each task gets an elastic network interface (ENI).')), [])
  assert.deepEqual(checkNote(note('Private subnets use a NAT gateway (network address translation) to reach out.')), [])
  assert.deepEqual(checkNote(note('IAM is who can do what.')), [])
  assert.deepEqual(checkNote(note('See [VPC Networking](/?topic=aws-vpc&read).')), [])
  assert.deepEqual(checkNote(note('Stop it with `SIGTERM`, then an HTTP GET.')), [])
  assert.match(checkNote(note('Each task gets its own ENI.'))[0], /"ENI" isn't explained/)
  assert.match(checkNote(note('Run it on (ECS, EKS, Fargate).'))[0], /"ECS" isn't explained/)
  // Only the first use needs it.
  assert.deepEqual(checkNote(note('An ENI (a network card). Every ENI has an IP.')), [])
})

test('the parts a reader relies on must be there', () => {
  assert.ok(checkNote('# Title\n\nNo callout.\n').some((p) => p.includes('TL;DR')))
  assert.ok(checkNote(note('x').replace('## Sources', '## Reading')).includes('Missing "## Sources".'))
  assert.deepEqual(checkNote(note('x').replace('## How to choose', '## How to choose: a or b?')), [])
  assert.ok(checkNote(note('x').replace('**Q: c?**\n\nA: c.', '')).some((p) => p.includes('2 questions')))
})
