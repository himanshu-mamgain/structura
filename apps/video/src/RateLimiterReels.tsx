import { ArrowRight, Database, Server } from 'lucide-react'
import { interpolate, useCurrentFrame } from 'remotion'
import { mono, sans } from './cards/fonts'
import { CardScene, Chip, GlowCard, Header, Inset, ink, Mono, NavyBackground, SegmentBar, Typed, useCue, useEnter, WordsContext } from './cards/kit'
import fixedJson from './narration/rate-limiter-fixed-window.json'
import counterJson from './narration/rate-limiter-sliding-counter.json'
import logJson from './narration/rate-limiter-sliding-log.json'
import bucketJson from './narration/rate-limiter-token-bucket.json'
import { Axis, Bucket, KEY, Label, Pop, Row, Show, Slots, Stat, TryIt, useGlide, Verdict } from './rate-limiter/parts'
import type { Narration } from './timeline'
import { clamp, type Scene, type SceneProps, Timeline, totalFrames, type VideoProps } from './ui'

// Rate limiting in four reels, one algorithm each, in teaching order: the fixed window
// and its edge problem, the sliding window log that fixes it exactly, the sliding window
// counter that fixes it cheaply, and the token bucket that allows bursts on purpose.
// Numbers match the Structura topic (10 requests per 60 s for key_live_8f3a) and its
// deep notes (apps/web/src/topics/notes/rate-limiter.md).

function Reel({ video, narration, scenes, voice, words }: VideoProps & { video: string; narration: Narration; scenes: Scene[] }) {
  return (
    <WordsContext.Provider value={words ?? null}>
      <Timeline
        video={video}
        narration={narration}
        scenes={scenes}
        voice={voice}
        background={<NavyBackground />}
        overlay={(progress) => (
          <>
            <SegmentBar progress={progress} scenes={scenes.length} />
            <Header />
          </>
        )}
      />
    </WordsContext.Provider>
  )
}

/** The request every reel follows. */
function RequestCard({ enter, top = 480 }: { enter: number; top?: number }) {
  return (
    <GlowCard enter={enter} tone="cyan" style={{ top }}>
      <Row>
        <Label>API REQUEST</Label>
        <Chip tone="cyan" style={{ marginLeft: 'auto' }}>
          FREE PLAN · 10 / 60 s
        </Chip>
      </Row>
      <Inset>
        <Mono>GET /v1/orders</Mono>
        <Mono color={ink.muted}>{`Authorization: Bearer ${KEY}`}</Mono>
      </Inset>
    </GlowCard>
  )
}

// ═══ 1 · Fixed window ════════════════════════════════════════════════════════

const fixedNarration: Narration = fixedJson
export const FIXED = 'rate-limiter-fixed-window'

function FwHook({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="01"
      eyebrow="RATE LIMITING · 1 OF 4"
      title="10 requests a minute."
      accent="Who counts?"
      accentTone="cyan"
      status={[
        [0, 'LIMIT: 10 / MIN', 'cyan'],
        [cue('fw-hook-3', 'fixed'), 'FIXED WINDOW', 'violet'],
      ]}
    >
      <RequestCard enter={4} />
      <Pop enter={cue('fw-hook-2', 'count')} style={{ top: 830 }}>
        <Stat value="? / 10" caption="requests so far this minute" tone="amber" />
      </Pop>
      <Pop enter={cue('fw-hook-3', 'fixed')} style={{ top: 1060 }}>
        <Chip tone="violet" style={{ fontSize: 34, padding: '14px 28px' }}>
          ALGORITHM 1 · FIXED WINDOW
        </Chip>
      </Pop>
    </CardScene>
  )
}

function FwCount({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const adding = cue('fw-count-3')
  const refused = cue('fw-count-4', 'refused')
  const count = Math.max(0, Math.min(10, Math.floor((frame - adding) / 3) + 1))
  return (
    <CardScene
      lines={lines}
      number="02"
      eyebrow="ONE COUNTER PER MINUTE"
      title="Cut time"
      accent="into minutes."
      accentTone="violet"
      status={[
        [0, 'COUNTING', 'cyan'],
        [refused, '429 TOO MANY REQUESTS', 'red'],
      ]}
    >
      <Axis
        top={470}
        enter={2}
        minutes={{ enter: cue('fw-count-1', 'minutes') }}
        stacks={[{ t: 30, n: 11, ok: 10, enter: adding }]}
      />
      <GlowCard enter={cue('fw-count-2')} tone={frame >= refused ? 'red' : 'violet'} style={{ top: 1020, padding: '20px 26px' }}>
        <Row>
          <Database size={28} color={ink.violet} />
          <Label>REDIS · ONE KEY PER MINUTE</Label>
        </Row>
        <Inset style={{ padding: '12px 18px' }}>
          <Mono size={24}>{`INCR rl:fw:${KEY}:29913450`}</Mono>
          <Mono size={24} color={ink.muted}>{`→ ${frame >= adding ? Math.min(count, 10) + (frame >= refused ? 1 : 0) : 0}   (EXPIRE 120 s)`}</Mono>
        </Inset>
        <Slots count={frame >= adding ? count : 0} refused={frame >= refused} />
      </GlowCard>
      <Pop enter={refused} style={{ top: 1350 }}>
        <Chip tone="red" style={{ fontSize: 28, padding: '12px 24px' }}>
          #11 → 429 · Retry-After: 30
        </Chip>
      </Pop>
    </CardScene>
  )
}

function FwEdge({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const first = cue('fw-edge-2')
  const reset = cue('fw-edge-3', 'zero')
  const second = cue('fw-edge-4')
  const twenty = cue('fw-edge-5', '20')
  const minute1 = frame >= second ? 10 : 0
  return (
    <CardScene
      lines={lines}
      number="03"
      eyebrow="THE EDGE PROBLEM"
      title="Two windows,"
      accent="double the limit."
      status={[
        [0, 'WATCH THE EDGE', 'amber'],
        [first, 'MINUTE 0: 10 / 10', 'green'],
        [reset, 'NEW MINUTE: 0 / 10', 'violet'],
        [second, 'MINUTE 1: 10 / 10', 'green'],
        [twenty, '20 IN 10 s', 'red'],
      ]}
    >
      <Axis
        top={470}
        enter={2}
        tone={frame >= twenty ? 'red' : 'cyan'}
        minutes={{ enter: 2, labels: [`MINUTE 0 · ${frame >= first ? 10 : 0}/10`, `MINUTE 1 · ${minute1}/10`] }}
        stacks={[
          { t: 55, n: 10, ok: 10, enter: first },
          { t: 65, n: 10, ok: 10, enter: second },
        ]}
        brace={{ from: 55, to: 65, label: '20 IN 10 s', tone: 'red', enter: twenty }}
      />
      <GlowCard enter={reset} tone="violet" style={{ top: 1040, padding: '20px 26px' }}>
        <Label>AT 1:00 THE KEY CHANGES</Label>
        <Inset style={{ padding: '12px 18px' }}>
          <Mono size={24} color={ink.muted}>{`rl:fw:${KEY}:29913450 → 10`}</Mono>
          <Mono size={24} color={ink.violet}>{`rl:fw:${KEY}:29913451 → ${minute1}`}</Mono>
        </Inset>
      </GlowCard>
      <Pop enter={twenty} style={{ top: 1290 }}>
        <Chip tone="red" style={{ fontSize: 30, padding: '12px 26px' }}>
          LIMIT 10 · LET THROUGH 20
        </Chip>
      </Pop>
    </CardScene>
  )
}

function FwTakeaway({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene lines={lines} number="04" eyebrow="THE TAKEAWAY" title="Cheap," accent="leaky at the edges." accentTone="amber" status={[[0, 'FIXED WINDOW', 'violet']]}>
      <GlowCard enter={4} tone="green" style={{ top: 480, padding: '20px 26px' }}>
        <Verdict ok>1 NUMBER PER KEY</Verdict>
        <div style={{ fontSize: 26, color: ink.muted, marginTop: 6 }}>About 70 bytes. One atomic INCR per request.</div>
      </GlowCard>
      <GlowCard enter={cue('fw-take-2')} tone="amber" style={{ top: 690, padding: '20px 26px' }}>
        <Verdict ok={false}>UP TO 2× AT A MINUTE'S EDGE</Verdict>
        <div style={{ fontSize: 26, color: ink.muted, marginTop: 6 }}>Fine when a short burst does no harm.</div>
      </GlowCard>
      <Pop enter={cue('fw-take-3', 'sliding')} style={{ top: 960 }}>
        <Chip tone="cyan" style={{ fontSize: 30, padding: '14px 26px' }}>
          NEXT · SLIDING WINDOW LOG <ArrowRight size={28} />
        </Chip>
      </Pop>
    </CardScene>
  )
}

const fixedScenes: Scene[] = [
  [FwHook, 60, 'hook'],
  [FwCount, 60, 'count'],
  [FwEdge, 60, 'edge'],
  [FwTakeaway, 60, 'takeaway'],
  [(p) => <TryIt {...p} part={1} algorithm="Fixed window" hint={['Send 10 at 0:55, then 10 at 1:05.', 'Watch 20 get through.']} />, 220, 'cta'],
]

export const FIXED_CHAPTERS = ['Who counts?', 'One counter per minute', 'The edge problem', 'The takeaway', 'Try it']
export const fixedDuration = (voice: VideoProps['voice']) => totalFrames(FIXED, fixedNarration, fixedScenes, voice)
export const FixedWindowReel = (props: VideoProps) => <Reel {...props} video={FIXED} narration={fixedNarration} scenes={fixedScenes} />

// ═══ 2 · Sliding window log ══════════════════════════════════════════════════

const logNarration: Narration = logJson
export const LOG = 'rate-limiter-sliding-log'

function SlHook({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="01"
      eyebrow="RATE LIMITING · 2 OF 4"
      title="Remember"
      accent="every request."
      accentTone="cyan"
      status={[
        [0, 'FIXED WINDOW: 20 IN 10 s', 'red'],
        [cue('sl-hook-2', 'exact'), 'SLIDING WINDOW LOG', 'cyan'],
      ]}
    >
      <Axis
        top={470}
        enter={2}
        tone="red"
        minutes={{ enter: 2 }}
        stacks={[
          { t: 55, n: 10, ok: 10, enter: 4 },
          { t: 65, n: 10, ok: 10, enter: 10 },
        ]}
        brace={{ from: 55, to: 65, label: '20 IN 10 s', tone: 'red', enter: 24 }}
      />
      <Pop enter={cue('sl-hook-2', 'exact')} style={{ top: 1060 }}>
        <Chip tone="cyan" style={{ fontSize: 34, padding: '14px 28px' }}>
          ALGORITHM 2 · SLIDING WINDOW LOG
        </Chip>
      </Pop>
      <Pop enter={cue('sl-hook-3', 'time')} style={{ top: 1190 }}>
        <Stat value="1 entry = 1 request" caption="the time it arrived" tone="cyan" />
      </Pop>
    </CardScene>
  )
}

function SlLog({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const drop = cue('sl-log-2', 'drop')
  const count = cue('sl-log-3', 'count')
  const add = cue('sl-log-4', 'add')
  // Now is 1:40.0 (100 s); three entries are older than 60 s.
  const entries: [string, boolean][] = [
    ['0:31.2', true],
    ['0:35.8', true],
    ['0:39.4', true],
    ['0:52.0', false],
    ['1:04.6', false],
    ['1:11.3', false],
    ['1:18.9', false],
    ['1:26.1', false],
    ['1:30.7', false],
    ['1:37.5', false],
  ]
  const dropped = frame >= drop
  return (
    <CardScene
      lines={lines}
      number="02"
      eyebrow="A LOG OF TIMES"
      title="A sorted set"
      accent="of timestamps."
      accentTone="cyan"
      status={[
        [0, 'NOW: 1:40', 'cyan'],
        [drop, 'DROP < 0:40', 'amber'],
        [count, 'COUNT: 7 OF 10', 'violet'],
        [add, 'ALLOWED', 'green'],
      ]}
    >
      <GlowCard enter={cue('sl-log-1')} tone="cyan" style={{ top: 470, padding: '18px 26px' }}>
        <Row>
          <Database size={28} color={ink.cyan} />
          <Label>{`ZSET rl:log:${KEY}`}</Label>
        </Row>
        {/* Oldest first, down the left column, then the right. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(6, auto)', gridAutoFlow: 'column', gap: '6px 30px', marginTop: 14 }}>
          {entries.map(([t, old], i) => (
            <Mono key={t} size={27} color={old && dropped ? ink.red : ink.text} style={{ opacity: old && dropped ? 0.45 : 1, textDecoration: old && dropped ? 'line-through' : 'none' }}>
              {`${String(i + 1).padStart(2, ' ')}  ${t}`}
            </Mono>
          ))}
          <Mono size={27} color={ink.green} style={{ opacity: useEnter(add) }}>
            {'11  1:40.0  new'}
          </Mono>
        </div>
      </GlowCard>
      <GlowCard enter={drop} tone="violet" style={{ top: 960, padding: '18px 26px' }}>
        <Label>ONE LUA SCRIPT, ONE STEP</Label>
        <Inset style={{ padding: '12px 18px' }}>
          <Typed enter={drop} size={23} text="ZREMRANGEBYSCORE … 0 (now−60)  → 3" color={ink.amber} />
          <Typed enter={count} size={23} text="ZCARD …                        → 7" color={ink.violet} />
          <Typed enter={add} size={23} text="7 < 10 → ZADD … now            → 8" color={ink.green} />
        </Inset>
      </GlowCard>
    </CardScene>
  )
}

function SlEdge({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const first = cue('sl-edge-1')
  const win = cue('sl-edge-2', 'window')
  const refused = cue('sl-edge-3', 'refused')
  const opens = cue('sl-edge-4', 'opens')
  const at = useGlide(65, 115, opens, opens + 40)
  const later = frame >= opens + 40
  return (
    <CardScene
      lines={lines}
      number="03"
      eyebrow="THE EDGE, FIXED"
      title="Always the"
      accent="last 60 seconds."
      accentTone="amber"
      status={[
        [0, '10 AT 0:55', 'green'],
        [refused, '1:05 → 429', 'red'],
        [opens + 40, '1:55 → ALLOWED', 'green'],
      ]}
    >
      <Axis
        top={470}
        enter={2}
        stacks={[
          { t: 55, n: 10, ok: 10, enter: first, dim: later },
          { t: 65, n: 1, ok: 0, enter: refused, dim: later },
          ...(later ? [{ t: 115, n: 1, ok: 1, enter: opens + 40 }] : []),
        ]}
        slide={{ at, enter: win }}
      />
      <GlowCard enter={win} tone={later ? 'green' : frame >= refused ? 'red' : 'amber'} style={{ top: 1040, padding: '20px 26px' }}>
        <Row>
          <Label>{`AT ${later ? '1:55' : '1:05'} · WINDOW ${later ? '0:55 → 1:55' : '0:05 → 1:05'}`}</Label>
        </Row>
        <Inset style={{ padding: '12px 18px' }}>
          <Mono size={25}>{later ? 'the 0:55 entries are 60 s old → dropped' : 'entries inside: 10 (all from 0:55)'}</Mono>
        </Inset>
        <div style={{ marginTop: 14 }}>{later ? <Verdict ok>ALLOWED</Verdict> : frame >= refused ? <Verdict ok={false}>REFUSED · 429</Verdict> : null}</div>
      </GlowCard>
    </CardScene>
  )
}

function SlCost({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="04"
      eyebrow="THE COST"
      title="Exact,"
      accent="but heavy."
      accentTone="amber"
      status={[
        [0, '1 ENTRY PER REQUEST', 'amber'],
        [cue('sl-cost-3'), 'SMALL, EXACT LIMITS', 'green'],
      ]}
    >
      <GlowCard enter={4} tone="amber" style={{ top: 480, padding: '22px 26px' }}>
        <Label>MEMORY</Label>
        <Inset style={{ padding: '12px 18px' }}>
          <Typed enter={cue('sl-cost-2')} size={26} text="100 / min × 16 B × 10,000,000 keys" />
          <Typed enter={cue('sl-cost-2', 'gigabytes')} size={30} text="= 16 GB" color={ink.amber} />
        </Inset>
        <Mono size={24} color={ink.muted} style={{ marginTop: 12 }}>
          fixed window, same keys: 0.7 GB
        </Mono>
      </GlowCard>
      <GlowCard enter={cue('sl-cost-3')} tone="green" style={{ top: 830, padding: '20px 26px' }}>
        <Verdict ok>GOOD FOR: 5 LOGINS A MINUTE</Verdict>
        <div style={{ fontSize: 26, color: ink.muted, marginTop: 6 }}>Few requests per key, and every one counts.</div>
      </GlowCard>
      <Pop enter={cue('sl-cost-4', 'counter')} style={{ top: 1060 }}>
        <Chip tone="cyan" style={{ fontSize: 30, padding: '14px 26px' }}>
          NEXT · SLIDING WINDOW COUNTER <ArrowRight size={28} />
        </Chip>
      </Pop>
    </CardScene>
  )
}

const logScenes: Scene[] = [
  [SlHook, 60, 'hook'],
  [SlLog, 60, 'log'],
  [SlEdge, 60, 'edge'],
  [SlCost, 60, 'cost'],
  [(p) => <TryIt {...p} part={2} algorithm="Sliding window log" hint={['Send 10 at 0:55, then try at 1:05.', 'See when room opens again.']} />, 220, 'cta'],
]

export const LOG_CHAPTERS = ['Remember every request', 'A log of times', 'The edge, fixed', 'The cost', 'Try it']
export const logDuration = (voice: VideoProps['voice']) => totalFrames(LOG, logNarration, logScenes, voice)
export const SlidingLogReel = (props: VideoProps) => <Reel {...props} video={LOG} narration={logNarration} scenes={logScenes} />

// ═══ 3 · Sliding window counter ══════════════════════════════════════════════

const counterNarration: Narration = counterJson
export const COUNTER = 'rate-limiter-sliding-counter'

function ScHook({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="01"
      eyebrow="RATE LIMITING · 3 OF 4"
      title="Almost exact."
      accent="Almost free."
      accentTone="green"
      status={[
        [0, 'LOG: 16 GB', 'amber'],
        [cue('sc-hook-2', 'two'), '2 NUMBERS PER KEY', 'green'],
      ]}
    >
      <GlowCard enter={4} tone="amber" dim={false} style={{ top: 480, padding: '22px 26px' }}>
        <Label>SLIDING WINDOW LOG</Label>
        <Mono size={28} style={{ marginTop: 10 }}>
          1 entry per request → 16 GB
        </Mono>
      </GlowCard>
      <GlowCard enter={cue('sc-hook-2')} tone="green" style={{ top: 700, padding: '22px 26px' }}>
        <Label color={ink.green}>SLIDING WINDOW COUNTER</Label>
        <Mono size={28} style={{ marginTop: 10 }}>
          2 numbers per key → ~1.4 GB
        </Mono>
      </GlowCard>
      <Pop enter={cue('sc-hook-2', 'numbers')} style={{ top: 960 }}>
        <Chip tone="green" style={{ fontSize: 34, padding: '14px 28px' }}>
          ALGORITHM 3 · SLIDING WINDOW COUNTER
        </Chip>
      </Pop>
    </CardScene>
  )
}

function Formula({ enter, parts }: { enter: number; parts: [string, number, string][] }) {
  return (
    <GlowCard enter={enter} tone="violet" style={{ top: 1040, padding: '22px 26px' }}>
      <Label>THE ESTIMATE FOR THE LAST 60 s</Label>
      <div style={{ marginTop: 14, fontFamily: mono, fontWeight: 800, fontSize: 34, lineHeight: 1.5 }}>
        {parts.map(([text, at, color]) => (
          <Show key={text} enter={at} style={{ display: 'inline' }}>
            <span style={{ color }}>{text}</span>
          </Show>
        ))}
      </div>
    </GlowCard>
  )
}

function ScCounters({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="02"
      eyebrow="THE ESTIMATE"
      title="Weight the"
      accent="last minute."
      accentTone="violet"
      status={[
        [0, 'PREV + CURRENT', 'violet'],
        [cue('sc-counters-3', 'part'), 'SHARE STILL INSIDE', 'amber'],
      ]}
    >
      <Axis
        top={470}
        enter={2}
        minutes={{ enter: cue('sc-counters-1'), labels: ['LAST MINUTE: prev', 'THIS MINUTE: cur'] }}
        slide={{ at: 65, enter: cue('sc-counters-2', 'guess') }}
        focus={{ at: 65, enter: cue('sc-counters-3', 'part') }}
        stacks={[]}
      />
      <Formula
        enter={cue('sc-counters-2')}
        parts={[
          ['prev', cue('sc-counters-3', 'count'), ink.cyan],
          [' × (60 − s) ÷ 60', cue('sc-counters-3', 'part'), ink.amber],
          [' + cur', cue('sc-counters-4', 'plus'), ink.violet],
        ]}
      />
      <Show enter={cue('sc-counters-3', 'part')} style={{ position: 'absolute', top: 1270, left: 80, right: 80 }}>
        <Mono size={25} color={ink.muted} style={{ whiteSpace: 'normal' }}>
          s = seconds into this minute
        </Mono>
      </Show>
    </CardScene>
  )
}

function ScWorked({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const at105 = cue('sc-worked-2')
  const refused = cue('sc-worked-4', 'refused')
  const at106 = cue('sc-worked-5')
  const allowed = cue('sc-worked-5', 'allowed')
  const later = frame >= at106
  const showRefused = useEnter(refused)
  const showAllowed = useEnter(allowed)
  return (
    <CardScene
      lines={lines}
      number="03"
      eyebrow="WORKED EXAMPLE"
      title="10 at 0:55."
      accent="Then?"
      accentTone="amber"
      status={[
        [0, 'PREV = 10, CUR = 0', 'cyan'],
        [refused, '1:05 → 10.17 → 429', 'red'],
        [allowed, '1:06 → 10 → ALLOWED', 'green'],
      ]}
    >
      <Axis
        top={470}
        enter={2}
        minutes={{ enter: 2 }}
        stacks={[
          { t: 55, n: 10, ok: 10, enter: cue('sc-worked-1') },
          // 1:05 and 1:06 are a few pixels apart: the allowed one replaces the refused one.
          later ? { t: 66, n: 1, ok: 1, enter: allowed } : { t: 65, n: 1, ok: 0, enter: refused },
        ]}
        slide={{ at: later ? 66 : 65, enter: at105 }}
      />
      <GlowCard enter={at105} tone={later ? 'green' : frame >= refused ? 'red' : 'violet'} style={{ top: 1030, padding: '20px 26px' }}>
        {!later ? (
          <>
            <Label>AT 1:05 · s = 5</Label>
            <Inset style={{ padding: '12px 18px' }}>
              <Typed enter={cue('sc-worked-3')} size={25} text="10 × (60 − 5) ÷ 60 = 10 × 0.917" />
              <Typed enter={cue('sc-worked-4')} size={25} text="= 9.17;  + 0 + 1 = 10.17 > 10" color={ink.amber} />
            </Inset>
            <div style={{ marginTop: 14, opacity: showRefused }}>
              <Verdict ok={false}>REFUSED · 429</Verdict>
            </div>
          </>
        ) : (
          <>
            <Label>AT 1:06 · s = 6</Label>
            <Inset style={{ padding: '12px 18px' }}>
              <Typed enter={at106} size={25} text="10 × (60 − 6) ÷ 60 = 10 × 0.9" />
              <Typed enter={at106 + 14} size={25} text="= 9.00;  + 0 + 1 = 10 ≤ 10" color={ink.green} />
            </Inset>
            <div style={{ marginTop: 14, opacity: showAllowed }}>
              <Verdict ok>ALLOWED</Verdict>
            </div>
          </>
        )}
      </GlowCard>
    </CardScene>
  )
}

function ScClose({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="04"
      eyebrow="GOOD ENOUGH?"
      title="Close enough"
      accent="in practice."
      accentTone="green"
      status={[
        [0, 'AN ESTIMATE', 'amber'],
        [cue('sc-close-2'), 'CLOUDFLARE: 0.003%', 'green'],
        [cue('sc-close-4', 'token'), 'NEXT: TOKEN BUCKET', 'cyan'],
      ]}
    >
      <GlowCard enter={4} tone="amber" style={{ top: 480, padding: '20px 26px' }}>
        <Label>THE ASSUMPTION</Label>
        <div style={{ fontSize: 32, fontWeight: 800, marginTop: 8 }}>Last minute's requests were spread evenly.</div>
      </GlowCard>
      <GlowCard enter={cue('sc-close-2')} tone="green" style={{ top: 700, padding: '20px 26px' }}>
        <Label>CLOUDFLARE, 400 MILLION REQUESTS</Label>
        <Row gap={30} style={{ marginTop: 10 }}>
          <Stat value="0.003%" caption="wrongly allowed or limited" tone="green" />
        </Row>
      </GlowCard>
      <Pop enter={cue('sc-close-3')} style={{ top: 990 }}>
        <Row gap={14}>
          <Chip tone="green" style={{ fontSize: 28, padding: '12px 22px' }}>
            2 NUMBERS
          </Chip>
          <Chip tone="green" style={{ fontSize: 28, padding: '12px 22px' }}>
            NO 2× EDGE
          </Chip>
        </Row>
      </Pop>
      <Pop enter={cue('sc-close-4', 'token')} style={{ top: 1110 }}>
        <Chip tone="cyan" style={{ fontSize: 30, padding: '14px 26px' }}>
          NEXT · TOKEN BUCKET <ArrowRight size={28} />
        </Chip>
      </Pop>
    </CardScene>
  )
}

const counterScenes: Scene[] = [
  [ScHook, 60, 'hook'],
  [ScCounters, 60, 'counters'],
  [ScWorked, 60, 'worked'],
  [ScClose, 60, 'close'],
  [(p) => <TryIt {...p} part={3} algorithm="Sliding window counter" hint={['Send 10 at 0:55, then 10 at 1:05.', 'Compare it with the fixed window.']} />, 220, 'cta'],
]

export const COUNTER_CHAPTERS = ['Almost exact, almost free', 'The estimate', 'Worked example', 'Close enough', 'Try it']
export const counterDuration = (voice: VideoProps['voice']) => totalFrames(COUNTER, counterNarration, counterScenes, voice)
export const SlidingCounterReel = (props: VideoProps) => <Reel {...props} video={COUNTER} narration={counterNarration} scenes={counterScenes} />

// ═══ 4 · Token bucket ════════════════════════════════════════════════════════

const bucketNarration: Narration = bucketJson
export const BUCKET = 'rate-limiter-token-bucket'

function TbHook({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="01"
      eyebrow="RATE LIMITING · 4 OF 4"
      title="Allow a burst."
      accent="Hold the average."
      accentTone="cyan"
      status={[
        [0, 'TOKEN BUCKET', 'cyan'],
        [cue('tb-hook-2', 'burst'), 'BURSTS OK', 'green'],
      ]}
    >
      <GlowCard enter={4} tone="cyan" style={{ top: 480, padding: '24px 28px' }}>
        <Label>STRIPE ENGINEERING BLOG</Label>
        <div style={{ fontSize: 40, fontWeight: 800, marginTop: 12, lineHeight: 1.3 }}>“We use the token bucket algorithm to do rate limiting.”</div>
      </GlowCard>
      <Pop enter={cue('tb-hook-2', 'burst')} style={{ top: 830 }}>
        <Bucket level={10} size={0.9} />
      </Pop>
      <Pop enter={cue('tb-hook-2', 'average')} style={{ top: 1150 }}>
        <Chip tone="cyan" style={{ fontSize: 34, padding: '14px 28px' }}>
          ALGORITHM 4 · TOKEN BUCKET
        </Chip>
      </Pop>
    </CardScene>
  )
}

function TbBucket({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const takes = cue('tb-bucket-2', 'takes')
  const drips = cue('tb-bucket-3', 'drips')
  const refused = cue('tb-bucket-4', 'Refused')
  const empty = cue('tb-bucket-4')
  // One request takes a token, one drips back, then the bucket shown empty: nothing to take.
  const level = frame < takes ? 10 : frame < drips ? 9 : frame < empty ? interpolate(frame, [drips, drips + 30], [9, 10], clamp) : 0
  return (
    <CardScene
      lines={lines}
      number="02"
      eyebrow="THE BUCKET"
      title="10 tokens."
      accent="1 back every 6 s."
      accentTone="green"
      status={[
        [0, 'CAPACITY: 10', 'cyan'],
        [takes, 'REQUEST → −1 TOKEN', 'violet'],
        [drips, '+1 TOKEN / 6 s', 'green'],
        [refused, 'EMPTY → 429', 'red'],
      ]}
    >
      <Pop enter={2} style={{ top: 470 }}>
        <Bucket level={level} dripping={frame >= drips && frame < empty} />
      </Pop>
      <GlowCard enter={drips} tone="green" style={{ top: 840, padding: '20px 26px' }}>
        <Label>REFILL</Label>
        <Inset style={{ padding: '12px 18px' }}>
          <Mono size={27}>{'60 s ÷ 10 tokens = 6 s per token'}</Mono>
          <Mono size={27} color={ink.muted}>
            {'10 ÷ 60 = 0.167 tokens a second'}
          </Mono>
        </Inset>
      </GlowCard>
      <GlowCard enter={refused} tone="red" style={{ top: 1110, padding: '18px 26px' }}>
        <Verdict ok={false}>NO WHOLE TOKEN → 429</Verdict>
        <Mono size={25} color={ink.muted} style={{ marginTop: 6 }}>
          Retry-After: 6
        </Mono>
      </GlowCard>
    </CardScene>
  )
}

function TbTimeline({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const t0 = cue('tb-time-1', 'All')
  const t3 = cue('tb-time-2')
  const t6 = cue('tb-time-3')
  const full = cue('tb-time-4', 'full')
  // The bucket level, step by step: 10 → 0 (ten requests) → 0.5 → 1 → 0 → full.
  const level =
    frame < t0 ? 10 : frame < t3 ? Math.max(0, 10 - Math.floor((frame - t0) / 2)) : frame < t6 ? 0.5 : frame < t6 + 24 ? 1 : frame < full ? 0 : 10
  const rows: [string, string, string, boolean | null, number][] = [
    ['0 s', '10 requests', '0', true, t0],
    ['3 s', '+0.5 → 0.5', '0.5', false, t3],
    ['6 s', '+0.5 → 1', '0', true, t6],
    ['60 s+', 'refilled', '10', null, full],
  ]
  return (
    <CardScene
      lines={lines}
      number="03"
      eyebrow="SECOND BY SECOND"
      title="Follow"
      accent="one client."
      accentTone="cyan"
      status={[
        [0, '0 s: BURST OF 10', 'cyan'],
        [t3, '3 s: 0.5 TOKEN → 429', 'red'],
        [t6, '6 s: 1 TOKEN → OK', 'green'],
        [full, 'FULL: 10, NEVER MORE', 'cyan'],
      ]}
    >
      <Pop enter={2} style={{ top: 460 }}>
        <Bucket level={level} dripping={frame >= t3 && frame < full + 20} size={0.85} />
      </Pop>
      <GlowCard enter={t0} tone="cyan" style={{ top: 770, padding: '18px 26px' }}>
        <Row style={{ fontFamily: mono, fontWeight: 700, fontSize: 21, letterSpacing: '0.1em', color: ink.muted }}>
          <span style={{ width: 120 }}>TIME</span>
          <span style={{ flex: 1 }}>TOKENS</span>
          <span style={{ width: 140 }}>RESULT</span>
          <span style={{ width: 80, textAlign: 'right' }}>LEFT</span>
        </Row>
        {rows.map(([time, tokens, left, ok, at]) => (
          <Show key={time} enter={at}>
            <Row style={{ marginTop: 12, fontFamily: mono, fontSize: 28, fontWeight: 700 }}>
              <span style={{ width: 120, color: ink.text }}>{time}</span>
              <span style={{ flex: 1, color: ink.muted }}>{tokens}</span>
              <span style={{ width: 140, color: ok === null ? ink.cyan : ok ? ink.green : ink.red }}>{ok === null ? 'FULL' : ok ? 'ALLOW' : '429'}</span>
              <span style={{ width: 80, textAlign: 'right', color: ink.amber }}>{left}</span>
            </Row>
          </Show>
        ))}
      </GlowCard>
    </CardScene>
  )
}

function Gateway({ name, ok, enter }: { name: string; ok: boolean; enter: number }) {
  const t = useEnter(enter)
  return (
    <div style={{ flex: 1, opacity: t, padding: '16px 18px', borderRadius: 18, border: `2.5px solid ${ok ? ink.green : ink.red}`, background: `${ok ? ink.green : ink.red}14` }}>
      <Row gap={10}>
        <Server size={28} color={ink.text} />
        <span style={{ fontSize: 28, fontWeight: 900 }}>{name}</span>
      </Row>
      <div style={{ marginTop: 8, fontFamily: mono, fontWeight: 800, fontSize: 25, color: ok ? ink.green : ink.red }}>{ok ? 'GOT THE TOKEN' : 'NONE LEFT · 429'}</div>
    </div>
  )
}

function TbRedis({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="04"
      eyebrow="IN REDIS"
      title="Two numbers,"
      accent="one script."
      accentTone="violet"
      status={[
        [0, 'HASH: tokens, ts', 'cyan'],
        [cue('tb-redis-2', 'Lua'), 'ATOMIC LUA SCRIPT', 'violet'],
        [cue('tb-redis-3'), 'NO RACE', 'green'],
      ]}
    >
      <GlowCard enter={4} tone="cyan" style={{ top: 470, padding: '18px 26px' }}>
        <Row>
          <Database size={28} color={ink.cyan} />
          <Label>{`HGETALL rl:tb:${KEY}`}</Label>
        </Row>
        <Inset style={{ padding: '10px 18px' }}>
          <Mono size={26}>{'tokens → 3.5'}</Mono>
          <Mono size={26}>{'ts     → 1794807005'}</Mono>
        </Inset>
      </GlowCard>
      <GlowCard enter={cue('tb-redis-2')} tone="violet" style={{ top: 760, padding: '18px 26px' }}>
        <Label>ONE STEP INSIDE REDIS</Label>
        <Inset style={{ padding: '10px 18px' }}>
          <Typed enter={cue('tb-redis-2', 'refills')} size={22} text="tokens = min(10, tokens + (now − ts) × 10/60)" />
          <Typed enter={cue('tb-redis-2', 'takes')} size={22} text="if tokens >= 1 then tokens = tokens − 1" color={ink.green} />
          <Typed enter={cue('tb-redis-2', 'step')} size={22} text="HSET tokens, ts = now   (EXPIRE 120)" color={ink.muted} />
        </Inset>
      </GlowCard>
      <div style={{ position: 'absolute', top: 1090, left: 56, right: 56, display: 'flex', gap: 20 }}>
        <Gateway name="Gateway A" ok enter={cue('tb-redis-3', 'gateways')} />
        <Gateway name="Gateway B" ok={false} enter={cue('tb-redis-3', 'last')} />
      </div>
    </CardScene>
  )
}

function TbTakeaway({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene
      lines={lines}
      number="05"
      eyebrow="THE TAKEAWAY"
      title="Bursts up to 10."
      accent="10 a minute after."
      accentTone="green"
      status={[
        [0, 'TOKEN BUCKET', 'cyan'],
        [cue('tb-take-2', '19'), 'FIRST MINUTE: 19', 'amber'],
      ]}
    >
      <div style={{ position: 'absolute', top: 500, left: 80, right: 80, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40 }}>
        <Show enter={4}>
          <Stat value="10" caption="at once, from a full bucket" tone="cyan" />
        </Show>
        <Show enter={cue('tb-take-1', 'average')}>
          <Stat value="10 / min" caption="on average after that" tone="green" />
        </Show>
        <Show enter={cue('tb-take-2', '19')}>
          <Stat value="19" caption="most in the first minute: 10 + 9" tone="amber" />
        </Show>
        <Show enter={cue('tb-take-3', 'smaller')}>
          <Stat value="5 tokens" caption="a smaller bucket, smaller bursts" tone="violet" />
        </Show>
      </div>
      <Show enter={cue('tb-take-2', '19')} style={{ position: 'absolute', top: 1010, left: 80, right: 80 }}>
        <Mono size={25} color={ink.muted} style={{ whiteSpace: 'normal', fontFamily: sans }}>
          10 at 0 s, then one at 6, 12, 18 … 54 s.
        </Mono>
      </Show>
    </CardScene>
  )
}

const bucketScenes: Scene[] = [
  [TbHook, 60, 'hook'],
  [TbBucket, 60, 'bucket'],
  [TbTimeline, 60, 'timeline'],
  [TbRedis, 60, 'redis'],
  [TbTakeaway, 60, 'takeaway'],
  [(p) => <TryIt {...p} part={4} algorithm="Token bucket" hint={['Pick an algorithm, send a burst,', 'and switch Redis off.']} />, 220, 'cta'],
]

export const BUCKET_CHAPTERS = ['Allow a burst', 'The bucket', 'Second by second', 'In Redis', 'The takeaway', 'Try it']
export const bucketDuration = (voice: VideoProps['voice']) => totalFrames(BUCKET, bucketNarration, bucketScenes, voice)
export const TokenBucketReel = (props: VideoProps) => <Reel {...props} video={BUCKET} narration={bucketNarration} scenes={bucketScenes} />
