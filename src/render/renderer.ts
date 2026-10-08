import { NoToneMapping, RenderPipeline, SRGBColorSpace, WebGPURenderer } from 'three/webgpu'
import {
  Fn,
  abs,
  exp,
  float,
  instanceIndex,
  instancedArray,
  renderOutput,
  select,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { WebGPUUnavailable, type Gpu } from '../gpu/device'
import { COC_MM, SENSOR_WIDTH_MM } from '../optics/thinLens'
import { blurUniforms } from '../optics/world'
import { store } from '../state/store'
import { computeLayout, type Layout } from './layout'

/**
 * Owns the frame loop. M0 content: a compute pass fills a storage buffer with
 * the signed blur (px) along a dioptre ramp, 0.3 m on the left to ∞ on the
 * right, and a post pass reads it as a false-colour blur map inside the 3:2
 * sensor frame. The same packed uniforms will drive the DoF passes.
 */

const RAMP = 1024
const NEAREST_M = 0.3

export interface FocusRenderer {
  renderer: WebGPURenderer
  dispose(): void
}

export async function createRenderer(canvas: HTMLCanvasElement, gpu: Gpu): Promise<FocusRenderer> {
  const renderer = new WebGPURenderer({
    canvas,
    device: gpu.device,
    alpha: false,
    antialias: false,
    trackTimestamp: true,
  })
  renderer.toneMapping = NoToneMapping
  renderer.setClearColor(0x0b0c0e, 1)
  await renderer.init()
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
    throw new WebGPUUnavailable('three.js did not start its WebGPU backend.')
  }

  const kPerM = uniform(0)
  const cocScalePx = uniform(0)
  const cocLimitPx = uniform(0)

  const ramp = instancedArray(RAMP, 'float')
  const fillRamp = Fn(() => {
    const t = instanceIndex.toFloat().div(RAMP - 1)
    const invD = float(1 / NEAREST_M).mul(t.oneMinus())
    ramp.element(instanceIndex).assign(cocScalePx.mul(kPerM.sub(invD)))
  })().compute(RAMP)

  const blurMap = Fn(() => {
    const c = ramp.toReadOnly().element(uv().x.mul(RAMP - 1).toInt())
    const near = vec3(0.25, 0.55, 1.0)
    const far = vec3(1.0, 0.55, 0.2)
    const strength = float(1).sub(exp(abs(c).negate().div(12)))
    const map = select(c.lessThan(0), near, far).mul(strength)
    const inDof = abs(c).lessThanEqual(cocLimitPx)
    return vec4(select(inDof, vec3(0.92), map), 1)
  })()

  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  pipeline.outputNode = renderOutput(blurMap, NoToneMapping, SRGBColorSpace)

  let layout: Layout = computeLayout(innerWidth, innerHeight)
  let dirty = true

  const resize = (): void => {
    renderer.setPixelRatio(devicePixelRatio)
    renderer.setSize(innerWidth, innerHeight, false)
    layout = computeLayout(innerWidth, innerHeight)
    dirty = true
  }
  resize()
  addEventListener('resize', resize)
  const unsubscribe = store.subscribe(() => (dirty = true))

  renderer.setAnimationLoop(() => {
    if (!dirty) return
    dirty = false
    const { frame } = layout
    const widthPx = Math.floor(frame.w * devicePixelRatio)
    const u = blurUniforms(store.get().optics, widthPx)
    kPerM.value = u.kPerM
    cocScalePx.value = u.cocScalePx
    cocLimitPx.value = (COC_MM / SENSOR_WIDTH_MM) * widthPx

    renderer.compute(fillRamp)
    renderer.setViewport(frame.x, frame.y, frame.w, frame.h)
    pipeline.render()
  })

  return {
    renderer,
    dispose() {
      renderer.setAnimationLoop(null)
      removeEventListener('resize', resize)
      unsubscribe()
      pipeline.dispose()
      renderer.dispose()
    },
  }
}
