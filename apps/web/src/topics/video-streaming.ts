import type { Trace } from '@structura/shared'
import { json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// Written from scratch (no source text copied). The bitrate ladder, segment
// length and the 80% bandwidth rule are typical values used by HLS/DASH
// players; every number the simulator prints is computed from them below.

/** The encoding ladder: height in pixels and video bitrate in kbit/s. */
const LADDER = [
  { p: 144, kbps: 100 },
  { p: 240, kbps: 300 },
  { p: 360, kbps: 700 },
  { p: 480, kbps: 1_250 },
  { p: 720, kbps: 2_500 },
  { p: 1080, kbps: 4_500 },
  { p: 2160, kbps: 15_000 },
]
/** Each segment is a few seconds long, so quality can change every few seconds. */
const SEGMENT_SECONDS = 4
const VIDEO_SECONDS = 600
/** Uploads go in chunks, so a dropped connection resumes instead of restarting. */
const CHUNK_MB = 8
/** The player only picks a rung whose bitrate fits in this share of its measured bandwidth. */
const SAFETY = 0.8

const SOURCES: Record<string, { p: number; mbps: number }> = {
  '480p phone clip': { p: 480, mbps: 2.5 },
  '1080p camera': { p: 1080, mbps: 12 },
  '4K camera': { p: 2160, mbps: 45 },
}
const NETWORKS: Record<string, number> = {
  'Fast Wi-Fi (25 Mbps)': 25,
  '4G (3 Mbps)': 3,
  'Weak 3G (0.6 Mbps)': 0.6,
}
const HIT = 'Popular video (cached at the edge)'
const MISS = 'Rarely watched video (cache miss)'

const fmt = (n: number, d = 1) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const mb = (bytes: number) => bytes / 1e6
const fmtSize = (bytes: number) => (bytes >= 1e9 ? `${fmt(bytes / 1e9, 2)} GB` : `${fmt(mb(bytes))} MB`)
const fmtTime = (s: number) => (s >= 90 ? `${fmt(s / 60)} min` : `${fmt(s)} s`)

/** The rungs a source can be turned into: never upscale. */
const rungsFor = (p: number) => LADDER.filter((r) => r.p <= p)
/** What the player picks: the best rung that fits in SAFETY × bandwidth, else the lowest. */
const pickRung = (rungs: typeof LADDER, mbps: number) => [...rungs].reverse().find((r) => r.kbps <= SAFETY * mbps * 1000) ?? rungs[0]

const simulator: Simulator = {
  fields: [
    { id: 'action', label: 'What happens', options: ['Upload a video', 'Watch a video'] },
    { id: 'source', label: 'Best quality of the video', options: Object.keys(SOURCES) },
    { id: 'network', label: 'Network', options: Object.keys(NETWORKS) },
    { id: 'popularity', label: 'Popularity (when watching)', options: [HIT, MISS] },
  ],
  defaults: { action: 'Upload a video', source: '1080p camera', network: 'Fast Wi-Fi (25 Mbps)', popularity: HIT },
  run({ action, source, network, popularity }) {
    const src = SOURCES[source] ?? SOURCES['1080p camera']
    const mbps = NETWORKS[network] ?? 25
    const rungs = rungsFor(src.p)
    const segments = VIDEO_SECONDS / SEGMENT_SECONDS
    const steps: Trace['steps'] = []
    const videoId = 'vK3pQ9xL2mA'

    if (action === 'Upload a video') {
      const bytes = (src.mbps * 1e6 * VIDEO_SECONDS) / 8
      const chunks = Math.ceil(mb(bytes) / CHUNK_MB)
      const uploadSeconds = (bytes * 8) / (mbps * 1e6)
      const jobs = rungs.length * segments
      const outBytes = rungs.reduce((sum, r) => sum + (r.kbps * 1e3 * VIDEO_SECONDS) / 8, 0)
      steps.push(
        {
          text: `The creator picks a 10-minute ${source} file (${fmtSize(bytes)}). The Client App asks the API Gateway for an upload session; it checks the login and passes the request to the Upload Service.`,
          nodes: ['Client App', 'API Gateway', 'Upload Service'],
          data: `POST /v1/uploads\n${json({ title: 'Street food tour', size_bytes: Math.round(bytes), content_type: 'video/mp4' })}\n→ 201 { "upload_id": "${videoId}", "chunk_mb": ${CHUNK_MB} }`,
        },
        {
          text: `The Upload Service writes a Metadata DB row with status "processing", so the video exists (but cannot be watched) from the first second.`,
          nodes: ['Upload Service', 'Metadata DB'],
          data: `INSERT INTO videos (video_id, owner_id, title, status, duration_s)\nVALUES ('${videoId}', 4821, 'Street food tour', 'processing', ${VIDEO_SECONDS});`,
        },
        {
          text: `The file is sent in ${chunks} chunks of ${CHUNK_MB} MB straight into the Raw Video Store (object storage, using pre-signed URLs). At ${mbps} Mbps that takes about ${fmtTime(uploadSeconds)}. If the connection drops, only the unfinished chunk is re-sent.`,
          nodes: ['Client App', 'Raw Video Store'],
          data: `PUT raw/${videoId}/part-0001 … part-${String(chunks).padStart(4, '0')}\n${fmtSize(bytes)} ÷ ${mbps} Mbps = ${fmtTime(uploadSeconds)}`,
        },
        {
          text: `When the last chunk lands, the Upload Service puts one message on the Task Queue. The creator's phone is done; everything else happens in the background.`,
          nodes: ['Upload Service', 'Task Queue'],
          data: json({ task: 'transcode', video_id: videoId, source: `raw/${videoId}`, ladder: rungs.map((r) => `${r.p}p`) }),
        },
        {
          text: `A source this size becomes ${rungs.length} renditions (${rungs.map((r) => `${r.p}p`).join(', ')}): we never upscale. Each is cut into ${SEGMENT_SECONDS}-second segments, so ${rungs.length} × ${segments} = ${fmt(jobs, 0)} small jobs go to the Transcoding Workers, which run in parallel.`,
          nodes: ['Task Queue', 'Transcoding Workers'],
          data: `${rungs.map((r) => `${r.p}p @ ${fmt(r.kbps, 0)} kbps: ${segments} segments`).join('\n')}\ntotal jobs: ${fmt(jobs, 0)}`,
        },
        {
          text: `The workers write the segments and a manifest (the playlist that lists every rendition) to the Processed Video Store. The ${rungs.length} renditions together are ${fmtSize(outBytes)}, versus ${fmtSize(bytes)} for the original.`,
          nodes: ['Transcoding Workers', 'Processed Video Store'],
          data: `processed/${videoId}/master.m3u8\n${rungs.map((r) => `processed/${videoId}/${r.p}p/seg-00001.ts … seg-${String(segments).padStart(5, '0')}.ts`).join('\n')}\nrenditions total: ${fmtSize(outBytes)}`,
        },
        {
          text: `The last worker marks the video "ready" in the Metadata DB. Only now does the watch page work, and the creator is notified.`,
          nodes: ['Transcoding Workers', 'Metadata DB'],
          data: `UPDATE videos SET status = 'ready', renditions = '${rungs.map((r) => r.p).join(',')}' WHERE video_id = '${videoId}';`,
        },
      )
      return { input: `Upload a 10-minute ${source} over ${network}`, steps }
    }

    const best = pickRung(rungs, mbps)
    const segBytes = (best.kbps * 1e3 * SEGMENT_SECONDS) / 8
    const rttMs = 30
    const originMs = 140
    const hit = popularity === HIT
    const firstMs = rttMs + (segBytes * 8) / (mbps * 1e6) * 1000 + (hit ? 0 : originMs)
    const fits = best.kbps <= SAFETY * mbps * 1000
    steps.push(
      {
        text: 'A viewer opens the watch page. The Client App asks the API Gateway, which sends it to the Playback Service.',
        nodes: ['Client App', 'API Gateway', 'Playback Service'],
        data: `GET /v1/videos/${videoId}/play`,
      },
      {
        text: 'The Playback Service looks up the video in the Metadata Cache (Redis). Hot videos are answered from memory; the Metadata DB is only asked on a miss.',
        nodes: ['Playback Service', 'Metadata Cache'],
        data: `GET video:${videoId}\n→ ${json({ status: 'ready', renditions: rungs.map((r) => r.p), manifest: `https://cdn.example.com/${videoId}/master.m3u8` })}`,
      },
      {
        text: `The player gets the manifest URL and downloads the manifest from the nearest CDN Edge. It lists ${rungs.length} renditions; the player now measures its own bandwidth.`,
        nodes: ['Client App', 'CDN Edge'],
        data: `#EXTM3U\n${rungs.map((r) => `#EXT-X-STREAM-INF:BANDWIDTH=${r.kbps * 1000},RESOLUTION=${Math.round((r.p * 16) / 9)}x${r.p}\n${r.p}p/index.m3u8`).join('\n')}`,
      },
      {
        text: fits
          ? `Adaptive bitrate: on ${network} the player may use ${SAFETY * 100}% of its bandwidth for video, i.e. ${fmt(SAFETY * mbps * 1000, 0)} kbps. The best rendition that fits is ${best.p}p (${fmt(best.kbps, 0)} kbps).`
          : `Adaptive bitrate: on ${network} the player may use ${fmt(SAFETY * mbps * 1000, 0)} kbps, which is below even the smallest rendition. It starts at ${best.p}p (${fmt(best.kbps, 0)} kbps) and relies on buffering.`,
        nodes: ['Client App'],
        data: `bandwidth ${mbps} Mbps × ${SAFETY} = ${fmt(SAFETY * mbps * 1000, 0)} kbps\nchoose ${best.p}p (${fmt(best.kbps, 0)} kbps)${rungs.length < LADDER.length ? `\n(this video has no rendition above ${rungs[rungs.length - 1].p}p)` : ''}`,
      },
    )
    if (hit) {
      steps.push({
        text: `The first ${SEGMENT_SECONDS}-second segment (${fmtSize(segBytes)}) is already cached on the CDN Edge, a few milliseconds away. Playback starts after about ${fmt(firstMs, 0)} ms.`,
        nodes: ['Client App', 'CDN Edge'],
        data: `GET ${best.p}p/seg-00001.ts\nX-Cache: HIT\n${fmtSize(segBytes)} ÷ ${mbps} Mbps + ${rttMs} ms RTT ≈ ${fmt(firstMs, 0)} ms`,
      })
    } else {
      steps.push(
        {
          text: `Nobody has watched this video recently, so the CDN Edge does not have the segment. It fetches it from the Processed Video Store (the origin) and keeps a copy for the next viewer.`,
          nodes: ['CDN Edge', 'Processed Video Store'],
          data: `GET ${best.p}p/seg-00001.ts\nX-Cache: MISS → origin (+${originMs} ms)\nCache-Control: public, max-age=31536000, immutable`,
        },
        {
          text: `Playback starts after about ${fmt(firstMs, 0)} ms: ${rttMs} ms round trip + ${originMs} ms to the origin + ${fmt(((segBytes * 8) / (mbps * 1e6)) * 1000, 0)} ms to download ${fmtSize(segBytes)}. The second viewer gets a hit.`,
          nodes: ['Client App', 'CDN Edge'],
          data: `${rttMs} + ${originMs} + ${fmt(((segBytes * 8) / (mbps * 1e6)) * 1000, 0)} ≈ ${fmt(firstMs, 0)} ms to first frame`,
        },
      )
    }
    const downgrade = rungs.length > 1 && best.p < rungs[rungs.length - 1].p
    steps.push({
      text: downgrade
        ? `While playing, the player downloads the next segments ahead into its buffer and re-measures after every ${SEGMENT_SECONDS}-second segment. If the network gets worse it drops to a lower rung; if it improves it climbs. Segments are separate files, so switching costs nothing.`
        : `The player keeps the buffer full by downloading a few segments ahead. Every ${SEGMENT_SECONDS} seconds it can switch rungs; here it already sits at the best one.`,
      nodes: ['Client App', 'CDN Edge'],
      data: `segments played: ${best.p}p × ${segments} (${VIDEO_SECONDS} s)\ndata used: ${fmtSize((best.kbps * 1e3 * VIDEO_SECONDS) / 8)} for the whole video`,
    })
    return { input: `Watch a ${source} video on ${network}, ${hit ? 'cached' : 'cache miss'}`, steps }
  },
}

export const videoStreaming: StaticTopic = {
  kind: 'static',
  difficulty: 'Intermediate',
  id: 'video-streaming',
  title: 'Video Streaming (YouTube-style)',
  blurb: 'Chunked upload, transcoding into a bitrate ladder, adaptive streaming and CDN delivery',
  guides: [
    'how-does-youtube-handle-massive-video-content-upload',
    'scale-adaptive-video-streaming-at-youtube',
    'live-streaming-explained',
    'scale-netflix-what-happens-when-you-press-play',
    'scale-optimizing-video-stream-for-low-bandwidth-with-dynamic-optimizer-at-ne',
    'scale-hardware-assisted-video-transcoding-at-dailymotion',
    "a-beginner's-guide-to-cdn-content-delivery-network",
    'explain-the-top-6-use-cases-of-object-stores',
  ],
  takeaways: [
    'Upload and playback are two separate paths: a slow, background write path and a fast, cached read path.',
    'Big files go to object storage in resumable chunks, never through your application servers.',
    'Transcoding turns one upload into many renditions, each cut into short segments that workers process in parallel.',
    'Adaptive bitrate streaming lets the player pick a rendition every few seconds, based on its own measured bandwidth.',
    'Segments are immutable files, so a CDN can cache them for a year; egress, not storage, is the big cost.',
    'Store a "processing / ready" status so a video is never offered before every rendition exists.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'write', label: 'Upload path' },
      { id: 'read', label: 'Playback path' },
    ],
    nodes: [
      { id: 'client', label: 'Client App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: null },
      { id: 'upload', label: 'Upload Service', shape: 'rectangle', color: 'violet', group: 'write' },
      { id: 'raw', label: 'Raw Video Store', shape: 'rectangle', color: 'green', group: 'write' },
      { id: 'queue', label: 'Task Queue', shape: 'rectangle', color: 'yellow', group: 'write' },
      { id: 'workers', label: 'Transcoding Workers', shape: 'rectangle', color: 'orange', group: 'write' },
      { id: 'processed', label: 'Processed Video Store', shape: 'rectangle', color: 'green', group: 'write' },
      { id: 'metadb', label: 'Metadata DB', shape: 'rectangle', color: 'green', group: null },
      { id: 'playback', label: 'Playback Service', shape: 'rectangle', color: 'violet', group: 'read' },
      { id: 'metacache', label: 'Metadata Cache', shape: 'rectangle', color: 'red', group: 'read' },
      { id: 'cdn', label: 'CDN Edge', shape: 'cloud', color: 'blue', group: 'read' },
    ],
    edges: [
      { from: 'client', to: 'gateway', label: 'upload / play', dashed: false },
      { from: 'gateway', to: 'upload', label: 'upload session', dashed: false },
      { from: 'upload', to: 'metadb', label: 'status: processing', dashed: false },
      { from: 'client', to: 'raw', label: 'chunks (pre-signed URL)', dashed: false },
      { from: 'upload', to: 'queue', label: 'transcode task', dashed: false },
      { from: 'queue', to: 'workers', label: 'segment jobs', dashed: false },
      { from: 'raw', to: 'workers', label: 'read source', dashed: true },
      { from: 'workers', to: 'processed', label: 'segments + manifest', dashed: false },
      { from: 'workers', to: 'metadb', label: 'status: ready', dashed: false },
      { from: 'gateway', to: 'playback', label: 'GET /play', dashed: false },
      { from: 'playback', to: 'metacache', label: 'video lookup', dashed: false },
      { from: 'metacache', to: 'metadb', label: 'on miss', dashed: true },
      { from: 'client', to: 'cdn', label: 'manifest + segments', dashed: false },
      { from: 'cdn', to: 'processed', label: 'on cache miss', dashed: true },
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
          { name: 'channel_name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
        ],
        indexes: [],
      },
      {
        id: 'videos',
        name: 'videos',
        columns: [
          { name: 'video_id', type: 'char(11)', pk: true, fk: null, nullable: false, unique: false },
          { name: 'owner_id', type: 'bigint', pk: false, fk: 'users.user_id', nullable: false, unique: false },
          { name: 'title', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'status', type: "text ('processing' | 'ready' | 'failed')", pk: false, fk: null, nullable: false, unique: false },
          { name: 'duration_s', type: 'int', pk: false, fk: null, nullable: true, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(owner_id, created_at)'],
      },
      {
        id: 'renditions',
        name: 'renditions',
        columns: [
          { name: 'video_id', type: 'char(11)', pk: true, fk: 'videos.video_id', nullable: false, unique: false },
          { name: 'height_p', type: 'int', pk: true, fk: null, nullable: false, unique: false },
          { name: 'bitrate_kbps', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'segment_count', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'storage_prefix', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
    ],
    relations: [
      { from: 'users', to: 'videos', kind: 'one-to-many', label: 'uploads' },
      { from: 'videos', to: 'renditions', kind: 'one-to-many', label: 'has' },
    ],
  },
  explanation: {
    title: 'Video Streaming (YouTube-style)',
    summary:
      'A video platform has two jobs. The upload path accepts a huge file, converts it into many sizes and splits each into short segments. The playback path hands every viewer the right size, a few seconds at a time, from a cache close to them. Storage is cheap; delivering the bytes is the expensive part.',
    sections: [
      {
        heading: 'Overview',
        body: "Phones record in one big format, but viewers watch on everything from a 4K TV on fibre to an old phone on 3G. So the platform converts (\"transcodes\") each upload into a ladder of renditions: the same video at several resolutions and bitrates.\n\nEach rendition is cut into segments of a few seconds, and a small text file, the manifest, lists them all. The player downloads the manifest, measures its own bandwidth, and fetches one segment at a time from the best rendition that fits. This is adaptive bitrate streaming (HLS and MPEG-DASH are the two common formats). Because a segment is just a file, a normal CDN can cache and serve it.",
      },
      {
        heading: 'Requirements',
        body: '- Creators upload large videos, even on flaky networks.\n- Viewers start playback fast (under about 2 seconds) and rarely see buffering.\n- Quality adapts to the viewer\'s network and device.\n- A video appears only when it is fully processed.\n- Not covered here: live streaming, recommendations, comments, ads, copyright checks.',
      },
      {
        heading: 'Capacity estimates',
        body: 'Assumptions (round numbers, not any company\'s real figures): 500 hours of video uploaded per minute, an average source of 8 Mbps, and 1 billion hours watched per day at an average of 2.5 Mbps.\n- One hour of source: 8 Mbps × 3,600 s ÷ 8 = 3.6 GB.\n- Uploads: 500 h × 3.6 GB = 1.8 TB per minute = 30 GB/s of incoming data, about 2.6 PB per day of raw video.\n- A ladder of 144p to 1080p (100 + 300 + 700 + 1,250 + 2,500 + 4,500 = 9,350 kbps) stores about 4.2 GB per hour, so roughly 3.0 PB per day of renditions more. Storage grows by petabytes a day.\n- Transcoding: 500 h/min is 30,000 seconds of video per second. With 6 renditions and a worker that encodes at about real time, that is about 180,000 cores busy at once, which is why the work is cut into small parallel segment jobs.\n- Playback: 10⁹ h × 3,600 s × 2.5 Mbps ÷ 8 = about 1.1 EB per day, or roughly 13 TB/s on average. This is far bigger than uploads, so the CDN, not the origin, must serve nearly all of it.',
      },
      {
        heading: 'Step by step',
        body: '1. The Client App asks the API Gateway for an upload session, which goes to the Upload Service.\n2. The Upload Service creates a row in the Metadata DB with status "processing".\n3. The Client App sends the file in chunks directly to the Raw Video Store using pre-signed URLs.\n4. The Upload Service puts a transcode job on the Task Queue.\n5. The Transcoding Workers split the video into segments, encode each rendition in parallel, and write the results and a manifest to the Processed Video Store.\n6. The last worker sets the status to "ready" in the Metadata DB.\n7. A viewer\'s Client App calls the API Gateway; the Playback Service reads the video\'s details from the Metadata Cache, falling back to the Metadata DB.\n8. The Client App fetches the manifest and then segments from the CDN Edge, choosing the rendition by its measured bandwidth.\n9. On a cache miss, the CDN Edge pulls the segment from the Processed Video Store and keeps it for the next viewer.',
      },
      {
        heading: 'Components',
        body: '- Client App: uploads in chunks; the player measures bandwidth and picks renditions.\n- API Gateway: authenticates requests and routes uploads and playback to the right service.\n- Upload Service: creates upload sessions and pre-signed URLs, records the video, queues the work.\n- Raw Video Store: object storage for the original uploads; kept so videos can be re-encoded later.\n- Task Queue: holds transcode jobs so a burst of uploads waits in line instead of overloading workers.\n- Transcoding Workers: stateless machines (often with GPUs or encoder chips) that cut and encode segments.\n- Processed Video Store: object storage for segments and manifests; the CDN\'s origin.\n- Metadata DB: titles, owners, status and rendition lists; sharded by video id at large scale.\n- Playback Service: returns the manifest URL for a video the viewer may watch.\n- Metadata Cache: keeps hot videos\' metadata in memory so the database is not hit on every play.\n- CDN Edge: servers close to viewers that cache segments; it serves almost all the bytes.',
      },
      {
        heading: 'Key decisions',
        body: '- Pre-signed URLs: the client uploads straight to object storage, so application servers never carry the bytes.\n- Segment length: short segments (2 to 6 s) switch quality quickly and parallelise well, but make more files and requests; longer ones are cheaper to manage but react slowly.\n- Ladder design: more rungs fit more networks but cost more to encode, store and cache. Skip rungs above the source, and give rarely watched videos fewer rungs.\n- Encode on demand or ahead: popular videos get every rendition immediately; the long tail can be encoded lazily or with cheaper settings.\n- Cache policy: segments never change, so cache them for a year with immutable; only the manifest of a live stream needs short lifetimes.\n- Status field: never publish before all renditions exist, or the player may ask for a segment that is not there.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Workers are stateless and each job is one segment of one rendition, so failures simply retry and the fleet scales with queue length.\n- A poisoned upload (corrupt file) goes to a failed state after a few retries, and the creator is told.\n- A chunked upload resumes from the last good chunk after a dropped connection.\n- CDN egress dominates the bill: use many edge sites, a mid-tier cache, and pre-warm new popular videos.\n- A viral video can overload a single edge; request collapsing (one origin fetch for many simultaneous misses) protects the origin.\n- The Metadata Cache absorbs read spikes; the Metadata DB is sharded by video id.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How would you resume an interrupted 5 GB upload?\n- How do you choose the bitrate ladder, and how do you cut encoding cost for videos nobody watches?\n- Why are segments cacheable by a plain CDN when a live stream is harder?\n- How would you add view counts without a database write for every view?\n- What changes for live streaming, where there is no upload-then-process delay?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Pick a rendition from measured bandwidth',
        language: 'typescript',
        source: `type Rung = { height: number; kbps: number }

// Best rendition whose bitrate fits in 80% of the bandwidth; else the lowest.
export function pickRung(rungs: Rung[], bandwidthKbps: number): Rung {
  const budget = bandwidthKbps * 0.8 // leave headroom for jitter
  const fits = rungs.filter((r) => r.kbps <= budget)
  return fits.length ? fits[fits.length - 1] : rungs[0] // rungs sorted low → high
}`,
      },
      {
        title: 'A manifest (HLS master playlist)',
        language: 'bash',
        source: `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080
1080p/index.m3u8`,
      },
      {
        title: 'Cut and encode with ffmpeg (4-second segments)',
        language: 'bash',
        source: `# One rendition; the worker runs this per rung.
ffmpeg -i source.mp4 -vf scale=-2:720 -c:v libx264 -b:v 2500k -c:a aac -b:a 128k \\
  -force_key_frames "expr:gte(t,n_forced*4)" \\
  -f hls -hls_time 4 -hls_playlist_type vod \\
  -hls_segment_filename "720p/seg-%05d.ts" 720p/index.m3u8`,
      },
      {
        title: 'Metadata: the videos table',
        language: 'sql',
        source: `-- Playback only ever shows videos that are fully processed.
SELECT v.video_id, v.title, r.height_p, r.bitrate_kbps
FROM videos v JOIN renditions r USING (video_id)
WHERE v.video_id = 'vK3pQ9xL2mA' AND v.status = 'ready'
ORDER BY r.height_p;`,
      },
    ],
    related: ['Adaptive bitrate (HLS, DASH)', 'Transcoding', 'CDN', 'Object storage', 'Pre-signed URLs', 'Live streaming'],
  },
  simulator,
}
