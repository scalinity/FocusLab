import {
  HalfFloatType,
  NodeMaterial,
  PerspectiveCamera,
  QuadMesh,
  RenderTarget,
  Vector3,
  type ComputeNode,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import { Fn, float, instanceIndex, instancedArray, int, ivec2, mix, screenCoordinate, select, textureLoad, uniform, uvec2, vec4 } from 'three/tsl'
import { sampleAperture, type Aperture } from '../optics/aperture'
import { halton, r2 } from '../optics/sequence'

/**
 * Exact exposure by aperture sampling (Haeberli & Akeley 1990). Each sample
 * is an ordinary pinhole render from a point on the aperture, with the
 * frustum sheared so the plane of focus stays fixed on screen, plus a
 * Halton sub-pixel jitter. A compute pass adds every sample into a float32
 * storage buffer (no float blending or filtering needed). Occlusion,
 * see-through foreground blur and bokeh shape all come out right because
 * nothing is approximated: it only moves the camera.
 *
 * Shear: a camera moved by a (metres, camera frame) sees a point on the
 * plane at 1/k shifted by −a·k at unit distance, so the near-plane window
 * moves by −a·near·k. k is the focus power in 1/m: 0 at infinity (pure
 * translation), negative past it.
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
}

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
  const sample = new RenderTarget(1, 1, { type: HalfFloatType })
  const image = new RenderTarget(1, 1, { type: HalfFloatType })
  const width = uniform(1, 'uint')
  const first = uniform(1, 'uint')
  const fade = uniform(0)
  const splitX = uniform(-1)

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
      const c = vec4(textureLoad(sample.texture, uvec2(i.mod(width), i.div(width))).rgb, 1)
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
      build()
    },
    renderSamples(scene, base, o, start, count) {
      base.updateMatrixWorld()
      camera.near = base.near
      camera.far = base.far
      camera.layers.mask = base.layers.mask
      base.matrixWorld.extractBasis(right, up, fwd)
      const n = camera.near
      const halfW = n * o.tanW
      const halfH = n * o.tanH
      for (let s = start; s < start + count; s++) {
        const [u1, u2] = r2(s)
        const [ax, ay] = sampleAperture(o.aperture, u1, u2)
        const x = ax * o.apertureRadiusM
        const y = ay * o.apertureRadiusM
        camera.position.setFromMatrixPosition(base.matrixWorld).addScaledVector(right, x).addScaledVector(up, y)
        camera.quaternion.setFromRotationMatrix(base.matrixWorld)
        camera.updateMatrixWorld()
        const jx = (halton(s + 1, 2) - 0.5) * ((2 * halfW) / W)
        const jy = (halton(s + 1, 3) - 0.5) * ((2 * halfH) / H)
        const sx = -x * n * o.kPerM + jx
        const sy = -y * n * o.kPerM + jy
        Object.assign(camera.window, { left: -halfW + sx, right: halfW + sx, top: halfH + sy, bottom: -halfH + sy })
        camera.updateProjectionMatrix()

        renderer.setRenderTarget(sample)
        renderer.render(scene, camera)
        renderer.setRenderTarget(null)
        first.value = s === 0 ? 1 : 0
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
