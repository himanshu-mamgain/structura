/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Draws the link-preview card (1200 × 630) for every topic, public/og/<id>.jpg, plus the site's
// own, public/og/default.jpg: the title and blurb on Warm Paper, with the first three boxes of
// the topic's diagram hand-drawn underneath. scripts/prerender.tsx points each topic page's
// og:image at its card. Like the videos, the cards are made locally and committed.
//
//   npm run og -w @structura/web              (every topic without a card)
//   npm run og -w @structura/web -- --all     (redraw them all)
//   npm run og -w @structura/web -- aws-vpc   (just these)
//
// Needs Playwright's Chromium (installed in Claude's cloud sessions; elsewhere
// `npx playwright install chromium`) and the Inter font.
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { Boxes } from 'lucide-react'
import { edgeSketch, INK, nodeSketch, shapeOf, type SketchPath } from '../src/diagram/sketch'
import { AREA_ICON } from '../src/shell/areaIcons'
import { STATIC_TOPICS, type StaticTopic } from '../src/topics'
import { areaById, AREA_OF, AREAS, type AreaId } from '../src/topics/areas'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../public/og')

// The area colours from features.css (.area-is-<id>).
const AREA_COLOR: Record<AreaId, string> = { development: '#3f5fa8', infra: '#a55a1f', databases: '#1d6f86', ai: '#a23e72' }
const LEVEL_COLOR: Record<string, [string, string]> = {
  Beginner: ['rgba(52, 211, 153, 0.16)', '#2f7a55'],
  Intermediate: ['rgba(250, 204, 21, 0.18)', '#8a6100'],
  Advanced: ['rgba(248, 113, 113, 0.17)', '#b4443a'],
}

interface Box {
  id: string
  label: string
  shape: string
  color: string
}

/** The topic's first box and the two it leads to, following the arrows, so the strip reads as a flow. */
function strip(t: StaticTopic): { boxes: Box[]; labels: string[] } {
  const { nodes, edges } = t.architecture
  const path = [nodes[0]]
  const labels: string[] = []
  while (path.length < 3) {
    const last = path[path.length - 1]
    const edge = edges.find((e) => e.from === last.id && !path.some((n) => n.id === e.to))
    const next = edge && nodes.find((n) => n.id === edge.to)
    if (!edge || !next) break
    path.push(next)
    labels.push(edge.label ?? '')
  }
  // Nothing to follow: the first three boxes, unconnected.
  if (path.length < 3) return { boxes: nodes.slice(0, 3), labels: [] }
  return { boxes: path, labels }
}

const W = 1200
const H = 630
const BOX_W = 304
const BOX_H = 78
const GAP = (W - 2 * 72 - 3 * BOX_W) / 2
const BOX_Y = 480

function Strip({ boxes, labels }: { boxes: Box[]; labels: string[] }) {
  const paths: SketchPath[] = []
  boxes.forEach((b, i) => {
    const x = 72 + i * (BOX_W + GAP)
    paths.push(...nodeSketch(`og-${b.id}`, shapeOf(b.shape, b.color), x, BOX_Y, BOX_W, BOX_H, INK[b.color] ?? INK.grey))
    if (i < boxes.length - 1 && labels.length) {
      const x1 = x + BOX_W + 8
      const x2 = x + BOX_W + GAP - 8
      const y = BOX_Y + BOX_H / 2
      paths.push(...edgeSketch(`og-${b.id}-arrow`, `M${x1},${y} C${x1 + 20},${y - 6} ${x2 - 20},${y + 6} ${x2},${y}`, { x: x2, y }, { x: x2 - 20, y: y + 6 }, INK[b.color] ?? INK.grey, false))
    }
  })
  return (
    <>
      <svg className="strip" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.strokeWidth} strokeLinecap="round" opacity={p.kind === 'fill' ? 0.28 : 1} />
        ))}
      </svg>
      {boxes.map((b, i) => (
        <div key={b.id} className="box-label" style={{ left: 72 + i * (BOX_W + GAP), top: BOX_Y, width: BOX_W, height: BOX_H }}>
          {b.label}
        </div>
      ))}
    </>
  )
}

function Card({ kicker, title, blurb, boxes, labels }: { kicker: JSX.Element; title: string; blurb: string; boxes: Box[]; labels: string[] }) {
  return (
    <div className="card">
      <div className="brand">
        <span className="mark">
          <Boxes size={26} color="#fff" />
        </span>
        Structura
        <span className="url">structura-web.netlify.app</span>
      </div>
      <div className="kicker">{kicker}</div>
      <h1>{title}</h1>
      <p>{blurb}</p>
      <Strip boxes={boxes} labels={labels} />
    </div>
  )
}

function Pill({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return (
    <span className="pill" style={{ color, background: bg, borderColor: `${color}55` }}>
      {children}
    </span>
  )
}

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; }
.card { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; padding: 56px 72px 0; color: #292d32;
  font-family: Inter, sans-serif;
  background:
    linear-gradient(rgba(119,115,107,0.07) 1px, transparent 1px) 0 0 / 36px 36px,
    linear-gradient(90deg, rgba(119,115,107,0.07) 1px, transparent 1px) 0 0 / 36px 36px,
    #f7f5ef; }
.card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 10px; background: #557c72; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 800; letter-spacing: -0.01em; }
.mark { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #557c72, #46685f); }
.url { margin-left: auto; color: #77736b; font-size: 22px; font-weight: 500; }
.kicker { display: flex; gap: 12px; margin-top: 34px; }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border: 1.5px solid; border-radius: 999px; font-size: 21px; font-weight: 700; }
h1 { margin: 18px 0 0; font-size: 62px; line-height: 1.08; letter-spacing: -0.025em; font-weight: 800;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; text-wrap: balance; }
p { margin: 16px 0 0; max-width: 1000px; color: #5f5b54; font-size: 27px; line-height: 1.38;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.strip { position: absolute; inset: 0; pointer-events: none; }
.box-label { position: absolute; display: flex; align-items: center; justify-content: center; padding: 0 22px;
  font-size: 21px; font-weight: 700; text-align: center; line-height: 1.2; }
`

function html(card: JSX.Element) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${renderToStaticMarkup(card)}</body></html>`
}

const args = process.argv.slice(2)
const all = args.includes('--all')
const only = args.filter((a) => !a.startsWith('--'))
const topics = STATIC_TOPICS.filter((t) => (only.length ? only.includes(t.id) : all || !existsSync(join(out, `${t.id}.jpg`))))

mkdirSync(out, { recursive: true })
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })

async function shoot(card: JSX.Element, file: string) {
  await page.setContent(html(card), { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(out, file), type: 'jpeg', quality: 80 })
}

for (const t of topics) {
  const area = AREA_OF[t.id]
  const Icon = AREA_ICON[area]
  const [bg, fg] = LEVEL_COLOR[t.difficulty]
  const kicker = (
    <>
      <Pill color={AREA_COLOR[area]} bg={`${AREA_COLOR[area]}18`}>
        <Icon size={20} /> {areaById(area).title}
      </Pill>
      <Pill color={fg} bg={bg}>
        {t.difficulty}
      </Pill>
    </>
  )
  await shoot(<Card kicker={kicker} title={t.title} blurb={t.blurb} {...strip(t)} />, `${t.id}.jpg`)
}

if (all || only.length === 0 || !existsSync(join(out, 'default.jpg'))) {
  const kicker = (
    <>
      {AREAS.map((a) => {
        const Icon = AREA_ICON[a.id]
        return (
          <Pill key={a.id} color={AREA_COLOR[a.id]} bg={`${AREA_COLOR[a.id]}18`}>
            <Icon size={20} /> {a.title}
          </Pill>
        )
      })}
    </>
  )
  const boxes: Box[] = [
    { id: 'users', label: 'Users', shape: 'ellipse', color: 'blue' },
    { id: 'lb', label: 'Load Balancer', shape: 'rectangle', color: 'violet' },
    { id: 'db', label: 'Database', shape: 'rectangle', color: 'green' },
  ]
  await shoot(
    <Card kicker={kicker} title="Learn system design by seeing it work" blurb="Hand-drawn architectures you can click, short lessons in simple English, walkthroughs, videos and interview questions." boxes={boxes} labels={['HTTPS', 'SQL']} />,
    'default.jpg',
  )
}

await browser.close()
console.log(`og: ${topics.length} topic cards`)
