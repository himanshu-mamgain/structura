import type { Trace } from '@structura/shared'
import { defaultTrace, json, type Simulator, stableHash } from './simulator'
import type { StaticTopic } from './types'

// Written from scratch (no source text copied). The 4 MB block size and the
// block-hash approach are the common design for Dropbox-style sync; every
// number the simulator prints is computed from the constants below.

const BLOCK_MB = 4
const DOWNLOAD_MBPS = 50

const SIZES: Record<string, number> = { '5 MB report': 5, '200 MB video': 200, '2 GB archive': 2048 }
const NETWORKS: Record<string, number> = { 'Home Wi-Fi (20 Mbps up)': 20, 'Mobile (3 Mbps up)': 3 }
const NEW = 'New file'
const DUP = 'New file, identical copy already stored'
const MIDDLE = 'Edit: change a few bytes in the middle'
const START = 'Edit: insert a line at the start'
const FIXED = 'Fixed 4 MB blocks'
const CDC = 'Content-defined blocks (about 4 MB)'

const fmt = (n: number, d = 1) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const fmtSize = (mb: number) => (mb >= 1024 ? `${fmt(mb / 1024, 2)} GB` : `${fmt(mb)} MB`)
const fmtTime = (s: number) => (s >= 90 ? `${fmt(s / 60)} min` : `${fmt(s, s < 10 ? 1 : 0)} s`)
const hash = (text: string) => `sha256:${stableHash(text).toString(16).padStart(8, '0')}…`
const seconds = (mb: number, mbps: number) => (mb * 8) / mbps

const simulator: Simulator = {
  fields: [
    { id: 'change', label: 'What happened on this laptop', options: [NEW, DUP, MIDDLE, START] },
    { id: 'size', label: 'File size', options: Object.keys(SIZES) },
    { id: 'chunking', label: 'How the file is cut into blocks', options: [FIXED, CDC] },
    { id: 'network', label: 'Upload speed', options: Object.keys(NETWORKS) },
  ],
  defaults: { change: MIDDLE, size: '200 MB video', chunking: FIXED, network: 'Home Wi-Fi (20 Mbps up)' },
  run({ change, size, chunking, network }) {
    const sizeMb = SIZES[size] ?? 200
    const mbps = NETWORKS[network] ?? 20
    const cdc = chunking === CDC
    const total = Math.ceil(sizeMb / BLOCK_MB)
    const isEdit = change === MIDDLE || change === START
    const name = isEdit ? 'Q3-plan' : 'holiday'
    const path = `/Work/${name}${sizeMb >= 1024 ? '.zip' : sizeMb >= 100 ? '.mov' : '.docx'}`
    const version = isEdit ? 4 : 1

    // How many blocks have to travel, and how big they are.
    let changed: number[] = []
    if (change === NEW) changed = Array.from({ length: total }, (_, i) => i)
    else if (change === MIDDLE) changed = [Math.floor(total / 2)]
    else if (change === START) changed = cdc ? [0] : Array.from({ length: total }, (_, i) => i)
    const blockMb = (i: number) => (i === total - 1 ? sizeMb - BLOCK_MB * (total - 1) : BLOCK_MB)
    const sendMb = changed.reduce((sum, i) => sum + blockMb(i), 0)
    const dup = change === DUP
    const upMb = dup ? 0 : sendMb
    const upSeconds = seconds(upMb, mbps)
    const downSeconds = seconds(upMb, DOWNLOAD_MBPS)
    const needed = dup ? [] : changed
    const hashes = (idx: number[]) => idx.slice(0, 3).map((i) => hash(`${path}#${version}#${i}`))
    const shown = (idx: number[]) => `${hashes(idx).join(', ')}${idx.length > 3 ? `, … (${idx.length} in all)` : ''}`

    const steps: Trace['steps'] = []
    steps.push({
      text: dup
        ? `The Desktop Client sees a new ${size} in the synced folder. It cuts the file into ${total} blocks of up to ${BLOCK_MB} MB and hashes each one.`
        : isEdit
          ? `The Desktop Client notices ${path} changed. It re-cuts the ${size} into ${chunking === CDC ? 'content-defined' : 'fixed'} blocks and hashes each one. ${change === START ? (cdc ? 'Cut points follow the content, so the inserted line only changes the first block: every later block has the same bytes and the same hash as before.' : 'Cut points are fixed offsets, so a line added at the start moves every byte after it: every block has a new hash.') : 'Only the block containing the edit has a new hash; the others are byte-for-byte the same as before.'}`
          : `The Desktop Client sees a new ${size} in the synced folder. It cuts the file into ${total} blocks of up to ${BLOCK_MB} MB and hashes each one.`,
      nodes: ['Desktop Client'],
      data: `${path}: ${fmtSize(sizeMb)} → ${total} blocks\n${shown(changed.length ? changed : [0])}${isEdit ? `\nchanged blocks: ${changed.length} of ${total}` : ''}`,
    })
    steps.push(
      {
        text: `The client sends only the list of block hashes, not the bytes, to the API Gateway, which routes it to the Sync Service. The Sync Service asks the Metadata DB which of those hashes it already stores.`,
        nodes: ['Desktop Client', 'API Gateway', 'Sync Service', 'Metadata DB'],
        data: `POST /v1/commit\n${json({ path, base_version: isEdit ? version - 1 : 0, size_mb: sizeMb, blocks: `${total} hashes` })}\nSELECT block_hash FROM blocks WHERE block_hash IN (…${total} hashes…)`,
      },
      {
        text: dup
          ? `All ${total} hashes already exist, because another account stored exactly this file. The Sync Service answers "need: nothing". Nothing is uploaded, which is deduplication.`
          : `${needed.length} of ${total} hashes are new, so the Sync Service answers with that list. ${isEdit ? `The other ${total - needed.length} blocks are already stored and are not sent again.` : 'Everything is new, so every block is needed.'}`,
        nodes: ['Sync Service', 'Metadata DB', 'Desktop Client'],
        data: json({ need: needed.length ? `${needed.length} blocks: ${shown(needed)}` : [], have: total - needed.length }),
      },
    )
    if (!dup) {
      steps.push(
        {
          text: `The client uploads just those ${needed.length} blocks (${fmtSize(upMb)}) to the Block Server in parallel. At ${mbps} Mbps that takes about ${fmtTime(upSeconds)}.${isEdit ? ` Sending the whole file again would take ${fmtTime(seconds(sizeMb, mbps))}.` : ''} Each block is compressed and checked against its hash before it is accepted.`,
          nodes: ['Desktop Client', 'Block Server'],
          data: `PUT /v1/blocks/${hashes(needed)[0]}\n… ${needed.length} blocks\n${fmtSize(upMb)} × 8 ÷ ${mbps} Mbps = ${fmtTime(upSeconds)}${isEdit ? `\n(full re-upload: ${fmtSize(sizeMb)} → ${fmtTime(seconds(sizeMb, mbps))})` : ''}`,
        },
        {
          text: `The Block Server writes each block to the Block Store under its hash, so the same bytes are stored once however many files or users contain them. It also records the hash in the Metadata DB.`,
          nodes: ['Block Server', 'Block Store', 'Metadata DB'],
          data: `blocks/${hashes(needed)[0].replace('sha256:', '').slice(0, 2)}/${hashes(needed)[0].replace('sha256:', '')} ← ${fmtSize(blockMb(needed[0]))}\nINSERT INTO blocks (block_hash, size_mb, refcount) VALUES (…, …, 1);`,
        },
      )
    }
    steps.push(
      {
        text: `Only when every block exists does the client ask the Sync Service to commit. It writes version ${version} of ${path} as a list of block hashes (${total} entries), in one transaction. Until then, other devices still see the old version, so nobody ever sees half a file.`,
        nodes: ['Sync Service', 'Metadata DB', 'Metadata Cache'],
        data: `INSERT INTO file_versions (file_id, version, size_mb, device_id) VALUES (88, ${version}, ${sizeMb}, 'laptop-1');\nINSERT INTO file_blocks (file_id, version, idx, block_hash) … ${total} rows\nDEL folder:/Work   -- cache entry dropped`,
      },
      {
        text: `The Sync Service puts a small "file changed" event on the Message Queue and the Notification Service picks it up. It holds a long-poll connection open to each of the user's other devices and answers it now.`,
        nodes: ['Sync Service', 'Message Queue', 'Notification Service', 'Other Device'],
        data: `${json({ user_id: 4821, file: path, version, cursor: 90417 })}\n→ other device's open request returns: "changes available"`,
      },
      {
        text: dup
          ? `The Other Device asks the API Gateway what changed since its cursor, gets the new block list, and checks its disk: it has none of these blocks, so it downloads all ${total} (${fmtSize(sizeMb)}) from the Block Server at about ${DOWNLOAD_MBPS} Mbps (${fmtTime(seconds(sizeMb, DOWNLOAD_MBPS))}). Deduplication saved the upload, not the download.`
          : `The Other Device asks what changed since its cursor, compares the new block list with the blocks already on its disk, and downloads only the ${needed.length} it lacks (${fmtSize(upMb)}) from the Block Server: about ${fmtTime(downSeconds)} at ${DOWNLOAD_MBPS} Mbps. It then stitches the blocks together into the file.`,
        nodes: ['Other Device', 'Block Server'],
        data: dup
          ? `GET /v1/changes?cursor=90417\nGET /v1/blocks/<hash> × ${total}  (${fmtSize(sizeMb)})`
          : `GET /v1/changes?cursor=90417\nGET /v1/blocks/<hash> × ${needed.length}  (${fmtSize(upMb)})\nreused from local disk: ${total - needed.length} blocks`,
      },
    )
    return { input: `${change}: ${size}, ${chunking.toLowerCase()}, ${network}`, steps }
  },
}

export const fileSync: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'file-sync',
  title: 'File Sync (Dropbox-style)',
  blurb: 'Block-level sync: chunk and hash files, upload only what changed, and tell other devices',
  guides: [
    'scale-sync-engine-2-parts-at-dropbox',
    'scale-magic-pocket-in-house-multi-exabyte-storage-system-at-dropbox',
    'how-to-upload-a-large-file-to-s3',
    'explain-the-top-6-use-cases-of-object-stores',
    'scale-object-storage',
    'shortlong-polling-sse-websocket',
    'scale-stream-data-deduplication',
    'primer-consistency-patterns',
  ],
  takeaways: [
    'Cut files into blocks and name each block by the hash of its bytes: unchanged blocks never travel again.',
    'Metadata (who owns which version, which blocks make it up) and block bytes are separate paths with separate stores.',
    'Equal hashes mean equal bytes, so identical blocks are stored once across files, versions and even users.',
    'Commit a new version only after all its blocks exist, so other devices never see half a file.',
    'Devices keep a cursor and ask "what changed since?"; a long-poll notification just tells them when to ask.',
    'Fixed blocks break when bytes are inserted at the start; content-defined chunking keeps most blocks stable.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'meta', label: 'Metadata path' },
      { id: 'blocks', label: 'Block path' },
      { id: 'notify', label: 'Change notifications' },
    ],
    nodes: [
      { id: 'client', label: 'Desktop Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: null },
      { id: 'sync', label: 'Sync Service', shape: 'rectangle', color: 'violet', group: 'meta' },
      { id: 'metadb', label: 'Metadata DB', shape: 'rectangle', color: 'green', group: 'meta' },
      { id: 'metacache', label: 'Metadata Cache', shape: 'rectangle', color: 'red', group: 'meta' },
      { id: 'blockserver', label: 'Block Server', shape: 'rectangle', color: 'violet', group: 'blocks' },
      { id: 'blockstore', label: 'Block Store', shape: 'rectangle', color: 'green', group: 'blocks' },
      { id: 'queue', label: 'Message Queue', shape: 'rectangle', color: 'yellow', group: 'notify' },
      { id: 'notify', label: 'Notification Service', shape: 'rectangle', color: 'violet', group: 'notify' },
      { id: 'other', label: 'Other Device', shape: 'ellipse', color: 'blue', group: null },
    ],
    edges: [
      { from: 'client', to: 'gateway', label: 'commit / list changes', dashed: false },
      { from: 'gateway', to: 'sync', label: 'metadata calls', dashed: false },
      { from: 'sync', to: 'metacache', label: 'folder lookups', dashed: false },
      { from: 'metacache', to: 'metadb', label: 'on miss', dashed: true },
      { from: 'sync', to: 'metadb', label: 'new version + block list', dashed: false },
      { from: 'client', to: 'blockserver', label: 'upload missing blocks', dashed: false },
      { from: 'blockserver', to: 'blockstore', label: 'put block by hash', dashed: false },
      { from: 'blockserver', to: 'metadb', label: 'record hash', dashed: false },
      { from: 'sync', to: 'queue', label: 'file changed', dashed: false },
      { from: 'queue', to: 'notify', label: 'event', dashed: false },
      { from: 'notify', to: 'other', label: 'long poll: changes available', dashed: true },
      { from: 'other', to: 'blockserver', label: 'download missing blocks', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'user_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'email', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'quota_gb', type: 'int', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'devices',
        name: 'devices',
        columns: [
          { name: 'device_id', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'cursor', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id)'],
      },
      {
        id: 'files',
        name: 'files',
        columns: [
          { name: 'file_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'user_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'path', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'latest_version', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'deleted', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(user_id, path) unique'],
      },
      {
        id: 'file_versions',
        name: 'file_versions',
        columns: [
          { name: 'file_id', type: 'bigint', pk: true, fk: 'files.file_id', nullable: false, unique: false },
          { name: 'version', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'size_bytes', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'device_id', type: 'text', pk: false, fk: 'devices.device_id', nullable: false, unique: false },
          { name: 'change_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: ['(change_id)'],
      },
      {
        id: 'file_blocks',
        name: 'file_blocks',
        columns: [
          { name: 'file_id', type: 'bigint', pk: true, fk: 'file_versions.file_id', nullable: false, unique: false },
          { name: 'version', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'idx', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'block_hash', type: 'char(64)', pk: false, fk: 'blocks.block_hash', nullable: false, unique: false },
        ],
        indexes: ['(block_hash)'],
      },
      {
        id: 'blocks',
        name: 'blocks',
        columns: [
          { name: 'block_hash', type: 'char(64)', pk: true, fk: null, nullable: false, unique: false },
          { name: 'size_bytes', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'refcount', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'users', to: 'devices', kind: 'one-to-many', label: 'signs in on' },
      { from: 'users', to: 'files', kind: 'one-to-many', label: 'owns' },
      { from: 'files', to: 'file_versions', kind: 'one-to-many', label: 'has versions' },
      { from: 'file_versions', to: 'file_blocks', kind: 'one-to-many', label: 'made of' },
      { from: 'blocks', to: 'file_blocks', kind: 'one-to-many', label: 'reused by' },
    ],
  },
  explanation: {
    title: 'File Sync (Dropbox-style)',
    summary:
      'A sync service keeps the same folder identical on all of a person\'s devices. The trick is to never treat a file as one lump: cut it into blocks, name each block by a hash of its bytes, and send only the blocks the server does not already have. A small metadata record says which blocks make up each version of each file.',
    sections: [
      {
        heading: 'Overview',
        body: 'Saving a 200 MB video after editing one scene should not upload 200 MB. So the client cuts every file into blocks (here 4 MB) and computes a hash of each block: a short fingerprint that is the same for the same bytes. The client sends the list of hashes first; the server replies with the ones it does not have; only those blocks are uploaded.\n\nThe server keeps two kinds of data. Block bytes go to cheap, durable object storage, keyed by hash. Metadata (the file tree, versions, and each version\'s ordered list of block hashes) goes to a database. Because a block is addressed by its content, it is immutable and can be shared: two versions of a file, two files, even two users can point at the same stored block (deduplication).\n\nWhen a new version is committed, the other devices are told. They ask for the changes since their last cursor, compare the block list with what is on their disk and download only the missing blocks.',
      },
      {
        heading: 'Requirements',
        body: '- Files added or edited on one device appear on the user\'s other devices within seconds.\n- Large files sync efficiently: only changed parts travel, and a broken upload resumes.\n- Nothing is lost or half-written; concurrent edits never silently overwrite each other.\n- Old versions can be restored.\n- Not covered here: sharing and permissions, real-time co-editing, search, end-to-end encryption.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions (round numbers, not any company\'s real figures): 100 million users, 2 GB stored on average, 20% of users active each day with 10 file changes each, and an average of 2 MB actually uploaded per change thanks to block-level sync.\n- Logical data: 100 M × 2 GB = 200 PB.\n- After deduplication (assume 30% saved): 140 PB. With erasure coding at about 1.5× overhead that is roughly 210 PB on disk, versus 420 PB with 3 full copies.\n- Changes: 20 M × 10 = 200 M commits per day, about 2,300 per second on average and roughly 7,000 per second at a 3× peak.\n- Upload traffic: 200 M × 2 MB = 400 TB per day, about 4.6 GB/s.\n- Block index: 200 PB ÷ 4 MB = 5 × 10¹⁰ blocks (3.5 × 10¹⁰ unique after dedup); at 100 bytes per row that is about 3.5 to 5 TB, so it must be sharded.\n- File metadata: 100 M users × 1,000 files × 200 bytes = 20 TB, also sharded (by user id, so one user\'s tree lives on one shard).',
      },
      {
        heading: 'Step by step',
        body: '1. The Desktop Client sees a file change, cuts it into blocks and hashes each block.\n2. The Desktop Client sends the list of hashes through the API Gateway to the Sync Service.\n3. The Sync Service checks the Metadata DB for which hashes already exist and replies with the missing ones.\n4. The Desktop Client uploads only the missing blocks to the Block Server.\n5. The Block Server stores each block in the Block Store under its hash and records it in the Metadata DB.\n6. The Sync Service commits the new version, as an ordered list of block hashes, in the Metadata DB and updates the Metadata Cache.\n7. The Sync Service puts a "file changed" event on the Message Queue.\n8. The Notification Service reads the event and wakes the Other Device through its open long-poll connection.\n9. The Other Device asks for the changes since its cursor, then downloads only the blocks it lacks from the Block Server and rebuilds the file.',
      },
      {
        heading: 'Components',
        body: '- Desktop Client: watches the folder, cuts files into blocks, hashes them, keeps a local database of what it has synced.\n- API Gateway: authenticates the device and routes metadata calls to the Sync Service.\n- Sync Service: the brain; compares block lists, commits versions atomically, and hands out change lists by cursor.\n- Metadata DB: users, devices, the file tree, versions, and the ordered block list of every version; sharded by user id.\n- Metadata Cache: keeps hot folder listings in memory so that opening a folder does not hit the database.\n- Block Server: accepts and serves blocks; verifies each hash, compresses, and keeps clients away from the raw storage.\n- Block Store: object storage that holds the immutable blocks, keyed by hash, replicated or erasure-coded.\n- Message Queue: carries "file changed" events from the Sync Service so commits do not wait for notifications.\n- Notification Service: keeps one open long-poll connection per device and answers it when there are changes.\n- Other Device: the user\'s second computer or phone; it pulls changes and downloads missing blocks.',
      },
      {
        heading: 'Key decisions',
        body: '- Block size: small blocks send less when a file changes but create more hashes, rows and requests; big blocks are cheaper to track but resend more. 4 MB is a common middle.\n- Fixed vs content-defined chunking: fixed offsets are simple, but inserting a byte near the start shifts every later block. Content-defined chunking cuts where a rolling hash of the bytes hits a pattern, so the cuts move with the content and only nearby blocks change.\n- Hash everything: equal hashes give you dedup and integrity checking for free. Use a strong hash (SHA-256) so collisions are not a concern.\n- Commit last: write blocks first, metadata last. A crash in between leaves only unreferenced blocks, which a garbage collector removes later.\n- Notify, then pull: the event only says "something changed". The device pulls by cursor, so a missed notification is harmless; the next poll or startup catches up.\n- Conflicts: if two devices edit the same base version, the second commit is refused; keep both files ("report (conflicted copy)") instead of overwriting.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Block Servers are stateless and scale by adding machines; blocks go straight to object storage, which scales on its own.\n- The Metadata DB is the hard part: shard by user id so a user\'s tree and versions stay together, and keep a read replica or cache for folder listings.\n- An interrupted upload resumes: the client asks again which hashes are missing and sends only those.\n- Reference counts (or mark and sweep) decide when a block is unused by any version and can be deleted; keep deleted files for a retention period first.\n- A device that was offline for a week simply asks for changes since its old cursor; if the change log was trimmed, it falls back to a full compare of its tree with the server.\n- Hot spots: one shared folder with thousands of members means thousands of long-poll answers per commit; batch events per user and fan out from the Notification Service.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you detect and resolve a conflict when a laptop edits a file while offline?\n- Why is deduplication across different users a privacy risk, and how can it be limited?\n- How would you add end-to-end encryption without losing deduplication?\n- How would you do version history and "restore this file to Tuesday"?\n- What changes when the shared folder has 10,000 members?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Cut a file into 4 MB blocks and hash each one',
        language: 'typescript',
        source: `import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const BLOCK = 4 * 1024 * 1024

// Returns one SHA-256 per fixed 4 MB block (the last may be shorter).
export async function blockHashes(path: string): Promise<string[]> {
  const hashes: string[] = []
  let pending = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    pending = Buffer.concat([pending, chunk as Buffer])
    while (pending.length >= BLOCK) {
      hashes.push(createHash('sha256').update(pending.subarray(0, BLOCK)).digest('hex'))
      pending = pending.subarray(BLOCK)
    }
  }
  if (pending.length) hashes.push(createHash('sha256').update(pending).digest('hex'))
  return hashes
}`,
      },
      {
        title: 'Content-defined chunking with a rolling hash',
        language: 'python',
        source: `import hashlib, random

random.seed(7)
GEAR = [random.getrandbits(32) for _ in range(256)]  # one random number per byte value
MASK = (1 << 20) - 1         # cut when the low 20 bits are zero: ~1 MB average
MIN, MAX = 256 * 1024, 4 * 1024 * 1024

def chunks(data: bytes):
    start, h = 0, 0
    for i, byte in enumerate(data):
        h = ((h << 1) + GEAR[byte]) & 0xFFFFFFFF   # old bytes shift out after 32 steps
        size = i - start + 1
        if (size >= MIN and (h & MASK) == 0) or size >= MAX:
            yield data[start : i + 1]
            start, h = i + 1, 0
    if start < len(data):
        yield data[start:]

# Insert one byte at the start: only the first chunk's hash changes.
a = bytes(random.getrandbits(8) for _ in range(8_000_000))
before = [hashlib.sha256(c).hexdigest()[:8] for c in chunks(a)]
after = [hashlib.sha256(c).hexdigest()[:8] for c in chunks(b"x" + a)]
print(len(before), "chunks;", len(set(after) - set(before)), "new after an insert")`,
      },
      {
        title: 'Which blocks does the server still need?',
        language: 'sql',
        source: `-- The client sends its hashes; the server answers with the ones it lacks.
WITH incoming(block_hash) AS (
  VALUES ('9f2c…'), ('41ab…'), ('c07e…')
)
SELECT i.block_hash
FROM incoming i
LEFT JOIN blocks b ON b.block_hash = i.block_hash
WHERE b.block_hash IS NULL;

-- Commit succeeds only if nobody committed since the client's base version.
UPDATE files SET latest_version = 4
WHERE file_id = 88 AND latest_version = 3;   -- 0 rows updated = conflict`,
      },
      {
        title: 'A device asks what changed since its cursor',
        language: 'bash',
        source: `# Long poll: the server holds this request open until there is something new.
curl -s "https://sync.example.com/v1/changes?cursor=90417&wait=60" \\
  -H "Authorization: Bearer $TOKEN"
# → { "cursor": 90422, "changes": [{ "path": "/Work/Q3-plan.mov", "version": 4 }] }`,
      },
    ],
    related: ['Content-addressable storage', 'Deduplication', 'Content-defined chunking', 'Long polling', 'Object storage', 'Conflict resolution'],
  },
  simulator,
}
