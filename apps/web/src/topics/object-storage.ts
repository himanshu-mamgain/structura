import type { Trace } from '@structura/shared'
import { defaultTrace, json, stableHash, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written for Structura from general knowledge, not adapted from a source.
// The simulator uploads one object, spreads it over 3 zones, breaks some disks and tries to read it.
// Every size, overhead and loss chance below is computed from the scheme, not typed in.

const MB = 1_000_000
const PART_BYTES = 8 * MB // the client uploads in 8 MB parts
const DISK_AFR = 0.02 // a disk dies about 2 times in 100 years
const REPAIR_DAYS = 1 // a lost shard is rebuilt within a day
const ZONES = ['Zone A', 'Zone B', 'Zone C']

const OBJECTS = ['12 MB photo', '400 MB video', '5 GB backup']
const OBJECT_BYTES: Record<string, number> = { '12 MB photo': 12 * MB, '400 MB video': 400 * MB, '5 GB backup': 5000 * MB }
const SCHEMES = ['3 full copies', 'Erasure coding 6+3', 'Erasure coding 10+4']
const FAILURES = ['Nothing fails', '1 disk dies', '3 disks die', '4 disks die', 'All of Zone A is lost']

interface Scheme {
  k: number // pieces you need to rebuild the object
  m: number // extra pieces you may lose
}
const SCHEME: Record<string, Scheme> = {
  '3 full copies': { k: 1, m: 2 },
  'Erasure coding 6+3': { k: 6, m: 3 },
  'Erasure coding 10+4': { k: 10, m: 4 },
}

const nice = (bytes: number) => (bytes >= 1000 * MB ? `${+(bytes / (1000 * MB)).toFixed(2)} GB` : `${+(bytes / MB).toFixed(2)} MB`)

function choose(n: number, r: number) {
  let v = 1
  for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i
  return v
}

/** The chance a given object is lost in a year: more than m of its n disks fail inside one repair window. */
function yearlyLoss(n: number, m: number) {
  const p = (DISK_AFR * REPAIR_DAYS) / 365
  let window = 0
  for (let j = m + 1; j <= n; j++) window += choose(n, j) * p ** j * (1 - p) ** (n - j)
  return window * (365 / REPAIR_DAYS)
}

function oneIn(x: number) {
  const n = 1 / x
  for (const [unit, word] of [[1e15, 'quadrillion'], [1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million']] as const) {
    if (n >= unit) return `1 in about ${+(n / unit).toFixed(1)} ${word}`
  }
  return `1 in about ${Math.round(n).toLocaleString('en-US')}`
}

function simulate(object: string, scheme: string, failure: string) {
  const size = OBJECT_BYTES[object] ?? OBJECT_BYTES[OBJECTS[0]]
  const { k, m } = SCHEME[scheme] ?? SCHEME[SCHEMES[1]]
  const copies = k === 1
  const n = k + m // pieces stored: 3 copies, or k data + m parity shards
  const shardBytes = copies ? size : Math.ceil(size / k)
  const stored = shardBytes * n
  const parts = Math.ceil(size / PART_BYTES)
  // Piece i goes to zone i % 3, so each zone holds about a third of them.
  const inZoneA = Array.from({ length: n }, (_, i) => i).filter((i) => i % 3 === 0).length
  const wanted = failure === FAILURES[1] ? 1 : failure === FAILURES[2] ? 3 : failure === FAILURES[3] ? 4 : failure === FAILURES[4] ? inZoneA : 0
  const lost = Math.min(wanted, n) // 3 copies can't lose 4 pieces: there are only 3
  const readable = lost <= m
  const survivors = n - lost
  return {
    size,
    k,
    m,
    n,
    copies,
    shardBytes,
    stored,
    parts,
    overhead: stored / size,
    inZoneA,
    lost,
    readable,
    survivors,
    // Rebuilding one lost piece: copies read one whole copy; erasure coding reads k shards (one object's worth).
    repairRead: readable && lost > 0 ? size : 0,
    repairWrite: readable ? lost * shardBytes : 0,
    yearly: yearlyLoss(n, m),
    etag: stableHash(`${object}:${scheme}`).toString(16).padStart(8, '0'),
  }
}

const simulator: Simulator = {
  fields: [
    { id: 'object', label: 'Object you upload', options: OBJECTS },
    { id: 'scheme', label: 'How it is protected', options: SCHEMES },
    { id: 'failure', label: 'What breaks', options: FAILURES },
  ],
  defaults: { object: OBJECTS[1], scheme: SCHEMES[1], failure: FAILURES[2] },
  run({ object, scheme, failure }) {
    const r = simulate(object, scheme, failure)
    const key = `photos/2026/${object.includes('video') ? 'trip.mp4' : object.includes('photo') ? 'cat.jpg' : 'laptop-backup.tar'}`
    const label = r.copies ? `${r.n} full copies` : `${r.k} data + ${r.m} parity shards`
    const steps: Trace['steps'] = []

    steps.push({
      text: `The Client uploads the ${object} with PUT ${key}. A big file is sent in ${PART_BYTES / MB} MB parts, so ${r.parts} part${r.parts === 1 ? '' : 's'} go in at once and a dropped connection only repeats one part. The API Gateway checks who is calling and whether they may write to this bucket.`,
      nodes: ['Client', 'API Gateway'],
      data: `PUT /${key}\nContent-Length: ${r.size}\nmultipart: ${r.parts} part${r.parts === 1 ? '' : 's'} × ${PART_BYTES / MB} MB${r.parts > 1 && r.size % PART_BYTES ? ` (the last part is ${nice(r.size - (r.parts - 1) * PART_BYTES)})` : ''}\nAuthorization: signed by the caller's key`,
    })

    steps.push({
      text: r.copies
        ? `With full copies the Erasure Coder has little to do: it sends the whole object to ${r.n} nodes. Each copy is ${nice(r.shardBytes)}, so ${nice(r.size)} costs ${nice(r.stored)} of disk, an overhead of ${r.overhead}×.`
        : `The Erasure Coder cuts the object into ${r.k} data shards of ${nice(r.shardBytes)} each (${nice(r.size)} ÷ ${r.k}) and computes ${r.m} parity shards of the same size. That is ${r.n} shards, ${nice(r.stored)} on disk: an overhead of ${+r.overhead.toFixed(2)}×. Any ${r.k} of the ${r.n} shards are enough to rebuild the object.`,
      nodes: ['API Gateway', 'Erasure Coder'],
      data: r.copies
        ? `scheme: ${label}\ncopy size: ${r.shardBytes} bytes\nstored: ${r.shardBytes} × ${r.n} = ${r.stored} bytes\noverhead: ${r.overhead}×`
        : `scheme: ${r.k}+${r.m}\nshard size: ceil(${r.size} ÷ ${r.k}) = ${r.shardBytes} bytes\nshards: ${r.n} (${r.k} data + ${r.m} parity)\nstored: ${r.shardBytes} × ${r.n} = ${r.stored} bytes\noverhead: ${r.n} ÷ ${r.k} = ${+r.overhead.toFixed(2)}×`,
    })

    steps.push({
      text: `The ${r.copies ? 'copies' : 'shards'} are spread over three zones (separate buildings with their own power), piece number i going to zone i mod 3. Zone A gets ${r.inZoneA} of the ${r.n}, so losing a whole zone loses at most ${r.inZoneA}. Each piece is saved with a checksum, a short fingerprint of its bytes.`,
      nodes: ['Erasure Coder', 'Storage Nodes (Zone A)', 'Storage Nodes (Zone B)', 'Storage Nodes (Zone C)'],
      data: Array.from({ length: Math.min(r.n, 6) }, (_, i) => `piece ${i} → ${ZONES[i % 3]}  fnv1a ${stableHash(`${r.etag}:${i}`).toString(16).padStart(8, '0')}`).join('\n') + (r.n > 6 ? `\n… ${r.n - 6} more` : ''),
    })

    steps.push({
      text: `Only after every piece is safely written does the Metadata Service record the object: its key, size, version and where each piece lives. Then the Client gets "200 OK" with an ETag (a fingerprint of the whole object). Until that row exists, the object does not exist for readers.`,
      nodes: ['Metadata Service', 'Metadata DB'],
      data: json({ bucket: 'photos', key, version: 'v1', size: r.size, scheme: r.copies ? 'replica-3' : `ec-${r.k}-${r.m}`, pieces: r.n, etag: r.etag }),
    })

    steps.push({
      text: failure === FAILURES[0]
        ? `Nothing breaks. All ${r.n} pieces are healthy, and the chance of losing this object is ${oneIn(r.yearly)} a year (each disk fails 2% of years, and a lost piece is rebuilt within ${REPAIR_DAYS} day).`
        : `${failure}. That removes ${r.lost} of the ${r.n} pieces, leaving ${r.survivors}. ${r.copies ? 'One surviving copy is enough' : `You need ${r.k}`}, and you have ${r.survivors}${r.survivors >= r.k ? ': still readable.' : `: ${r.k - r.survivors} short, so the object cannot be rebuilt.`}`,
      nodes: ['Storage Nodes (Zone A)', 'Storage Nodes (Zone B)', 'Storage Nodes (Zone C)'],
      data: `pieces stored: ${r.n}\npieces lost: ${r.lost}\npieces left: ${r.survivors}\nneeded to read: ${r.k}\nyou can lose at most ${r.m}\nloss chance in a year (nothing broken now): ${r.yearly.toExponential(1)}  (${oneIn(r.yearly)} a year)`,
    })

    steps.push({
      text: r.readable
        ? `The Client reads GET ${key}. The Metadata Service says where the pieces are. ${r.copies ? 'The API Gateway reads from any healthy copy.' : r.lost ? `The Erasure Coder fetches any ${r.k} of the ${r.survivors} surviving shards and rebuilds the missing data with maths. The read is a little slower.` : `The Erasure Coder reads the ${r.k} data shards in parallel and joins them. The parity shards are not touched.`} The bytes come back ${r.lost ? 'correct, though some disks are gone' : 'unchanged'}.`
        : `The Client reads GET ${key}. The Metadata Service lists the pieces, but only ${r.survivors} of the ${r.k} needed can be read. The API Gateway returns an error: the object is lost. This is the failure the scheme was meant to prevent, and ${r.lost} lost pieces were more than the ${r.m} it can take.`,
      nodes: ['Client', 'API Gateway', 'Metadata Service', 'Erasure Coder'],
      data: r.readable
        ? `GET /${key}\n→ 200 OK, ${r.size} bytes\npieces read: ${r.copies ? 1 : r.k} of ${r.survivors} healthy\nbytes read from disks: ${r.size}\ndegraded read: ${r.lost ? 'yes' : 'no'}`
        : `GET /${key}\n→ 500 data lost\npieces left: ${r.survivors}, needed: ${r.k}`,
    })

    steps.push({
      text: !r.readable
        ? `The Repair Service has nothing to rebuild from: with only ${r.survivors} of the ${r.k} pieces it needs, there is no way back. The only cure is a restore from a backup in another region. This is why durability is designed up front, not after the loss.`
        : r.lost === 0
          ? `The Scrubber reads every piece in the background, recomputes its checksum and compares. Silent corruption (a bit that flipped on a healthy-looking disk) is found this way and sent to the Repair Service, which rebuilds the piece from the others.`
          : `The Repair Service rebuilds the ${r.lost} lost piece${r.lost === 1 ? '' : 's'} on healthy disks. It reads ${nice(r.repairRead)} (${r.copies ? 'one whole copy' : `${r.k} shards of ${nice(r.shardBytes)}`}) and writes ${nice(r.repairWrite)}. Until it finishes, the object has fewer spare pieces than before, so it can survive ${r.m - r.lost} more loss${r.m - r.lost === 1 ? '' : 'es'}. Fast repair is what keeps the loss chance tiny.`,
      nodes: r.readable && r.lost === 0 ? ['Scrubber (checksums)', 'Repair Service', 'Storage Nodes (Zone A)'] : ['Repair Service', 'Storage Nodes (Zone B)', 'Storage Nodes (Zone C)'],
      data: r.readable
        ? `repair read: ${r.repairRead} bytes\nrepair write: ${r.repairWrite} bytes\nspare pieces after repair: ${r.m}`
        : `pieces left: ${r.survivors} < ${r.k}\nrestore from backup`,
    })

    return { input: `${object}; ${scheme}; ${failure}`, steps }
  },
}

export const objectStorage: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'object-storage',
  title: 'Object Storage (S3-style)',
  blurb: 'How S3 stores trillions of files: flat keys, a metadata index, erasure coding and checksums',
  guides: ['scale-object-storage', 'erasure-coding', 'what-happens-when-you-upload-a-file-to-amazon-s3', 'how-to-upload-a-large-file-to-s3', 'scale-magic-pocket-in-house-multi-exabyte-storage-system-at-dropbox', 'scale-ambry-distributed-immutable-object-store-at-linkedin'],
  takeaways: [
    'An object store keeps whole files under a flat key. You write a file once and read it back, and you never edit a few bytes in the middle.',
    'Split the system in two: a small, fast metadata index (key to where the pieces are) and a huge, simple pool of storage nodes for the bytes.',
    'Erasure coding stores 6 data and 3 parity shards for 1.5× the space, and survives 3 losses. Three full copies cost 2× more and survive only 2.',
    'Spread pieces over zones so one building can fail without losing the object.',
    'Durability comes from fast repair as much as from the scheme: a lost shard must be rebuilt long before another one dies.',
    'Write the metadata row last, and check checksums when you read and in a background scrub, so a half-written or silently damaged object is never served.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'front', label: 'Front door' },
      { id: 'index', label: 'Where is it? (small, fast)' },
      { id: 'bytes', label: 'The bytes (huge, simple)' },
      { id: 'health', label: 'Keep it healthy' },
    ],
    nodes: [
      { id: 'client', label: 'Client', shape: 'ellipse', color: 'blue', group: null },
      { id: 'api', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: 'front' },
      { id: 'meta', label: 'Metadata Service', shape: 'rectangle', color: 'violet', group: 'index' },
      { id: 'metadb', label: 'Metadata DB', shape: 'rectangle', color: 'green', group: 'index' },
      { id: 'coder', label: 'Erasure Coder', shape: 'rectangle', color: 'orange', group: 'bytes' },
      { id: 'za', label: 'Storage Nodes (Zone A)', shape: 'rectangle', color: 'green', group: 'bytes' },
      { id: 'zb', label: 'Storage Nodes (Zone B)', shape: 'rectangle', color: 'green', group: 'bytes' },
      { id: 'zc', label: 'Storage Nodes (Zone C)', shape: 'rectangle', color: 'green', group: 'bytes' },
      { id: 'repair', label: 'Repair Service', shape: 'rectangle', color: 'orange', group: 'health' },
      { id: 'scrub', label: 'Scrubber (checksums)', shape: 'rectangle', color: 'orange', group: 'health' },
    ],
    edges: [
      { from: 'client', to: 'api', label: 'PUT / GET', dashed: false },
      { from: 'api', to: 'meta', label: 'where does this key live?', dashed: false },
      { from: 'meta', to: 'metadb', label: 'key → pieces', dashed: false },
      { from: 'api', to: 'coder', label: 'stream the bytes', dashed: false },
      { from: 'coder', to: 'za', label: 'shard', dashed: false },
      { from: 'coder', to: 'zb', label: 'shard', dashed: false },
      { from: 'coder', to: 'zc', label: 'shard', dashed: false },
      { from: 'scrub', to: 'za', label: 'verify checksums', dashed: true },
      { from: 'scrub', to: 'zb', label: 'verify checksums', dashed: true },
      { from: 'scrub', to: 'zc', label: 'verify checksums', dashed: true },
      { from: 'scrub', to: 'repair', label: 'bad piece found', dashed: true },
      { from: 'repair', to: 'coder', label: 'rebuild from the rest', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'buckets',
        name: 'buckets',
        columns: [
          { name: 'bucket_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'owner_id', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'versioning', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(owner_id)'],
      },
      {
        id: 'objects',
        name: 'objects',
        columns: [
          { name: 'bucket_id', type: 'bigint', pk: true, fk: 'buckets.bucket_id', nullable: false, unique: false },
          { name: 'key', type: 'text', pk: true, fk: null, nullable: false, unique: false },
          { name: 'version_id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'size_bytes', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'etag', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'scheme', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'is_delete_marker', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(bucket_id, key, created_at DESC)'],
      },
      {
        id: 'pieces',
        name: 'pieces',
        columns: [
          { name: 'version_id', type: 'uuid', pk: true, fk: 'objects.version_id', nullable: false, unique: false },
          { name: 'piece_no', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'node_id', type: 'bigint', pk: false, fk: 'storage_nodes.node_id', nullable: false, unique: false },
          { name: 'checksum', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'is_parity', type: 'boolean', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(node_id)'],
      },
      {
        id: 'storage_nodes',
        name: 'storage_nodes',
        columns: [
          { name: 'node_id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'zone', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'free_bytes', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(zone, status)'],
      },
    ],
    relations: [
      { from: 'objects', to: 'buckets', kind: 'one-to-many', label: 'lives in' },
      { from: 'pieces', to: 'objects', kind: 'one-to-many', label: 'is stored for' },
      { from: 'pieces', to: 'storage_nodes', kind: 'one-to-many', label: 'sits on' },
    ],
  },
  explanation: {
    title: 'Object Storage (S3-style)',
    summary:
      'An object store keeps files (objects) under flat keys in buckets. A small metadata index says where each object is, and a huge pool of storage nodes holds the bytes, cut into shards with erasure coding so that several disks can die without losing a file.',
    sections: [
      {
        heading: 'Overview',
        body: 'Photos, videos, backups and logs all need a place to live that never fills up and almost never loses anything. A normal disk or a file system on one server cannot do that. An object store is built for it. Amazon S3 is the best known one. Google Cloud Storage and Azure Blob Storage work the same way.\n\nThree words matter. A **bucket** is a named container. An **object** is one file plus its metadata (size, type, owner). A **key** is the object\'s name inside the bucket, such as photos/2026/cat.jpg. The slashes are just characters: there are no real folders, only a flat list of keys.\n\nAn object is written whole and read whole. You cannot change byte 5 of a stored file. To change it, you upload a new version. This one rule makes everything else simple, because stored bytes never change.',
      },
      {
        heading: 'Requirements',
        body: '- PUT an object, GET it back (or a byte range of it), DELETE it, and list keys by prefix.\n- Hold files from a few bytes up to terabytes.\n- Durability: lose an object about once in billions of object-years (people say "11 nines").\n- High availability: reads and writes keep working when a disk, a server or a whole building fails.\n- Versioning, so an overwrite or delete can be undone.\n- Low cost per gigabyte: this is where the data goes when it is too big for a database.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Store 50 billion objects of about 1 MB each: 50 billion × 1 MB = 50 PB (petabytes, 1 PB = 1,000 TB).\n- Three full copies need 3 × 50 PB = 150 PB of raw disk. With 20 TB disks that is 150 PB ÷ 20 TB = 7,500 disks.\n- Erasure coding 10+4 needs 50 PB × 14 ÷ 10 = 70 PB, so 70 PB ÷ 20 TB = 3,500 disks. That saves 4,000 disks.\n- Metadata: about 300 bytes a row (key, size, version, checksum, piece list). 50 billion × 300 B = 15 TB. That is small enough for a sharded database, and tiny next to the 50 PB of data.\n- Requests: 5 billion a day ÷ 86,400 seconds = 57,870 a second on average. The metadata index sees every one of them, so it must be fast. The data nodes see the byte traffic.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client sends PUT with a key. A big file is split into 8 MB parts that upload in parallel (a multipart upload).\n2. The API Gateway checks who is calling and whether they may write to the bucket.\n3. The API Gateway streams the bytes to the Erasure Coder.\n4. The Erasure Coder cuts the object into data shards, computes parity shards, and writes each shard with a checksum to the Storage Nodes (Zone A), Storage Nodes (Zone B) and Storage Nodes (Zone C).\n5. Only after every shard is safely stored does the Metadata Service write the object\'s row in the Metadata DB: key, version, size, and where each piece is.\n6. The Client gets 200 OK and an ETag.\n7. On GET, the Metadata Service finds the pieces and the Erasure Coder reads enough of them, checks their checksums and joins the bytes.\n8. In the background, the Scrubber (checksums) re-reads every shard, and when it finds a damaged or missing one, the Repair Service rebuilds it from the others.',
      },
      {
        heading: 'Components',
        body: '- Client: an app or SDK that talks the S3-style HTTP API (PUT, GET, DELETE, LIST) and signs each request.\n- API Gateway: the front door. It checks the signature and permissions, applies limits, and routes the request.\n- Metadata Service: the only place that knows which pieces make up a key. It answers "where is this object?" and commits new objects.\n- Metadata DB: a sharded database of buckets, objects, versions and pieces, split by (bucket, key). It is small and must be fast and strongly consistent.\n- Erasure Coder: cuts objects into shards, computes parity, and rebuilds missing shards on read or repair.\n- Storage Nodes (Zone A): servers full of disks that store shards as plain files. They know nothing about keys.\n- Storage Nodes (Zone B): the same, in a second building with its own power and network.\n- Storage Nodes (Zone C): the same, in a third building.\n- Repair Service: watches for dead disks and bad shards, and rebuilds the lost pieces on healthy nodes.\n- Scrubber (checksums): a slow background reader that recomputes each shard\'s checksum and compares it with the saved one, to find silent corruption.',
      },
      {
        heading: 'Key decisions',
        body: '- Separate metadata from data: the index is small, hot and needs transactions; the bytes are huge, cold and never change. Each can scale on its own.\n- Replication or erasure coding: three copies are simple and fast to read, but cost 3× the space. Erasure coding 6+3 stores 6 data shards and 3 parity shards: 9 ÷ 6 = 1.5× the space, and any 6 of the 9 rebuild the object. It survives 3 lost pieces, not 2. The price is more CPU, and a read of a damaged object must fetch several shards. Many stores use copies for small, hot objects and erasure coding for the rest.\n- How parity works: the simplest parity is XOR. With shards A and B, store P = A xor B. If A is lost, A = B xor P. Real erasure codes (Reed-Solomon) use the same idea with algebra over a small number field, so that m parity shards can repair any m losses.\n- Zones: put pieces in different zones. With 6+3 and three zones, each zone holds 3 shards, so losing a whole zone loses 3 and the object is still readable. With 10+4, a zone holds up to 5 of 14, so one zone loss is too many.\n- Write order: write shards first, metadata last. A crash in between leaves orphan shards that a garbage collector removes. The reverse order would show a key that points to nothing.\n- Strong consistency: after a successful PUT, a GET must see it. This works because there is one commit point, the metadata row.\n- Durability is about repair speed too: in a year each disk dies about 2% of the time. The chance that more pieces fail inside one repair window than the scheme allows is what loses data. Repairing in 1 day instead of 10 makes the loss chance much smaller.\n- Small objects: millions of tiny files are bad for disks. Pack many small objects into big files and keep an offset in the metadata. Facebook\'s Haystack does this for photos.\n- Delete and versions: with versioning on, a delete adds a delete marker. The bytes go only after the lifecycle rules say so, and a garbage collector frees the space.',
      },
      {
        heading: 'Scaling and failure',
        body: '- The API Gateway is stateless: add servers behind a load balancer.\n- Shard the Metadata DB by hash of (bucket, key). A bucket with a huge number of keys with the same prefix, such as dates, makes a hot shard: hash the key, or spread the prefix.\n- Add storage nodes any time. New objects go to the emptiest nodes; old data can be moved slowly in the background.\n- A dead disk: the Repair Service reads the other shards of every object that had a shard there and writes new ones elsewhere. Spread each disk\'s shards across many peers, so hundreds of nodes share the work and repair is fast.\n- A dead zone: reads keep working in degraded mode from the other zones. New writes go to the zones that are left.\n- Silent corruption: disks sometimes return wrong bytes without an error. The checksum on every shard, checked on read and by the scrubber, catches it.\n- Hot objects: a viral video makes the same shards busy. Put a CDN or a cache in front of the store, and let the storage nodes serve the long tail.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why not store files in a database or a normal file system?\n- 3 copies or erasure coding 6+3: what do you save and what do you pay?\n- A client crashes in the middle of an upload. What state is left, and who cleans it up?\n- How do you make GET after PUT always show the new object?\n- How do you know a disk returned the wrong bytes?\n- How would you design LIST by prefix over 50 billion keys?\n- How do you delete 1 PB of data without hurting reads?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Split an object into shards and add one XOR parity shard',
        language: 'javascript',
        source: `// A tiny erasure code: k data shards + 1 parity shard. Lose any one, and you can rebuild it.
// Real stores use Reed-Solomon to survive several losses, but the idea is the same.
export function encode(bytes, k) {
  const size = Math.ceil(bytes.length / k)
  const shards = []
  for (let i = 0; i < k; i++) {
    const shard = new Uint8Array(size) // padded with zeros if the last one is short
    shard.set(bytes.subarray(i * size, (i + 1) * size))
    shards.push(shard)
  }
  const parity = new Uint8Array(size)
  for (const shard of shards) for (let i = 0; i < size; i++) parity[i] ^= shard[i]
  return [...shards, parity]
}

// One shard is missing (null): XOR all the others together to get it back.
export function rebuild(shards) {
  const missing = shards.findIndex((s) => s === null)
  const size = shards.find((s) => s).length
  const out = new Uint8Array(size)
  for (const shard of shards) if (shard) for (let i = 0; i < size; i++) out[i] ^= shard[i]
  shards[missing] = out
  return shards
}`,
        versions: [
          {
            language: 'java',
            source: `public class XorParity {
  // k data shards + 1 parity shard. Lose any one, and you can rebuild it.
  static byte[][] encode(byte[] bytes, int k) {
    int size = (bytes.length + k - 1) / k;
    byte[][] shards = new byte[k + 1][size]; // the last one is parity
    for (int i = 0; i < bytes.length; i++) shards[i / size][i % size] = bytes[i];
    for (int s = 0; s < k; s++)
      for (int i = 0; i < size; i++) shards[k][i] ^= shards[s][i];
    return shards;
  }

  // One shard is missing (null): XOR all the others together to get it back.
  static void rebuild(byte[][] shards) {
    int missing = -1, size = 0;
    for (int s = 0; s < shards.length; s++) {
      if (shards[s] == null) missing = s; else size = shards[s].length;
    }
    byte[] out = new byte[size];
    for (byte[] shard : shards) if (shard != null) for (int i = 0; i < size; i++) out[i] ^= shard[i];
    shards[missing] = out;
  }
}`,
          },
        ],
      },
      {
        title: 'Upload in parts and check each part\'s checksum',
        language: 'javascript',
        source: `import { createHash } from 'node:crypto'

const PART = 8 * 1024 * 1024 // 8 MiB per part

// Parts upload in parallel. If one fails, only that part is sent again.
export async function uploadBig(api, key, bytes) {
  const { uploadId } = await api.post('/' + key + '?uploads')
  const parts = []
  for (let i = 0; i * PART < bytes.length; i++) {
    const chunk = bytes.subarray(i * PART, (i + 1) * PART)
    const md5 = createHash('md5').update(chunk).digest('hex') // the server compares this
    parts.push({ n: i + 1, md5, send: () => api.put('/' + key + '?uploadId=' + uploadId + '&part=' + (i + 1), chunk, { md5 }) })
  }
  await Promise.all(parts.map((p) => p.send()))
  // Only now does the object appear: the metadata row is written once, at the end.
  return api.post('/' + key + '?uploadId=' + uploadId, { parts: parts.map(({ n, md5 }) => ({ n, md5 })) })
}`,
        versions: [
          {
            language: 'python',
            source: `import hashlib
from concurrent.futures import ThreadPoolExecutor

PART = 8 * 1024 * 1024  # 8 MiB per part

# Parts upload in parallel. If one fails, only that part is sent again.
def upload_big(api, key, data):
    upload_id = api.post(f"/{key}?uploads")["uploadId"]
    chunks = [data[i:i + PART] for i in range(0, len(data), PART)]

    def send(n_chunk):
        n, chunk = n_chunk
        md5 = hashlib.md5(chunk).hexdigest()  # the server compares this
        api.put(f"/{key}?uploadId={upload_id}&part={n}", chunk, md5=md5)
        return {"n": n, "md5": md5}

    with ThreadPoolExecutor(8) as pool:
        parts = list(pool.map(send, enumerate(chunks, start=1)))
    # Only now does the object appear: the metadata row is written once, at the end.
    return api.post(f"/{key}?uploadId={upload_id}", {"parts": parts})`,
          },
        ],
      },
      {
        title: 'The loss chance of a scheme',
        language: 'javascript',
        source: `// A disk fails about 2 times in 100 years. A lost piece is rebuilt within 1 day.
// An object is lost when MORE than m of its n pieces fail inside the same repair window.
const p = 0.02 / 365 // chance one disk fails on a given day

const choose = (n, r) => { let v = 1; for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i; return v }

export function lossPerYear(n, m) {
  let day = 0
  for (let j = m + 1; j <= n; j++) day += choose(n, j) * p ** j * (1 - p) ** (n - j)
  return day * 365
}

console.log(lossPerYear(3, 2))   // 3 copies:  6.0e-11  (1 in about 16.7 billion)
console.log(lossPerYear(9, 3))   // 6+3:       4.1e-13  (1 in about 2.4 trillion)
console.log(lossPerYear(14, 4))  // 10+4:      3.6e-16  (1 in about 2.8 quadrillion)`,
      },
      {
        title: 'Where the keys live',
        language: 'sql',
        source: `-- One row per version of each key. Writing it is the commit point of a PUT.
INSERT INTO objects (bucket_id, key, version_id, size_bytes, etag, scheme, is_delete_marker, created_at)
VALUES (1, 'photos/2026/trip.mp4', gen_random_uuid(), 400000000, '9a3c51e0', 'ec-6-3', false, now());

-- GET: the newest version that is not a delete marker.
SELECT o.version_id, o.size_bytes, p.piece_no, p.node_id, p.checksum
FROM objects o JOIN pieces p USING (version_id)
WHERE o.bucket_id = 1 AND o.key = 'photos/2026/trip.mp4'
ORDER BY o.created_at DESC, p.piece_no
LIMIT 9;

-- LIST by prefix: a range scan on the index, not a folder walk.
SELECT key FROM objects
WHERE bucket_id = 1 AND key >= 'photos/2026/' AND key < 'photos/2026/~'
ORDER BY key LIMIT 1000;`,
      },
    ],
    related: ['Erasure coding', 'Consistent hashing', 'Database sharding', 'Checksums', 'CDN', 'Replication'],
  },
  simulator,
}
