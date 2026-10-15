import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ComponentStats } from '../sim/engine'
import type { Board } from './store'
import type { BoardEdge, BoardNode, Bounds } from './types'

// The look follows map-style traffic explainers: a mid-grey world, light
// low-poly buildings, dark roads whose edges glow green when traffic flows and
// red when it jams, little cars (requests) with blue pins, and callout cards.

// Board units (the old canvas pixels) to world units.
const SCALE = 1 / 80
const BUILDING_HEIGHT = 1.1
const TABLE_HEIGHT = 0.18
const MAX_EXTRA_HEIGHT = 2.2
const MAX_CARS = 700
const DEFAULT_ROAD_WIDTH = 0.42
const CAR_SPEED = 2.4 // world units per second on a free road
const PIN_EVERY = 4 // one car in this many carries a pin
const MAX_QUEUE_CARS = 18
// Out-of-focus geometry during a walkthrough: faded, but still clearly there.
const DIMMED = 0.25
// Zoomed out beyond this camera distance, arrow labels hide to keep the view readable.
const EDGE_LABEL_DISTANCE = 24

const SKY_TOP = '#454a52'
const SKY_BOTTOM = '#25282d'
const GROUND = 0x3b3e45
const ROAD = 0x1a1c21
const BUILDING = 0xe4e7ec
const PIN = 0x3b82f6

// Role colours (from the diagram), used for the buildings' roof caps.
const PALETTE: Record<string, number> = {
  black: 0x9aa0aa,
  grey: 0x9aa0aa,
  'light-violet': 0xc4b5fd,
  violet: 0x8b5cf6,
  blue: 0x3b82f6,
  'light-blue': 0x7dd3fc,
  yellow: 0xfacc15,
  orange: 0xf97316,
  green: 0x22c55e,
  'light-green': 0x86efac,
  'light-red': 0xfca5a5,
  red: 0xef4444,
  white: 0xe5e7eb,
}

const GREEN = new THREE.Color(0x34d399)
const AMBER = new THREE.Color(0xf59e0b)
const RED = new THREE.Color(0xef4444)
const IDLE_GLOW = new THREE.Color(0x34d399).multiplyScalar(0.8)
const CAR_COLORS = [0xf3f4f6, 0xe5e7eb, 0xd1d5db, 0xf9fafb, 0x9ca3af].map((c) => new THREE.Color(c))

/** Green when relaxed, amber past 70% busy, red when saturated. */
export function loadColor(utilization: number, out = new THREE.Color()): THREE.Color {
  if (utilization < 0.7) return out.copy(GREEN).lerp(AMBER, utilization / 0.7)
  return out.copy(AMBER).lerp(RED, Math.min(1, (utilization - 0.7) / 0.25))
}

/** How fast traffic moves into a component this busy: free below 60%, crawling when saturated. */
const flowSpeed = (utilization: number | undefined) =>
  utilization === undefined ? 1 : 1 - 0.88 * THREE.MathUtils.smoothstep(utilization, 0.6, 1)

export interface HoverInfo {
  label: string
  stats: ComponentStats | null
  x: number
  y: number
}

interface NodeView {
  node: BoardNode
  group: THREE.Group
  body: THREE.Mesh
  cap: THREE.Mesh
  ring: THREE.Mesh
  materials: THREE.MeshStandardMaterial[]
  ringMaterial: THREE.MeshBasicMaterial
  /** A table's columns, printed on its top face (tables only). */
  face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null
  faceText: string
  label: CSS2DObject
  callout: CSS2DObject
  queue: THREE.InstancedMesh
  pos: THREE.Vector2
  height: number
  targetHeight: number
  stats: ComponentStats | null
}

interface EdgeView {
  edge: BoardEdge
  from: NodeView
  to: NodeView
  group: THREE.Group
  materials: THREE.Material[]
  glow: THREE.MeshBasicMaterial
  label: CSS2DObject | null
  curve: THREE.QuadraticBezierCurve3
  length: number
  width: number
  rate: number
  carry: number
}

interface Car {
  edge: EdgeView
  t: number
  color: THREE.Color
  pinned: boolean
  lane: number
}

/** A flat ribbon following a curve: a road, or one of its glowing edges. */
function ribbon(curve: THREE.Curve<THREE.Vector3>, width: number, offset = 0, y = 0, segments = 32): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const point = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const side = new THREE.Vector3()
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    curve.getPoint(t, point)
    curve.getTangent(t, tangent)
    side.set(-tangent.z, 0, tangent.x).normalize()
    for (const s of [-1, 1]) {
      const d = offset + (s * width) / 2
      positions.push(point.x + side.x * d, y, point.z + side.z * d)
    }
    if (i < segments) {
      const k = i * 2
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** A small low-poly car, nose pointing along +x. */
function carGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.2, 0.07, 0.11).translate(0, 0.055, 0)
  const cabin = new THREE.BoxGeometry(0.1, 0.06, 0.09).translate(-0.015, 0.115, 0)
  return mergeGeometries([body, cabin])!
}

function bodyGeometry(shape: string, table: boolean): THREE.BufferGeometry {
  if (table) return new RoundedBoxGeometry(1, 1, 1, 2, 0.04)
  switch (shape) {
    case 'ellipse':
    case 'cloud':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 24)
    case 'diamond':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 4).rotateY(Math.PI / 4)
    case 'hexagon':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 6)
    default:
      return new RoundedBoxGeometry(1, 1, 1, 3, 0.06)
  }
}

const roleColor = (node: BoardNode) => PALETTE[node.color] ?? 0x9aa0aa

/**
 * A database table's columns, printed onto its slab so the text zooms with the
 * world (HTML labels stay one size and pile up when zoomed out).
 */
function tableTexture(lines: string[], w: number, h: number, maxAnisotropy: number): THREE.CanvasTexture {
  // Board units are roughly canvas pixels at the size the layout measured; draw at 2x for sharpness.
  const scale = Math.min(2, 2048 / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#f8fafc'
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, 10)
  ctx.fill()
  ctx.fillStyle = '#1e293b'
  ctx.beginPath()
  ctx.roundRect(0, 0, w, 34, [10, 10, 0, 0])
  ctx.fill()
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 18px ${mono}`
  ctx.fillText(lines[0] ?? '', 16, 18)
  ctx.font = `17px ${mono}`
  lines.slice(1).forEach((line, i) => {
    ctx.fillStyle = line.startsWith('index') ? '#6b7280' : '#1f2937'
    ctx.fillText(line, 16, 34 + 13 + i * 26)
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = maxAnisotropy
  return texture
}

function skyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, 0, 256)
  gradient.addColorStop(0, SKY_TOP)
  gradient.addColorStop(1, SKY_BOTTOM)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 2, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * The board in 3D. It follows the board: new boxes rise as buildings, moved
 * ones glide, walkthrough focus dims the rest, and load-test results make busy
 * components grow and glow, roads jam, and callout cards appear.
 */
export class BoardScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly labels = new CSS2DRenderer()
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 800)
  private readonly controls: OrbitControls
  private readonly nodes = new Map<string, NodeView>()
  private edges: EdgeView[] = []
  /** Road width per edge id: busier roads are wider. */
  private readonly roadWidths = new Map<string, number>()
  private readonly frameGroup = new THREE.Group()
  private readonly cars: Car[] = []
  private readonly carMesh: THREE.InstancedMesh
  private readonly pinMesh: THREE.InstancedMesh
  private readonly floor: THREE.Mesh
  private readonly sun: THREE.DirectionalLight
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly resize: ResizeObserver
  private readonly clock = new THREE.Clock()
  private frameCount = 0
  private readonly matrix = new THREE.Matrix4()
  private readonly quaternion = new THREE.Quaternion()
  private readonly temp = new THREE.Vector3()
  private readonly tangent = new THREE.Vector3()
  private readonly carScale = new THREE.Vector3(1, 1, 1)
  private readonly xAxis = new THREE.Vector3(1, 0, 0)
  private readonly unsubscribe: () => void
  private lastFit: Board['fit'] = null
  private cameraGoal: { position: THREE.Vector3; target: THREE.Vector3 } | null = null
  private pointerDown = { x: 0, y: 0 }

  constructor(
    private readonly host: HTMLElement,
    private readonly board: Board,
    /** Screen pixels covered by side panels, so framing leaves room for them. */
    private readonly insets: () => { left: number; right: number; top: number; bottom: number },
    private readonly onHover: (info: HoverInfo | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    host.appendChild(this.renderer.domElement)
    this.labels.domElement.className = 'scene-labels'
    host.appendChild(this.labels.domElement)

    this.scene.background = skyTexture()
    this.scene.fog = new THREE.Fog(0x2c2f35, 45, 190)
    this.scene.add(new THREE.HemisphereLight(0xf1f5ff, 0x2a2d33, 1.25))
    this.sun = new THREE.DirectionalLight(0xffffff, 1.9)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004
    this.scene.add(this.sun, this.sun.target)

    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1 }))
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = -0.01
    this.floor.receiveShadow = true
    this.scene.add(this.floor, this.frameGroup)

    this.carMesh = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.5 }), MAX_CARS)
    this.carMesh.castShadow = true
    this.carMesh.count = 0
    this.carMesh.frustumCulled = false
    const pin = mergeGeometries([
      new THREE.CylinderGeometry(0.006, 0.006, 0.32, 6).translate(0, 0.3, 0),
      new THREE.SphereGeometry(0.055, 14, 10).translate(0, 0.48, 0),
    ])!
    this.pinMesh = new THREE.InstancedMesh(pin, new THREE.MeshStandardMaterial({ color: PIN, emissive: PIN, emissiveIntensity: 0.35 }), MAX_CARS)
    this.pinMesh.count = 0
    this.pinMesh.frustumCulled = false
    this.scene.add(this.carMesh, this.pinMesh)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2.3
    // The user takes over the camera: stop any automatic framing.
    this.controls.addEventListener('start', () => (this.cameraGoal = null))
    this.camera.position.set(0, 10, 18)

    const el = this.renderer.domElement
    el.addEventListener('pointermove', this.handlePointerMove)
    el.addEventListener('pointerleave', this.handleLeave)
    el.addEventListener('pointerdown', this.handlePointerDown)
    el.addEventListener('pointerup', this.handlePointerUp)
    this.resize = new ResizeObserver(() => this.fitSize())
    this.resize.observe(host)
    this.fitSize()

    this.unsubscribe = board.subscribe(() => this.sync())
    this.sync(true)
    this.renderer.setAnimationLoop(() => this.tick())
  }

  // ─── Following the board ────────────────────────────────────────────────

  private sync(initial = false) {
    const page = this.board.page
    const seen = new Set<string>()
    for (const node of page.nodes) {
      seen.add(node.id)
      const view = this.nodes.get(node.id)
      if (!view) this.addNode(node, initial)
      else this.updateNode(view, node)
    }
    for (const [id, view] of this.nodes) {
      if (!seen.has(id)) this.removeNode(id, view)
    }

    this.rebuildFrames()
    this.rebuildEdges()
    this.applyStats()
    this.applyHighlight()
    this.updateWorld()

    if (this.board.fit && this.board.fit !== this.lastFit) {
      this.lastFit = this.board.fit
      this.flyTo(this.board.fit.bounds, this.board.fit.margin, initial)
    } else if (initial) {
      const bounds = this.board.contentBounds()
      if (bounds) this.flyTo(bounds, 80, true)
    }
  }

  private addNode(node: BoardNode, instant: boolean) {
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: BUILDING, roughness: 0.6, transparent: true })
    const capMaterial = new THREE.MeshStandardMaterial({ color: roleColor(node), roughness: 0.45, transparent: true })
    const ringMaterial = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0, depthWrite: false })
    const body = new THREE.Mesh(bodyGeometry(node.shape, !!node.table), bodyMaterial)
    body.castShadow = true
    body.receiveShadow = true
    body.userData.nodeId = node.id
    const cap = new THREE.Mesh(bodyGeometry(node.shape, !!node.table), capMaterial)
    cap.userData.nodeId = node.id
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 48), ringMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    const group = new THREE.Group()
    group.add(body, cap, ring)

    const label = new CSS2DObject(document.createElement('div'))
    label.center.set(0.5, 1)
    const callout = new CSS2DObject(document.createElement('div'))
    callout.center.set(0.5, 1)
    callout.visible = false
    const queue = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ color: 0xd1d5db }), MAX_QUEUE_CARS)
    queue.count = 0
    queue.castShadow = true
    this.scene.add(group, label, callout, queue)

    const height = node.table ? TABLE_HEIGHT : BUILDING_HEIGHT
    const view: NodeView = {
      node,
      group,
      body,
      cap,
      ring,
      materials: [bodyMaterial, capMaterial],
      ringMaterial,
      face: null,
      faceText: '',
      label,
      callout,
      queue,
      pos: new THREE.Vector2((node.x + node.w / 2) * SCALE, (node.y + node.h / 2) * SCALE),
      // During a live build, new buildings rise out of the ground.
      height: instant ? height : 0.01,
      targetHeight: height,
      stats: null,
    }
    this.nodes.set(node.id, view)
    this.updateNode(view, node)
  }

  private updateNode(view: NodeView, node: BoardNode) {
    const reshaped = view.node.shape !== node.shape || !!view.node.table !== !!node.table
    view.node = node
    if (reshaped) {
      for (const mesh of [view.body, view.cap]) {
        mesh.geometry.dispose()
        mesh.geometry = bodyGeometry(node.shape, !!node.table)
      }
    }
    ;(view.materials[1] as THREE.MeshStandardMaterial).color.setHex(roleColor(node))
    const el = view.label.element as HTMLDivElement
    if (node.table) {
      // Tables print their columns on their top face; the pill keeps the name
      // readable when zoomed out.
      view.label.visible = true
      el.className = 'scene-label is-table-name'
      el.textContent = node.table.lines[0] ?? node.label
      const text = `${node.w}x${node.h}:${node.table.lines.join('\n')}`
      if (text !== view.faceText) {
        view.faceText = text
        if (view.face) {
          view.face.material.map?.dispose()
          view.face.material.dispose()
          view.group.remove(view.face)
        }
        const material = new THREE.MeshBasicMaterial({
          map: tableTexture(node.table.lines, node.w, node.h, this.renderer.capabilities.getMaxAnisotropy()),
          transparent: true,
        })
        view.face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
        view.face.rotation.x = -Math.PI / 2
        view.face.userData.nodeId = node.id
        view.group.add(view.face)
      }
    } else {
      view.label.visible = true
      el.className = 'scene-label'
      el.textContent = node.label
    }
  }

  private removeNode(id: string, view: NodeView) {
    this.scene.remove(view.group, view.label, view.callout, view.queue)
    view.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    view.materials.forEach((m) => m.dispose())
    view.ringMaterial.dispose()
    view.face?.material.map?.dispose()
    view.face?.material.dispose()
    view.label.element.remove()
    view.callout.element.remove()
    this.nodes.delete(id)
  }

  private rebuildFrames() {
    for (const child of [...this.frameGroup.children]) {
      this.frameGroup.remove(child)
      child.traverse((o) => {
        ;(o as THREE.Mesh).geometry?.dispose()
        ;((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose?.()
        if (o instanceof CSS2DObject) o.element.remove()
      })
    }
    for (const frame of this.board.page.frames) {
      const w = frame.w * SCALE
      const d = frame.h * SCALE
      // A slightly raised plaza for each group (a service boundary, client vs server…).
      const plaza = new THREE.Mesh(
        new RoundedBoxGeometry(w, 0.06, d, 2, 0.03),
        new THREE.MeshStandardMaterial({ color: 0x3a3e46, roughness: 0.95, transparent: true }),
      )
      plaza.position.set((frame.x + frame.w / 2) * SCALE, 0.0, (frame.y + frame.h / 2) * SCALE)
      plaza.receiveShadow = true
      plaza.userData.frameId = frame.id
      const label = new CSS2DObject(Object.assign(document.createElement('div'), { className: 'scene-frame-label', textContent: frame.label }))
      label.position.set(-w / 2 + 0.25, 0.08, -d / 2 + 0.3)
      label.center.set(0, 0.5)
      plaza.add(label)
      this.frameGroup.add(plaza)
    }
  }

  private rebuildEdges() {
    for (const view of this.edges) {
      this.scene.remove(view.group)
      view.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
      view.materials.forEach((m) => m.dispose())
      view.label?.element.remove()
    }
    const old = new Map(this.edges.map((e) => [e.edge.id, e]))
    this.edges = []
    for (const edge of this.board.page.edges) {
      const from = this.nodes.get(edge.from)
      const to = this.nodes.get(edge.to)
      if (!from || !to) continue
      const view = this.makeRoad(edge, from, to, this.roadWidths.get(edge.id) ?? DEFAULT_ROAD_WIDTH)
      if (!view) continue
      const previous = old.get(edge.id)
      if (previous) {
        view.rate = previous.rate
        view.carry = previous.carry
      }
      this.edges.push(view)
    }
    // Cars on roads that no longer exist disappear; the rest move to the rebuilt road.
    const byId = new Map(this.edges.map((e) => [e.edge.id, e]))
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const road = byId.get(this.cars[i].edge.edge.id)
      if (road) this.cars[i].edge = road
      else this.cars.splice(i, 1)
    }
  }

  private makeRoad(edge: BoardEdge, from: NodeView, to: NodeView, width: number): EdgeView | null {
    const center = (n: BoardNode) => new THREE.Vector3((n.x + n.w / 2) * SCALE, 0, (n.y + n.h / 2) * SCALE)
    const start = center(from.node)
    const end = center(to.node)
    const direction = end.clone().sub(start)
    const fullLength = direction.length()
    if (fullLength < 1e-6) return null
    direction.normalize()
    // Start and end at the buildings' edges rather than their centres.
    const halfExtent = (n: BoardNode) =>
      Math.min(
        Math.abs(direction.x) > 1e-6 ? ((n.w * SCALE) / 2) * 0.8 / Math.abs(direction.x) : Infinity,
        Math.abs(direction.z) > 1e-6 ? ((n.h * SCALE) / 2) * 0.8 / Math.abs(direction.z) : Infinity,
      )
    const a = start.clone().addScaledVector(direction, Math.min(halfExtent(from.node) + 0.1, fullLength * 0.4))
    const b = end.clone().addScaledVector(direction, -Math.min(halfExtent(to.node) + 0.25, fullLength * 0.4))
    // A gentle curve; the two directions between the same buildings bend to opposite sides.
    const bend = (edge.from < edge.to ? 1 : -1) * Math.min(0.12 * a.distanceTo(b), 1.2)
    const side = new THREE.Vector3(-direction.z, 0, direction.x)
    const control = a.clone().lerp(b, 0.5).addScaledVector(side, bend)
    const curve = new THREE.QuadraticBezierCurve3(a, control, b)

    const asphalt = new THREE.MeshStandardMaterial({ color: ROAD, roughness: 0.9, transparent: true, opacity: edge.dashed ? 0.7 : 1 })
    const glow = new THREE.MeshBasicMaterial({ color: IDLE_GLOW, transparent: true, depthWrite: false })
    const laneMarks = new THREE.LineDashedMaterial({ color: 0x9ca3af, dashSize: 0.12, gapSize: 0.12, transparent: true, opacity: 0.6 })
    const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x9ca3af, transparent: true })
    const group = new THREE.Group()
    const road = new THREE.Mesh(ribbon(curve, width, 0, 0.012), asphalt)
    road.receiveShadow = true
    const edgeWidth = 0.06
    const leftGlow = new THREE.Mesh(ribbon(curve, edgeWidth, -width / 2 - edgeWidth / 2, 0.016), glow)
    const rightGlow = new THREE.Mesh(ribbon(curve, edgeWidth, width / 2 + edgeWidth / 2, 0.016), glow)
    const centerLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40).map((p) => p.setY(0.02))), laneMarks)
    centerLine.computeLineDistances()
    // A chevron at the end shows which way traffic flows.
    const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 3), arrowMaterial)
    curve.getTangent(1, this.tangent)
    chevron.position.copy(b).setY(0.05)
    chevron.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.tangent)
    group.add(road, leftGlow, rightGlow, centerLine, chevron)

    let label: CSS2DObject | null = null
    if (edge.label) {
      label = new CSS2DObject(Object.assign(document.createElement('div'), { className: 'scene-edge-label', textContent: edge.label }))
      curve.getPoint(0.5, label.position)
      label.position.y = 0.25
      group.add(label)
    }
    this.scene.add(group)
    return {
      edge,
      from,
      to,
      group,
      materials: [asphalt, glow, laneMarks, arrowMaterial],
      glow,
      label,
      curve,
      length: curve.getLength(),
      width,
      rate: 0.6,
      carry: Math.random(),
    }
  }

  private updateWorld() {
    const bounds = this.board.contentBounds()
    const cx = bounds ? (bounds.x + bounds.w / 2) * SCALE : 0
    const cz = bounds ? (bounds.y + bounds.h / 2) * SCALE : 0
    const span = Math.max(bounds ? Math.max(bounds.w, bounds.h) * SCALE : 0, 12)
    this.floor.position.set(cx, -0.01, cz)
    this.floor.scale.set(span * 8, span * 8, 1)
    this.sun.position.set(cx + span * 0.35, span * 0.8, cz + span * 0.5)
    this.sun.target.position.set(cx, 0, cz)
    Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, far: span * 4 })
    this.sun.shadow.camera.updateProjectionMatrix()
  }

  // ─── Load-test results, selection and walkthrough focus ─────────────────

  private applyStats() {
    const { stats, baseline } = this.board
    for (const view of this.nodes.values()) {
      const key = view.node.label.toLowerCase()
      const s = view.node.table ? null : (stats?.get(key) ?? null)
      view.stats = s
      view.targetHeight = view.node.table ? TABLE_HEIGHT : BUILDING_HEIGHT + (s ? Math.min(1, s.utilization) * MAX_EXTRA_HEIGHT : 0)
      if (s) loadColor(s.utilization, view.ringMaterial.color)
      view.ringMaterial.opacity = s ? 0.9 : 0

      if (!view.node.table) {
        const el = view.label.element as HTMLDivElement
        el.textContent = view.node.label
        el.classList.toggle('is-hot', !!s && s.utilization > 0.9)
      }

      // A callout card for components under real pressure, compared with usual.
      const usual = baseline?.get(key)
      const show = !!s && s.utilization >= 0.7
      view.callout.visible = show
      if (show && s) {
        const el = view.callout.element as HTMLDivElement
        el.className = `scene-callout${s.utilization > 0.95 ? ' is-hot' : ''}`
        el.replaceChildren(
          Object.assign(document.createElement('strong'), { textContent: `${Math.round(s.utilization * 100)}%` }),
          Object.assign(document.createElement('span'), { textContent: 'busy' }),
          Object.assign(document.createElement('small'), {
            textContent: usual ? `usual here: ${Math.round(usual.utilization * 100)}%` : s.meanQueue >= 1 ? `${Math.round(s.meanQueue)} waiting` : '',
          }),
        )
      }
      this.setQueue(view, s ? s.meanQueue : 0)
    }

    // Road traffic: the requests into its destination, shared among the roads
    // that lead there; buildings without stats (decisions) pass on their
    // source's traffic. Busier roads are wider and carry more cars.
    const incoming = new Map<NodeView, number>()
    for (const edge of this.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    const raw = this.edges.map((edge) => {
      const through = edge.to.stats?.throughputPerS ?? edge.from.stats?.throughputPerS
      return through === undefined ? 0 : through / (incoming.get(edge.to) ?? 1)
    })
    const busiest = Math.max(0, ...raw)
    const rates = new Map<string, number>()
    let widthChanged = false
    this.edges.forEach((edge, i) => {
      const share = busiest > 0 ? raw[i] / busiest : 0
      rates.set(edge.edge.id, stats && busiest > 0 ? (raw[i] > 0 ? Math.max(0.3, share * 9) : 0) : 0.6)
      const width = stats && busiest > 0 ? 0.3 + 0.45 * Math.sqrt(share) : DEFAULT_ROAD_WIDTH
      if (Math.abs(width - (this.roadWidths.get(edge.edge.id) ?? DEFAULT_ROAD_WIDTH)) > 0.02) widthChanged = true
      this.roadWidths.set(edge.edge.id, width)
    })
    // Road geometry depends on width, so rebuild once if traffic changed it.
    if (widthChanged) this.rebuildEdges()
    for (const edge of this.edges) {
      edge.rate = rates.get(edge.edge.id) ?? 0.6
      const utilization = edge.to.stats?.utilization
      if (stats && utilization !== undefined) loadColor(utilization, edge.glow.color)
      else edge.glow.color.copy(IDLE_GLOW)
    }
  }

  private applyHighlight() {
    const { focus, selection } = this.board
    const page = this.board.page
    for (const view of this.nodes.values()) {
      const visible = !focus || focus.has(view.node.id)
      for (const material of view.materials) {
        material.opacity = visible ? 1 : DIMMED
        material.depthWrite = visible
      }
      if (view.face) view.face.material.opacity = visible ? 1 : DIMMED
      const selected = selection.has(view.node.id)
      view.materials[0].emissive.setHex(selected ? 0x4f46e5 : 0x000000)
      view.materials[0].emissiveIntensity = selected ? 0.35 : 0
      view.label.element.classList.toggle('is-dimmed', !visible)
      view.label.element.classList.toggle('is-selected', selected)
      view.callout.element.classList.toggle('is-dimmed', !visible)
    }
    for (const view of this.edges) {
      // Roads stay lit when both ends are in focus (or the walkthrough named them).
      const visible = !focus || focus.has(view.edge.id) || (focus.has(view.edge.from) && focus.has(view.edge.to))
      view.materials.forEach((m, i) => (m.opacity = (visible ? 1 : DIMMED) * (i === 2 ? 0.6 : i === 0 && view.edge.dashed ? 0.7 : 1)))
      view.label?.element.classList.toggle('is-dimmed', !visible)
    }
    for (const plaza of this.frameGroup.children as THREE.Mesh[]) {
      const id = plaza.userData.frameId as string
      const visible = !focus || page.nodes.some((n) => n.group === id && focus.has(n.id))
      ;(plaza.material as THREE.MeshStandardMaterial).opacity = visible ? 1 : DIMMED
      plaza.children.forEach((child) => {
        if (child instanceof CSS2DObject) child.element.classList.toggle('is-dimmed', !visible)
      })
    }
  }

  /** Cars waiting in line in front of a busy component (log scale). */
  private setQueue(view: NodeView, meanQueue: number) {
    view.queue.count = meanQueue < 0.05 ? 0 : Math.min(MAX_QUEUE_CARS, Math.ceil(Math.log2(1 + meanQueue) * 3))
  }

  // ─── Camera ──────────────────────────────────────────────────────────────

  /** Glides the camera to frame `bounds` in the space between the side panels. */
  private flyTo(bounds: Bounds, margin: number, instant: boolean) {
    const w = (bounds.w + margin * 2) * SCALE
    const d = (bounds.h + margin * 2) * SCALE
    const center = new THREE.Vector3((bounds.x + bounds.w / 2) * SCALE, 0, (bounds.y + bounds.h / 2) * SCALE)
    const aspect = this.camera.aspect || 1
    const fov = THREE.MathUtils.degToRad(this.camera.fov)
    // The content must fit the part of the screen not covered by the panels.
    const width = this.host.clientWidth || 1
    const height = this.host.clientHeight || 1
    const covered = this.insets()
    const left = Math.min(covered.left, width / 2) / width
    const right = Math.min(covered.right, width / 2) / width
    const top = Math.min(covered.top, height / 3) / height
    const bottom = Math.min(covered.bottom, height * 0.6) / height
    const usable = Math.max(0.3, 1 - left - right)
    const usableHeight = Math.max(0.3, 1 - top - bottom)
    const fit = Math.max(w / (aspect * usable), (d * 1.5) / usableHeight) / (2 * Math.tan(fov / 2))
    const distance = Math.max(4, fit * 1.12)
    const visibleHeight = 2 * distance * Math.tan(fov / 2)
    const visibleWidth = visibleHeight * aspect
    // Shift the view so the content sits centred in the uncovered part. On the
    // ground, a screen-height step is longer by 1 / sin(camera elevation).
    const elevation = Math.atan2(0.55, 0.84)
    const target = center
      .clone()
      .add(new THREE.Vector3(((right - left) / 2) * visibleWidth, 0, (((bottom - top) / 2) * visibleHeight) / Math.sin(elevation)))
    // A low, cinematic angle, like a drone shot over a city.
    const position = target.clone().add(new THREE.Vector3(0, distance * 0.55, distance * 0.84))
    if (instant) {
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      this.cameraGoal = null
    } else {
      this.cameraGoal = { position, target }
    }
  }

  private fitSize() {
    const { clientWidth: w, clientHeight: h } = this.host
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.labels.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ─── Animation ───────────────────────────────────────────────────────────

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1)
    const now = performance.now()
    if (this.cameraGoal) {
      const k = Math.min(1, dt * 2.6)
      this.camera.position.lerp(this.cameraGoal.position, k)
      this.controls.target.lerp(this.cameraGoal.target, k)
      if (this.camera.position.distanceTo(this.cameraGoal.position) < 0.01) this.cameraGoal = null
    }
    this.controls.update()
    const cameraDistance = this.camera.position.distanceTo(this.controls.target)
    this.labels.domElement.classList.toggle('is-far', cameraDistance > EDGE_LABEL_DISTANCE)
    // Cars grow when zoomed out, so traffic stays visible from far away.
    this.carScale.setScalar(THREE.MathUtils.clamp(cameraDistance / 14, 1, 3))

    for (const view of this.nodes.values()) {
      const n = view.node
      const k = Math.min(1, dt * 5)
      view.pos.lerp(new THREE.Vector2((n.x + n.w / 2) * SCALE, (n.y + n.h / 2) * SCALE), k)
      view.height += (view.targetHeight - view.height) * Math.min(1, dt * 4)
      const footprint = n.table ? 0.95 : 0.9
      const fx = n.w * SCALE * footprint
      const fz = n.h * SCALE * footprint
      const capHeight = n.table ? 0.03 : 0.08
      view.group.position.set(view.pos.x, 0, view.pos.y)
      view.body.scale.set(fx, view.height, fz)
      view.body.position.y = view.height / 2
      view.cap.scale.set(fx * 1.02, capHeight, fz * 1.02)
      view.cap.position.y = view.height + capHeight / 2
      view.ring.scale.set(Math.max(fx, fz) * 1.25, Math.max(fx, fz) * 1.25, 1)
      const top = view.height + capHeight
      if (view.face) {
        view.face.scale.set(fx * 0.98, fz * 0.98, 1)
        view.face.position.y = top + 0.003
      }
      view.label.position.set(view.pos.x, n.table ? top + 0.05 : top + 0.35, view.pos.y)
      view.callout.position.set(view.pos.x, top + 1.1, view.pos.y)
      if (view.stats && view.stats.utilization > 0.9) {
        // Saturated components pulse.
        view.ringMaterial.opacity = 0.55 + 0.4 * Math.sin(now / 160)
      }
      const queued = view.queue.count
      if (queued) {
        const front = view.pos.y + fz / 2 + 0.35
        for (let i = 0; i < queued; i++) {
          this.matrix.makeTranslation(view.pos.x - 0.5 + (i % 6) * 0.22, 0, front + Math.floor(i / 6) * 0.16)
          view.queue.setMatrixAt(i, this.matrix)
        }
        view.queue.instanceMatrix.needsUpdate = true
      }
    }

    const focus = this.board.focus
    for (const edge of this.edges) {
      edge.carry += edge.rate * dt
      while (edge.carry >= 1 && this.cars.length < MAX_CARS) {
        edge.carry -= 1
        this.cars.push({
          edge,
          t: 0,
          color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
          pinned: this.cars.length % PIN_EVERY === 0,
          lane: Math.random() < 0.5 ? -1 : 1,
        })
      }
      edge.carry = Math.min(edge.carry, 1)
    }

    let shownCars = 0
    let shownPins = 0
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i]
      const road = car.edge
      // Cars crawl on roads into a saturated component: traffic visibly jams.
      const speed = CAR_SPEED * flowSpeed(road.to.stats?.utilization)
      car.t += (speed * dt) / Math.max(road.length, 0.1)
      if (car.t >= 1) {
        this.cars.splice(i, 1)
        continue
      }
      // During a walkthrough, only roads in focus carry traffic.
      if (focus && !(focus.has(road.edge.id) || (focus.has(road.edge.from) && focus.has(road.edge.to)))) continue
      road.curve.getPoint(car.t, this.temp)
      road.curve.getTangent(car.t, this.tangent)
      // Keep to a lane on either side of the centre line.
      const laneOffset = (road.width / 4) * car.lane
      this.temp.x += -this.tangent.z * laneOffset
      this.temp.z += this.tangent.x * laneOffset
      this.temp.y = 0.015
      this.quaternion.setFromUnitVectors(this.xAxis, this.tangent.setY(0).normalize())
      this.matrix.compose(this.temp, this.quaternion, this.carScale)
      this.carMesh.setMatrixAt(shownCars, this.matrix)
      this.carMesh.setColorAt(shownCars, car.color)
      shownCars++
      if (car.pinned) {
        this.pinMesh.setMatrixAt(shownPins++, this.matrix)
      }
    }
    this.carMesh.count = shownCars
    this.pinMesh.count = shownPins
    this.carMesh.instanceMatrix.needsUpdate = true
    this.pinMesh.instanceMatrix.needsUpdate = true
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true

    this.renderer.render(this.scene, this.camera)
    this.labels.render(this.scene, this.camera)
    if (++this.frameCount % 6 === 0) this.declutter()
  }

  /**
   * Hides labels that would overlap a more important one, like a map does when
   * zoomed out: selected and in-focus buildings first, then busy ones, then the
   * biggest. Arrow labels give way to building labels.
   */
  private declutter() {
    const placed: DOMRect[] = []
    const overlaps = (r: DOMRect) => placed.some((p) => r.left < p.right + 4 && r.right > p.left - 4 && r.top < p.bottom + 2 && r.bottom > p.top - 2)
    const views = [...this.nodes.values()].filter((v) => v.label.visible)
    const rank = (v: NodeView) => {
      const el = v.label.element
      return (
        (el.classList.contains('is-selected') ? 4e6 : 0) +
        (el.classList.contains('is-dimmed') ? 0 : 2e6) +
        (v.stats && v.stats.utilization > 0.9 ? 1e6 : 0) +
        v.node.w * v.node.h
      )
    }
    views.sort((a, b) => rank(b) - rank(a))
    for (const view of views) {
      const el = view.label.element
      const r = el.getBoundingClientRect()
      const crowded = r.width > 0 && overlaps(r)
      el.classList.toggle('is-crowded', crowded)
      if (!crowded && r.width > 0) placed.push(r)
    }
    for (const edge of this.edges) {
      const el = edge.label?.element
      if (!el) continue
      const r = el.getBoundingClientRect()
      const crowded = r.width > 0 && overlaps(r)
      el.classList.toggle('is-crowded', crowded)
      if (!crowded && r.width > 0) placed.push(r)
    }
  }

  // ─── Pointer ─────────────────────────────────────────────────────────────

  private pick(event: PointerEvent): NodeView | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const meshes = [...this.nodes.values()].flatMap((n) => (n.face ? [n.body, n.cap, n.face] : [n.body, n.cap]))
    const hit = this.raycaster.intersectObjects(meshes)[0]
    return hit ? this.nodes.get(hit.object.userData.nodeId as string) : undefined
  }

  private handlePointerMove = (event: PointerEvent) => {
    const view = this.pick(event)
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.renderer.domElement.style.cursor = view ? 'pointer' : ''
    this.onHover(view ? { label: view.node.label, stats: view.stats, x: event.clientX - rect.left, y: event.clientY - rect.top } : null)
  }

  private handleLeave = () => this.onHover(null)

  private handlePointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY }
  }

  /** A click (not a drag to orbit) selects a building; Shift adds to the selection. */
  private handlePointerUp = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 5) return
    const view = this.pick(event)
    const current = new Set(this.board.selection)
    if (!view) {
      if (current.size) this.board.setSelection([])
      return
    }
    if (event.shiftKey) {
      if (current.has(view.node.id)) current.delete(view.node.id)
      else current.add(view.node.id)
      this.board.setSelection(current)
    } else {
      this.board.setSelection([view.node.id])
    }
  }

  dispose() {
    this.unsubscribe()
    this.renderer.setAnimationLoop(null)
    this.resize.disconnect()
    this.controls.dispose()
    const el = this.renderer.domElement
    el.removeEventListener('pointermove', this.handlePointerMove)
    el.removeEventListener('pointerleave', this.handleLeave)
    el.removeEventListener('pointerdown', this.handlePointerDown)
    el.removeEventListener('pointerup', this.handlePointerUp)
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    })
    ;(this.scene.background as THREE.Texture | null)?.dispose()
    this.renderer.dispose()
    el.remove()
    this.labels.domElement.remove()
  }
}
