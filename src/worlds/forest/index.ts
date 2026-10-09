import {
  DirectionalLight,
  EquirectangularReflectionMapping,
  Group,
  Vector3,
  type DataTexture,
} from 'three/webgpu'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { LENS_WORLD, type Subject } from '../../bench/geometry'
import type { WorldSource } from '../WorldSource'
import { ambientCgSet, loadHdr, polyHavenSet } from './assets'
import { createTerrain } from './terrain'
import { createTrees } from './trees'
import { forestAtmosphere } from './atmosphere'

/**
 * The procedural forest: life-size, seen from a low tripod, lit by a
 * golden-hour HDRI with a directional sun aligned to its brightest point and
 * placed in front of the camera, so the scene is backlit.
 */

/** Sun azimuth relative to the view direction (−z), radians; negative is left. */
const SUN_AZIMUTH = -0.35

/** Direction (world, y up) of the brightest texel of an equirectangular HDR. */
function brightestDirection(hdr: DataTexture): Vector3 {
  const { data, width, height } = hdr.image as { data: ArrayLike<number>; width: number; height: number }
  const toFloat = data instanceof Uint16Array ? halfToFloat : (v: number) => v
  let best = -1
  let bi = 0
  for (let i = 0; i < width * height; i++) {
    const l = 0.2126 * toFloat(data[i * 4]) + 0.7152 * toFloat(data[i * 4 + 1]) + 0.0722 * toFloat(data[i * 4 + 2])
    if (l > best) {
      best = l
      bi = i
    }
  }
  const u = ((bi % width) + 0.5) / width
  const v = (Math.floor(bi / width) + 0.5) / height
  // three's equirectangular convention: u = atan2(z, x)/2π + 0.5, v = 0.5 − asin(y)/π (row 0 at the top).
  const phi = (u - 0.5) * 2 * Math.PI
  const lat = (0.5 - v) * Math.PI
  return new Vector3(Math.cos(lat) * Math.cos(phi), Math.sin(lat), Math.cos(lat) * Math.sin(phi))
}

/**
 * The HDRI is unclipped: its sun is thousands of times brighter than the sky.
 * Left in, it would light everything from every angle with no shadows. The
 * directional light carries the sun (with shadows), so the environment keeps
 * only the sky: texels are clamped to SUN_CLIP.
 */
const SUN_CLIP = 6

function clipSun(hdr: DataTexture): number {
  const data = (hdr.image as { data: Float32Array | Uint16Array }).data
  const half = data instanceof Uint16Array
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue
    const v = half ? halfToFloat(data[i]) : data[i]
    peak = Math.max(peak, v)
    if (v > SUN_CLIP) data[i] = half ? floatToHalf(SUN_CLIP) : SUN_CLIP
  }
  hdr.needsUpdate = true
  return peak
}

function floatToHalf(v: number): number {
  const f = new Float32Array([v])
  const x = new Uint32Array(f.buffer)[0]
  const e = ((x >> 23) & 0xff) - 127 + 15
  return ((x >> 16) & 0x8000) | (Math.max(0, Math.min(31, e)) << 10) | ((x >> 13) & 0x3ff)
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

export async function createForest(): Promise<WorldSource> {
  const [hdr, litterA, litterB, moss, bark, leaves] = await Promise.all([
    loadHdr('polyhaven/river_walk_1/river_walk_1_4k.hdr'),
    polyHavenSet('forest_leaves_02', 'diffuse'),
    polyHavenSet('leaves_forest_ground'),
    ambientCgSet('Moss002'),
    polyHavenSet('bark_brown_01'),
    ambientCgSet('LeafSet024'),
  ])
  hdr.mapping = EquirectangularReflectionMapping
  // Rotate the environment so its sun sits in front of the camera, a little left.
  // Found before clipping: afterwards every clipped texel ties for brightest.
  const sunInHdr = brightestDirection(hdr)
  const peak = clipSun(hdr)
  console.info(`[forest] HDRI peak ${peak.toFixed(0)} clipped to ${SUN_CLIP}; sun dir in HDRI ${sunInHdr.toArray().map((v) => v.toFixed(2)).join(', ')}`)
  const hdrAzimuth = Math.atan2(sunInHdr.x, -sunInHdr.z)
  const rotation = SUN_AZIMUTH - hdrAzimuth
  const elevation = Math.asin(Math.min(1, Math.max(-1, sunInHdr.y)))
  const sunDir = new Vector3(Math.sin(SUN_AZIMUTH) * Math.cos(elevation), Math.sin(elevation), -Math.cos(SUN_AZIMUTH) * Math.cos(elevation))

  const atmosphere = forestAtmosphere(sunDir, hdr, rotation)
  const root = new Group()
  root.name = 'forest'
  root.add(createTerrain(litterA, litterB, moss))
  root.add(createTrees(bark, moss, leaves))

  const sun = new DirectionalLight(0xffd2a1, 5)
  sun.position.copy(sunDir).multiplyScalar(200)
  sun.target.position.set(0, 0, -20)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.02
  sun.shadow.shadowNode = new CSMShadowNode(sun, { cascades: 3, maxFar: 180, mode: 'practical', lightMargin: 60 })
  root.add(sun, sun.target)

  const at = (name: string, x: number, y: number, d: number): Subject => ({
    name,
    position: { x: LENS_WORLD.x + x, y: LENS_WORLD.y + y, z: LENS_WORLD.z - d },
  })
  const subjects = [at('log edge', -0.06, -0.04, 0.35), at('trunk', -0.3, 0.2, 3), at('far tree', 3, 4, 40)]

  return {
    root,
    subjects,
    far: subjects[2],
    presets: [
      { name: 'Foreground', distanceM: 0.35 },
      { name: 'Middle', distanceM: 3 },
      { name: 'Background', distanceM: 40 },
    ],
    environment: hdr,
    environmentRotation: rotation,
    fog: atmosphere.fog,
    background: atmosphere.background,
    dispose() {
      hdr.dispose()
    },
  }
}
