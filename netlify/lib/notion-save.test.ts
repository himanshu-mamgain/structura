// npm run test:notion
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveKey, PBKDF2_ITERATIONS, saltFor, seal, toBase64, unseal, fromBase64 } from '../../apps/web/src/learn/notesFormat'
import { MAX_AGE, noteBlocks, pageIdOf, parseNote } from './notion-save'

const now = Date.parse('2026-11-08T14:22:00Z') // 19:52 in India
const note = { topicId: 'kafka', topicTitle: 'Kafka: Event Streaming', text: 'Offsets are per partition.', at: now, timeZone: 'Asia/Kolkata' }

test('accepts a fresh, well-formed note', () => {
  assert.deepEqual(parseNote(note, now + 1000), note)
})

test('refuses old or replayed saves', () => {
  assert.ok('error' in parseNote({ ...note, at: now - MAX_AGE - 1 }, now))
  assert.ok('error' in parseNote({ ...note, at: undefined }, now))
})

test('refuses bad topics and empty or huge notes', () => {
  assert.ok('error' in parseNote({ ...note, topicId: '../etc' }, now))
  assert.ok('error' in parseNote({ ...note, topicTitle: '' }, now))
  assert.ok('error' in parseNote({ ...note, text: '   ' }, now))
  assert.ok('error' in parseNote({ ...note, text: 'x'.repeat(6001) }, now))
})

test('an unknown time zone falls back to UTC', () => {
  const parsed = parseNote({ ...note, timeZone: 'Mars/Olympus' }, now)
  assert.ok(!('error' in parsed) && parsed.timeZone === undefined)
})

test('writes a dated heading, paragraphs and bullets', () => {
  const blocks = noteBlocks({ ...note, text: 'First idea\nstill first\n\n- one\n- two\n\nLast' }) as { type: string; [k: string]: any }[]
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading_3', 'paragraph', 'bulleted_list_item', 'bulleted_list_item', 'paragraph'],
  )
  assert.equal(blocks[0].heading_3.rich_text[0].text.content, '8 Nov 2026, 19:52')
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, 'First idea\nstill first')
  assert.equal(blocks[3].bulleted_list_item.rich_text[0].text.content, 'two')
})

test('splits long text into pieces Notion accepts', () => {
  const [, para] = noteBlocks({ ...note, text: 'y'.repeat(4000) }) as { paragraph: { rich_text: { text: { content: string } }[] } }[]
  assert.ok(para.paragraph.rich_text.every((r) => r.text.content.length <= 2000))
  assert.equal(para.paragraph.rich_text.map((r) => r.text.content).join('').length, 4000)
})

test('reads page ids from URLs', () => {
  assert.equal(pageIdOf('https://www.notion.so/System-Design-0f1e2d3c4b5a69788796a5b4c3d2e1f0?pvs=4'), '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')
  assert.equal(pageIdOf('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'), '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')
  assert.equal(pageIdOf('nope'), null)
})

test('the app and the function derive the same key', async () => {
  const root = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
  const app = await deriveKey('correct horse battery', await saltFor(root), PBKDF2_ITERATIONS)
  const fn = await deriveKey('correct horse battery', await saltFor('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'), PBKDF2_ITERATIONS)
  const sealed = toBase64(await seal(app, new TextEncoder().encode('hello')))
  assert.equal(new TextDecoder().decode(await unseal(fn, fromBase64(sealed))), 'hello')
  const other = await deriveKey('wrong', await saltFor(root), PBKDF2_ITERATIONS)
  await assert.rejects(unseal(other, fromBase64(sealed)))
})
