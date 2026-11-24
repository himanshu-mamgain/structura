import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// A Google Docs-style editor. The simulator runs a real, small operational transformation (OT)
// engine: two people edit the same text at the same moment, the server puts the edits in one
// order, and each edit is rewritten (transformed) so it still means what its author meant.
// With "apply as received" the same edits are applied untouched, so the three copies of the
// document end up different. All the text you see in the walkthrough is computed here.

export type Op = { type: 'ins'; pos: number; text: string } | { type: 'del'; pos: number; len: number }

export function applyOp(doc: string, op: Op): string {
  if (op.type === 'ins') return doc.slice(0, op.pos) + op.text + doc.slice(op.pos)
  return doc.slice(0, op.pos) + doc.slice(op.pos + op.len)
}

export function applyOps(doc: string, ops: Op[]): string {
  return ops.reduce(applyOp, doc)
}

/**
 * Rewrites `op` so it can be applied after `against` has already happened, where both were made
 * on the same version of the text. `againstWinsTie` decides who goes first when two inserts land
 * on the same spot. It returns a list because a delete can be split in two by an insert inside it.
 */
export function transform(op: Op, against: Op, againstWinsTie: boolean): Op[] {
  if (op.type === 'ins') {
    if (against.type === 'ins') {
      const shift = against.pos < op.pos || (against.pos === op.pos && againstWinsTie)
      return [{ ...op, pos: shift ? op.pos + against.text.length : op.pos }]
    }
    // Against a delete: text after the deleted part moves left; an insert inside it lands where the cut was.
    const end = against.pos + against.len
    if (op.pos <= against.pos) return [op]
    if (op.pos >= end) return [{ ...op, pos: op.pos - against.len }]
    return [{ ...op, pos: against.pos }]
  }
  if (against.type === 'ins') {
    const end = op.pos + op.len
    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]
    if (against.pos >= end) return [op]
    // Someone typed inside the text being deleted: delete around it, so their text survives.
    const before = against.pos - op.pos
    return [
      { type: 'del', pos: op.pos, len: before },
      { type: 'del', pos: op.pos + against.text.length, len: op.len - before },
    ]
  }
  // Two deletes: remove whatever the other one already removed.
  const cut = (x: number) => x - Math.min(against.len, Math.max(0, x - against.pos))
  const start = cut(op.pos)
  const len = cut(op.pos + op.len) - start
  return len > 0 ? [{ type: 'del', pos: start, len }] : []
}

export const transformAll = (ops: Op[], against: Op, againstWinsTie: boolean): Op[] =>
  ops.flatMap((op) => transform(op, against, againstWinsTie))

const BASE = 'The cat sat'
const USERS = ['Alice', 'Bob'] as const

interface Scenario {
  text: string
  /** Alice's edit and Bob's edit, both made on BASE. */
  alice: Op
  bob: Op
}

const SCENARIOS: Record<string, Scenario> = {
  'Alice adds a word, Bob adds an ending': {
    text: 'Alice types "big " before "cat" while Bob adds "." at the end.',
    alice: { type: 'ins', pos: 4, text: 'big ' },
    bob: { type: 'ins', pos: 11, text: '.' },
  },
  'Both type at the same spot': {
    text: 'Alice and Bob both type at position 4, right before "cat".',
    alice: { type: 'ins', pos: 4, text: 'big ' },
    bob: { type: 'ins', pos: 4, text: 'old ' },
  },
  'Alice deletes "cat", Bob types inside it': {
    text: 'Alice deletes the word "cat" while Bob types "!" in the middle of it.',
    alice: { type: 'del', pos: 4, len: 3 },
    bob: { type: 'ins', pos: 6, text: '!' },
  },
  'Both delete the same word': {
    text: 'Alice and Bob both select "cat" and press Delete.',
    alice: { type: 'del', pos: 4, len: 3 },
    bob: { type: 'del', pos: 4, len: 3 },
  },
}
const STRATEGIES = ['Operational transformation', 'Apply as received (no transform)']
const ORDERS = ['Alice reaches the server first', 'Bob reaches the server first']

const q = (s: string) => JSON.stringify(s)
const describe = (op: Op) => (op.type === 'ins' ? `insert ${q(op.text)} at ${op.pos}` : `delete ${op.len} character${op.len === 1 ? '' : 's'} from ${op.pos}`)
const describeAll = (ops: Op[]) => (ops.length ? ops.map(describe).join(', then ') : 'nothing (already done)')

/** Everything the walkthrough shows, worked out from the two edits. */
export function replay(scenarioName: string, strategy: string, order: string) {
  const sc = SCENARIOS[scenarioName] ?? SCENARIOS[Object.keys(SCENARIOS)[0]]
  const useOt = strategy !== STRATEGIES[1]
  const aliceFirst = order !== ORDERS[1]
  const [first, second] = aliceFirst ? [USERS[0], USERS[1]] : [USERS[1], USERS[0]]
  const firstOp = aliceFirst ? sc.alice : sc.bob
  const secondOp = aliceFirst ? sc.bob : sc.alice
  const afterFirst = applyOp(BASE, firstOp)
  // The server rewrites the second edit so it fits after the first one. The first user, who is
  // always ahead in the server's order, wins a tie.
  const secondForServer = useOt ? transform(secondOp, firstOp, true) : [secondOp]
  const server = applyOps(afterFirst, secondForServer)
  // Each browser already has its own edit. It receives the other edit, rewritten to fit after its own.
  const firstForSecond = useOt ? transform(firstOp, secondOp, false) : [firstOp]
  const clientFirst = applyOps(afterFirst, secondForServer)
  const clientSecond = applyOps(applyOp(BASE, secondOp), firstForSecond)
  // What the two people meant: the result when the second edit is rewritten to fit after the first.
  const intended = applyOps(afterFirst, transform(secondOp, firstOp, true))
  return { sc, intended, useOt, first, second, firstOp, secondOp, afterFirst, secondForServer, firstForSecond, server, clientFirst, clientSecond }
}

const simulator: Simulator = {
  fields: [
    { id: 'scenario', label: 'Two edits at the same moment', options: Object.keys(SCENARIOS) },
    { id: 'strategy', label: 'How the server handles it', options: STRATEGIES },
    { id: 'order', label: 'Which edit arrives first', options: ORDERS },
  ],
  defaults: { scenario: 'Alice adds a word, Bob adds an ending', strategy: STRATEGIES[0], order: ORDERS[0] },
  run({ scenario, strategy, order }) {
    const r = replay(scenario, strategy, order)
    const firstBrowser = `${r.first} (browser)`
    const secondBrowser = `${r.second} (browser)`
    const cursorBefore = r.secondOp.pos
    const cursorAfter = transform({ type: 'ins', pos: cursorBefore, text: '' }, r.firstOp, true)[0].pos
    const same = r.server === r.clientFirst && r.server === r.clientSecond
    const rows = `server:  ${q(r.server)}\n${r.first}:  ${q(r.clientFirst)}\n${r.second}:  ${q(r.clientSecond)}`

    const steps: Trace['steps'] = [
      {
        text: `Everyone sees ${q(BASE)} at revision 0. ${r.sc.text} Each browser shows its own edit at once, without waiting for the server, so typing never feels slow.`,
        nodes: ['Alice (browser)', 'Bob (browser)'],
        data: `Alice: ${describe(r.sc.alice)}\nBob:   ${describe(r.sc.bob)}\nboth based on revision 0 of ${q(BASE)}`,
      },
      {
        text: 'Each browser sends its edit over a WebSocket (a connection that stays open so either side can send at any time). The gateway asks the Permissions Service whether this person may edit the document.',
        nodes: ['Alice (browser)', 'Bob (browser)', 'WebSocket Gateway', 'Permissions Service'],
        data: `→ { doc: "d_91", baseRev: 0, op: ${json(r.sc.alice).replace(/\s+/g, ' ')} }\n→ { doc: "d_91", baseRev: 0, op: ${json(r.sc.bob).replace(/\s+/g, ' ')} }\nACL: alice=editor ✓, bob=editor ✓`,
      },
      {
        text: 'Every edit to one document goes to the same Collaboration Server, chosen by hashing the document id. One machine puts all the edits of a document in a single order, so there is one truth to agree on.',
        nodes: ['WebSocket Gateway', 'Collaboration Server'],
        data: 'owner = servers[hash("d_91") % 100] = collab-17',
      },
      {
        text: `${r.first}'s edit arrives first. It is based on revision 0 and the document is still at revision 0, so nothing needs fixing. The server applies it, gives it revision 1 and appends it to the Operation Log.`,
        nodes: ['Collaboration Server', 'Operation Log'],
        data: `rev 1  ${r.first}: ${describe(r.firstOp)}\ndocument is now ${q(r.afterFirst)}`,
      },
    ]

    if (r.useOt) {
      steps.push({
        text: `${r.second}'s edit arrives next, still based on revision 0. But the document is now at revision 1, so the position ${r.second} meant may have moved. The server transforms the edit against revision 1: it rewrites the edit so it keeps ${r.second}'s intent on the new text.`,
        nodes: ['Collaboration Server'],
        data: `${r.second} sent: ${describe(r.secondOp)}\nafter rev 1 (${describe(r.firstOp)}):\n${r.second} means: ${describeAll(r.secondForServer)}`,
      })
    } else {
      steps.push({
        text: `${r.second}'s edit arrives next, still based on revision 0. This server does not transform edits, so it applies the numbers exactly as ${r.second} sent them, even though the text has changed since.`,
        nodes: ['Collaboration Server'],
        data: `${r.second} sent: ${describe(r.secondOp)}\napplied unchanged to ${q(r.afterFirst)}`,
      })
    }

    steps.push({
      text: `The server applies the second edit as revision 2 and appends it to the Operation Log. Its copy of the document is now ${q(r.server)}.`,
      nodes: ['Collaboration Server', 'Operation Log'],
      data: `rev 2  ${r.second}: ${describeAll(r.secondForServer)}\nserver document: ${q(r.server)}`,
    })

    steps.push({
      text: `The server sends each person the edit they have not seen. ${r.first} gets ${r.second}'s edit as revision 2. ${r.second} gets ${r.first}'s edit, ${r.useOt ? `transformed against their own edit, so it fits their text` : 'exactly as it was typed'}.`,
      nodes: ['Collaboration Server', 'WebSocket Gateway', firstBrowser, secondBrowser],
      data: `to ${r.first}:  rev 2 ${describeAll(r.secondForServer)}\nto ${r.second}:  rev 1 ${describeAll(r.firstForSecond)}`,
    })

    steps.push({
      text: same && r.server !== r.intended
        ? `All three copies are the same, but the text is wrong: ${q(r.server)} instead of ${q(r.intended)}. Both edits deleted the same word, and without transforming, the second delete removed more characters that nobody chose to delete.`
        : same
        ? `All three copies are the same: ${q(r.server)}. Transforming made both orders of applying the edits give one answer, which is the whole point. Nobody lost their typing.`
        : `The three copies are different, and they will stay different. ${r.second}'s numbers pointed at the old text, so the edit hit the wrong characters on some machines. Nothing will ever repair this, because no one knows which copy is right.`,
      nodes: ['Collaboration Server', 'Alice (browser)', 'Bob (browser)'],
      data: `${rows}\n${same && r.server === r.intended ? '✓ converged' : same ? `✗ wrong text (expected ${q(r.intended)})` : '✗ diverged'}`,
    })

    steps.push({
      text: 'Cursors and selections follow the same rule. When an edit lands before another person\'s cursor, their cursor position is shifted by the edit\'s length, so the coloured caret does not jump. Cursors are short-lived and are not stored in the log.',
      nodes: ['Collaboration Server', 'Presence (cursors)'],
      data: `${r.second}'s cursor was at ${cursorBefore}. ${r.first}'s edit (${describe(r.firstOp)}) lands first, so it moves to ${cursorAfter}.\npresence d_91: { ${r.second.toLowerCase()}: { cursor: ${cursorAfter} } }  (ttl 30s)`,
    })

    steps.push({
      text: 'Replaying a long Operation Log to open a document would be slow. So the Snapshot Worker saves a full copy of the text every 100 revisions. To open the document, the server loads the latest snapshot and replays only the edits after it.',
      nodes: ['Operation Log', 'Snapshot Worker', 'Snapshot Store', 'Collaboration Server'],
      data: 'document at revision 1,250\nsnapshot at revision 1,200 + replay 50 edits\n= 50 edits to apply, not 1,250',
    })

    return { input: `${scenario}, ${strategy.toLowerCase()}, ${order.toLowerCase()}`, steps }
  },
}

export const collaborativeEditing: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'collaborative-editing',
  title: 'Collaborative Editing (Google Docs-style)',
  blurb: 'Many people typing in one document: operational transformation, a server that orders edits, and snapshots',
  guides: ['how-to-design-google-docs', 'shortlong-polling-sse-websocket', 'primer-consistency-patterns', 'differences-in-event-sourcing-system-design'],
  takeaways: [
    'Two people can edit the same text at the same moment, so every edit must still make sense after someone else\'s edit lands first.',
    'Operational transformation (OT) rewrites an edit\'s positions against the edits that came before it, so everyone ends with the same text.',
    'One Collaboration Server owns each document and puts all its edits in a single order, with a revision number on each.',
    'Browsers show their own typing at once and fix it up later, so the editor feels instant even on a slow network.',
    'The Operation Log is the source of truth, and snapshots every 100 revisions keep opening a document fast.',
    'CRDTs reach the same goal without a central server, by giving every character a unique id; they cost more memory.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [{ id: 'session', label: 'One server owns each document' }],
    nodes: [
      { id: 'alice', label: 'Alice (browser)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'bob', label: 'Bob (browser)', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'WebSocket Gateway', shape: 'rectangle', color: 'violet', group: null },
      { id: 'perms', label: 'Permissions Service', shape: 'rectangle', color: 'violet', group: null },
      { id: 'meta', label: 'Document Metadata DB', shape: 'rectangle', color: 'green', group: null },
      { id: 'collab', label: 'Collaboration Server', shape: 'rectangle', color: 'violet', group: 'session' },
      { id: 'presence', label: 'Presence (cursors)', shape: 'rectangle', color: 'red', group: 'session' },
      { id: 'oplog', label: 'Operation Log', shape: 'rectangle', color: 'yellow', group: null },
      { id: 'worker', label: 'Snapshot Worker', shape: 'rectangle', color: 'orange', group: null },
      { id: 'snap', label: 'Snapshot Store', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'alice', to: 'gateway', label: 'edits over WebSocket', dashed: false },
      { from: 'bob', to: 'gateway', label: 'edits over WebSocket', dashed: false },
      { from: 'gateway', to: 'perms', label: 'may this user edit?', dashed: false },
      { from: 'perms', to: 'meta', label: 'look up access list', dashed: false },
      { from: 'gateway', to: 'collab', label: 'route by document id', dashed: false },
      { from: 'collab', to: 'gateway', label: 'transformed edits', dashed: true },
      { from: 'collab', to: 'presence', label: 'cursor moves', dashed: true },
      { from: 'collab', to: 'oplog', label: 'append revision n', dashed: false },
      { from: 'oplog', to: 'worker', label: 'every 100 revisions', dashed: true },
      { from: 'worker', to: 'snap', label: 'save full text', dashed: false },
      { from: 'snap', to: 'collab', label: 'load on open', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'documents',
        name: 'documents',
        columns: [
          { name: 'id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'owner_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'head_rev', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamp', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(owner_id, created_at)'],
      },
      {
        id: 'doc_ops',
        name: 'doc_ops',
        columns: [
          { name: 'doc_id', type: 'text', pk: true, fk: 'documents.id', nullable: false, unique: false },
          { name: 'rev', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'op', type: 'jsonb', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamp', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'snapshots',
        name: 'snapshots',
        columns: [
          { name: 'doc_id', type: 'text', pk: true, fk: 'documents.id', nullable: false, unique: false },
          { name: 'rev', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'content', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'doc_permissions',
        name: 'doc_permissions',
        columns: [
          { name: 'doc_id', type: 'text', pk: true, fk: 'documents.id', nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'role', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id)'],
      },
    ],
    relations: [
      { from: 'documents', to: 'doc_ops', kind: 'one-to-many', label: 'has edits' },
      { from: 'documents', to: 'snapshots', kind: 'one-to-many', label: 'has snapshots' },
      { from: 'documents', to: 'doc_permissions', kind: 'one-to-many', label: 'shared with' },
    ],
  },
  explanation: {
    title: 'Collaborative Editing (Google Docs-style)',
    summary:
      'In a shared document, two people can type at the same moment. Each edit says "put this at position 4", but if someone else\'s edit lands first, position 4 is no longer the right place. Operational transformation rewrites each edit against the edits before it, and one server puts all edits of a document in a single order, so every screen ends with the same text.',
    sections: [
      {
        heading: 'Overview',
        body: 'The hard part is not sending text over the network. It is that two people edit the same text at the same moment, while each sees only their own screen. If Alice inserts a word at the start, every position after it moves. Bob\'s edit was written for the old positions, so applying it unchanged puts his text in the wrong place.\n\nTwo families of ideas fix this. Operational transformation (OT) keeps one server that orders the edits and rewrites each one so it still fits. This is what Google Docs does. A CRDT (conflict-free replicated data type) gives every character a unique id, so edits never need rewriting and no central server is needed. This topic builds the OT design and compares it with CRDTs at the end.',
      },
      {
        heading: 'Requirements',
        body: '- Several people edit one document at once and see each other\'s changes within about 200 ms.\n- Typing feels instant: your own keystrokes show at once, even on a slow network.\n- Everyone ends with the same text (convergence), and nobody\'s typing is lost.\n- Show other people\'s cursors and selections.\n- Keep the full history, so you can undo and see old versions.\n- Work offline for a while and merge on return. Not needed: a perfect answer to "whose intent wins" when two people rewrite the same sentence; the rules only need to be fair and the same for everyone.',
      },
      {
        heading: 'Capacity estimates',
        body: 'An example at peak: 1 million people editing at once, each sending about 1 edit a second (the browser groups keystrokes for 300 ms).\n- Incoming edits: 1 million per second.\n- Average 2.5 editors per open document, so each edit goes to 1.5 other people: 1.5 million outgoing messages per second.\n- Connections: 1 million WebSockets. A gateway holds about 50k, so 1 million ÷ 50k = 20 gateways.\n- Collaboration Servers: each handles about 20k edits per second, so 1 million ÷ 20k = 50, and about 100 with headroom.\n- Log size: an edit is about 100 bytes. If the average over a day is a quarter of the peak (250k edits per second), that is 250k × 100 B × 86,400 s ≈ 2.2 TB a day.\n- Snapshots every 100 revisions keep a document\'s open time to at most 99 edits to replay.',
      },
      {
        heading: 'Step by step',
        body: '1. Alice (browser) and Bob (browser) open the same document. Each connects to the WebSocket Gateway, which asks the Permissions Service whether the person may edit; it reads the access list from the Document Metadata DB.\n2. The WebSocket Gateway routes the connection to the Collaboration Server that owns this document, chosen by hashing the document id.\n3. The Collaboration Server loads the latest copy from the Snapshot Store and replays the newer edits from the Operation Log.\n4. A person types. Their browser shows the change at once and sends the edit, with the revision it was based on, to the WebSocket Gateway.\n5. The Collaboration Server receives the edit. If other edits arrived since that revision, it transforms the edit against each of them.\n6. The Collaboration Server gives the edit the next revision number and appends it to the Operation Log.\n7. It sends the transformed edit through the WebSocket Gateway to every other browser, and tells the sender it was accepted.\n8. Cursor moves go to Presence (cursors) and are shared with everyone, shifted by the edits.\n9. Every 100 revisions the Snapshot Worker reads the Operation Log and saves the full text in the Snapshot Store.',
      },
      {
        heading: 'Components',
        body: '- Alice (browser): the editor. It shows her own typing at once, keeps edits that the server has not confirmed yet, and transforms incoming edits against them.\n- Bob (browser): the same editor for a second person; there can be many more.\n- WebSocket Gateway: holds the open connections and passes messages; it holds no document state, so any gateway can serve anyone.\n- Permissions Service: checks that a person may view or edit the document, with the answer cached for a short time.\n- Document Metadata DB: holds titles, owners and access lists.\n- Collaboration Server: owns one document at a time; it orders and transforms the edits, applies them and broadcasts the result.\n- Presence (cursors): keeps who is online and where their cursor is, in memory with a short expiry, because a lost cursor does not matter.\n- Operation Log: the append-only list of every edit with its revision number; it is the source of truth.\n- Snapshot Worker: turns the log into full copies of the text every 100 revisions.\n- Snapshot Store: keeps those full copies, so opening a document does not replay everything.',
      },
      {
        heading: 'Key decisions',
        body: '- OT with a central server, or a CRDT: with one server per document, ordering is easy and edits stay small. A CRDT needs no server and is good for offline work, but every character carries an id, so memory use is several times larger.\n- One owner per document: all edits for a document go to one server, so there is one order. Spread documents over servers with consistent hashing, so a server dying moves only its documents.\n- Optimistic local edits: the browser applies your typing first. The price is that it must keep unconfirmed edits and transform incoming ones against them.\n- One unconfirmed edit at a time: the browser sends one edit and waits for the answer before sending the next, grouping keystrokes in between. This keeps the browser\'s side simple.\n- Revision numbers: every edit says which revision it was based on, so the server knows exactly which edits to transform it against.\n- Tie-breaking: when two people insert at the same spot, the one who reaches the server first goes first. The rule is fixed, so everyone resolves it the same way.',
      },
      {
        heading: 'Scaling and failure',
        body: '- A Collaboration Server dies: the edits are already in the Operation Log, so another server loads the last snapshot, replays the log and carries on. Browsers reconnect and resend any unconfirmed edit.\n- A browser goes offline: it keeps typing locally. On return it sends its edits with the old revision, and the server transforms them like any other late edit.\n- A very popular document (thousands of viewers): one server still orders the edits, but readers are served from a fan-out layer that only receives the finished edits, so the owner does not hold every connection.\n- Log growth: old edits can be merged into a snapshot and archived, keeping enough history for "version history" and undo.\n- Bugs in the transform code: this is the real danger. If the rules are slightly wrong, copies diverge in rare cases. Test with many random pairs of edits and check that both orders give the same text.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Two people insert at the same position. How is the tie broken, and why must the rule be the same on every machine?\n- Why must edits go through one server per document in OT? What changes with a CRDT?\n- How does a browser work out what to do with an edit that arrives while its own is waiting for confirmation?\n- How would you build undo for one person, without undoing other people\'s edits?\n- How do you open a document with 200,000 revisions quickly?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Transform an edit against another edit',
        language: 'javascript',
        source: `// op is { type: 'ins', pos, text } or { type: 'del', pos, len }.
// Rewrites "op" so it still works after "against" has been applied.
// againstWinsTie: when two inserts land on the same spot, "against" goes first.
export function transform(op, against, againstWinsTie) {
  if (op.type === 'ins' && against.type === 'ins') {
    const shift = against.pos < op.pos || (against.pos === op.pos && againstWinsTie)
    return [{ ...op, pos: shift ? op.pos + against.text.length : op.pos }]
  }
  if (op.type === 'ins') { // against is a delete
    const end = against.pos + against.len
    if (op.pos <= against.pos) return [op]
    if (op.pos >= end) return [{ ...op, pos: op.pos - against.len }]
    return [{ ...op, pos: against.pos }] // typed inside deleted text: keep it at the cut
  }
  if (against.type === 'ins') { // op is a delete
    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]
    if (against.pos >= op.pos + op.len) return [op]
    const before = against.pos - op.pos // delete around the inserted text, so it survives
    return [
      { type: 'del', pos: op.pos, len: before },
      { type: 'del', pos: op.pos + against.text.length, len: op.len - before },
    ]
  }
  // both are deletes: skip what the other already removed
  const cut = (x) => x - Math.min(against.len, Math.max(0, x - against.pos))
  const start = cut(op.pos)
  const len = cut(op.pos + op.len) - start
  return len > 0 ? [{ type: 'del', pos: start, len }] : []
}`,
        versions: [
          {
            language: 'typescript',
            source: `type Op = { type: 'ins'; pos: number; text: string } | { type: 'del'; pos: number; len: number }

// Rewrites "op" so it still works after "against" has been applied.
// againstWinsTie: when two inserts land on the same spot, "against" goes first.
export function transform(op: Op, against: Op, againstWinsTie: boolean): Op[] {
  if (op.type === 'ins' && against.type === 'ins') {
    const shift = against.pos < op.pos || (against.pos === op.pos && againstWinsTie)
    return [{ ...op, pos: shift ? op.pos + against.text.length : op.pos }]
  }
  if (op.type === 'ins' && against.type === 'del') {
    const end = against.pos + against.len
    if (op.pos <= against.pos) return [op]
    if (op.pos >= end) return [{ ...op, pos: op.pos - against.len }]
    return [{ ...op, pos: against.pos }] // typed inside deleted text: keep it at the cut
  }
  if (op.type === 'del' && against.type === 'ins') {
    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]
    if (against.pos >= op.pos + op.len) return [op]
    const before = against.pos - op.pos // delete around the inserted text, so it survives
    return [
      { type: 'del', pos: op.pos, len: before },
      { type: 'del', pos: op.pos + against.text.length, len: op.len - before },
    ]
  }
  // both are deletes: skip what the other already removed
  const del = op as Extract<Op, { type: 'del' }>
  const other = against as Extract<Op, { type: 'del' }>
  const cut = (x: number) => x - Math.min(other.len, Math.max(0, x - other.pos))
  const start = cut(del.pos)
  const len = cut(del.pos + del.len) - start
  return len > 0 ? [{ type: 'del', pos: start, len }] : []
}`,
          },
        ],
      },
      {
        title: 'Server: order, transform, append, broadcast',
        language: 'javascript',
        source: `// One Collaboration Server owns this document, so edits arrive here in one order.
export class DocumentSession {
  constructor(text, rev, log) {
    this.text = text
    this.rev = rev // number of edits applied so far
    this.log = log // the Operation Log; log.append(rev, op) writes one edit
    this.history = [] // edits since the last snapshot: history[i] has revision (rev - history.length + i + 1)
  }

  // edit.baseRev is the revision the person's browser had when they typed.
  receive(edit, broadcast) {
    let ops = [edit.op]
    const missed = this.history.slice(this.history.length - (this.rev - edit.baseRev))
    for (const earlier of missed) {
      // The edit that arrived first goes first on a tie, so "againstWinsTie" is true.
      ops = ops.flatMap((op) => transform(op, earlier, true))
    }
    for (const op of ops) {
      this.text = applyOp(this.text, op)
      this.rev += 1
      this.history.push(op)
      this.log.append(this.rev, op) // the source of truth
    }
    broadcast({ rev: this.rev, from: edit.user, ops })
  }
}`,
        versions: [
          {
            language: 'typescript',
            source: `type Edit = { user: string; baseRev: number; op: Op }

export class DocumentSession {
  history: Op[] = [] // edits since the last snapshot

  constructor(
    public text: string,
    public rev: number, // number of edits applied so far
    private log: { append(rev: number, op: Op): void },
  ) {}

  // edit.baseRev is the revision the person's browser had when they typed.
  receive(edit: Edit, broadcast: (msg: { rev: number; from: string; ops: Op[] }) => void) {
    let ops: Op[] = [edit.op]
    const missed = this.history.slice(this.history.length - (this.rev - edit.baseRev))
    for (const earlier of missed) {
      // The edit that arrived first goes first on a tie, so againstWinsTie is true.
      ops = ops.flatMap((op) => transform(op, earlier, true))
    }
    for (const op of ops) {
      this.text = applyOp(this.text, op)
      this.rev += 1
      this.history.push(op)
      this.log.append(this.rev, op) // the source of truth
    }
    broadcast({ rev: this.rev, from: edit.user, ops })
  }
}`,
          },
        ],
      },
      {
        title: 'Browser: show my typing first, fix it up later',
        language: 'javascript',
        source: `export class Editor {
  constructor(text, rev, send) {
    this.text = text
    this.rev = rev // last revision the server confirmed
    this.pending = null // my edit, sent but not confirmed yet
    this.send = send
  }

  // I typed: show it at once, then tell the server. One edit travels at a time.
  type(op) {
    this.text = applyOp(this.text, op)
    if (!this.pending) {
      this.pending = op
      this.send({ baseRev: this.rev, op })
    } // else: keep it for later (grouped with the next keystrokes)
  }

  // The server's answer to my edit.
  ack() {
    this.rev += 1
    this.pending = null
  }

  // Someone else's edit arrived. My pending edit is already on my screen but not on the server's
  // list yet, so their edit must be rewritten to fit after mine.
  receive(op) {
    this.rev += 1
    const fits = this.pending ? transform(op, this.pending, false) : [op]
    // (A pending delete that gets split in two is left out here, to keep the idea clear.)
    if (this.pending) this.pending = transform(this.pending, op, true)[0] ?? null
    for (const o of fits) this.text = applyOp(this.text, o)
  }
}`,
        versions: [
          {
            language: 'typescript',
            source: `export class Editor {
  pending: Op | null = null // my edit, sent but not confirmed yet

  constructor(
    public text: string,
    public rev: number, // last revision the server confirmed
    private send: (msg: { baseRev: number; op: Op }) => void,
  ) {}

  // I typed: show it at once, then tell the server. One edit travels at a time.
  type(op: Op) {
    this.text = applyOp(this.text, op)
    if (!this.pending) {
      this.pending = op
      this.send({ baseRev: this.rev, op })
    } // else: keep it for later (grouped with the next keystrokes)
  }

  // The server's answer to my edit.
  ack() {
    this.rev += 1
    this.pending = null
  }

  // Someone else's edit arrived: rewrite it to fit after my pending edit, which is already on my screen.
  receive(op: Op) {
    this.rev += 1
    const fits = this.pending ? transform(op, this.pending, false) : [op]
    if (this.pending) this.pending = transform(this.pending, op, true)[0]
    for (const o of fits) this.text = applyOp(this.text, o)
  }
}`,
          },
        ],
      },
    ],
    related: ['WebSocket', 'Operational transformation', 'CRDT', 'Event sourcing', 'Consistent hashing', 'Snapshots'],
  },
  simulator,
}
