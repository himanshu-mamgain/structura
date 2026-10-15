import type { ReactNode } from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { between, type Building, City, type Shot, type Trip } from './city3d'
import narrationJson from './narration/url-shortener.json'
import { colors, font, mono } from './theme'
import type { Narration } from './timeline'
import { Appear, Callout, Card, clamp, Heading, Narrated, type Scene, type SceneProps, Timeline, totalFrames, type VideoProps } from './ui'

// "URL Shortener", a vertical explainer with 3D scenes (three.js via @remotion/three).
// The example matches the app's topic: ID 125,000,000,000 → base62 "2crtgcg".

export const VIDEO = 'url-shortener'
const narration: Narration = narrationJson

const ID = 125_000_000_000
const CODE = '2crtgcg'
const LONG = 'example.com/blog/2026/how-we-scaled…'

export const BUILDINGS: Building[] = [
  { id: 'user', label: 'Browser', x: 0, z: 6, color: '#3b82f6', height: 0.7, enter: 0 },
  { id: 'lb', label: 'Load Balancer', x: 0, z: 3, color: '#8b5cf6', height: 0.9, enter: 6 },
  { id: 'shorten', label: 'Shorten API', x: -2.7, z: 0, color: '#8b5cf6', enter: 12 },
  { id: 'redirect', label: 'Redirect API', x: 2.7, z: 0, color: '#8b5cf6', enter: 18 },
  { id: 'keygen', label: 'Key Generator', x: -2.7, z: -3.2, color: '#a78bfa', height: 0.9, enter: 24 },
  { id: 'cache', label: 'Redis Cache', x: 2.7, z: -3.2, color: '#ef4444', height: 0.8, enter: 30 },
  { id: 'db', label: 'URL Database', x: 0, z: -6, color: '#10b981', height: 1.5, enter: 36 },
]

export const ROADS: [string, string][] = [
  ['user', 'lb'],
  ['lb', 'shorten'],
  ['lb', 'redirect'],
  ['shorten', 'keygen'],
  ['shorten', 'db'],
  ['redirect', 'cache'],
  ['redirect', 'db'],
]

export const WIDE: Shot = { position: [0, 20, 12.5], target: [0, 0, -0.6], fov: 42 }
const LEFT: Shot = { position: [-1.4, 18.5, 11.5], target: [-1, 0, -0.6], fov: 42 }
export const RIGHT: Shot = { position: [1.4, 18.5, 11.5], target: [1, 0, -0.6], fov: 42 }

/** A code chip floating over the 3D scene, e.g. the generated ID. */
function Chip({ enter, top, children }: { enter: number; top: number; children: ReactNode }) {
  return (
    <Appear enter={enter} style={{ position: 'absolute', top, left: 70, right: 70, textAlign: 'center' }}>
      <span style={{ display: 'inline-block', padding: '16px 28px', borderRadius: 20, background: 'rgba(15,17,21,0.9)', border: '2px solid rgba(255,255,255,0.18)', fontFamily: mono, fontSize: 38, color: colors.text }}>
        {children}
      </span>
    </Appear>
  )
}

// ─── Scenes ────────────────────────────────────────────────────────────────

function Title() {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, 120], [1, 1.06], clamp)
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: font, color: colors.text }}>
      <div style={{ transform: `scale(${scale})`, textAlign: 'center', padding: 80 }}>
        <Appear enter={4}>
          <div style={{ fontSize: 40, fontWeight: 700, color: colors.highlight, letterSpacing: '0.12em' }}>SYSTEM DESIGN IN 3D</div>
        </Appear>
        <Appear enter={14}>
          <div style={{ marginTop: 30, fontSize: 132, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.03em' }}>URL Shortener</div>
        </Appear>
        <Appear enter={30}>
          <div style={{ marginTop: 40, fontFamily: mono, fontSize: 40, color: colors.muted }}>
            {LONG}
            <br />→ <span style={{ color: colors.highlight }}>sho.rt/{CODE}</span>
          </div>
        </Appear>
      </div>
    </AbsoluteFill>
  )
}

function Shorten({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const shot = between(WIDE, LEFT, interpolate(frame, [120, 260], [0, 1], { ...clamp, easing: (t) => t * t * (3 - 2 * t) }))
  const trips: Trip[] = [
    { path: ['user', 'lb', 'shorten'], start: 20, end: 120 },
    { path: ['shorten', 'keygen'], start: 160, end: 215 },
    { path: ['keygen', 'shorten'], start: 225, end: 285, color: '#fde047' },
    { path: ['shorten', 'db'], start: 460, end: 540, color: '#34d399' },
  ]
  const active = (from: number, to: number) => frame >= from && frame < to
  return (
    <>
      <City
        buildings={BUILDINGS}
        roads={ROADS}
        shot={shot}
        trips={trips}
        status={{
          shorten: active(100, 460) ? 'active' : undefined,
          keygen: active(200, 300) ? 'active' : undefined,
          db: frame >= 530 ? 'ok' : undefined,
        }}
        tags={{ keygen: frame >= 210 ? { text: `id ${ID.toLocaleString('en-US')}`, color: '#fde047' } : undefined }}
      />
      <Heading sub="POST /shorten">Making a short link</Heading>
      <Chip enter={300} top={1290}>
        {ID.toLocaleString('en-US')} → <b style={{ color: colors.highlight }}>{CODE}</b>
      </Chip>
      <Chip enter={470} top={1390}>
        INSERT urls ('{CODE}', '{LONG.slice(0, 14)}…')
      </Chip>
      <Narrated lines={lines} />
    </>
  )
}

const DIVISIONS: [number, number, string][] = [
  [125000000000, 16, 'g'],
  [2016129032, 12, 'c'],
  [32518210, 16, 'g'],
  [524487, 29, 't'],
  [8459, 27, 'r'],
  [136, 12, 'c'],
  [2, 2, '2'],
]

/** Repeated division by 62: each remainder is one character, read bottom-up. */
function Base62({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const revealed = Math.floor(interpolate(frame, [170, 330], [0, DIVISIONS.length], clamp))
  const code = DIVISIONS.slice(0, revealed).map(([, , c]) => c).reverse().join('')
  return (
    <>
      <Heading sub="0–9 · a–z · A–Z = 62 symbols">Base62</Heading>
      <Appear enter={20} style={{ position: 'absolute', top: 400, left: 80, right: 80, fontFamily: mono, fontSize: 34, color: colors.muted, letterSpacing: '0.06em', lineHeight: 1.5, wordBreak: 'break-all' }}>
        <span style={{ color: colors.engine }}>0123456789</span>
        <span style={{ color: colors.highlight }}>abcdefghijklmnopqrstuvwxyz</span>
        <span style={{ color: colors.os }}>ABCDEFGHIJKLMNOPQRSTUVWXYZ</span>
      </Appear>
      <div style={{ position: 'absolute', top: 560, left: 80, right: 80, fontFamily: mono, fontSize: 34, color: colors.text }}>
        {DIVISIONS.map(([n, r, c], i) => (
          <div key={n} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', opacity: i < revealed ? 1 : 0.12, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <span>{n.toLocaleString('en-US')} % 62</span>
            <span>
              = {r} → <b style={{ color: colors.highlight }}>{c}</b>
            </span>
          </div>
        ))}
      </div>
      <Appear enter={180} style={{ position: 'absolute', top: 1060, left: 0, right: 0, textAlign: 'center', fontFamily: mono, fontSize: 96, fontWeight: 800, color: colors.highlight }}>
        {code || ' '}
      </Appear>
      <Callout enter={340} x={160} y={1220} big="3.5" unit="trillion codes" small="62⁷ = 3,521,614,606,208" />
      <Narrated lines={lines} />
    </>
  )
}

function Redirect({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const shot = between(WIDE, RIGHT, interpolate(frame, [100, 240], [0, 1], { ...clamp, easing: (t) => t * t * (3 - 2 * t) }))
  // After the first miss, every click is a quick round trip to Redis.
  const hits: Trip[] = Array.from({ length: 6 }, (_, i) => ({ path: ['redirect', 'cache', 'redirect'], start: 450 + i * 22, end: 470 + i * 22, color: '#34d399' }))
  const trips: Trip[] = [
    { path: ['user', 'lb', 'redirect'], start: 15, end: 100 },
    { path: ['redirect', 'cache'], start: 130, end: 175 },
    { path: ['redirect', 'db'], start: 195, end: 250 },
    { path: ['db', 'redirect'], start: 255, end: 300, color: '#fde047' },
    { path: ['redirect', 'cache'], start: 310, end: 360, color: '#fde047' },
    ...hits,
    { path: ['redirect', 'lb', 'user'], start: 600, end: 690, color: '#34d399' },
  ]
  const cacheTag =
    frame >= 450 ? { text: 'HIT · <1 ms', color: '#34d399' } : frame >= 360 ? { text: 'SET · TTL 24h', color: '#fde047' } : frame >= 175 ? { text: 'MISS', color: '#f87171' } : undefined
  return (
    <>
      <City
        buildings={BUILDINGS}
        roads={ROADS}
        shot={shot}
        trips={trips}
        status={{
          redirect: frame >= 90 ? 'active' : undefined,
          cache: frame >= 450 ? 'ok' : frame >= 175 && frame < 360 ? 'bad' : undefined,
          db: frame >= 245 && frame < 450 ? 'active' : undefined,
          user: frame >= 690 ? 'ok' : undefined,
        }}
        tags={{ cache: cacheTag, user: frame >= 690 ? { text: '302 Found', color: '#34d399' } : undefined }}
      />
      <Heading sub={`GET sho.rt/${CODE}`}>Following a short link</Heading>
      <Chip enter={250} top={1390}>
        SELECT long_url WHERE short_code = '{CODE}'
      </Chip>
      <Narrated lines={lines} />
    </>
  )
}

function Scale({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const grow = interpolate(frame, [20, 70], [0, 1], { ...clamp, easing: (t) => 1 - (1 - t) ** 3 })
  const bar = (label: string, value: string, width: number, color: string, enter: number) => (
    <Appear enter={enter} style={{ marginBottom: 30 }}>
      <div style={{ fontSize: 34, color: colors.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 10 }}>
        <div style={{ height: 50, width: Math.max(14, width * grow), borderRadius: 10, background: color }} />
        <span style={{ fontSize: 36, fontWeight: 800 }}>{value}</span>
      </div>
    </Appear>
  )
  return (
    <>
      <Heading sub="typical numbers">Built for reads</Heading>
      <div style={{ position: 'absolute', top: 390, left: 80, right: 80, fontFamily: font, color: colors.text }}>
        {bar('New links per second', '~1,000', 8, colors.os, 10)}
        {bar('Clicks per second', '~100,000', 640, colors.highlight, 20)}
        <div style={{ height: 30 }} />
        <Card enter={160} title="Cache hard" color={colors.danger} items={['Hot links live in Redis', 'The database sees only misses']} />
        <Card enter={320} title="Clicks → queue" color={colors.engine} items={['Redirect replies first', 'Analytics workers count later']} />
      </div>
      <Narrated lines={lines} />
    </>
  )
}

function Outro() {
  const line = (enter: number, children: ReactNode) => (
    <Appear enter={enter}>
      <div style={{ marginTop: 40, fontSize: 60, fontWeight: 800, lineHeight: 1.2 }}>{children}</div>
    </Appear>
  )
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: 90, fontFamily: font, color: colors.text }}>
      {line(5, <><span style={{ color: colors.os }}>Write</span>: unique ID → base62 code.</>)}
      {line(30, <><span style={{ color: colors.highlight }}>Read</span>: cache first, database on a miss.</>)}
      {line(55, <><span style={{ color: colors.engine }}>Scale</span>: more redirect servers, async analytics.</>)}
      <Appear enter={85}>
        <div style={{ marginTop: 70, fontSize: 36, color: colors.muted }}>Made with Structura · system design, explained</div>
      </Appear>
    </AbsoluteFill>
  )
}

const SCENES: Scene[] = [
  [Title, 120, null],
  [Shorten, 600, 'shorten'],
  [Base62, 450, 'base62'],
  [Redirect, 750, 'redirect'],
  [Scale, 450, 'scale'],
  [Outro, 150, null],
]

export const duration = (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice)

export function UrlShortener({ voice }: VideoProps) {
  return <Timeline video={VIDEO} narration={narration} scenes={SCENES} voice={voice} />
}
