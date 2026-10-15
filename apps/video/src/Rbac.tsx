import type { ReactNode } from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { between, type Building, City, type Shot, type Trip } from './city3d'
import narrationJson from './narration/rbac.json'
import { colors, font, mono } from './theme'
import type { Narration } from './timeline'
import { Appear, clamp, Heading, Narrated, type Scene, type SceneProps, Svg, Timeline, totalFrames, type VideoProps } from './ui'

// "Role-Based Access Control", a vertical explainer with 3D scenes (three.js via
// @remotion/three). Roles and permissions match the app's RBAC topic.

export const VIDEO = 'rbac'
const narration: Narration = narrationJson

const BUILDINGS: Building[] = [
  { id: 'user', label: 'Maya', x: 0, z: 6.4, color: '#3b82f6', height: 0.6, enter: 0 },
  { id: 'app', label: 'Client App', x: 0, z: 3.6, color: '#60a5fa', height: 0.8, enter: 6 },
  { id: 'login', label: 'Login Service', x: -2.8, z: 1, color: '#8b5cf6', enter: 12 },
  { id: 'rolesdb', label: 'Users & Roles DB', x: -2.8, z: -2.4, color: '#10b981', height: 1.4, enter: 18 },
  { id: 'gateway', label: 'API Gateway', x: 2.8, z: 1, color: '#8b5cf6', enter: 24 },
  { id: 'policy', label: 'Policy Check', x: 2.8, z: -2.4, color: '#a78bfa', height: 0.9, enter: 30 },
  { id: 'service', label: 'Article Service', x: 2.8, z: -5.8, color: '#10b981', height: 1.2, enter: 36 },
  { id: 'audit', label: 'Audit Log', x: -1.2, z: -5.8, color: '#f59e0b', height: 0.7, enter: 42 },
]

const ROADS: [string, string][] = [
  ['user', 'app'],
  ['app', 'login'],
  ['login', 'rolesdb'],
  ['app', 'gateway'],
  ['gateway', 'policy'],
  ['policy', 'service'],
  ['policy', 'audit'],
]

const WIDE: Shot = { position: [0, 20, 12.5], target: [0, 0, -0.6], fov: 42 }
const LEFT: Shot = { position: [-1.4, 18.5, 11.5], target: [-1, 0, -0.6], fov: 42 }
const RIGHT: Shot = { position: [1.4, 18.5, 11.5], target: [1, 0, -0.6], fov: 42 }
const smooth = { ...clamp, easing: (t: number) => t * t * (3 - 2 * t) }

const TOKEN = '#fde047'
const ALLOW = '#34d399'
const DENY = '#f87171'

function Chip({ enter, top, children }: { enter: number; top: number; children: ReactNode }) {
  return (
    <Appear enter={enter} style={{ position: 'absolute', top, left: 70, right: 70, textAlign: 'center' }}>
      <span style={{ display: 'inline-block', padding: '16px 28px', borderRadius: 20, background: 'rgba(15,17,21,0.9)', border: '2px solid rgba(255,255,255,0.18)', fontFamily: mono, fontSize: 34, color: colors.text, lineHeight: 1.45, textAlign: 'left' }}>
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
          <div style={{ marginTop: 30, fontSize: 120, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.03em' }}>
            Role-Based
            <br />
            Access Control
          </div>
        </Appear>
        <Appear enter={34}>
          <div style={{ marginTop: 40, fontSize: 42, color: colors.muted }}>Who are you, and what may you do?</div>
        </Appear>
      </div>
    </AbsoluteFill>
  )
}

function Question({ enter, code, color, title, question, example }: { enter: number; code: string; color: string; title: string; question: string; example: string }) {
  return (
    <Appear enter={enter} style={{ padding: '34px 40px', borderRadius: 28, background: 'rgba(15, 17, 21, 0.8)', border: `3px solid ${color}`, marginBottom: 40 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 50, fontWeight: 800, color }}>{title}</span>
        <span style={{ fontFamily: mono, fontSize: 72, fontWeight: 800, color }}>{code}</span>
      </div>
      <div style={{ marginTop: 12, fontSize: 44, fontWeight: 700 }}>“{question}”</div>
      <div style={{ marginTop: 14, fontSize: 32, color: colors.muted }}>{example}</div>
    </Appear>
  )
}

function Auth({ lines }: SceneProps) {
  return (
    <>
      <Heading>Two questions</Heading>
      <div style={{ position: 'absolute', top: 380, left: 70, right: 70, fontFamily: font, color: colors.text }}>
        <Question enter={180} code="401" color={TOKEN} title="Authentication" question="Who are you?" example="No or expired token → sign in again" />
        <Question enter={330} code="403" color={DENY} title="Authorization" question="What may you do?" example="Signed in, but not allowed → signing in again won't help" />
      </div>
      <Narrated lines={lines} />
    </>
  )
}

const USERS = ['Maya', 'Ravi', 'Sam']
const ROLES = ['viewer', 'editor', 'admin']
const PERMS = ['article:read', 'article:write', 'article:delete', 'user:manage']
const USER_ROLE: [number, number][] = [
  [0, 1],
  [1, 0],
  [2, 2],
]
const ROLE_PERM: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [2, 0],
  [2, 1],
  [2, 2],
  [2, 3],
]

/** Users → roles → permissions, with Maya's path lit up. */
function Model({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const COL = [150, 470, 800]
  const rowY = (i: number) => 480 + i * 150
  const focusEditor = frame >= 150
  const focusMaya = frame >= 330
  const node = (x: number, y: number, text: string, color: string, lit: boolean, enter: number, size = 34) => (
    <Appear key={`${x}-${text}`} enter={enter} style={{ position: 'absolute', left: x - 140, top: y - 36, width: 280, textAlign: 'center' }}>
      <span
        style={{
          display: 'inline-block',
          padding: '14px 20px',
          borderRadius: 16,
          background: lit ? color : 'rgba(15,17,21,0.85)',
          color: lit ? '#0b0d10' : colors.text,
          border: `3px solid ${color}`,
          fontFamily: size < 34 ? mono : font,
          fontSize: size,
          fontWeight: 800,
        }}
      >
        {text}
      </span>
    </Appear>
  )
  const lit = (role: number) => (focusEditor && role === 1) || false
  return (
    <>
      <Heading sub="users → roles → permissions">The RBAC model</Heading>
      <Svg>
        {USER_ROLE.map(([u, r]) => (
          <line key={`u${u}`} x1={COL[0] + 90} y1={rowY(u)} x2={COL[1] - 90} y2={rowY(r)} stroke={focusMaya && u === 0 ? TOKEN : 'rgba(255,255,255,0.25)'} strokeWidth={focusMaya && u === 0 ? 7 : 4} opacity={frame >= 60 ? 1 : 0} />
        ))}
        {ROLE_PERM.map(([r, p]) => (
          <line key={`r${r}${p}`} x1={COL[1] + 90} y1={rowY(r)} x2={COL[2] - 140} y2={rowY(p)} stroke={lit(r) ? ALLOW : 'rgba(255,255,255,0.2)'} strokeWidth={lit(r) ? 7 : 3} opacity={frame >= 40 ? 1 : 0} />
        ))}
      </Svg>
      {USERS.map((u, i) => node(COL[0], rowY(i), u, colors.engine, focusMaya && i === 0, 60 + i * 8))}
      {ROLES.map((r, i) => node(COL[1], rowY(i), r, colors.hypervisor, lit(i), 10 + i * 8))}
      {PERMS.map((p, i) => node(COL[2], rowY(i), p, i === 2 && focusEditor ? DENY : ALLOW, lit(1) && i < 2, 20 + i * 8, 26))}
      <Appear enter={200} style={{ position: 'absolute', top: rowY(2) - 36, left: COL[2] + 120, fontSize: 52, color: DENY, fontWeight: 900 }}>
        ✗
      </Appear>
      <Narrated lines={lines} />
    </>
  )
}

function Flow({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const shot =
    frame < 330 ? between(WIDE, LEFT, interpolate(frame, [20, 140], [0, 1], smooth)) : between(LEFT, RIGHT, interpolate(frame, [330, 450], [0, 1], smooth))
  const trips: Trip[] = [
    { path: ['user', 'app', 'login'], start: 15, end: 110 },
    { path: ['login', 'rolesdb'], start: 115, end: 160 },
    { path: ['rolesdb', 'login'], start: 165, end: 205, color: ALLOW },
    { path: ['login', 'app'], start: 210, end: 275, color: TOKEN },
    { path: ['app', 'gateway'], start: 340, end: 420, color: TOKEN },
    { path: ['gateway', 'policy'], start: 610, end: 665, color: TOKEN },
    { path: ['policy', 'service'], start: 760, end: 820, color: ALLOW },
    { path: ['policy', 'audit'], start: 770, end: 840, color: '#f59e0b' },
  ]
  const after = (f: number) => frame >= f
  return (
    <>
      <City
        buildings={BUILDINGS}
        roads={ROADS}
        shot={shot}
        trips={trips}
        status={{
          login: after(100) && !after(330) ? 'active' : undefined,
          rolesdb: after(160) && !after(330) ? 'active' : undefined,
          gateway: after(480) ? 'ok' : after(410) ? 'active' : undefined,
          policy: after(665) ? 'ok' : undefined,
          service: after(820) ? 'ok' : undefined,
          audit: after(840) ? 'active' : undefined,
        }}
        tags={{
          rolesdb: after(160) && !after(330) ? { text: 'roles: [editor]', color: ALLOW } : undefined,
          gateway: after(480) ? { text: 'signature ✓ exp ✓', color: ALLOW } : undefined,
          policy: after(665) ? { text: 'editor → read, write', color: ALLOW } : undefined,
          service: after(820) ? { text: '200 OK', color: ALLOW } : undefined,
          audit: after(840) ? { text: 'allow', color: '#f59e0b' } : undefined,
        }}
      />
      <Heading sub="PUT /articles/42 as an editor">Following a request</Heading>
      {frame < 330 && (
        <Chip enter={215} top={1370}>
          <span style={{ color: colors.muted }}>JWT claims</span>
          <br />
          {'{ sub: "maya", roles: ["editor"], exp: +15 min }'}
        </Chip>
      )}
      {frame >= 340 && (
        <Chip enter={340} top={1370}>
          PUT /articles/42
          <br />
          Authorization: Bearer eyJhbGciOi…
        </Chip>
      )}
      <Narrated lines={lines} />
    </>
  )
}

function Deny({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const after = (f: number) => frame >= f
  const trips: Trip[] = [
    { path: ['app', 'gateway', 'policy'], start: 15, end: 130, color: TOKEN },
    { path: ['policy', 'gateway', 'app'], start: 185, end: 285, color: DENY },
    { path: ['policy', 'audit'], start: 190, end: 255, color: '#f59e0b' },
    { path: ['app', 'gateway'], start: 330, end: 390, color: '#9ca3af' },
    { path: ['gateway', 'app'], start: 400, end: 450, color: TOKEN },
  ]
  return (
    <>
      <City
        buildings={BUILDINGS}
        roads={ROADS}
        shot={RIGHT}
        trips={trips}
        status={{
          policy: after(150) && !after(330) ? 'bad' : undefined,
          app: after(285) && !after(330) ? 'bad' : undefined,
          gateway: after(390) ? 'bad' : after(130) && !after(330) ? 'ok' : undefined,
          audit: after(255) && !after(330) ? 'active' : undefined,
        }}
        tags={{
          policy: after(150) && !after(330) ? { text: 'needs article:delete ✗', color: DENY } : undefined,
          app: after(285) && !after(330) ? { text: '403 Forbidden', color: DENY } : after(450) ? { text: '401 Unauthorized', color: TOKEN } : undefined,
          gateway: after(390) ? { text: 'exp passed ✗', color: TOKEN } : undefined,
          audit: after(255) && !after(330) ? { text: 'deny', color: '#f59e0b' } : undefined,
        }}
      />
      <Heading sub={after(330) ? 'same request, expired token' : 'DELETE /articles/42 as an editor'}>When it's refused</Heading>
      <Narrated lines={lines} />
    </>
  )
}

function Outro() {
  const line = (enter: number, children: ReactNode) => (
    <Appear enter={enter}>
      <div style={{ marginTop: 40, fontSize: 58, fontWeight: 800, lineHeight: 1.2 }}>{children}</div>
    </Appear>
  )
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: 90, fontFamily: font, color: colors.text }}>
      {line(5, <><span style={{ color: TOKEN }}>401</span>: we don't know who you are.</>)}
      {line(30, <><span style={{ color: DENY }}>403</span>: we know, and the answer is no.</>)}
      {line(55, <><span style={{ color: ALLOW }}>Roles</span> hold permissions; users hold roles.</>)}
      <Appear enter={85}>
        <div style={{ marginTop: 70, fontSize: 36, color: colors.muted }}>Made with Structura · system design, explained</div>
      </Appear>
    </AbsoluteFill>
  )
}

const SCENES: Scene[] = [
  [Title, 120, null],
  [Auth, 480, 'auth'],
  [Model, 480, 'model'],
  [Flow, 900, 'flow'],
  [Deny, 480, 'deny'],
  [Outro, 150, null],
]

export const duration = (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice)

export function Rbac({ voice }: VideoProps) {
  return <Timeline video={VIDEO} narration={narration} scenes={SCENES} voice={voice} />
}
