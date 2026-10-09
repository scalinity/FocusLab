import { BufferAttribute, BufferGeometry, Mesh, MeshStandardNodeMaterial } from 'three/webgpu'
import { cos, mix, mx_noise_float, normalMap, positionWorld, sin, smoothstep, texture, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { focusContour } from '../../render/focusContour'
import type { PbrSet } from './assets'
import { fbm } from './noise'

/**
 * Ground height (m) at world (x, z). Flat under the tripod so the near
 * subjects sit where they are placed, gently rolling in the middle distance,
 * larger relief far away.
 */
export function groundHeight(x: number, z: number): number {
  const d = Math.hypot(x, z)
  const near = Math.min(1, Math.max(0, (d - 2) / 8))
  const far = Math.min(1, Math.max(0, (d - 25) / 60))
  return fbm(x * 0.09, z * 0.09, 4, 3) * 0.35 * near + fbm(x * 0.012, z * 0.012, 3, 9) * 5 * far
}

const RADIUS = 400
const GRID = 300

/** A grid whose spacing grows with distance: ~0.15 m near the camera, metres far away. */
function terrainGeometry(): BufferGeometry {
  const map = (u: number): number => RADIUS * (0.12 * u + 0.88 * u * Math.abs(u) * Math.abs(u))
  const pos = new Float32Array((GRID + 1) * (GRID + 1) * 3)
  let k = 0
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const x = map((i / GRID) * 2 - 1)
      const z = map((j / GRID) * 2 - 1)
      pos[k++] = x
      pos[k++] = groundHeight(x, z)
      pos[k++] = z
    }
  }
  const index: number[] = []
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * (GRID + 1) + i
      index.push(a, a + GRID + 1, a + 1, a + 1, a + GRID + 1, a + GRID + 2)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

const rotate = (p: Node<'vec2'>, a: number): Node<'vec2'> => vec2(p.x.mul(cos(a)).sub(p.y.mul(sin(a))), p.x.mul(sin(a)).add(p.y.mul(cos(a))))

/**
 * Forest floor: two leaf-litter sets in large patches, moss in between, each
 * sampled twice at different scales and rotations and blended by noise so the
 * texture never visibly tiles.
 */
export function createTerrain(litterA: PbrSet, litterB: PbrSet, moss: PbrSet): Mesh {
  const m = new MeshStandardNodeMaterial()
  const w = positionWorld.xz
  const patches = smoothstep(-0.25, 0.25, mx_noise_float(vec3(w.mul(0.11), 1)))
  const antiTile = smoothstep(-0.3, 0.3, mx_noise_float(vec3(w.mul(0.45), 2)))
  const mossy = smoothstep(0.2, 0.55, mx_noise_float(vec3(w.mul(0.23), 5)))

  const sample = (set: PbrSet, scale: number, angle: number) => {
    const uv1 = rotate(w, angle).div(scale)
    const uv2 = rotate(w, angle + 1.7).div(scale * 1.37).add(0.31)
    const pick = (tex: PbrSet['color']) => mix(texture(tex, uv1), texture(tex, uv2), antiTile)
    return { color: pick(set.color).rgb, normal: pick(set.normal).rgb, rough: pick(set.roughness).r }
  }
  const a = sample(litterA, 1.9, 0.2)
  const b = sample(litterB, 2.3, 1.1)
  const c = sample(moss, 1.2, 2.3)
  m.colorNode = mix(mix(a.color, b.color, patches), c.color.mul(vec3(0.85, 1, 0.8)), mossy)
  m.normalNode = normalMap(mix(mix(a.normal, b.normal, patches), c.normal, mossy), vec2(1.2))
  m.roughnessNode = mix(mix(a.rough, b.rough, patches), c.rough, mossy).mul(0.95)
  m.emissiveNode = focusContour()
  const mesh = new Mesh(terrainGeometry(), m)
  mesh.receiveShadow = true
  mesh.name = 'terrain'
  return mesh
}
