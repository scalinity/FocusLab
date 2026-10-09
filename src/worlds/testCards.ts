import {
  CanvasTexture,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
} from 'three/webgpu'
import { abs, float, fract, fwidth, max, mix, positionWorld, smoothstep, vec3 } from 'three/tsl'
import { LENS_WORLD, type Subject } from '../bench/geometry'
import { focusContour } from '../render/focusContour'
import type { WorldSource } from './WorldSource'

/**
 * Printed test charts at the hero depths, framed from the low tripod. Each
 * card subtends about 4° and sits at a fixed direction (tan offsets from the
 * axis) so all eight are in frame at 50 mm and none hides another.
 */
const CARDS: Array<{ d: number; tx: number; ty: number }> = [
  { d: 0.35, tx: -0.25, ty: -0.13 },
  { d: 0.8, tx: -0.1, ty: 0.12 },
  { d: 1.5, tx: 0.12, ty: -0.14 },
  { d: 3, tx: -0.02, ty: 0.02 },
  { d: 7, tx: 0.22, ty: 0.06 },
  { d: 15, tx: -0.2, ty: 0.03 },
  { d: 40, tx: 0.1, ty: 0.025 },
  { d: 120, tx: -0.07, ty: 0.012 },
]
const CARD_TAN = 0.07
const FAR_CARD = 40

function label(d: number): string {
  return d < 1 ? `${Math.round(d * 100)} cm` : `${d} m`
}

function chartTexture(d: number): Texture {
  const c = document.createElement('canvas')
  c.width = 768
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = '#f1efe8'
  g.fillRect(0, 0, c.width, c.height)
  // Siemens star: 36 spoke pairs.
  const cx = 384
  const cy = 230
  const r = 190
  g.fillStyle = '#16161a'
  for (let i = 0; i < 36; i++) {
    const a0 = (i / 36) * 2 * Math.PI
    const a1 = a0 + Math.PI / 36
    g.beginPath()
    g.moveTo(cx, cy)
    g.arc(cx, cy, r, a0, a1)
    g.closePath()
    g.fill()
  }
  g.strokeStyle = '#16161a'
  g.lineWidth = 6
  g.strokeRect(14, 14, c.width - 28, c.height - 28)
  g.font = '600 46px "Outfit Variable", sans-serif'
  g.textAlign = 'center'
  g.fillText(label(d), cx, 488)
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Antialiased metre grid on dark mossy ground, 10 m lines stronger. */
function groundMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 0.95 })
  const grid = (spacing: number) => {
    const q = positionWorld.xz.div(spacing)
    const dist = abs(fract(q.sub(0.5)).sub(0.5)).div(fwidth(q))
    return float(1).sub(smoothstep(0, 1.2, dist.x.min(dist.y)))
  }
  const lines = max(grid(1).mul(0.35), grid(10))
  m.colorNode = mix(vec3(0.045, 0.06, 0.035), vec3(0.16, 0.2, 0.13), lines)
  m.emissiveNode = focusContour()
  return m
}

export function createTestCards(): WorldSource {
  const root = new Group()
  root.name = 'test cards'

  const ground = new Mesh(new PlaneGeometry(600, 600), groundMaterial())
  ground.rotation.x = -Math.PI / 2
  root.add(ground)

  const postMaterial = new MeshStandardNodeMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.3 })
  const subjects: Subject[] = []
  const textures: Texture[] = []
  for (const { d, tx, ty } of CARDS) {
    const h = CARD_TAN * d
    const w = h * 1.5
    const center = { x: LENS_WORLD.x + tx * d, y: LENS_WORLD.y + ty * d, z: LENS_WORLD.z - d }
    const tex = chartTexture(d)
    textures.push(tex)
    const material = new MeshStandardNodeMaterial({ map: tex, roughness: 0.85 })
    material.emissiveNode = focusContour()
    const card = new Mesh(new PlaneGeometry(w, h), material)
    card.position.set(center.x, center.y, center.z)
    root.add(card)

    const bottom = center.y - h / 2
    if (bottom > 0) {
      const radius = Math.max(0.002, w * 0.012)
      const post = new Mesh(new CylinderGeometry(radius, radius, bottom, 8), postMaterial)
      post.position.set(center.x, bottom / 2, center.z - 0.002)
      root.add(post)
    }
    subjects.push({ name: label(d), position: center })
  }

  root.add(new HemisphereLight(0xbfd3ff, 0x3b3226, 0.9))
  const sun = new DirectionalLight(0xffe2b8, 2.4)
  sun.position.set(-6, 9, 8)
  root.add(sun)

  return {
    root,
    subjects,
    far: subjects.find((s) => s.name === label(FAR_CARD))!,
    presets: [
      { name: 'Foreground', distanceM: 0.35 },
      { name: 'Middle', distanceM: 3 },
      { name: 'Background', distanceM: FAR_CARD },
    ],
    dispose() {
      root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose()
          ;(o.material as MeshStandardNodeMaterial).dispose()
        }
      })
      for (const t of textures) t.dispose()
    },
  }
}
