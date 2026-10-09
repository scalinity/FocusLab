import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Path,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Shape,
  ShapeGeometry,
  Vector2,
  type BufferGeometry,
  type Texture,
} from 'three/webgpu'
import { texture, uv, vec2 } from 'three/tsl'
import { apertureDiameter, sensorDistance } from '../optics/thinLens'
import { apertureOutline } from '../optics/aperture'
import { N_D, singletFor } from '../optics/glass'
import { closeFocusDistance, maxSensorDistance } from '../optics/travel'
import { metresToMm, mmToMetres } from '../optics/world'
import type { Settings } from '../state/store'
import {
  LENS_HEIGHT_M,
  RING_DISTANCES_M,
  barrelRadiusMm,
  imagePlane,
  imageScale,
  ringAngle,
  ringMarkAngle,
} from './geometry'

/**
 * The magnified camera on its optical bench, in rig-local metres (lens centre
 * at the origin, image space along +z). Rear focusing: the lens stays where
 * the tripod holds it and the image-plane carriage moves along the rail,
 * which is optically identical to moving the glass and keeps every distance
 * lens-referenced. Everything here lives on layer 1, which the viewfinder
 * camera does not render.
 */

export const BENCH_LAYER = 1

/** Ring rotation direction: distances increase clockwise seen from the front. */
const RING_DIR = 1
const INDEX_ANGLE = Math.PI / 2

export interface BenchModel {
  group: Group
  /** Pickable focus ring. */
  ring: Mesh
  /** Anchor points for labels, rig-local metres. */
  anchors: { lensTop: number[]; planeTop: number[] }
  update(o: Settings, dof: { nearM: number | null; farM: number | null }): void
  dispose(): void
}

const toRig = (mm: number, N: number): number => mmToMetres(mm * N)

function metal(color: number, roughness: number, env: Texture, envMapIntensity = 0.7): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ color, roughness, metalness: 0.85, envMap: env, envMapIntensity, side: DoubleSide })
}

function setLayer(g: Group): void {
  g.traverse((o) => o.layers.set(BENCH_LAYER))
}

/** Engraved focus scale on a strip that wraps the ring once. */
function ringTexture(f: number): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4096
  c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#0d0e11'
  g.fillRect(0, 0, c.width, c.height)
  // Knurled grip bands top and bottom.
  g.fillStyle = '#17191d'
  for (let x = 0; x < c.width; x += 16) {
    g.fillRect(x, 0, 8, 30)
    g.fillRect(x, 98, 8, 30)
  }
  const close = closeFocusDistance(f)
  const uOf = (dM: number): number => {
    const a = INDEX_ANGLE + RING_DIR * ringAngle(f, sensorDistance(f, metresToMm(dM)))
    return ((((a + Math.PI / 2) / (2 * Math.PI)) % 1) + 1) % 1
  }
  g.font = '500 30px "DM Mono", ui-monospace, monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (const dM of RING_DISTANCES_M) {
    if (metresToMm(dM) < close) continue
    const x = uOf(dM) * c.width
    g.fillStyle = dM === Infinity ? '#ffb454' : '#e9edf5'
    g.fillRect(x - 1.5, 34, 3, 14)
    // Rotated in place so the scale reads upright from behind the camera,
    // where a photographer looks down at it.
    g.save()
    g.translate(x, 70)
    g.rotate(Math.PI)
    g.fillText(dM === Infinity ? '∞' : String(dM), 0, 0)
    g.restore()
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = RepeatWrapping
  tex.anisotropy = 8
  return tex
}

/** Biconvex profile revolved about the optical axis (z). */
function elementGeometry(f: number, N: number): BufferGeometry {
  const s = singletFor(f)
  const h = s.diameter / 2
  const sag = (r: number): number => s.radius - Math.sqrt(s.radius * s.radius - r * r)
  const pts: Vector2[] = []
  const steps = 32
  for (let i = 0; i <= steps; i++) {
    const r = (h * i) / steps
    pts.push(new Vector2(toRig(r, N), toRig(-s.thickness / 2 + sag(r), N)))
  }
  for (let i = steps; i >= 0; i--) {
    const r = (h * i) / steps
    pts.push(new Vector2(toRig(r, N), toRig(s.thickness / 2 - sag(r), N)))
  }
  const geo = new LatheGeometry(pts, 96)
  geo.rotateX(Math.PI / 2)
  return geo
}

function irisGeometry(o: Settings, N: number, outerMm: number): BufferGeometry {
  const shape = new Shape()
  shape.absarc(0, 0, toRig(outerMm, N), 0, Math.PI * 2, false)
  const hole = new Path()
  const outline = apertureOutline(o.aperture, apertureDiameter(o.f, o.N), 128)
  hole.moveTo(toRig(outline[0][0], N), toRig(outline[0][1], N))
  for (let i = outline.length - 1; i > 0; i--) hole.lineTo(toRig(outline[i][0], N), toRig(outline[i][1], N))
  shape.holes.push(hole)
  return new ShapeGeometry(shape, 96)
}

export function createBenchModel(env: Texture, imageTexture: Texture): BenchModel {
  const group = new Group()
  group.name = 'bench'

  const glass = new MeshPhysicalNodeMaterial({
    transmission: 1,
    ior: N_D,
    roughness: 0.02,
    metalness: 0,
    dispersion: 2,
    attenuationColor: new Color(0.78, 0.95, 1),
    attenuationDistance: 0.6,
    envMap: env,
    envMapIntensity: 1.4,
    side: DoubleSide,
  })
  const anodised = metal(0x0a0b0d, 0.5, env, 0.35)
  const steel = metal(0x1b1e24, 0.32, env)
  const brass = metal(0xb07a35, 0.3, env)
  const rail = metal(0x24262b, 0.5, env)
  const ringMaterial = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.3, envMap: env })
  const markIndex = new MeshBasicNodeMaterial({ color: new Color(0.212 * 3, 0.768 * 3, 3) })
  const markDof = new MeshBasicNodeMaterial({ color: new Color(1.0 * 2.2, 0.46 * 2.2, 0.09 * 2.2) })

  // Image plane: the viewfinder's HDR image, rotated 180° as the lens projects it.
  const screenMaterial = new MeshBasicNodeMaterial({ side: DoubleSide })
  screenMaterial.colorNode = texture(imageTexture, vec2(uv().x.oneMinus(), uv().y.oneMinus()))

  const element = new Mesh(undefined, glass)
  const iris = new Mesh(undefined, steel)
  const barrel = new Mesh(undefined, anodised)
  const lip = new Mesh(undefined, brass)
  const ring = new Mesh(undefined, ringMaterial)
  const index = new Mesh(new BoxGeometry(1, 1, 1), markIndex)
  const dofNear = new Mesh(new BoxGeometry(1, 1, 1), markDof)
  const dofFar = new Mesh(new BoxGeometry(1, 1, 1), markDof)
  const screen = new Mesh(new PlaneGeometry(1, 1), screenMaterial)
  const frame = new Mesh(undefined, anodised)
  const carriage = new Group()
  const railBar = new Mesh(new BoxGeometry(1, 1, 1), rail)
  const posts = new Group()
  carriage.add(screen, frame)
  group.add(element, iris, barrel, lip, ring, index, dofNear, dofFar, carriage, railBar, posts)

  let builtF = 0
  let builtIris = ''
  let ringTex: CanvasTexture | null = null
  const anchors = { lensTop: [0, 0, 0], planeTop: [0, 0, 0] }

  function buildForLens(f: number): void {
    const N = imageScale(f)
    const s = singletFor(f)
    const rb = barrelRadiusMm(f)
    element.geometry.dispose()
    element.geometry = elementGeometry(f, N)

    // Barrel cutaway: the quarter facing the default view (+x, +y) is removed.
    const front = s.thickness / 2 + 0.16 * f
    const back = s.thickness / 2 + 0.1 * f
    const barrelGeo = new CylinderGeometry(toRig(rb, N), toRig(rb, N), toRig(front + back, N), 96, 1, true, Math.PI, 1.5 * Math.PI)
    barrelGeo.rotateX(Math.PI / 2)
    barrelGeo.translate(0, 0, toRig((back - front) / 2, N))
    barrel.geometry.dispose()
    barrel.geometry = barrelGeo

    const lipGeo = new CylinderGeometry(toRig(rb * 1.04, N), toRig(rb * 1.04, N), toRig(0.03 * f, N), 96, 1, true)
    lipGeo.rotateX(Math.PI / 2)
    lipGeo.translate(0, 0, -toRig(front, N))
    lip.geometry.dispose()
    lip.geometry = lipGeo

    const ringW = 0.11 * f
    const ringGeo = new CylinderGeometry(toRig(rb * 1.06, N), toRig(rb * 1.06, N), toRig(ringW, N), 192, 1, true)
    ringGeo.rotateX(Math.PI / 2)
    ring.geometry.dispose()
    ring.geometry = ringGeo
    ring.position.z = -toRig(front - ringW / 2 - 0.035 * f, N)
    ringTex?.dispose()
    ringTex = ringTexture(f)
    ringMaterial.map = ringTex
    ringMaterial.needsUpdate = true

    const markR = toRig(rb * 1.06, N)
    const markZ = ring.position.z + toRig(ringW / 2 + 0.012 * f, N)
    for (const m of [index, dofNear, dofFar]) {
      m.scale.set(toRig(0.006 * f, N), toRig(0.006 * f, N), toRig(0.018 * f, N))
      m.userData.r = markR
      m.position.z = markZ
    }

    // Rail under the whole travel, posts down to the ground.
    const railY = -toRig(rb, N) - 0.035
    const railStart = -toRig(front, N) - 0.08
    const railEnd = toRig(maxSensorDistance(f) + 0.12 * f, N) + 0.08
    railBar.scale.set(0.05, 0.022, railEnd - railStart)
    railBar.position.set(0, railY, (railStart + railEnd) / 2)
    for (const p of posts.children) (p as Mesh).geometry.dispose()
    posts.clear()
    const postH = LENS_HEIGHT_M + railY
    for (const z of [railStart + 0.05, railEnd - 0.05]) {
      const post = new Mesh(new CylinderGeometry(0.012, 0.016, postH, 16), rail)
      post.position.set(0, railY - postH / 2, z)
      posts.add(post)
    }

    // Image plane frame (fixed size: it is the sensor, magnified).
    const plane = imagePlane({ f, N: 2, si: f })
    screen.scale.set(plane.halfW * 2, plane.halfH * 2, 1)
    const border = 0.012
    const frameShape = new Shape()
    frameShape.moveTo(-plane.halfW - border, -plane.halfH - border)
    frameShape.lineTo(plane.halfW + border, -plane.halfH - border)
    frameShape.lineTo(plane.halfW + border, plane.halfH + border)
    frameShape.lineTo(-plane.halfW - border, plane.halfH + border)
    const opening = new Path()
    opening.moveTo(-plane.halfW, -plane.halfH)
    opening.lineTo(-plane.halfW, plane.halfH)
    opening.lineTo(plane.halfW, plane.halfH)
    opening.lineTo(plane.halfW, -plane.halfH)
    frameShape.holes.push(opening)
    frame.geometry.dispose()
    frame.geometry = new ShapeGeometry(frameShape)
    frame.position.z = 0.0015
    anchors.planeTop = [0, plane.halfH + border, 0]
    anchors.lensTop = [0, toRig(rb * 1.06, N) + 0.01, ring.position.z]

    setLayer(group)
    builtF = f
  }

  return {
    group,
    ring,
    anchors,
    update(o, dof) {
      if (o.f !== builtF) {
        buildForLens(o.f)
        builtIris = ''
      }
      const N = imageScale(o.f)
      const irisKey = `${o.f}|${o.N}|${o.aperture.blades}|${o.aperture.roundness}|${o.aperture.rotation}`
      if (irisKey !== builtIris) {
        iris.geometry.dispose()
        iris.geometry = irisGeometry(o, N, barrelRadiusMm(o.f) * 0.98)
        iris.position.z = toRig(singletFor(o.f).thickness / 2 + 0.03 * o.f, N)
        iris.layers.set(BENCH_LAYER)
        builtIris = irisKey
      }

      ring.rotation.z = -RING_DIR * ringAngle(o.f, o.si)
      const place = (m: Mesh, angle: number): void => {
        const r = m.userData.r as number
        m.position.x = r * Math.cos(angle)
        m.position.y = r * Math.sin(angle)
        m.rotation.z = angle
      }
      place(index, INDEX_ANGLE)
      dofNear.visible = dof.nearM !== null
      dofFar.visible = dof.farM !== null
      if (dof.nearM !== null) place(dofNear, INDEX_ANGLE + RING_DIR * ringMarkAngle(o, dof.nearM))
      if (dof.farM !== null) place(dofFar, INDEX_ANGLE + RING_DIR * ringMarkAngle(o, dof.farM))

      carriage.position.z = imagePlane(o).z
      anchors.planeTop[2] = carriage.position.z
    },
    dispose() {
      group.traverse((m) => {
        if (m instanceof Mesh) m.geometry.dispose()
      })
      for (const mat of [glass, anodised, steel, brass, rail, ringMaterial, markIndex, markDof, screenMaterial]) mat.dispose()
      ringTex?.dispose()
    },
  }
}
