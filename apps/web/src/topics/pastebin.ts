import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Adapted from "Design Pastebin.com (or Bit.ly)" in the System Design Primer by
// Donne Martin (CC BY 4.0). Requirements, estimates and the core design (MD5 of
// ip + timestamp, base 62, metadata in SQL, text in an object store) follow the
// primer; the walkthrough, simulator, code and the expiry and collision detail
// are Structura's.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const KEY_LENGTH = 7

/** MD5 (RFC 1321), so the keys shown are the real ones a server would make. */
export function md5(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input)
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
  const padded = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor((bytes.length * 8) / 2 ** 32), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let off = 0; off < padded.length; off += 64) {
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true))
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const sum = (a + f + k[i] + m[g]) | 0
      const s = shifts[(i >> 4) * 4 + (i % 4)]
      a = d
      d = c
      c = b
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  ;[a0, b0, c0, d0].forEach((v, i) => outView.setUint32(i * 4, v >>> 0, true))
  return out
}

/** The paste key: MD5 of "ip + timestamp", written in base 62, first 7 characters. */
export function pasteKey(source: string): string {
  let n = 0n
  for (const byte of md5(source)) n = (n << 8n) | BigInt(byte)
  let code = ''
  while (n > 0n) {
    code = BASE62[Number(n % 62n)] + code
    n /= 62n
  }
  return code.slice(0, KEY_LENGTH)
}

const CLIENT_IP = '203.0.113.42'
const CREATED = Date.UTC(2026, 2, 14, 9, 41, 7)
const MAX_MIN = 30 * 24 * 60

const PASTES: Record<string, { text: string; bytes: number; note: string }> = {
  'Python snippet (a few lines)': {
    text: 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n',
    bytes: 0,
    note: '',
  },
  'Nginx error log (about 48 KB)': {
    text: '2026/03/14 09:40:51 [error] 1187#1187: *4021 connect() failed (111: Connection refused) while connecting to upstream\n…',
    bytes: 48_000,
    note: ' (shortened here; the real paste is about 48 KB)',
  },
}
for (const p of Object.values(PASTES)) if (!p.bytes) p.bytes = new TextEncoder().encode(p.text).length

const EXPIRY: Record<string, number | null> = {
  '10 minutes': 10,
  '1 month': MAX_MIN,
  'Never expires': null,
}

const ACTIONS = ['Create a paste', 'Read it (cache hit)', 'Read it (cache miss)', 'Read it after it expired']

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
const fmt = (n: number) => n.toLocaleString('en-US')
const kb = (bytes: number) => (bytes >= 1000 ? `${(bytes / 1000).toFixed(bytes >= 10_000 ? 0 : 1)} KB` : `${bytes} B`)

/** Keys are made from "ip + timestamp"; a repeat key means another paste already has it. */
const keyFor = (salt = '') => pasteKey(`${CLIENT_IP}${CREATED}${salt}`)

const simulator: Simulator = {
  fields: [
    { id: 'action', label: 'What happens', options: ACTIONS },
    { id: 'paste', label: 'The paste', options: Object.keys(PASTES) },
    { id: 'expiry', label: 'Expires after', options: Object.keys(EXPIRY) },
  ],
  defaults: { action: 'Create a paste', paste: 'Python snippet (a few lines)', expiry: '10 minutes' },
  run({ action, paste, expiry }) {
    const p = PASTES[paste] ?? PASTES['Python snippet (a few lines)']
    const minutes = expiry in EXPIRY ? EXPIRY[expiry] : 10
    const expiresAt = minutes === null ? null : CREATED + minutes * 60_000
    const key = keyFor()
    const path = `pastes/${key}.txt`
    const expiresText = expiresAt === null ? 'never' : iso(expiresAt)
    const steps: Trace['steps'] = []
    const input = `${action}: ${paste.toLowerCase()}, ${expiry === 'Never expires' ? 'never expires' : `expires after ${expiry}`}`

    if (action === 'Create a paste') {
      steps.push(
        {
          text: `The Client sends the text and how long to keep it. The Web Server (a reverse proxy) forwards it to the Write API.`,
          nodes: ['Client', 'Web Server', 'Write API'],
          data: `POST /api/v1/paste\n${json({ paste_contents: p.text.length > 120 ? p.text.slice(0, 117) + '…' : p.text, expiration_length_in_minutes: minutes ?? 0 })}${minutes === null ? '\n(0 = never expires)' : ''}`,
        },
        {
          text: `The Write API makes the paste's key: MD5 of the client's IP plus the timestamp, written in base 62, first ${KEY_LENGTH} characters. ${KEY_LENGTH} characters of base 62 give 62^7 = 3.5 trillion keys, about 98,000 times the 36 million pastes expected in 3 years.`,
          nodes: ['Write API'],
          data: `md5("${CLIENT_IP}${CREATED}")\n= ${Array.from(md5(`${CLIENT_IP}${CREATED}`), (b) => b.toString(16).padStart(2, '0')).join('')}\n→ base62 → first ${KEY_LENGTH}: ${key}`,
        },
        {
          text: `The paste text goes to the Object Store, not the database: a row stays tiny while the text (here ${kb(p.bytes)}${p.note}) lives in cheap blob storage, which is the primer's choice for a read-heavy service.`,
          nodes: ['Write API', 'Object Store'],
          data: `PUT s3://pastebin/${path}  (${fmt(p.bytes)} bytes)`,
        },
        {
          text: 'The Write API saves the metadata in the SQL Database: the key, when it expires, when it was created and where the text lives. The key is the primary key, so a clash is rejected instead of overwriting.',
          nodes: ['Write API', 'SQL Database'],
          data: `INSERT INTO pastes (shortlink, expiration_length_in_minutes, created_at, paste_path)\nVALUES ('${key}', ${minutes ?? 0}, '${iso(CREATED)}', '${path}');\n\nexpires: ${expiresText}`,
        },
        {
          text: 'The Write API returns the link. Nothing has been read yet, so the Memory Cache (Redis) is filled lazily by the first reader. The Web Server also appends the request to an access log for the Analytics Job.',
          nodes: ['Write API', 'Web Server', 'Client'],
          data: `HTTP/1.1 201 Created\n${json({ shortlink: key, url: `https://pastebin.example/${key}` })}`,
        },
      )
      return { input, steps }
    }

    const readTime = action === 'Read it after it expired' && expiresAt !== null ? expiresAt + 5 * 60_000 : CREATED + 3 * 60_000
    steps.push({
      text: 'A reader opens the link. The Web Server forwards it to the Read API.',
      nodes: ['Client', 'Web Server', 'Read API'],
      data: `GET /api/v1/paste?shortlink=${key}\nat ${iso(readTime)}`,
    })

    if (action === 'Read it (cache hit)') {
      steps.push(
        {
          text: 'The Read API asks the Memory Cache (Redis) first. This paste was read a moment ago, so it is there, and its time-to-live matches the paste\'s own expiry, so a cached copy can never outlive the paste.',
          nodes: ['Read API', 'Memory Cache (Redis)'],
          data: `GET paste:${key}\n→ ${fmt(p.bytes)} bytes${expiresAt === null ? '' : `\nTTL ${Math.round((expiresAt - readTime) / 1000)} s left`}`,
        },
        {
          text: 'The text goes straight back. No database or object store was touched: this is how the 10:1 read-to-write ratio stays cheap.',
          nodes: ['Read API', 'Client'],
          data: `HTTP/1.1 200 OK\n${json({ shortlink: key, expires: expiresText })}`,
        },
      )
    } else if (action === 'Read it (cache miss)' || expiresAt === null) {
      const neverNote = action === 'Read it after it expired' ? `This paste never expires, so there is nothing to expire: it is read like any other paste. ` : ''
      steps.push(
        {
          text: `${neverNote}The Read API asks the Memory Cache (Redis); nobody has read this paste yet, so it misses.`,
          nodes: ['Read API', 'Memory Cache (Redis)'],
          data: `GET paste:${key}\n→ (nil)`,
        },
        {
          text: 'It looks the key up in the SQL Database. The primary-key lookup returns the expiry and where the text is stored. The paste is still valid, so reading continues.',
          nodes: ['Read API', 'SQL Database'],
          data: `SELECT paste_path, expiration_length_in_minutes, created_at\nFROM pastes WHERE shortlink = '${key}';\n→ ${path}, ${minutes ?? 0}, ${iso(CREATED)}\nexpires: ${expiresText}`,
        },
        {
          text: 'The Read API fetches the text from the Object Store.',
          nodes: ['Read API', 'Object Store'],
          data: `GET s3://pastebin/${path}\n→ ${fmt(p.bytes)} bytes`,
        },
        {
          text: 'It fills the Memory Cache (Redis) so the next reader skips both stores, then returns the text.',
          nodes: ['Read API', 'Memory Cache (Redis)', 'Client'],
          data: `SET paste:${key} <${fmt(p.bytes)} bytes>${expiresAt === null ? ' EX 86400' : ` EX ${Math.round((expiresAt - readTime) / 1000)}`}\n\nHTTP/1.1 200 OK`,
        },
      )
    } else {
      steps.push(
        {
          text: 'The Memory Cache (Redis) has nothing: its entry expired together with the paste.',
          nodes: ['Read API', 'Memory Cache (Redis)'],
          data: `GET paste:${key}\n→ (nil)`,
        },
        {
          text: `The SQL Database still has the row, but the Read API checks the expiry on every read: ${expiresText} is before the read time ${iso(readTime)}. Expiry is enforced at read time, so a paste disappears the moment it expires, not when the cleanup runs.`,
          nodes: ['Read API', 'SQL Database'],
          data: `created ${iso(CREATED)} + ${minutes} min = ${expiresText}\nnow = ${iso(readTime)} → expired by ${Math.round((readTime - (expiresAt ?? 0)) / 60_000)} min`,
        },
        {
          text: 'The Read API answers 404 without touching the Object Store.',
          nodes: ['Read API', 'Client'],
          data: `HTTP/1.1 404 Not Found\n${json({ error: 'paste expired or does not exist' })}`,
        },
        {
          text: 'Later, the Expiry Cleanup Job deletes expired rows in small batches and the matching objects, so storage is reclaimed without slowing readers.',
          nodes: ['Expiry Cleanup Job', 'SQL Database', 'Object Store'],
          data: `-- batch of up to 1,000 expired rows (full query in the code tab)\nDELETE FROM pastes WHERE shortlink = '${key}' RETURNING paste_path;\n→ ${path}  (then deleted from the Object Store)`,
        },
      )
    }
    steps.push({
      text: 'Every request is logged by the Web Server. The Analytics Job aggregates the logs later (hits per month per paste), off the request path.',
      nodes: ['Web Server', 'Analytics Job'],
      data: `203.0.113.42 "GET /${key}" ${action === 'Read it after it expired' && expiresAt !== null ? 404 : 200} ${iso(readTime)}`,
    })
    return { input, steps }
  },
}

export const pastebin: StaticTopic = {
  difficulty: 'Beginner',
  kind: 'static',
  id: 'pastebin',
  title: 'Pastebin',
  blurb: 'Short keys, metadata in SQL, text in an object store, expiry and caching',
  adaptedFrom: {
    title: 'Design Pastebin.com (or Bit.ly)',
    author: 'Donne Martin, System Design Primer',
    url: 'https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/pastebin/README.md',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  guides: ['primer-design-pastebincom-or-bitly', 'primer-cache', 'primer-database', 'consistent-hashing'],
  takeaways: [
    'Split a paste in two: a small metadata row in SQL and the text in an object store.',
    'The key is MD5 of ip + timestamp in base 62; seven characters give 3.5 trillion keys.',
    'Make the key the primary key, so a collision is rejected and retried with a new salt.',
    'Reads outnumber writes 10 to 1, so cache hot pastes and match the cache TTL to the paste expiry.',
    'Check the expiry on every read; let a background job reclaim space later.',
    'Logging and analytics run from access logs, off the request path.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'api', label: 'API servers' },
      { id: 'data', label: 'Storage' },
      { id: 'background', label: 'Background' },
    ],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'web', label: 'Web Server', shape: 'rectangle', color: 'violet', group: null },
      { id: 'write', label: 'Write API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'read', label: 'Read API', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'cache', label: 'Memory Cache (Redis)', shape: 'rectangle', color: 'red', group: 'data' },
      { id: 'sql', label: 'SQL Database', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'objects', label: 'Object Store', shape: 'rectangle', color: 'green', group: 'data' },
      { id: 'cleanup', label: 'Expiry Cleanup Job', shape: 'rectangle', color: 'orange', group: 'background' },
      { id: 'analytics', label: 'Analytics Job', shape: 'rectangle', color: 'orange', group: 'background' },
    ],
    edges: [
      { from: 'client', to: 'web', label: 'HTTPS', dashed: false },
      { from: 'web', to: 'write', label: 'POST /paste', dashed: false },
      { from: 'web', to: 'read', label: 'GET /paste', dashed: false },
      { from: 'write', to: 'sql', label: 'metadata row', dashed: false },
      { from: 'write', to: 'objects', label: 'paste text', dashed: false },
      { from: 'read', to: 'cache', label: 'hot pastes', dashed: false },
      { from: 'read', to: 'sql', label: 'on a miss', dashed: true },
      { from: 'read', to: 'objects', label: 'fetch text', dashed: true },
      { from: 'cleanup', to: 'sql', label: 'delete expired', dashed: false },
      { from: 'cleanup', to: 'objects', label: 'delete text', dashed: false },
      { from: 'web', to: 'analytics', label: 'access logs', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'pastes',
        name: 'pastes',
        columns: [
          { name: 'shortlink', type: 'char(7)', pk: true, fk: null, nullable: false, unique: false },
          { name: 'expiration_length_in_minutes', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
          { name: 'paste_path', type: 'varchar(255)', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(created_at) — cleanup scans oldest first'],
      },
    ],
    relations: [],
  },
  explanation: {
    title: 'Pastebin',
    summary:
      'A user pastes text and gets a short link; anyone with the link can read it until it expires. The text sits in an object store, a small row in SQL records the key and expiry, a cache serves hot pastes, and a background job removes expired ones.',
    sections: [
      {
        heading: 'Overview',
        body: 'Pastebin looks like a URL shortener, with one difference: the thing behind the link is a block of text that can be kilobytes or megabytes, not a short URL. So the design splits each paste in two:\n- Metadata (key, expiry, creation time, where the text is): a few dozen bytes, in SQL.\n- The text itself: in an object store, which is cheap and built for large blobs.\n\nThe rest is the usual read-heavy toolkit: a cache for hot pastes and background jobs for cleanup and analytics.',
      },
      {
        heading: 'Requirements',
        body: 'In scope:\n- A user enters text and gets a randomly generated link.\n- Pastes expire after a set time, which the user can choose.\n- A user opens a link and sees the text.\n- The service tracks page analytics (monthly visit counts).\n- High availability.\n\nOut of scope: custom aliases, accounts, and editing a paste.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions from the System Design Primer:\n- 1 million new pastes a month and 10 million reads a month (10:1 read to write).\n- About 1 KB of text per paste.\n\nWhich works out to:\n- About 0.4 writes per second and about 4 reads per second.\n- 1 GB of new text a month; 36 GB, and 36 million pastes, in 3 years.\n- 62^7 = 3.5 trillion possible 7-character keys, about 98,000 times more than the 36 million needed.\n\nHandy rule: 400 requests per second ≈ 1 billion requests per month. This is a small system; the point is the structure, not the scale.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client sends the paste text and an expiry to the Web Server, which forwards it to the Write API.\n2. The Write API makes a 7-character key: MD5 of the IP plus timestamp, in base 62.\n3. It stores the text in the Object Store and the metadata row in the SQL Database.\n4. It returns the link to the Client.\n5. To read, the Client opens the link and the Web Server forwards it to the Read API.\n6. The Read API checks the Memory Cache (Redis) first.\n7. On a miss it reads the SQL Database for the path and expiry, and the text from the Object Store, then fills the cache.\n8. The Web Server writes access logs for the Analytics Job, and the Expiry Cleanup Job removes expired pastes in the background.',
      },
      {
        heading: 'Components',
        body: '- Client: a browser or API caller that posts and reads pastes.\n- Web Server: a reverse proxy: TLS, routing and the access log.\n- Write API: makes the key and stores the text and the row.\n- Read API: looks up a key, enforces expiry and returns the text.\n- Memory Cache (Redis): the most recently read pastes, with a TTL equal to the time left.\n- SQL Database: one small row per paste, keyed by shortlink.\n- Object Store: the paste text, one object per paste.\n- Expiry Cleanup Job: deletes expired rows and objects in batches.\n- Analytics Job: counts visits from the access logs, for example with MapReduce.',
      },
      {
        heading: 'Key decisions',
        body: '- Text in an object store, row in SQL. A 5 MB paste would bloat a table and its backups; a blob store handles size cheaply and scales without sharding.\n- Hash then truncate vs a counter. MD5 of ip + timestamp needs no coordination, but truncating to 7 characters can collide. A counter-based ID (as in the URL shortener) never collides but needs one shared sequence.\n- Collisions. The key is the primary key: an insert that clashes fails, and the Write API retries with a salt added to the input.\n- Expiry on read. A paste must stop working at its deadline, so the Read API compares the clock on every read. The cleanup job only reclaims space.\n- Cache TTL = remaining time, so the cache cannot serve a dead paste.',
      },
      {
        heading: 'Scaling and failure',
        body: '- At this size, one SQL primary with a replica is enough; the cache absorbs most reads.\n- If it grows: read replicas, then shard the pastes table by key. Keys are hashes, so shards fill evenly.\n- The Object Store replicates itself; put a CDN in front for pastes that go viral.\n- The cleanup job deletes in small batches so it does not lock the table, and is safe to re-run.\n- If the cache fails, reads fall back to SQL and the Object Store: slower, not broken.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- What happens when two pastes get the same key? Where is it caught?\n- Why enforce expiry at read time as well as in a cleanup job?\n- How would you support custom aliases without a collision race?\n- A paste goes viral: what protects the Object Store?\n- How would you stop one client from creating millions of pastes?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Make the paste key',
        language: 'javascript',
        source: `import { createHash } from 'node:crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// MD5 of ip + timestamp, written in base 62, first 7 characters.
export function pasteKey(ip, timestamp, salt = '') {
  let n = BigInt('0x' + createHash('md5').update(ip + timestamp + salt).digest('hex'))
  let code = ''
  while (n > 0n) {
    code = BASE62[Number(n % 62n)] + code
    n /= 62n
  }
  return code.slice(0, 7)
}`,
      },
      {
        title: 'Create a paste (retry on collision)',
        language: 'python',
        source: `def create_paste(db, store, text, minutes, ip, now):
    path = None
    for attempt in range(5):
        key = paste_key(ip, now, salt=str(attempt) if attempt else "")
        path = f"pastes/{key}.txt"
        store.put(path, text)  # write the blob first: an orphan blob is harmless
        try:
            # shortlink is the primary key, so a clash raises instead of overwriting
            db.execute(
                "INSERT INTO pastes (shortlink, expiration_length_in_minutes, created_at, paste_path)"
                " VALUES (%s, %s, %s, %s)",
                (key, minutes, now, path),
            )
            return key
        except UniqueViolation:
            continue  # another paste has this key: try again with a salt
    raise RuntimeError("could not find a free key")`,
      },
      {
        title: 'Read with expiry and cache',
        language: 'python',
        source: `def read_paste(cache, db, store, key, now):
    text = cache.get(f"paste:{key}")
    if text is not None:
        return text  # TTL was set to the time left, so it cannot be expired

    row = db.query_one("SELECT paste_path, created_at, expiration_length_in_minutes"
                       " FROM pastes WHERE shortlink = %s", (key,))
    if row is None:
        return None
    path, created, minutes = row
    if minutes > 0 and created + timedelta(minutes=minutes) <= now:
        return None  # enforce expiry on every read, cleanup comes later

    text = store.get(path)
    ttl = int((created + timedelta(minutes=minutes) - now).total_seconds()) if minutes else 86400
    cache.set(f"paste:{key}", text, ex=ttl)
    return text`,
      },
      {
        title: 'Cleanup job',
        language: 'sql',
        source: `-- Run every few minutes. Small batches keep locks short; safe to re-run.
DELETE FROM pastes
WHERE shortlink IN (
  SELECT shortlink FROM pastes
  WHERE expiration_length_in_minutes > 0
    AND created_at + expiration_length_in_minutes * interval '1 minute' < now()
  ORDER BY created_at
  LIMIT 1000
)
RETURNING paste_path; -- then delete these objects from the store`,
      },
    ],
    related: ['Object storage', 'Caching', 'Base62 encoding', 'TTL', 'Hash collisions', 'MapReduce'],
  },
  simulator,
}
