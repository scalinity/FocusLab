import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Line2NodeMaterial,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
} from 'three/webgpu'
import { abs, float, fract, fwidth, max, smoothstep, uv, vec2, vec3 } from 'three/tsl'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { Aperture } from '../optics/aperture'
import type { Lens } from '../optics/thinLens'
import { BENCH_LAYER } from './benchModel'
import { focusSheet, rayBundle, toRig, type Bundle, type Subject } from './geometry'

/** HDR line colours (linear), bright enough to bloom: near, in focus, far. */
export const BUNDLE_COLORS = [
  new Color(0.212 * 2.6, 0.768 * 2.6, 2.6),
  new Color(2.4, 2.45, 2.6),
  new Color(2.6, 1.2, 0.24),
]
export const BUNDLE_CSS = ['#7fe3ff', '#f2f5ff', '#ffb454']

const OBJECT_RAYS = 6
const IMAGE_RAYS = 12

interface BundleLines {
  object: LineSegments2
  solid: LineSegments2
  dashed: LineSegments2
  ring: LineSegments2
}

function lineMaterial(color: Color, dashed: boolean, width: number): Line2NodeMaterial {
  return new Line2NodeMaterial({
    color,
    linewidth: width,
    dashed,
    dashSize: 0.006,
    gapSize: 0.005,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  })
}

const flat = (pairs: Array<[{ x: number; y: number; z: number }, { x: number; y: number; z: number }]>): number[] => {
  const out: number[] = []
  for (const [a, b] of pairs) out.push(a.x, a.y, a.z, b.x, b.y, b.z)
  return out
}

function setSegments(line: LineSegments2, positions: number[]): void {
  line.visible = positions.length > 0
  if (!line.visible) return
  const geo = new LineSegmentsGeometry()
  geo.setPositions(positions)
  line.geometry.dispose()
  line.geometry = geo
  if ((line.material as Line2NodeMaterial).dashed) line.computeLineDistances()
}

/** Glowing translucent sheet with a grid, cyan, double-sided. */
function sheetMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  })
  const cells = uv().mul(vec2(18, 12))
  const d = abs(fract(cells.sub(0.5)).sub(0.5)).div(fwidth(cells))
  const grid = float(1).sub(smoothstep(0, 1, d.x.min(d.y)))
  const e = uv().sub(0.5).abs().mul(2)
  const edge = smoothstep(0.985, 1, max(e.x, e.y))
  const glow = float(0.025).add(grid.mul(0.22)).add(edge.mul(1.2))
  m.colorNode = vec3(0.212, 0.768, 1).mul(glow)
  return m
}

export interface RayView {
  group: Group
  bundles: Bundle[]
  /** Rig-local label anchor on the sheet (left edge, axis height), or null without a sheet. */
  sheetAnchor: number[] | null
  update(lens: Lens, ap: Aperture, subjects: Subject[]): void
  dispose(): void
}

export function createRayView(): RayView {
  const group = new Group()
  group.name = 'rays'
  const lines: BundleLines[] = BUNDLE_COLORS.map((c) => ({
    object: new LineSegments2(new LineSegmentsGeometry(), lineMaterial(c.clone().multiplyScalar(0.35), false, 0.9)),
    solid: new LineSegments2(new LineSegmentsGeometry(), lineMaterial(c.clone().multiplyScalar(0.6), false, 1)),
    dashed: new LineSegments2(new LineSegmentsGeometry(), lineMaterial(c.clone().multiplyScalar(0.6), true, 1.2)),
    ring: new LineSegments2(new LineSegmentsGeometry(), lineMaterial(c, false, 2.2)),
  }))
  for (const l of lines) group.add(l.object, l.solid, l.dashed, l.ring)

  const sheet = new Mesh(new PlaneGeometry(1, 1), sheetMaterial())
  sheet.renderOrder = 10
  group.add(sheet)
  group.traverse((o) => o.layers.set(BENCH_LAYER))

  const view: RayView = {
    group,
    bundles: [],
    sheetAnchor: null,
    update(lens, ap, subjects) {
      view.bundles = []
      subjects.forEach((s, i) => {
        const rig = { ...s, position: toRig(s.position) }
        const b = rayBundle(lens, ap, rig, IMAGE_RAYS)
        const l = lines[i]
        if (b === null) {
          for (const line of [l.object, l.solid, l.dashed, l.ring]) line.visible = false
          return
        }
        view.bundles.push(b)
        const objectRays = b.objectRays.filter((_, j) => j % (IMAGE_RAYS / OBJECT_RAYS) === 0)
        setSegments(l.object, flat(objectRays))
        setSegments(l.solid, flat(b.imageRays.map((r) => [r.from, r.to])))
        setSegments(
          l.dashed,
          flat(b.imageRays.filter((r) => r.past !== null).map((r) => [r.to, r.past!])),
        )
        setSegments(l.ring, flat(b.ring.map((p, j) => [p, b.ring[(j + 1) % b.ring.length]])))
      })

      const s = focusSheet(lens)
      sheet.visible = s !== null
      view.sheetAnchor = null
      if (s !== null) {
        sheet.scale.set(s.halfW * 2, s.halfH * 2, 1)
        sheet.position.set(0, 0, s.z)
        view.sheetAnchor = [-s.halfW, 0, s.z]
      }
    },
    dispose() {
      for (const l of lines) {
        for (const line of [l.object, l.solid, l.dashed, l.ring]) {
          line.geometry.dispose()
          ;(line.material as Line2NodeMaterial).dispose()
        }
      }
      sheet.geometry.dispose()
      ;(sheet.material as MeshBasicNodeMaterial).dispose()
    },
  }
  return view
}
