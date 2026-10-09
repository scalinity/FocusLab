import {
  Color,
  HalfFloatType,
  NodeMaterial,
  PerspectiveCamera,
  QuadMesh,
  RenderTarget,
  Vector3,
  type ComputeNode,
  type Node,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn,
  abs,
  cos,
  float,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  max,
  mix,
  mrt,
  output,
  positionView,
  screenCoordinate,
  select,
  sin,
  textureLoad,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import { sampleAperture, type Aperture } from '../optics/aperture'
import { fibonacci, halton } from '../optics/sequence'

/**
 * Exact exposure by aperture sampling (Haeberli & Akeley 1990). Each sample
 * is an ordinary pinhole render from a point on the aperture, with the
 * frustum sheared so the plane of focus stays fixed on screen, plus a
 * Halton(3,5) sub-pixel jitter. Aperture positions are a bit-reversed
 * Fibonacci lattice (see `fibonacci`), whose base-2 order would correlate
 * with Halton base 2. A compute pass adds every sample into a float32
 * storage buffer (no float blending or filtering needed). Occlusion,
 * see-through foreground blur and bokeh shape all come out right because
 * nothing is approximated: it only moves the camera.
 *
 * Shear: a camera moved by a (metres, camera frame) sees a point on the
 * plane at 1/k shifted by −a·k at unit distance, so the near-plane window
 * moves by −a·near·k. k is the focus power in 1/m: 0 at infinity (pure
 * translation), negative past it.
 *
 * Aperture cells: N samples leave a point source as N separate dots in the
 * pattern of the samples (a pinwheel for R2 on a disc) wherever its blur is
 * wider than the dots are apart. Each sample stands for a cell of the
 * aperture of radius ≈ 1/√N of it, so each pass is blurred by that share of
 * the blur, ~|c|/(2√N) (CELL_REACH): a small occlusion-aware gather (nearer samples spread
 * over farther ones, never the reverse) with a pattern turned every pass.
 * It vanishes on the plane of focus and as N grows, so the exposure still
 * converges to the same integral.
 */

class ApertureCamera extends PerspectiveCamera {
  readonly window = { left: -1, right: 1, top: 1, bottom: -1 }

  override updateProjectionMatrix(): void {
    // The base constructor calls this before the `window` field is initialised.
    if (this.window === undefined) return super.updateProjectionMatrix()
    const w = this.window
    this.projectionMatrix.makePerspective(w.left, w.right, w.top, w.bottom, this.near, this.far, this.coordinateSystem, this.reversedDepth)
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert()
  }
}

export interface SampleOptics {
  /** Focus power, 1/m. */
  kPerM: number
  /** Aperture radius, m (area-equivalent). */
  apertureRadiusM: number
  aperture: Aperture
  /** tan of half the field of view: 18/s_i and 12/s_i. */
  tanW: number
  tanH: number
  /** c_px = cocScalePx · (kPerM − 1/d) at the render width. */
  cocScalePx: number
  /** Samples the exposure will hold when developed. */
  samples: number
}

/** Taps of the aperture-cell gather, and its reach in px. */
const CELL_TAPS = 24
const CELL_MAX = 8
/**
 * Cell radius in equal-area cells. R2 on a disc is a spiral lattice whose gaps
 * between arms are wider than an equal-area cell; 1.5 of it closes them.
 */
const CELL_REACH = 1.5
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const CELL_PATTERN = Array.from({ length: CELL_TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / CELL_TAPS)
  return [r * Math.cos(i * GOLDEN_ANGLE), r * Math.sin(i * GOLDEN_ANGLE)]
})

export interface ExposureEngine {
  /** HDR image the viewfinder shows (live or the developing exposure). */
  image: RenderTarget
  resize(width: number, height: number): void
  /** Renders and accumulates samples [start, start + count). */
  renderSamples(scene: Scene, base: PerspectiveCamera, o: SampleOptics, start: number, count: number): void
  /**
   * Writes `image` as a mix of the live frame and the exposure (0 → 1). With
   * `split` (0…1) the live frame fills the left of that line and the exposure
   * the right, to show where the live approximation departs from the truth.
   */
  resolve(fade: number, split?: number | null): void
  readAccumulation(): Promise<{ data: Float32Array; width: number; height: number }>
  dispose(): void
}

export function createExposureEngine(renderer: WebGPURenderer, liveTexture: Texture): ExposureEngine {
  let W = 0
  let H = 0
  const sample = new RenderTarget(1, 1, { type: HalfFloatType, count: 2 })
  sample.textures[0].name = 'output'
  // Not 'depth': three treats an MRT output with that name as the fragment depth (r186).
  sample.textures[1].name = 'viewZ'
  const sampleMRT = mrt({ output, viewZ: vec4(positionView.z.negate(), 0, 0, 1) })
  // Pixels no geometry covers are infinitely far.
  sampleMRT.setClearColor('viewZ', new Color(65504, 0, 0))
  const image = new RenderTarget(1, 1, { type: HalfFloatType })
  const width = uniform(1, 'uint')
  const height = uniform(1, 'uint')
  const first = uniform(1, 'uint')
  const fade = uniform(0)
  const splitX = uniform(-1)
  const kPerM = uniform(0)
  const cocScale = uniform(0)
  /** CELL_REACH/(2√N): the share of the blur one sample's cell spans, as a radius. */
  const cellShare = uniform(0)
  /** Turn of the gather pattern for this pass, radians. */
  const spin = uniform(0)

  let accum = instancedArray(1, 'vec4')
  let accumulate: ComputeNode | null = null
  const resolveMaterial = new NodeMaterial()
  const resolveQuad = new QuadMesh(resolveMaterial)

  const camera = new ApertureCamera()
  const right = new Vector3()
  const up = new Vector3()
  const fwd = new Vector3()

  function build(): void {
    accum = instancedArray(W * H, 'vec4')
    const buffer = accum
    accumulate = Fn(() => {
      const i = instanceIndex
      const p = ivec2(int(i.mod(width)), int(i.div(width)))
      const last = vec2(float(width).sub(1), float(height).sub(1))
      const cell = (z: Node<'float'>) => abs(cocScale.mul(kPerM.sub(float(1).div(z)))).mul(cellShare).min(CELL_MAX)
      const zp = textureLoad(sample.textures[1], p).r
      const rp = cell(zp)
      const wp = float(1).div(max(rp.mul(rp).mul(Math.PI), 1))
      const sum = textureLoad(sample.textures[0], p).rgb.mul(wp).toVar()
      const weight = wp.toVar()
      const cs = cos(spin)
      const sn = sin(spin)
      for (const [x, y] of CELL_PATTERN) {
        const o = vec2(cs.mul(x).sub(sn.mul(y)), sn.mul(x).add(cs.mul(y))).mul(CELL_MAX)
        const q = ivec2(vec2(p).add(o).round().clamp(vec2(0), last))
        const zq = textureLoad(sample.textures[1], q).r
        const rq = cell(zq)
        const dist = o.length()
        // A sample's cell spreads over farther surfaces, and over nearer ones only within their own cell.
        const reaches = dist.lessThanEqual(rq).and(zq.lessThanEqual(zp).or(dist.lessThanEqual(rp)))
        const w = select(reaches, float(1).div(max(rq.mul(rq).mul(Math.PI), 1)), float(0))
        sum.addAssign(textureLoad(sample.textures[0], q).rgb.mul(w))
        weight.addAssign(w)
      }
      const c = vec4(sum.div(weight), 1)
      const slot = buffer.element(i)
      slot.assign(select(first.equal(1), c, slot.add(c)))
    })().compute(W * H, [64])

    resolveMaterial.fragmentNode = Fn(() => {
      const p = ivec2(screenCoordinate.xy)
      const a = buffer.element(p.y.mul(int(width)).add(p.x))
      const exact = a.rgb.div(a.w.max(1))
      const live = textureLoad(liveTexture, p).rgb
      const t = select(splitX.lessThan(0), fade, select(float(p.x).lessThan(splitX), float(0), float(1)))
      // The exposure only stands in where it has samples.
      return vec4(mix(live, exact, t.mul(select(a.w.greaterThan(0), float(1), float(0)))), 1)
    })()
    resolveMaterial.needsUpdate = true
  }

  return {
    image,
    resize(w, h) {
      if (w === W && h === H) return
      W = w
      H = h
      for (const t of [sample, image]) t.setSize(w, h)
      width.value = w
      height.value = h
      build()
    },
    renderSamples(scene, base, o, start, count) {
      base.updateMatrixWorld()
      camera.near = base.near
      camera.far = base.far
      camera.layers.mask = base.layers.mask
      base.matrixWorld.extractBasis(right, up, fwd)
      kPerM.value = o.kPerM
      cocScale.value = o.cocScalePx
      cellShare.value = CELL_REACH / (2 * Math.sqrt(o.samples))
      const n = camera.near
      const halfW = n * o.tanW
      const halfH = n * o.tanH
      for (let s = start; s < start + count; s++) {
        const [u1, u2] = fibonacci(s, o.samples)
        const [ax, ay] = sampleAperture(o.aperture, u1, u2)
        const x = ax * o.apertureRadiusM
        const y = ay * o.apertureRadiusM
        camera.position.setFromMatrixPosition(base.matrixWorld).addScaledVector(right, x).addScaledVector(up, y)
        camera.quaternion.setFromRotationMatrix(base.matrixWorld)
        camera.updateMatrixWorld()
        const jx = (halton(s + 1, 3) - 0.5) * ((2 * halfW) / W)
        const jy = (halton(s + 1, 5) - 0.5) * ((2 * halfH) / H)
        const sx = -x * n * o.kPerM + jx
        const sy = -y * n * o.kPerM + jy
        Object.assign(camera.window, { left: -halfW + sx, right: halfW + sx, top: halfH + sy, bottom: -halfH + sy })
        camera.updateProjectionMatrix()

        renderer.setRenderTarget(sample)
        renderer.setMRT(sampleMRT)
        renderer.render(scene, camera)
        renderer.setMRT(null)
        renderer.setRenderTarget(null)
        first.value = s === 0 ? 1 : 0
        spin.value = halton(s + 1, 7) * 2 * Math.PI
        renderer.compute(accumulate!)
      }
    },
    resolve(f, split = null) {
      fade.value = f
      splitX.value = split === null ? -1 : split * W
      renderer.setRenderTarget(image)
      resolveQuad.render(renderer)
      renderer.setRenderTarget(null)
    },
    async readAccumulation() {
      const buf = await renderer.getArrayBufferAsync(accum.value)
      return { data: new Float32Array(buf), width: W, height: H }
    },
    dispose() {
      for (const t of [sample, image]) t.dispose()
      resolveMaterial.dispose()
    },
  }
}
