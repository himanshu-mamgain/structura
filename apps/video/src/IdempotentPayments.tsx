import { ArrowDown, ArrowUp, Check, CircleAlert, IndianRupee, KeyRound, Landmark, Loader, ShoppingCart, Smartphone, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { mono, sans } from './cards/fonts'
import { CardScene, Chip, GlowCard, Header, Inset, ink, Logo, Mono, NavyBackground, SegmentBar, type Tone, toneColor, Typed, useCue, useEnter, WordsContext } from './cards/kit'
import narrationJson from './narration/payment-idempotency.json'
import type { Narration } from './timeline'
import { clamp, type Scene, type SceneProps, Timeline, totalFrames, type VideoProps } from './ui'

// Idempotent Payments, as a reel: "payment failed, but the money's gone".
// The values match the Structura topic's simulator (apps/web/src/topics/
// payment-idempotency.ts): ₹100 to Sharma General Store, the same key, payment
// ids, UPI reference numbers and clock times.

export const VIDEO = 'payment-idempotency'
const narration: Narration = narrationJson

const KEY = 'bb33e666-32f9-4974-b792-19a7a397bf7e'
const PAY_1 = 'pay_Q7mX2kd9aLr4'
const PAY_2 = 'pay_Q7mY8tLc0bWe'
const RRN_1 = '428915736201'
const RRN_2 = '428915736488'

/** A changing tone: the last [frame, tone] reached. */
function useTone(steps: [number, Tone][]): Tone {
  const frame = useCurrentFrame()
  return steps.reduce<Tone>((tone, [at, t]) => (frame >= at ? t : tone), steps[0][1])
}

const Row = ({ children, gap = 14, style }: { children: ReactNode; gap?: number; style?: React.CSSProperties }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap, ...style }}>{children}</div>
)
const Label = ({ children, color = ink.muted }: { children: ReactNode; color?: string }) => (
  <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 21, letterSpacing: '0.12em', color }}>{children}</span>
)

// ─── 01 · The panic ──────────────────────────────────────────────────────────

function Sms({ time, rrn, tone }: { time: string; rrn: string; tone: Tone }) {
  return (
    <>
      <Row>
        <Landmark size={30} color={toneColor(tone)} />
        <Label>BANK SMS · {time}</Label>
        <Chip tone={tone} style={{ marginLeft: 'auto' }}>
          −₹100
        </Chip>
      </Row>
      <div style={{ marginTop: 12, fontSize: 32, fontWeight: 700 }}>Rs.100 debited from A/c XX4821 via UPI.</div>
      <Mono color={ink.muted} size={24} style={{ marginTop: 4 }}>
        UPI Ref {rrn}
      </Mono>
    </>
  )
}

function Hook({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const failed = cue('hook-2', 'failed')
  const tone = useTone([
    [0, 'amber'],
    [failed, 'red'],
  ])
  return (
    <CardScene
      lines={lines}
      number="01"
      eyebrow="THE PANIC"
      title="Payment failed."
      accent="Money gone."
      status={[
        [0, 'UPI PAYMENT', 'cyan'],
        [failed, 'PAYMENT FAILED', 'red'],
        [cue('hook-3', 'bank'), '₹100 DEBITED', 'amber'],
        [cue('hook-4', 'twice'), 'DOUBLE DEBIT', 'red'],
      ]}
    >
      <GlowCard enter={4} tone={tone} style={{ top: 490 }}>
        <Row>
          <Smartphone size={30} color={ink.cyan} />
          <Label>UPI PAYMENT</Label>
        </Row>
        <div style={{ marginTop: 14, fontSize: 40, fontWeight: 800 }}>Sharma General Store</div>
        <div style={{ fontSize: 104, fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1.1 }}>₹100</div>
        <Row style={{ marginTop: 10 }}>
          {frame < failed ? (
            <>
              <Loader size={34} color={ink.amber} style={{ transform: `rotate(${frame * 12}deg)` }} />
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 28, color: ink.amber, letterSpacing: '0.06em' }}>PROCESSING…</span>
            </>
          ) : (
            <>
              <X size={38} color={ink.red} strokeWidth={3} />
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 30, color: ink.red, letterSpacing: '0.06em' }}>PAYMENT FAILED</span>
            </>
          )}
        </Row>
      </GlowCard>
      <GlowCard enter={cue('hook-3', 'bank')} tone="amber" style={{ top: 880 }}>
        <Sms time="22:41:09" rrn={RRN_1} tone="amber" />
      </GlowCard>
      <GlowCard enter={cue('hook-4', 'now')} tone="red" style={{ top: 1110 }}>
        <Sms time="22:41:31" rrn={RRN_2} tone="red" />
      </GlowCard>
      <Pop enter={cue('hook-4', 'twice')} style={{ top: 1350 }}>
        <Chip tone="red" style={{ fontSize: 26, padding: '10px 22px' }}>
          PAID ONCE · DEBITED TWICE
        </Chip>
      </Pop>
    </CardScene>
  )
}

/** Centred, pops in at `enter`. */
function Pop({ enter, children, style }: { enter: number; children: ReactNode; style?: React.CSSProperties }) {
  const t = useEnter(enter, 12)
  return <div style={{ position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: t, transform: `scale(${0.85 + 0.15 * t})`, ...style }}>{children}</div>
}

// ─── 02 · What actually happened ─────────────────────────────────────────────

function Lost({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const sent = cue('lost-2', 'reached')
  const took = cue('lost-2', 'took')
  const back = cue('lost-3', 'response')
  const lost = cue('lost-3', 'lost')
  const packet = interpolate(frame, [sent - 12, sent + 12], [0, 1], clamp)
  const response = interpolate(frame, [back, lost], [0, 1], clamp)
  const broken = frame >= lost
  // Lines run from under the app box (y 640) to the top of the bank box (y 1000).
  const top = 640
  const bottom = 1000
  const breakY = bottom - (bottom - top) * 0.55
  const showRequest = useEnter(sent - 12)
  const showResponse = useEnter(back)
  const showLost = useEnter(lost, 10)
  const showProcessed = useEnter(took)
  return (
    <CardScene
      lines={lines}
      number="02"
      eyebrow="WHAT ACTUALLY HAPPENED"
      title="Payment processed."
      accent="Response lost."
      status={[
        [0, 'TRACING THE PAYMENT', 'cyan'],
        [took, 'BANK: DEBITED', 'green'],
        [lost, 'RESPONSE LOST', 'red'],
        [cue('lost-4'), 'APP: UNKNOWN', 'amber'],
      ]}
    >
      <GlowCard enter={2} tone="cyan" style={{ top: 500, left: 280, right: 280, textAlign: 'center', padding: '22px 20px' }}>
        <div style={{ fontSize: 46, fontWeight: 900 }}>APP</div>
        <div style={{ fontSize: 26, color: ink.muted, fontWeight: 500 }}>Payment initiated</div>
      </GlowCard>
      <svg width={1080} height={1920} style={{ position: 'absolute', inset: 0 }}>
        {/* Request: dashed, down the left */}
        <line x1={470} y1={top} x2={470} y2={bottom} stroke={ink.cyan} strokeWidth={4} strokeDasharray="10 12" opacity={0.85} />
        {frame >= sent - 12 && <circle cx={470} cy={top + (bottom - top) * packet} r={12} fill={ink.cyan} style={{ filter: `drop-shadow(0 0 10px ${ink.cyan})` }} />}
        {/* Response: up the right, breaking part-way */}
        <line x1={610} y1={bottom} x2={610} y2={bottom - (bottom - top) * 0.55 * response} stroke={ink.red} strokeWidth={5} />
        {broken &&
          Array.from({ length: 9 }, (_, i) => {
            const drift = interpolate(frame, [lost, lost + 30], [0, 1], clamp)
            const x = 610 + Math.sin(i * 2.1) * 36 * (0.4 + drift)
            const y = breakY - 18 - i * 11 - drift * 14
            return <rect key={i} x={x} y={y} width={9} height={9} fill={ink.red} opacity={0.9 - i * 0.08 - drift * 0.2} />
          })}
      </svg>
      <div style={{ position: 'absolute', top: 760, left: 300, opacity: showRequest }}>
        <Row gap={6}>
          <Label color={ink.cyan}>REQUEST</Label>
          <ArrowDown size={24} color={ink.cyan} />
        </Row>
      </div>
      <div style={{ position: 'absolute', top: 900, left: 640, opacity: showResponse }}>
        <Row gap={6}>
          <Label color={ink.red}>RESPONSE</Label>
          <ArrowUp size={24} color={ink.red} />
        </Row>
      </div>
      {broken && (
        <div style={{ position: 'absolute', top: breakY - 70, left: 660, opacity: showLost }}>
          <Row gap={8}>
            <X size={30} color={ink.red} strokeWidth={3} />
            <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 28, color: ink.red, letterSpacing: '0.1em' }}>LOST</span>
          </Row>
        </div>
      )}
      <GlowCard enter={6} tone={frame >= took ? 'green' : 'cyan'} style={{ top: 1000, left: 170, right: 170, textAlign: 'center', padding: '22px 20px' }}>
        <div style={{ fontSize: 42, fontWeight: 900 }}>BANK SERVER</div>
        <div style={{ opacity: showProcessed, fontFamily: mono, fontWeight: 800, fontSize: 25, color: ink.green, marginTop: 6, letterSpacing: '0.04em' }}>
          REQUEST PROCESSED
          <br />
          −₹100 · RRN {RRN_1}
        </div>
      </GlowCard>
      <GlowCard enter={cue('lost-4')} tone="green" style={{ top: 1250, right: 556, padding: '20px 22px' }}>
        <Row gap={12}>
          <Check size={34} color={ink.green} strokeWidth={3} />
          <span style={{ fontSize: 31, fontWeight: 900, color: ink.green }}>BANK: DONE</span>
        </Row>
        <div style={{ fontSize: 24, color: ink.muted, marginTop: 4 }}>₹100 processed</div>
      </GlowCard>
      <GlowCard enter={cue('lost-4', 'app')} tone="red" style={{ top: 1250, left: 556, padding: '20px 22px' }}>
        <Row gap={12}>
          <CircleAlert size={34} color={ink.red} strokeWidth={3} />
          <span style={{ fontSize: 31, fontWeight: 900, color: ink.red }}>APP: UNKNOWN</span>
        </Row>
        <div style={{ fontSize: 24, color: ink.muted, marginTop: 4 }}>No response received</div>
      </GlowCard>
    </CardScene>
  )
}

// ─── 03 · The retry trap ─────────────────────────────────────────────────────

function Trap({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const unknown = cue('trap-1', 'unknown')
  const retry = cue('trap-2', 'brand')
  const charged = cue('trap-3', 'again')
  const states: [string, Tone][] = [
    ['SUCCESS', 'green'],
    ['UNKNOWN', 'amber'],
    ['FAILED', 'red'],
  ]
  return (
    <CardScene
      lines={lines}
      number="03"
      eyebrow="THE RETRY TRAP"
      title="A timeout means"
      accent="unknown."
      accentTone="amber"
      status={[
        [0, 'TIMEOUT AFTER 15 S', 'amber'],
        [cue('trap-2'), 'RETRY WITHOUT A KEY', 'amber'],
        [charged, 'CHARGED TWICE', 'red'],
      ]}
    >
      <GlowCard enter={2} tone="amber" style={{ top: 490, padding: '20px 22px' }}>
        <Row gap={14} style={{ justifyContent: 'space-between' }}>
          {states.map(([label, tone]) => {
            const on = label === 'UNKNOWN' && frame >= unknown
            const color = toneColor(tone)
            return (
              <div
                key={label}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '18px 0',
                  borderRadius: 16,
                  border: `2.5px solid ${on ? color : ink.border}`,
                  background: on ? `${color}22` : 'transparent',
                  boxShadow: on ? `0 0 30px ${color}66` : 'none',
                  fontFamily: mono,
                  fontWeight: 800,
                  fontSize: 30,
                  letterSpacing: '0.06em',
                  color: on ? color : ink.dim,
                  textDecoration: label === 'FAILED' && frame >= unknown ? 'line-through' : 'none',
                }}
              >
                {label}
              </div>
            )
          })}
        </Row>
      </GlowCard>
      <GlowCard enter={cue('trap-2')} tone={frame >= retry ? 'red' : 'amber'} style={{ top: 700 }}>
        <Row>
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: ink.red }} />
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: ink.amber }} />
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: ink.green }} />
          <Label>app.log · NO IDEMPOTENCY KEY</Label>
        </Row>
        <Inset>
          <Typed enter={cue('trap-2')} text="22:41:07  POST /v1/payments" />
          <Typed enter={cue('trap-2') + 8} text="22:41:22  no response after 15 s" color={ink.amber} />
          <Typed enter={retry} text="22:41:29  POST /v1/payments  (new!)" color={ink.red} />
          <Typed enter={cue('trap-3', 'charges')} text={`22:41:31  200 OK  ${PAY_2}`} />
        </Inset>
      </GlowCard>
      <GlowCard enter={cue('trap-3')} tone={frame >= charged ? 'red' : 'amber'} style={{ top: 1100 }}>
        <Row>
          <Landmark size={30} color={ink.amber} />
          <Label>BANK STATEMENT</Label>
        </Row>
        <Inset>
          <Mono>{`22:41:09  UPI ${RRN_1}  −₹100`}</Mono>
          <Mono color={ink.red} style={{ opacity: useEnter(charged) }}>{`22:41:31  UPI ${RRN_2}  −₹100`}</Mono>
        </Inset>
        <Row style={{ marginTop: 14, justifyContent: 'flex-end', opacity: useEnter(charged + 6) }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: ink.muted }}>Total</span>
          <span style={{ fontSize: 40, fontWeight: 900, color: ink.red }}>−₹200</span>
        </Row>
      </GlowCard>
    </CardScene>
  )
}

// ─── 04 · The fix ────────────────────────────────────────────────────────────

function KeyLine({ enter, glow }: { enter: number; glow: boolean }) {
  const t = useEnter(enter, 14)
  return (
    <div style={{ opacity: t }}>
      <Mono color={ink.muted} size={24}>
        Idempotency-Key:
      </Mono>
      <Mono color={ink.cyan} size={27} style={{ fontWeight: 700, textShadow: glow ? `0 0 18px ${ink.cyan}` : 'none' }}>
        {KEY}
      </Mono>
    </div>
  )
}

function Fix({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const named = cue('key-1', 'key')
  const same = cue('key-3', 'same')
  const saved = cue('key-4', 'saves')
  const replay = cue('key-5', 'replays')
  return (
    <CardScene
      lines={lines}
      number="04"
      eyebrow="THE FIX"
      title="One checkout,"
      accent="one key."
      accentTone="cyan"
      status={[
        [0, 'IDEMPOTENCY KEY', 'cyan'],
        [cue('key-3'), 'RETRY · SAME KEY', 'violet'],
        [saved, 'KEY + RESULT SAVED', 'cyan'],
        [replay, 'KEY SEEN · REPLAY', 'green'],
      ]}
    >
      <GlowCard enter={2} tone="cyan" style={{ top: 480, padding: '20px 26px' }}>
        <Row>
          <Chip tone="cyan">ATTEMPT 1 · 22:41:07</Chip>
          <Chip tone="muted" style={{ marginLeft: 'auto', opacity: useEnter(cue('key-2', 'creates')) }}>
            <KeyRound size={20} /> MADE AT CHECKOUT
          </Chip>
        </Row>
        <Mono style={{ marginTop: 12 }}>POST /v1/payments</Mono>
        <KeyLine enter={named} glow={frame >= named && frame < named + 40} />
      </GlowCard>
      <GlowCard enter={cue('key-3')} tone="violet" style={{ top: 760, padding: '20px 26px' }}>
        <Row>
          <Chip tone="violet">ATTEMPT 2 · RETRY</Chip>
          <Chip tone="cyan" style={{ marginLeft: 'auto', opacity: useEnter(same) }}>
            SAME KEY
          </Chip>
        </Row>
        <Mono style={{ marginTop: 12 }}>POST /v1/payments</Mono>
        <KeyLine enter={cue('key-3')} glow={frame >= same && frame < same + 40} />
      </GlowCard>
      <GlowCard enter={saved} tone="cyan" style={{ top: 1040, padding: '18px 26px' }}>
        <Row>
          <Label>DB · idempotency_keys</Label>
        </Row>
        <Inset style={{ marginTop: 10, padding: '12px 18px' }}>
          <Mono size={24}>{`u_8812 │ bb33e666… │ 200 SUCCEEDED`}</Mono>
          <Mono size={24} color={ink.muted}>{`         payment ${PAY_1}`}</Mono>
        </Inset>
      </GlowCard>
      <GlowCard enter={replay} tone="green" style={{ top: 1260, padding: '18px 26px' }}>
        <Row>
          <Check size={30} color={ink.green} strokeWidth={3} />
          <span style={{ fontSize: 30, fontWeight: 900, color: ink.green }}>KEY SEEN · REPLAYED</span>
          <Chip tone="green" style={{ marginLeft: 'auto', opacity: useEnter(cue('key-5', 'twice')) }}>
            BANK CALLS: 1
          </Chip>
        </Row>
        <Mono size={24} style={{ marginTop: 8 }}>
          200 OK · Idempotent-Replayed: true
        </Mono>
      </GlowCard>
    </CardScene>
  )
}

// ─── 05 · Edge cases ─────────────────────────────────────────────────────────

function CaseRow({ top, n, title, detail, state }: { top: number; n: string; title: string; detail: string; state: 'safe' | 'active' | 'waiting' }) {
  const tone: Tone = state === 'safe' ? 'green' : state === 'active' ? 'violet' : 'muted'
  return (
    <GlowCard enter={2 + Number(n) * 4} tone={tone} dim={state === 'waiting'} style={{ top, padding: '18px 24px' }}>
      <Row>
        <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 24, color: toneColor(tone) }}>{n.padStart(2, '0')}</span>
        <span style={{ fontSize: 34, fontWeight: 900 }}>{title}</span>
        <Chip tone={tone} style={{ marginLeft: 'auto' }}>
          {state === 'safe' ? (
            <>
              <Check size={20} strokeWidth={3} /> SAFE
            </>
          ) : state === 'active' ? (
            'ACTIVE'
          ) : (
            'NEXT'
          )}
        </Chip>
      </Row>
      <Mono size={23} color={ink.muted} style={{ marginTop: 6 }}>
        {detail}
      </Mono>
    </GlowCard>
  )
}

function Cases({ lines }: SceneProps) {
  const cue = useCue(lines)
  const frame = useCurrentFrame()
  const slow = cue('cases-3')
  const settled = cue('cases-4', 'later')
  const tapDone = slow
  const showB = useEnter(cue('cases-1', 'one'))
  const showWait = useEnter(cue('cases-2', 'waits'))
  const showWebhook = useEnter(cue('cases-4', 'webhook'))
  const showRecon = useEnter(cue('cases-4', 'reconciliation'))
  return (
    <CardScene
      lines={lines}
      number="05"
      eyebrow="EDGE CASES"
      title="Every retry,"
      accent="covered."
      accentTone="green"
      status={[
        [0, 'CASE 2: DOUBLE TAP', 'violet'],
        [slow, 'CASE 3: SLOW BANK', 'amber'],
        [settled, 'ALL SAFE', 'green'],
      ]}
    >
      <CaseRow top={480} n="1" title="Response lost" detail="same key → saved answer replayed" state="safe" />
      <CaseRow top={640} n="2" title="Double tap" detail="UNIQUE (user_id, key) → one insert wins" state={frame >= tapDone ? 'safe' : 'active'} />
      <CaseRow top={800} n="3" title="Bank too slow" detail="PENDING → webhook or reconciliation" state={frame >= settled ? 'safe' : frame >= slow ? 'active' : 'waiting'} />
      {frame < slow ? (
        <GlowCard key="tap" enter={cue('cases-1', 'constraint')} tone="violet" style={{ top: 990 }}>
          <Label>TWO TAPS, 300 ms APART</Label>
          <Inset>
            <Mono size={24}>{'A  INSERT key bb33e666…  1 row'}</Mono>
            <Mono size={24} color={ink.red} style={{ opacity: showB }}>
              {'B  INSERT key bb33e666…  ERROR 23505'}
            </Mono>
            <Mono size={24} color={ink.green} style={{ opacity: showWait }}>
              {"B waits for A's answer  → 1 debit"}
            </Mono>
          </Inset>
        </GlowCard>
      ) : (
        <GlowCard key="slow" enter={slow} tone={frame >= settled ? 'green' : 'amber'} style={{ top: 990 }}>
          <Label>BANK DOESN'T ANSWER IN 10 s</Label>
          <Inset>
            <Mono size={24} color={ink.amber}>
              {'22:41:17  timeout    → PENDING (202)'}
            </Mono>
            <Mono size={24} style={{ opacity: showWebhook }}>
              {'22:41:26  webhook    → SUCCEEDED'}
            </Mono>
            <Mono size={24} color={ink.muted} style={{ opacity: showRecon }}>
              {'no webhook? the reconciliation job asks'}
            </Mono>
          </Inset>
        </GlowCard>
      )}
    </CardScene>
  )
}

// ─── 06 · Takeaway ───────────────────────────────────────────────────────────

function BigRow({ enter, icon, text, tone }: { enter: number; icon: ReactNode; text: string; tone: Tone }) {
  const t = useEnter(enter, 11)
  return (
    <Row gap={24} style={{ opacity: t, transform: `translateX(${(1 - t) * -40}px)`, marginBottom: 18 }}>
      <div style={{ width: 96, height: 96, borderRadius: 24, display: 'grid', placeItems: 'center', border: `2.5px solid ${toneColor(tone)}`, boxShadow: `0 0 30px ${toneColor(tone)}55`, background: `${toneColor(tone)}14` }}>{icon}</div>
      <span style={{ fontFamily: sans, fontWeight: 900, fontSize: 92, letterSpacing: '-0.03em', color: ink.text }}>{text}</span>
    </Row>
  )
}

function Takeaway({ lines }: SceneProps) {
  const cue = useCue(lines)
  return (
    <CardScene lines={lines} number="06" eyebrow="THE TAKEAWAY" title="Retry safely." status={[[0, 'CORE PRINCIPLE', 'green']]}>
      <GlowCard enter={4} tone="amber" style={{ top: 420 + 60, padding: '20px 26px' }}>
        <div style={{ fontFamily: mono, fontWeight: 800, fontSize: 32, color: ink.amber }}>TIMEOUT = UNKNOWN</div>
        <div style={{ fontSize: 27, color: ink.muted, marginTop: 4 }}>Show “checking status”, never “failed”.</div>
      </GlowCard>
      <GlowCard enter={cue('take-1', 'safe')} tone="green" style={{ top: 680, padding: '20px 26px' }}>
        <div style={{ fontFamily: mono, fontWeight: 800, fontSize: 32, color: ink.green }}>SAME KEY = SAME RESULT</div>
        <div style={{ fontSize: 27, color: ink.muted, marginTop: 4 }}>Retry as often as you like: one debit.</div>
      </GlowCard>
      <div style={{ position: 'absolute', top: 920, left: 90 }}>
        <BigRow enter={cue('take-2', 'checkout')} icon={<ShoppingCart size={52} color={ink.cyan} />} text="1 checkout" tone="cyan" />
        <BigRow enter={cue('take-2', 'key')} icon={<KeyRound size={52} color={ink.violet} />} text="1 key" tone="violet" />
        <BigRow enter={cue('take-2', 'debit')} icon={<IndianRupee size={52} color={ink.green} />} text="1 debit" tone="green" />
      </div>
    </CardScene>
  )
}

// ─── Try it ──────────────────────────────────────────────────────────────────

function TryIt({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const press = interpolate(frame % 50, [0, 8, 16], [1, 0.96, 1], clamp)
  return (
    <CardScene lines={lines} eyebrow="TRY IT YOURSELF" title="Break it." accent="Safely." accentTone="cyan" status={[[0, 'INTERACTIVE SIMULATOR', 'cyan']]}>
      <GlowCard enter={6} tone="cyan" style={{ top: 520, padding: '46px 40px', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Logo size={130} />
        </div>
        <div style={{ marginTop: 24, fontSize: 48, fontWeight: 900, letterSpacing: '0.05em' }}>STRUCTURA</div>
        <div style={{ fontFamily: mono, fontSize: 26, color: ink.cyan, marginTop: 6 }}>Idempotent Payments</div>
        <div style={{ fontSize: 30, color: ink.muted, marginTop: 22, lineHeight: 1.4 }}>
          Lose the response, double-tap,
          <br />
          slow the bank. Watch every step.
        </div>
        <div
          style={{
            display: 'inline-block',
            marginTop: 34,
            padding: '20px 40px',
            borderRadius: 999,
            background: `linear-gradient(90deg, #2f7bff, ${ink.cyan})`,
            color: '#04101f',
            fontWeight: 900,
            fontSize: 30,
            letterSpacing: '0.06em',
            transform: `scale(${press})`,
            boxShadow: `0 0 40px ${ink.cyan}77`,
          }}
        >
          OPEN THE SIMULATOR
        </div>
        <div style={{ fontFamily: mono, fontSize: 26, color: ink.muted, marginTop: 26 }}>structura-web.netlify.app</div>
      </GlowCard>
    </CardScene>
  )
}

// ─── Timeline ────────────────────────────────────────────────────────────────

const SCENES: Scene[] = [
  [Hook, 60, 'hook'],
  [Lost, 60, 'lost'],
  [Trap, 60, 'trap'],
  [Fix, 60, 'key'],
  [Cases, 60, 'cases'],
  [Takeaway, 60, 'takeaway'],
  // Holds the end card a couple of seconds after the last line.
  [TryIt, 220, 'cta'],
]

export const CHAPTERS = ['The panic', 'What actually happened', 'The retry trap', 'The fix: idempotency keys', 'Edge cases', 'The takeaway', 'Try it']

export const duration = (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice)

export function IdempotentPayments({ voice, words = null }: VideoProps) {
  return (
    <WordsContext.Provider value={words}>
      <Timeline
        video={VIDEO}
        narration={narration}
        scenes={SCENES}
        voice={voice}
        background={<NavyBackground />}
        overlay={(progress) => (
          <>
            <SegmentBar progress={progress} scenes={SCENES.length} />
            <Header />
          </>
        )}
      />
    </WordsContext.Provider>
  )
}
