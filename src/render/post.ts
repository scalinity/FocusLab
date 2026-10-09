import { AgXToneMapping, RenderPipeline, SRGBColorSpace, type Texture, type WebGPURenderer } from 'three/webgpu'
import { Fn, float, fract, max, renderOutput, sin, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'

/**
 * The viewfinder's photographic finish, applied after the depth of field (live
 * or exact) in this order: optical vignetting in linear light → bloom →
 * exposure → AgX tone mapping → film grain → output transform.
 *
 * Vignetting is the lens's own: natural cos⁴ falloff at the field angle each
 * pixel sees (from s_i, not f), plus mechanical vignetting that darkens the
 * corners wide open and has gone by f/4.
 */
export interface ViewfinderPost {
  pipeline: RenderPipeline
  /** Lens-to-sensor distance, mm. */
  si: { value: number }
  N: { value: number }
  /** Linear multiplier applied before tone mapping. */
  exposure: { value: number }
  /** Changes every frame while live; held while the photograph is shown. */
  grainSeed: { value: number }
}

export function createViewfinderPost(renderer: WebGPURenderer, image: Texture): ViewfinderPost {
  const si = uniform(50)
  const N = uniform(2)
  const exposure = uniform(1)
  const grainSeed = uniform(0)

  const graded = Fn(() => {
    const p = uv()
    const c = texture(image, p).rgb
    // Sensor position in mm (36 × 24 frame) and the field angle it sees.
    const mm = p.sub(0.5).mul(vec2(36, 24))
    const tan2 = mm.dot(mm).div(si.mul(si))
    const natural = float(1).div(tan2.add(1).mul(tan2.add(1)))
    const corner = smoothstep(0.55, 1.15, p.sub(0.5).mul(vec2(1, 2 / 3)).length().mul(2.2))
    const mechanical = float(1).sub(corner.mul(0.45).mul(float(4).sub(N).div(2.6).clamp(0, 1)))
    return vec4(c.mul(natural).mul(mechanical), 1)
  })()

  const lit = graded.add(bloom(graded, 0.18, 0.55, 1.2)).mul(exposure)
  const toned = renderOutput(lit, AgXToneMapping, SRGBColorSpace)
  // Fine grain in display space, strongest in the mid-tones like film.
  const grained = Fn(() => {
    const p = uv().mul(vec2(1731.3, 1153.7)).add(grainSeed)
    const n = fract(sin(p.dot(vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5)
    const l = toned.rgb.dot(vec3(0.299, 0.587, 0.114))
    const mid = l.mul(float(1).sub(l)).mul(4)
    return vec4(toned.rgb.add(n.mul(0.035).mul(max(mid, 0.25))), 1)
  })()

  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  pipeline.outputNode = grained
  return { pipeline, si, N, exposure, grainSeed }
}
