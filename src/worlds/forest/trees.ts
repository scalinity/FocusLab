import {
  DoubleSide,
  Group,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu'
import { color, float, mix, normalMap, positionLocal, smoothstep, texture, uv, vec2 } from 'three/tsl'
import { Tree } from '../../../vendor/ez-tree/index.js'
import { LENS_WORLD } from '../../bench/geometry'
import { focusContour } from '../../render/focusContour'
import type { PbrSet } from './assets'
import { rng } from './noise'
import { batch } from './batch'
import { groundHeight } from './terrain'

/**
 * The forest's trees: ez-tree skeletons for a few deciduous species, each
 * meshed at three levels of detail from one skeleton (identical silhouettes,
 * so a level change never pops), batched across the forest and culled per tree
 * for every view (see batch.ts). The tripod never moves, so each instance's
 * level is fixed by its distance once.
 */

/** ez-tree units → metres (its large oak trunk is ~48 units). */
const UNIT = 0.42

/** Generous bounds of the large presets at UNIT, m, for keeping the sun's path clear. */
const TREE_HEIGHT = 22
const CROWN_RADIUS = 9

const SPECIES = [
  { preset: 'Oak Large', seeds: [11, 23] },
  { preset: 'Ash Large', seeds: [5, 41] },
  { preset: 'Aspen Large', seeds: [7] },
]

const LODS = [
  { maxDistance: 35, detail: {} },
  { maxDistance: 90, detail: { sectionStride: 3, segmentFactor: 0.6, leafStride: 2, leafScale: 1.3 } },
  { maxDistance: Infinity, detail: { sectionStride: 6, segmentFactor: 0.4, leafStride: 4, leafScale: 1.8, billboard: 'single' as const } },
]

interface Variant {
  lods: Array<{ branches: BufferGeometry; leaves: BufferGeometry }>
}

function buildVariant(preset: string, seed: number): Variant {
  const tree = new Tree()
  tree.loadPreset(preset)
  tree.options.seed = seed
  // Cards carry a cluster of nine beech leaves: smaller cards, more of them.
  tree.options.leaves.size *= 0.45
  tree.options.leaves.count = Math.round(tree.options.leaves.count * 1.8)
  tree.generate()
  return {
    lods: LODS.map((l) => {
      const g = tree.createGeometry(l.detail)
      g.branches.scale(UNIT, UNIT, UNIT)
      g.leaves.scale(UNIT, UNIT, UNIT)
      return g
    }),
  }
}

export function barkMaterial(bark: PbrSet, moss: PbrSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  const t = uv().mul(vec2(1, 0.35))
  // Moss climbs the lower trunk.
  const mossy = smoothstep(2.2, 0.3, positionLocal.y).mul(0.75)
  m.colorNode = mix(texture(bark.color, t).rgb, texture(moss.color, t.mul(2)).rgb.mul(0.85), mossy)
  m.normalNode = normalMap(texture(bark.normal, t), vec2(1.4))
  m.roughnessNode = texture(bark.roughness, t).r
  m.aoNode = bark.ao ? texture(bark.ao, t).r : float(1)
  m.emissiveNode = focusContour()
  return m
}

function leafMaterial(leaves: PbrSet & { opacity: PbrSet['color'] | null }): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, alphaTest: 0.5 })
  const leaf = texture(leaves.color, uv())
  m.colorNode = leaf.rgb.mul(color(0.92, 1, 0.82))
  m.opacityNode = leaves.opacity ? texture(leaves.opacity, uv()).r : leaf.a
  m.normalNode = normalMap(texture(leaves.normal, uv()))
  m.roughnessNode = texture(leaves.roughness, uv()).r.mul(0.9)
  m.emissiveNode = focusContour()
  return m
}

export interface TreePlacement {
  x: number
  z: number
  /** Index into the variant list. */
  variant: number
  scale: number
  rotation: number
}

/**
 * Trees across the forest, kept clear of the near field and of each other,
 * and out of the low sun's path to the composed foreground: a gap in the
 * canopy lets the sun reach it, as a photographer would choose the spot.
 * Anything within a crown's reach of that ray, short of where the ray
 * clears the treetops, would shade the foreground.
 */
export function placeTrees(seed: number, sun: Vector3): TreePlacement[] {
  const variantCount = SPECIES.reduce((n, s) => n + s.seeds.length, 0)
  const rand = rng(seed)
  const out: TreePlacement[] = []
  const minGap = 6
  const flat = Math.hypot(sun.x, sun.z)
  const [hx, hz, rise] = [sun.x / flat, sun.z / flat, sun.y / flat]
  const lit = { x: LENS_WORLD.x, z: LENS_WORLD.z - 1.5 }
  for (let tries = 0; tries < 20000 && out.length < 420; tries++) {
    const x = (rand() * 2 - 1) * 220
    const z = 30 - rand() * 260
    const d = Math.hypot(x, z)
    const scale = 0.8 + rand() * 0.45
    if (d < 9) continue
    if (out.some((t) => Math.hypot(t.x - x, t.z - z) < minGap)) continue
    const along = (x - lit.x) * hx + (z - lit.z) * hz
    const across = Math.abs((x - lit.x) * hz - (z - lit.z) * hx)
    if (along > 0 && along * rise < TREE_HEIGHT * scale && across < CROWN_RADIUS * scale) continue
    out.push({ x, z, variant: Math.floor(rand() * variantCount), scale, rotation: rand() * Math.PI * 2 })
  }
  return out
}

export function createTrees(
  bark: PbrSet,
  moss: PbrSet,
  leaves: PbrSet & { opacity: PbrSet['color'] | null },
  placements: TreePlacement[],
): Group {
  const group = new Group()
  group.name = 'trees'
  const variants: Variant[] = []
  for (const s of SPECIES) for (const seed of s.seeds) variants.push(buildVariant(s.preset, seed))
  const barkMat = barkMaterial(bark, moss)
  const leafMat = leafMaterial(leaves)

  // Geometry k = variant · LODS.length + level; each tree's level is fixed by its distance.
  const branchGeometries = variants.flatMap((v) => v.lods.map((l) => l.branches))
  const leafGeometries = variants.flatMap((v) => v.lods.map((l) => l.leaves))
  const branches: Array<{ geometry: number; matrix: Matrix4 }> = []
  const nearLeaves: typeof branches = []
  const farLeaves: typeof branches = []
  const q = new Quaternion()
  const up = new Vector3(0, 1, 0)
  for (const p of placements) {
    const level = LODS.findIndex((l) => Math.hypot(p.x, p.z) <= l.maxDistance)
    const geometry = p.variant * LODS.length + level
    q.setFromAxisAngle(up, p.rotation)
    const matrix = new Matrix4().compose(new Vector3(p.x, groundHeight(p.x, p.z) - 0.15, p.z), q, new Vector3().setScalar(p.scale))
    branches.push({ geometry, matrix })
    ;(level < 2 ? nearLeaves : farLeaves).push({ geometry, matrix })
  }
  // The farthest level's leaves are billboards and cast no shadow.
  const far = batch(leafGeometries, farLeaves, leafMat)
  far.castShadow = false
  group.add(batch(branchGeometries, branches, barkMat), batch(leafGeometries, nearLeaves, leafMat), far)
  return group
}
