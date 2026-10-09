import { Group, InstancedMesh, Matrix4, Quaternion, Vector3, type Mesh } from 'three/webgpu'
import { LENS_WORLD } from '../../bench/geometry'
import { fbm, rng } from './noise'
import { groundHeight } from './terrain'
import type { TreePlacement } from './trees'

/**
 * Ferns over the forest floor in patches, so the ground between the trees is
 * broken up as a woodland floor is. A jittered grid whose cells grow with
 * distance (density falls where the ferns are small in frame), masked by
 * low-frequency noise into clumps, kept to a wedge a little wider than the
 * widest lens sees. Instanced per variant: the ferns lie within the view, so
 * culling them per fern would only add draws.
 */

const L = LENS_WORLD
const NEAREST = 2
const FARTHEST = 80
/** Ferns farther than this (m) cast no shadow. */
const SHADOWS_TO = 20

/** Ground the composed foreground owns, and the tree trunks. */
function clear(x: number, z: number, trees: TreePlacement[]): boolean {
  const d = L.z - z
  const dx = x - L.x
  if (Math.hypot(dx, d - 1.7) < 1.1) return false // anemone drift
  if (Math.hypot(dx + 0.35, d - 3.24) < 0.45) return false // trunk at 3 m
  if (Math.abs(d - 7.2) < 0.45 && Math.abs(dx - 0.5) < 2.3) return false // fallen log
  return trees.every((t) => Math.hypot(t.x - x, t.z - z) > 0.6 + 0.5 * t.scale)
}

export function createUndergrowth(ferns: Mesh[], trees: TreePlacement[]): Group {
  const group = new Group()
  group.name = 'undergrowth'
  const rand = rng(31)
  const spots: Array<{ p: Vector3; variant: number }> = []
  for (let d = NEAREST; d < FARTHEST; ) {
    const cell = 0.5 + 0.035 * d
    const half = 0.9 * d + 2
    for (let x = -half; x < half; x += cell) {
      const px = L.x + x + rand() * cell
      const pz = L.z - d - rand() * cell
      if (fbm(px * 0.12, pz * 0.12, 3, 21) < 0.05 || !clear(px, pz, trees)) continue
      spots.push({ p: new Vector3(px, groundHeight(px, pz), pz), variant: Math.floor(rand() * ferns.length) })
    }
    d += cell
  }

  const q = new Quaternion()
  const tilt = new Quaternion()
  const up = new Vector3(0, 1, 0)
  ferns.forEach((fern, vi) => {
    const mine = spots.filter((s) => s.variant === vi)
    const matrices = mine.map((s) => {
      q.setFromAxisAngle(up, rand() * Math.PI * 2)
      tilt.setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), rand() * 0.15)
      return new Matrix4().compose(s.p, tilt.multiply(q), new Vector3().setScalar(0.75 + rand() * 0.7))
    })
    // Beyond SHADOWS_TO a fern's shadow is too small to see; it would cost
    // its triangles once more in every shadow cascade.
    for (const near of [true, false]) {
      const band = matrices.filter((_, i) => (Math.hypot(mine[i].p.x - L.x, mine[i].p.z - L.z) <= SHADOWS_TO) === near)
      if (band.length === 0) continue
      const mesh = new InstancedMesh(fern.geometry, fern.material, band.length)
      band.forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.castShadow = near
      mesh.receiveShadow = true
      group.add(mesh)
    }
  })
  console.info(`[forest] undergrowth: ${spots.length} ferns`)
  return group
}
