// npm run test:dbml
// The viewer draws erdToSchema(erd) so the browser never loads the DBML parser.
// These tests parse erdToDbml(erd) with the real parser and check both say the same thing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDbml } from 'dbml-erd-viewer'
import { STATIC_TOPICS } from '../topics'
import { erdToDbml, erdToSchema } from './dbml'

for (const topic of STATIC_TOPICS) {
  if (!topic.database) continue
  const erd = topic.database
  test(`${topic.id}: the DBML parses to the schema the viewer draws`, async () => {
    // JSON drops the parser's `undefined` fields, which the viewer treats as absent anyway.
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
    assert.deepEqual(plain(erdToSchema(erd)), plain(await parseDbml(erdToDbml(erd))))
  })
}

test('writes column refs, composite keys and indexes as DBML', () => {
  const dbml = erdToDbml({
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [{ name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false }],
        indexes: [],
      },
      {
        id: 'follows',
        name: 'follows (both ways)',
        columns: [
          { name: 'follower_id', type: 'bigint', pk: true, fk: 'users.id', nullable: false, unique: false },
          { name: 'followee_id', type: 'bigint', pk: true, fk: 'users.id', nullable: false, unique: false },
          { name: 'created_at', type: 'double precision', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(followee_id) — who to fan out to', 'GIN (tags)'],
      },
    ],
    relations: [{ from: 'follows', to: 'users', kind: 'many-to-many', label: 'follows' }],
  })
  assert.equal(
    dbml,
    `Table users {
  id bigint [pk]
}

Table "follows (both ways)" as follows {
  follower_id bigint [ref: > users.id, note: 'follows']
  followee_id bigint [ref: > users.id, note: 'follows']
  created_at "double precision"

  indexes {
    (follower_id, followee_id) [pk]
    followee_id [note: '(followee_id) — who to fan out to']
  }

  // index: GIN (tags)
}
`,
  )
})
