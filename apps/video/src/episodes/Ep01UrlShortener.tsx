import { interpolate, random, useCurrentFrame } from 'remotion'
import { City, type Trip } from '../city3d'
import narrationJson from '../narration/ep01-url-shortener.json'
import { Counter, EpisodeBar, GridBackground, InterviewerCard, Panel, reel, Rise, Tag, Voiced } from '../reel/kit'
import type { Narration } from '../timeline'
import { clamp, type Scene, type SceneProps, Svg, Timeline, totalFrames, type VideoProps } from '../ui'
import { BUILDINGS, RIGHT, ROADS } from '../UrlShortener'

// EP 01 · URL Shortener, a Hinglish reel: hook → trap → logic → build → twist → recap.
// Numbers are real: 62^7 codes; ~1.42 lakh expected collisions after 1 arab random
// codes (n² / 2N); ID 125,000,000,000 is "2crtgcg" in base62.

export const VIDEO = 'ep01-url-shortener'
const narration: Narration = narrationJson

const CHAPTERS = ['HOOK', 'TRAP', 'LOGIC', 'BUILD', 'TWIST', 'RECAP']
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const inr = (n: number) => Math.round(n).toLocaleString('en-IN')

// ─── HOOK ──────────────────────────────────────────────────────────────────

function Hook({ lines }: SceneProps) {
  return (
    <>
      <InterviewerCard enter={6} round="ROUND 2 · BACKEND" lines={['Ek URL shortener design karo.', '7 characters. 10 crore links/din.', 'Repeat? Kabhi nahi.']} />
      <Rise enter={150} style={{ position: 'absolute', top: 860, left: 0, right: 0, textAlign: 'center' }}>
        <Tag>62⁷ POSSIBLE CODES</Tag>
      </Rise>
      <Counter from={160} to={290} end={62 ** 7} size={96} style={{ position: 'absolute', top: 930, left: 0, right: 0 }} />
      <Rise enter={300} style={{ position: 'absolute', top: 1130, left: 0, right: 0, textAlign: 'center' }}>
        <Tag color={reel.red}>REPEATS ALLOWED: 0</Tag>
      </Rise>
      <Voiced lines={lines} />
    </>
  )
}

// ─── TRAP ──────────────────────────────────────────────────────────────────

const randomCode = (seed: string) => Array.from({ length: 7 }, (_, i) => ALPHABET[Math.floor(random(`${seed}-${i}`) * 62)]).join('')

/** A slot-machine list of random codes; every so often one collides. */
function RandomCodes() {
  const frame = useCurrentFrame()
  const tick = Math.floor(frame / 5)
  return (
    <Panel style={{ position: 'absolute', top: 300, left: 90, right: 90, padding: '24px 32px' }} glow={reel.red}>
      <div style={{ fontFamily: reel.mono, fontSize: 28, color: reel.muted, letterSpacing: '0.1em' }}>code = random(7)</div>
      {Array.from({ length: 5 }, (_, row) => {
        const n = tick - row
        const clash = n > 30 && random(`clash-${n}`) < 0.22
        return (
          <div key={row} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, opacity: 1 - row * 0.16 }}>
            <span style={{ fontFamily: reel.mono, fontSize: 52, fontWeight: 800, color: clash ? reel.red : reel.text, letterSpacing: '0.08em' }}>{randomCode(`code-${n}`)}</span>
            {clash ? <Tag color={reel.red} solid>COLLISION</Tag> : <Tag color={reel.green}>NEW</Tag>}
          </div>
        )
      })}
    </Panel>
  )
}

function Trap({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const retry = frame >= 315
  return (
    <>
      <RandomCodes />
      <div style={{ position: 'absolute', top: 860, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 70 }}>
        <div>
          <Counter from={140} to={280} end={1e9} size={64} color={reel.text} format={inr} />
          <div style={{ textAlign: 'center', fontFamily: reel.mono, fontSize: 26, color: reel.muted }}>links (10 din)</div>
        </div>
        <div>
          <Counter from={140} to={280} end={141980} size={64} color={reel.red} format={inr} />
          <div style={{ textAlign: 'center', fontFamily: reel.mono, fontSize: 26, color: reel.muted }}>collisions</div>
        </div>
      </div>
      {!retry && (
        <Rise enter={200} style={{ position: 'absolute', top: 1060, left: 0, right: 0, textAlign: 'center', fontFamily: reel.mono, fontSize: 34, color: reel.muted }}>
          n² ÷ 2N = (10⁹)² ÷ (2 × 62⁷) ≈ <b style={{ color: reel.red }}>1.4 lakh</b>
        </Rise>
      )}
      {retry && (
        <Rise enter={315} style={{ position: 'absolute', top: 1050, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 16, alignItems: 'center' }}>
          <Tag color={reel.text}>generate</Tag>
          <span style={{ color: reel.muted, fontSize: 34 }}>→</span>
          <Tag color={reel.orange}>DB: exists?</Tag>
          <span style={{ color: reel.muted, fontSize: 34 }}>→</span>
          <Tag color={reel.red} solid style={{ transform: `rotate(${Math.sin(frame / 4) * 3}deg)` }}>
            ↻ RETRY
          </Tag>
        </Rise>
      )}
      <Voiced lines={lines} />
    </>
  )
}

// ─── LOGIC ─────────────────────────────────────────────────────────────────

const CODE = '2crtgcg'

function Logic({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const letters = Math.floor(interpolate(frame, [160, 250], [0, CODE.length], clamp))
  return (
    <>
      <Rise enter={0} style={{ position: 'absolute', top: 330, left: 0, right: 0, textAlign: 'center' }}>
        <Tag>COUNTER · next_id++</Tag>
      </Rise>
      <Counter from={10} to={120} start={124_999_999_900} end={125_000_000_000} size={92} format={inr} style={{ position: 'absolute', top: 410, left: 0, right: 0 }} />
      <Rise enter={150} style={{ position: 'absolute', top: 580, left: 0, right: 0, textAlign: 'center', fontFamily: reel.mono, fontSize: 40, color: reel.muted }}>
        ↓ base 62 <span style={{ fontSize: 30 }}>(0-9 a-z A-Z)</span>
      </Rise>
      <div style={{ position: 'absolute', top: 680, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 14 }}>
        {[...CODE].map((ch, i) => {
          const shown = i < letters
          return (
            <span
              key={i}
              style={{
                width: 118,
                height: 150,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 20,
                border: `3px solid ${shown ? reel.lime : reel.border}`,
                background: shown ? 'rgba(212,255,63,0.08)' : 'transparent',
                fontFamily: reel.mono,
                fontSize: 100,
                fontWeight: 800,
                color: reel.lime,
                textShadow: `0 0 30px ${reel.lime}88`,
                transform: `translateY(${shown ? 0 : -30}px)`,
                opacity: shown ? 1 : 0.25,
              }}
            >
              {shown ? ch : ''}
            </span>
          )
        })}
      </div>
      <Rise enter={280} style={{ position: 'absolute', top: 900, left: 0, right: 0, textAlign: 'center' }}>
        <Tag color={reel.cyan}>12 DIGITS → 7 CHARACTERS</Tag>
      </Rise>
      <Rise enter={420} style={{ position: 'absolute', top: 1000, left: 140, right: 140 }}>
        <Panel glow={reel.green} style={{ fontFamily: reel.mono, fontSize: 34, lineHeight: 1.6, padding: '20px 30px' }}>
          {[
            ['1,25,00,00,00,001', '2crtgch'],
            ['1,25,00,00,00,002', '2crtgci'],
          ].map(([id, code]) => (
            <div key={code} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: reel.muted }}>{id}</span>
              <span style={{ color: reel.green, fontWeight: 800 }}>{code}</span>
            </div>
          ))}
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <Tag color={reel.green} solid>
              COLLISIONS: 0
            </Tag>
          </div>
        </Panel>
      </Rise>
      <Voiced lines={lines} />
    </>
  )
}

// ─── BUILD ─────────────────────────────────────────────────────────────────

function Build({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const hits: Trip[] = Array.from({ length: 6 }, (_, i) => ({ path: ['redirect', 'cache', 'redirect'], start: 320 + i * 22, end: 340 + i * 22, color: reel.green }))
  const trips: Trip[] = [
    { path: ['user', 'lb', 'redirect'], start: 10, end: 80 },
    { path: ['redirect', 'cache'], start: 90, end: 135 },
    { path: ['redirect', 'db'], start: 165, end: 215 },
    { path: ['db', 'redirect'], start: 220, end: 260, color: '#fde047' },
    { path: ['redirect', 'cache'], start: 265, end: 305, color: '#fde047' },
    ...hits,
  ]
  const cacheTag =
    frame >= 320 ? { text: 'HIT · <1 ms', color: reel.green } : frame >= 305 ? { text: 'SET', color: '#fde047' } : frame >= 135 ? { text: 'MISS', color: reel.red } : undefined
  return (
    <>
      <City
        buildings={BUILDINGS.map((b) => ({ ...b, enter: 0 }))}
        roads={ROADS}
        shot={RIGHT}
        trips={trips}
        ground="#0c0f17"
        status={{
          redirect: 'active',
          cache: frame >= 320 ? 'ok' : frame >= 135 && frame < 305 ? 'bad' : undefined,
          db: frame >= 160 && frame < 320 ? 'active' : undefined,
        }}
        tags={{ cache: cacheTag }}
      />
      <Rise enter={330} style={{ position: 'absolute', top: 1180, left: 0, right: 0 }}>
        <Counter from={330} to={420} start={0} end={0.4} size={110} color={reel.green} unit="ms" format={(n) => n.toFixed(1)} />
      </Rise>
      <Voiced lines={lines} />
    </>
  )
}

// ─── TWIST ─────────────────────────────────────────────────────────────────

const SERVERS = [
  { x: 210, y: 470 },
  { x: 540, y: 430 },
  { x: 870, y: 470 },
  { x: 210, y: 1030 },
  { x: 540, y: 1070 },
  { x: 870, y: 1030 },
]
const COUNTER_AT = { x: 540, y: 750 }

function Twist({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const blocks = frame >= 150
  const shuffle = frame >= 330
  if (shuffle) {
    const column = (title: string, color: string, tag: string, codes: string[], enter: number) => (
      <Rise enter={enter} style={{ flex: 1 }}>
        <Panel glow={color} style={{ textAlign: 'center', padding: '26px 20px' }}>
          <div style={{ fontFamily: reel.mono, fontSize: 28, color: reel.muted, letterSpacing: '0.1em' }}>{title}</div>
          {codes.map((code) => (
            <div key={code} style={{ fontFamily: reel.mono, fontSize: 58, fontWeight: 800, color, marginTop: 14 }}>
              {code}
            </div>
          ))}
          <div style={{ marginTop: 20 }}>
            <Tag color={color} solid>
              {tag}
            </Tag>
          </div>
        </Panel>
      </Rise>
    )
    return (
      <>
        <div style={{ position: 'absolute', top: 360, left: 70, right: 70, display: 'flex', gap: 30 }}>
          {column('SEQUENTIAL', reel.red, 'GUESSABLE', ['2crtgcg', '2crtgch', '2crtgci'], 335)}
          {column('SHUFFLED', reel.green, 'RANDOM-LOOKING', ['mPjVLT9', 'wDWfBPL', 'av66SXY'], 370)}
        </div>
        <Rise enter={400} style={{ position: 'absolute', top: 900, left: 0, right: 0, textAlign: 'center', fontFamily: reel.mono, fontSize: 32, color: reel.muted, lineHeight: 1.5 }}>
          shuffle = reversible scramble of the ID
          <br />
          (still unique, decode bhi ho sakta hai)
        </Rise>
        <Voiced lines={lines} />
      </>
    )
  }
  const pulse = 0.5 + 0.5 * Math.sin(frame / 5)
  return (
    <>
      <Svg>
        {SERVERS.map((s, i) => {
          // Before blocks: a packet every few frames from every server. After: one per block.
          const period = blocks ? 120 : 18
          const t = ((frame + i * 7) % period) / (blocks ? 30 : period)
          const travelling = t <= 1
          return (
            <g key={i}>
              <line x1={s.x} y1={s.y} x2={COUNTER_AT.x} y2={COUNTER_AT.y} stroke={blocks ? `${reel.green}66` : `${reel.red}88`} strokeWidth={4} />
              {travelling && <circle cx={s.x + (COUNTER_AT.x - s.x) * t} cy={s.y + (COUNTER_AT.y - s.y) * t} r={10} fill={blocks ? reel.green : reel.red} />}
            </g>
          )
        })}
      </Svg>
      <div
        style={{
          position: 'absolute',
          left: COUNTER_AT.x - 190,
          top: COUNTER_AT.y - 80,
          width: 380,
          height: 160,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 28,
          background: reel.panel,
          border: `4px solid ${blocks ? reel.green : reel.red}`,
          boxShadow: `0 0 ${blocks ? 30 : 30 + pulse * 50}px ${blocks ? reel.green : reel.red}88`,
          fontFamily: reel.mono,
          fontSize: 40,
          fontWeight: 800,
          color: reel.text,
        }}
      >
        ID COUNTER
      </div>
      {SERVERS.map((s, i) => (
        <Rise key={i} enter={i * 4} style={{ position: 'absolute', left: s.x - 130, top: s.y - 50, width: 260, textAlign: 'center' }}>
          <div style={{ padding: '14px 10px', borderRadius: 18, background: reel.panel, border: `2px solid ${reel.border}`, fontFamily: reel.mono }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: reel.text }}>server {i + 1}</div>
            {blocks && <div style={{ fontSize: 24, color: reel.green }}>{inr(i * 1000 + 1)}–{inr((i + 1) * 1000)}</div>}
          </div>
        </Rise>
      ))}
      <Rise enter={blocks ? 160 : 40} style={{ position: 'absolute', top: 1220, left: 0, right: 0, textAlign: 'center' }}>
        {blocks ? <Tag color={reel.green}>1 CALL PER 1000 LINKS</Tag> : <Tag color={reel.red}>BOTTLENECK</Tag>}
      </Rise>
      <Voiced lines={lines} />
    </>
  )
}

// ─── RECAP ─────────────────────────────────────────────────────────────────

function Recap({ lines }: SceneProps) {
  const items: [string, string][] = [
    ['Counter', 'har link ka unique ID'],
    ['Base62', '7 characters, 3.5 trillion codes'],
    ['Redis cache', 'click < 1 ms'],
    ['ID blocks + shuffle', 'scale + guess-proof'],
  ]
  return (
    <>
      <div style={{ position: 'absolute', top: 330, left: 80, right: 80 }}>
        {items.map(([title, sub], i) => (
          <Rise key={title} enter={10 + i * 25} style={{ marginBottom: 26 }}>
            <Panel glow={reel.lime} style={{ display: 'flex', alignItems: 'center', gap: 26, padding: '22px 30px' }}>
              <span style={{ fontSize: 50, color: reel.lime }}>✓</span>
              <div>
                <div style={{ fontFamily: reel.sans, fontSize: 46, fontWeight: 800, color: reel.text }}>{title}</div>
                <div style={{ fontFamily: reel.mono, fontSize: 28, color: reel.muted }}>{sub}</div>
              </div>
            </Panel>
          </Rise>
        ))}
      </div>
      <Rise enter={175} style={{ position: 'absolute', top: 1260, left: 0, right: 0, textAlign: 'center' }}>
        <span style={{ display: 'inline-block', padding: '20px 36px', borderRadius: 22, background: '#1b1e27', fontFamily: reel.sans, fontSize: 40, fontWeight: 800, color: reel.text }}>
          ▶ Next · EP 02 · Rate Limiter
        </span>
      </Rise>
      <Voiced lines={lines} />
    </>
  )
}

// ─── Timeline ──────────────────────────────────────────────────────────────

const SCENES: Scene[] = [
  [Hook, 450, 'hook'],
  [Trap, 465, 'trap'],
  [Logic, 555, 'logic'],
  [Build, 465, 'build'],
  [Twist, 495, 'twist'],
  [Recap, 330, 'recap'],
]

export const duration = (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice)

export function Ep01UrlShortener({ voice }: VideoProps) {
  return (
    <Timeline
      video={VIDEO}
      narration={narration}
      scenes={SCENES}
      voice={voice}
      background={<GridBackground />}
      overlay={(progress) => <EpisodeBar episode="EP 01" chapters={CHAPTERS} progress={progress} />}
    />
  )
}
