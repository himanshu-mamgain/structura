import type { ReactNode } from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { IsoBox, type Origin } from './iso'
import narrationJson from './narration/docker-vs-vm.json'
import { colors, font, mono } from './theme'
import type { Narration } from './timeline'
import { Appear, Callout, Card, clamp, Heading, Narrated, type Scene, type SceneProps, Svg, Timeline, totalFrames, type VideoProps } from './ui'

// "Docker vs VMs", a ~90 second vertical explainer (1080×1920, 30 fps).
// Captions and their spoken lines come from narration/docker-vs-vm.json; the
// timeline at the bottom strings the scenes together, stretching any that the
// voice needs longer.

export const VIDEO = 'docker-vs-vm'
const narration: Narration = narrationJson

/** SVG canvas for the isometric scenes. */
function Iso({ children }: { children: ReactNode }) {
  return <Svg>{children}</Svg>
}

// ─── Scenes ────────────────────────────────────────────────────────────────

function Title() {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, 120], [1, 1.06], clamp)
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: font, color: colors.text }}>
      <div style={{ transform: `scale(${scale})`, textAlign: 'center', padding: 80 }}>
        <Appear enter={4}>
          <div style={{ fontSize: 40, fontWeight: 700, color: colors.highlight, letterSpacing: '0.12em' }}>SYSTEM DESIGN IN 90 SECONDS</div>
        </Appear>
        <Appear enter={14}>
          <div style={{ marginTop: 30, fontSize: 132, fontWeight: 900, lineHeight: 0.98, letterSpacing: '-0.03em' }}>
            Docker
            <br />
            <span style={{ color: colors.muted, fontSize: 80 }}>vs</span>
            <br />
            VMs
          </div>
        </Appear>
        <Appear enter={34}>
          <div style={{ marginTop: 40, fontSize: 42, color: colors.muted }}>Why one starts in a second and the other in a minute</div>
        </Appear>
      </div>
    </AbsoluteFill>
  )
}

function Problem({ lines }: SceneProps) {
  // Each machine gets its own origin, so the two sit side by side on screen.
  return (
    <>
      <Heading sub="Different machines, different setups">The classic problem</Heading>
      <Iso>
        <IsoBox origin={{ x: 270, y: 600 }} x={0} y={0} z={0} w={230} d={180} h={120} color={colors.engine} label="Your laptop" enter={10} />
        <IsoBox origin={{ x: 770, y: 600 }} x={0} y={0} z={0} w={230} d={180} h={120} color={colors.hardware} label="Server" enter={40} />
      </Iso>
      <Callout enter={60} x={70} y={1010} big="3.12" unit="Python" small="OpenSSL 3 · works ✓" />
      <Callout enter={90} x={590} y={1010} big="3.8" unit="Python" small="OpenSSL 1.1 · crash ✗" hot />
      <Narrated lines={lines} />
    </>
  )
}

/** Three columns stacked on a shared base, x offsets along the X axis. */
const COLUMNS = [0, 190, 380]

function VmStack({ lines }: SceneProps) {
  const o: Origin = { x: 420, y: 780 }
  return (
    <>
      <Heading sub="Hardware → hypervisor → a full OS per app">Virtual machines</Heading>
      <Iso>
        <IsoBox origin={o} x={0} y={0} z={0} w={540} d={240} h={44} color={colors.hardware} label="Hardware" enter={10} />
        <IsoBox origin={o} x={0} y={0} z={44} w={540} d={240} h={36} color={colors.hypervisor} label="Hypervisor" enter={70} />
        {COLUMNS.map((x, i) => (
          <g key={x}>
            <IsoBox origin={o} x={x} y={0} z={80} w={160} d={240} h={120} color={colors.os} label="Guest OS" enter={160 + i * 18} />
            <IsoBox origin={o} x={x} y={0} z={200} w={160} d={240} h={34} color={colors.libs} label="Libs" enter={250 + i * 14} />
            <IsoBox origin={o} x={x} y={0} z={234} w={160} d={240} h={40} color={colors.app} label={`App ${'ABC'[i]}`} enter={300 + i * 14} />
          </g>
        ))}
      </Iso>
      <Callout enter={360} x={80} y={1160} big="1–2" unit="GB each" small="a full OS per VM (typical)" />
      <Callout enter={420} x={560} y={1160} big="~1" unit="min" small="to boot, like a computer" hot />
      <Narrated lines={lines} />
    </>
  )
}

function ContainerStack({ lines }: SceneProps) {
  const o: Origin = { x: 420, y: 820 }
  return (
    <>
      <Heading sub="Hardware → one OS → many isolated processes">Containers</Heading>
      <Iso>
        <IsoBox origin={o} x={0} y={0} z={0} w={540} d={240} h={44} color={colors.hardware} label="Hardware" enter={10} />
        <IsoBox origin={o} x={0} y={0} z={44} w={540} d={240} h={70} color={colors.os} label="Host OS · one kernel" enter={60} />
        <IsoBox origin={o} x={0} y={0} z={114} w={540} d={240} h={34} color={colors.engine} label="Docker Engine" enter={120} />
        {COLUMNS.map((x, i) => (
          <g key={x}>
            <IsoBox origin={o} x={x} y={0} z={148} w={160} d={240} h={30} color={colors.libs} label="Libs" enter={200 + i * 16} />
            <IsoBox origin={o} x={x} y={0} z={178} w={160} d={240} h={40} color={colors.app} label={`App ${'ABC'[i]}`} enter={240 + i * 16} />
          </g>
        ))}
      </Iso>
      <Callout enter={330} x={80} y={1160} big="10–200" unit="MB" small="per image (typical)" />
      <Callout enter={390} x={560} y={1160} big="< 1" unit="s" small="to start: just a process" />
      <Narrated lines={lines} />
    </>
  )
}

/** One comparison row: a label, then a VM bar and a container bar (0–1 of the row's maximum). */
function Row({ enter, label, vm, container, vmText, containerText }: { enter: number; label: string; vm: number; container: number; vmText: string; containerText: string }) {
  const frame = useCurrentFrame()
  const grow = interpolate(frame, [enter + 6, enter + 40], [0, 1], { ...clamp, easing: (t) => 1 - (1 - t) ** 3 })
  const bar = (fraction: number, color: string, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 12 }}>
      <div style={{ height: 46, width: Math.max(14, 560 * fraction * grow), borderRadius: 10, background: color }} />
      <span style={{ fontSize: 32, fontWeight: 700 }}>{text}</span>
    </div>
  )
  return (
    <Appear enter={enter} style={{ marginBottom: 44 }}>
      <div style={{ fontSize: 34, color: colors.muted, fontWeight: 600 }}>{label}</div>
      {bar(vm, colors.os, vmText)}
      {bar(container, colors.engine, containerText)}
    </Appear>
  )
}

function Compare({ lines }: SceneProps) {
  return (
    <>
      <Heading sub={<><span style={{ color: colors.os }}>■ VM</span> &nbsp; <span style={{ color: colors.engine }}>■ Container</span> · typical numbers</>}>
        Side by side
      </Heading>
      <div style={{ position: 'absolute', top: 430, left: 80, right: 60, fontFamily: font, color: colors.text }}>
        <Row enter={20} label="Image size" vm={1} container={0.06} vmText="~2 GB" containerText="~100 MB" />
        <Row enter={70} label="Start time" vm={1} container={0.03} vmText="~60 s" containerText="~1 s" />
        <Row enter={120} label="Per server" vm={0.12} container={1} vmText="tens" containerText="hundreds" />
        <Row enter={170} label="Isolation" vm={1} container={0.55} vmText="own kernel" containerText="shared kernel" />
      </div>
      <Narrated lines={lines} />
    </>
  )
}

function WhenToUse({ lines }: SceneProps) {
  return (
    <>
      <Heading>When to use which</Heading>
      <div style={{ position: 'absolute', top: 360, left: 80, right: 80, fontFamily: font, color: colors.text }}>
        <Card enter={15} title="Virtual machine" color={colors.os} items={['A different OS (Windows on Linux)', 'Hard isolation between customers', 'Old apps that need a full OS']} />
        <Card enter={75} title="Container" color={colors.engine} items={['Microservices', 'Same image: laptop → CI → prod', 'Scale up and down in seconds']} />
        <Appear enter={190} style={{ fontSize: 34, color: colors.muted, lineHeight: 1.35 }}>
          Often both: Docker Desktop on Windows and Mac runs a small Linux VM, and cloud containers run on VMs.
        </Appear>
      </div>
      <Narrated lines={lines} />
    </>
  )
}

/** Three side-by-side columns for the workflow: Dockerfile, image, container. */
const STEP_X = [175, 525, 875]

function Workflow({ lines }: SceneProps) {
  const frame = useCurrentFrame()
  const show = (enter: number) => interpolate(frame, [enter, enter + 20], [0, 1], clamp)
  // Each box gets its own origin so the three read left to right.
  const at = (i: number): Origin => ({ x: STEP_X[i] - 26, y: 640 })
  const label = (i: number, text: string, enter: number, strong = false) => (
    <div
      style={{
        position: 'absolute',
        top: 900,
        left: STEP_X[i] - 160,
        width: 320,
        textAlign: 'center',
        opacity: show(enter),
        fontFamily: font,
        fontSize: 34,
        color: strong ? colors.text : colors.muted,
      }}
    >
      {text}
    </div>
  )
  return (
    <>
      <Heading sub="Build once, run anywhere">From recipe to running</Heading>
      <Iso>
        {/* Dockerfile: the recipe */}
        <IsoBox origin={at(0)} x={0} y={0} z={0} w={170} d={120} h={150} color="#e5e7eb" label="Dockerfile" enter={10} labelSize={24} />
        {/* Image: read-only layers, built once */}
        <IsoBox origin={at(1)} x={0} y={0} z={0} w={170} d={120} h={50} color={colors.hardware} label="base OS" enter={70} labelSize={22} />
        <IsoBox origin={at(1)} x={0} y={0} z={50} w={170} d={120} h={50} color={colors.libs} label="deps" enter={85} labelSize={22} />
        <IsoBox origin={at(1)} x={0} y={0} z={100} w={170} d={120} h={50} color={colors.app} label="your code" enter={100} labelSize={22} />
        {/* Container: the image, running as an isolated process */}
        <IsoBox origin={at(2)} x={0} y={0} z={0} w={170} d={120} h={150} color={colors.engine} label="Container" enter={170} labelSize={24} />
      </Iso>
      {label(0, 'recipe', 10)}
      {label(1, 'image (layers)', 70)}
      {label(2, 'running process', 170)}
      <div style={{ position: 'absolute', top: 960, left: 0, right: 0, fontFamily: font, fontSize: 30, color: colors.text }}>
        <span style={{ position: 'absolute', left: 260, opacity: show(55) }}>docker build →</span>
        <span style={{ position: 'absolute', left: 640, opacity: show(155) }}>docker run →</span>
      </div>
      <Appear enter={200} style={{ position: 'absolute', top: 1060, left: 80, right: 80, fontFamily: mono, fontSize: 30, color: colors.text, background: 'rgba(15,17,21,0.8)', borderRadius: 18, padding: '24px 30px', lineHeight: 1.5 }}>
        <div style={{ color: colors.muted }}># Dockerfile</div>
        <div>FROM python:3.12-slim</div>
        <div>COPY . /app</div>
        <div>RUN pip install -r /app/requirements.txt</div>
        <div>CMD [&quot;python&quot;, &quot;/app/main.py&quot;]</div>
      </Appear>
      <Narrated lines={lines} />
    </>
  )
}

function Outro() {
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: 90, fontFamily: font, color: colors.text }}>
      <Appear enter={5}>
        <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.2 }}>
          <span style={{ color: colors.os }}>VM</span> = a computer inside a computer.
        </div>
      </Appear>
      <Appear enter={30}>
        <div style={{ marginTop: 40, fontSize: 64, fontWeight: 800, lineHeight: 1.2 }}>
          <span style={{ color: colors.engine }}>Container</span> = an isolated process sharing one kernel.
        </div>
      </Appear>
      <Appear enter={60}>
        <div style={{ marginTop: 70, fontSize: 36, color: colors.muted }}>Made with Structura · system design, explained</div>
      </Appear>
    </AbsoluteFill>
  )
}

// ─── Timeline ──────────────────────────────────────────────────────────────

const SCENES: Scene[] = [
  [Title, 120, null],
  [Problem, 210, 'problem'],
  [VmStack, 570, 'vm'],
  [ContainerStack, 540, 'containers'],
  [Compare, 420, 'compare'],
  [WhenToUse, 360, 'when'],
  [Workflow, 300, 'workflow'],
  [Outro, 120, null],
]

export const duration = (voice: VideoProps['voice']) => totalFrames(VIDEO, narration, SCENES, voice)

export function DockerVsVm({ voice }: VideoProps) {
  return <Timeline video={VIDEO} narration={narration} scenes={SCENES} voice={voice} />
}
