import {
  AgXToneMapping,
  Color,
  DataUtils,
  Group,
  HalfFloatType,
  MathUtils,
  PMREMGenerator,
  PerspectiveCamera,
  RenderPipeline,
  RenderTarget,
  SRGBColorSpace,
  Scene,
  TimestampQuery,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu'
import { mix, pass, positionWorldDirection, renderOutput, smoothstep, texture, vec3 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { WebGPUUnavailable, type Gpu } from '../gpu/device'
import { BENCH_LAYER, createBenchModel, type BenchModel } from '../bench/benchModel'
import { LENS_WORLD, chooseSubjects, imageScale } from '../bench/geometry'
import { createRayView, type RayView } from '../bench/rays'
import { stepSpring } from '../optics/spring'
import { maxSensorDistance } from '../optics/travel'
import { apertureRadiusM, blurUniforms, mmToMetres } from '../optics/world'
import {
  TIER_SAMPLES,
  addSamples,
  exposeNow,
  initialExposure,
  onInput,
  tick,
  type Exposure,
} from '../state/renderState'
import { store } from '../state/store'
import type { Hud, LabelPositions } from '../ui/hud'
import type { WorldSource } from '../worlds/WorldSource'
import { createExposureEngine } from './exposure'
import { createLiveDof } from './dofLive'
import { contour } from './focusContour'
import { viewfinderRect } from './layout'

/**
 * Owns the frame loop. One scene, two cameras: the viewfinder camera is the
 * lens (layer 0, the world only); the bench camera orbits (layers 0 and 1).
 *
 * The viewfinder is LIVE (a pinhole render) until the photo has been still
 * for a moment, then EXPOSES exact aperture samples and finally DEVELOPS,
 * after which nothing is rendered until something changes. The bench is
 * rendered into its own target only when it changes, so an exposing frame
 * costs its samples plus two cheap composites.
 */

export interface FocusRenderer {
  renderer: WebGPURenderer
  benchCamera: PerspectiveCamera
  controls: OrbitControls
  bench: BenchModel
  rays: RayView
  /** Resolves after the next rendered frame. */
  frame(): Promise<void>
  /** Resolves once the focus spring has settled and that state is on screen. */
  settled(): Promise<void>
  /** Starts an exposure now (Space). */
  exposeNow(): void
  /** Resolves when the current exposure has developed. */
  developed(): Promise<void>
  exposure(): Exposure
  /** Frames actually rendered (the loop skips frames when nothing changed). */
  framesRendered(): number
  /**
   * Mean wall-clock interval between `frames` back-to-back live frames, ms.
   * With `sweep`, focus moves every frame, so the bench re-renders too, as
   * while someone drags the focus ring.
   */
  frameIntervalMs(frames: number, sweep?: boolean): Promise<number>
  readAccumulation(): Promise<{ data: Float32Array; width: number; height: number }>
  /** The live DoF image as RGBA float, rows top to bottom. */
  readLive(): Promise<{ data: Float32Array; width: number; height: number }>
  /** Screen position (CSS px) of the ring point facing the bench camera, for the harness. */
  ringScreenPoint(): { x: number; y: number } | null
  resetView(): void
  dispose(): void
}

/** Home view of the bench, scaled to the magnified camera's length for the lens. */
const HOME_DIRECTION = new Vector3(1.6, 0.59, 1.9).normalize()
const REFERENCE_LENGTH_M = 0.48

function home(f: number): { target: Vector3; distance: number } {
  const length = mmToMetres(imageScale(f) * maxSensorDistance(f)) / REFERENCE_LENGTH_M
  return {
    target: new Vector3(LENS_WORLD.x - 0.05, LENS_WORLD.y - 0.09, LENS_WORLD.z + 0.216 * length - 0.75),
    distance: 2.55 * (0.35 + 0.65 * length),
  }
}

function skyNode() {
  const up = positionWorldDirection.y
  const horizon = vec3(0.34, 0.33, 0.33)
  const zenith = vec3(0.05, 0.08, 0.16)
  const ground = vec3(0.05, 0.055, 0.05)
  return mix(mix(ground, horizon, smoothstep(-0.08, 0, up)), zenith, smoothstep(0, 0.6, up))
}

/** GPU budget per frame for exposure samples, ms (holds ~60 fps on top of the composites). */
const SAMPLE_BUDGET_MS = 12
const MAX_SAMPLES_PER_FRAME = 48
/** Crossfade from the live frame once this many samples exist, complete at twice that. */
const FADE_FROM = 16

export async function createRenderer(
  canvas: HTMLCanvasElement,
  gpu: Gpu,
  world: WorldSource,
  hud: Hud,
): Promise<FocusRenderer> {
  const renderer = new WebGPURenderer({ canvas, device: gpu.device, alpha: false, antialias: false, trackTimestamp: true })
  renderer.setClearColor(new Color(0x0b0f1a), 1)
  await renderer.init()
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
    throw new WebGPUUnavailable('three.js did not start its WebGPU backend.')
  }

  const scene = new Scene()
  scene.backgroundNode = world.background ?? skyNode()
  scene.add(world.root)

  const pmrem = new PMREMGenerator(renderer)
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  const dof = createLiveDof(renderer)
  const exposure = createExposureEngine(renderer, dof.output.texture)
  const vfCamera = new PerspectiveCamera(30, 1.5, 0.02, 3000)
  vfCamera.position.set(LENS_WORLD.x, LENS_WORLD.y, LENS_WORLD.z)
  vfCamera.layers.set(0)

  const rig = new Group()
  rig.position.copy(vfCamera.position)
  const bench = createBenchModel(env, exposure.image.texture)
  const rays = createRayView()
  rig.add(bench.group, rays.group)
  scene.add(rig)

  const benchCamera = new PerspectiveCamera(30, 1, 0.01, 4000)
  benchCamera.layers.enable(BENCH_LAYER)
  const controls = new OrbitControls(benchCamera, canvas)
  controls.enableDamping = true
  controls.minDistance = 0.25
  controls.maxDistance = 60
  let framedF = store.get().optics.f
  const resetView = (): void => {
    const h = home(store.get().optics.f)
    controls.target.copy(h.target)
    benchCamera.position.copy(h.target).addScaledVector(HOME_DIRECTION, h.distance)
    framedF = store.get().optics.f
    controls.update()
  }
  resetView()

  // Bench view: HDR scene → bloom → explicit tone map and output transform,
  // into its own target so exposing frames only re-composite it.
  const benchOut = new RenderTarget(1, 1, { type: HalfFloatType })
  const benchColor = pass(scene, benchCamera).getTextureNode()
  const benchPipeline = new RenderPipeline(renderer)
  benchPipeline.outputColorTransform = false
  benchPipeline.outputNode = renderOutput(benchColor.add(bloom(benchColor, 0.6, 0.35, 1.6)), AgXToneMapping, SRGBColorSpace)
  const blitPipeline = new RenderPipeline(renderer)
  blitPipeline.outputColorTransform = false
  blitPipeline.outputNode = texture(benchOut.texture)

  // Viewfinder card: the HDR image, tone mapped once, at its own pixels.
  const cardPipeline = new RenderPipeline(renderer)
  cardPipeline.outputColorTransform = false
  cardPipeline.outputNode = renderOutput(texture(exposure.image.texture), AgXToneMapping, SRGBColorSpace)

  let ex = initialExposure(performance.now(), TIER_SAMPLES[store.get().ui.tier])
  let photoKey = ''
  let benchDirty = true
  let frameDirty = true
  let velocity = 0
  let frameWaiters: Array<() => void> = []
  let samplesPerFrame = 2
  let samplesSinceResolve = 0
  let samplesLastFrame = 0
  let resolving = false
  let rendered = 0

  const markDirty = (): void => {
    benchDirty = true
    frameDirty = true
  }
  const resize = (): void => {
    renderer.setPixelRatio(devicePixelRatio)
    renderer.setSize(innerWidth, innerHeight, false)
    markDirty()
  }
  resize()
  addEventListener('resize', resize)
  const unsubscribe = store.subscribe(markDirty)
  controls.addEventListener('change', () => (benchDirty = true))
  const visibility = (): void => {
    if (document.hidden) ex = onInput(ex, performance.now())
    markDirty()
  }
  document.addEventListener('visibilitychange', visibility)

  const project = (p: number[]): { x: number; y: number } | null => {
    const v = new Vector3(p[0], p[1], p[2]).add(rig.position).project(benchCamera)
    if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight }
  }

  /**
   * Per-sample GPU time from timestamp queries sets how many samples fit a
   * frame. three resolves to the last submitted frame's total, so the
   * divisor is that frame's sample count.
   */
  function adaptSamples(): void {
    if (resolving || samplesSinceResolve === 0 || !renderer.hasFeature('timestamp-query')) return
    resolving = true
    const n = samplesLastFrame
    samplesSinceResolve = 0
    Promise.all([
      renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
      renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE),
    ]).then(([r, c]) => {
      const perSample = ((r ?? 0) + (c ?? 0)) / n
      if (perSample > 0) {
        samplesPerFrame = Math.max(1, Math.min(MAX_SAMPLES_PER_FRAME, Math.floor(SAMPLE_BUDGET_MS / perSample)))
      }
      resolving = false
    })
  }

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now

    const o = store.get().optics
    if (o.si !== o.siTarget || velocity !== 0) {
      const s = stepSpring({ x: o.si, v: velocity }, o.siTarget, dt)
      const done = Math.abs(s.x - o.siTarget) < 1e-5 && Math.abs(s.v) < 1e-3
      velocity = done ? 0 : s.v
      store.setOptics({ si: done ? o.siTarget : s.x })
    }
    // A lens swap resizes the magnified camera: keep the orbit angle, rescale the framing.
    if (o.f !== framedF) {
      const from = home(framedF)
      const to = home(o.f)
      const offset = benchCamera.position.clone().sub(controls.target).multiplyScalar(to.distance / from.distance)
      controls.target.copy(to.target)
      benchCamera.position.copy(to.target).add(offset)
      framedF = o.f
    }
    controls.update(dt)

    const { optics, derived, ui } = store.get()
    const rect = viewfinderRect(innerWidth, innerHeight, ui.viewfinder)
    const W = ui.renderWidth ?? Math.max(1, Math.floor(rect.w * devicePixelRatio))
    const H = Math.max(1, Math.round((W * 2) / 3))
    dof.resize(W, H)
    exposure.resize(W, H)

    // Anything that changes the photo discards the exposure.
    const ap = optics.aperture
    const key = [optics.f, optics.N, optics.si, ap.blades, ap.roundness, ap.rotation, W, H, ui.view].join('|')
    if (key !== photoKey) {
      photoKey = key
      ex = onInput(ex, now)
    }
    // The blur map is a diagnostic of the live path; it never exposes.
    ex = { ...tick(ex, now, ui.autoExpose && ui.view !== 'blur' && !document.hidden), target: TIER_SAMPLES[ui.tier] }
    const split = ui.view === 'split' ? 0.5 : null
    if (!benchDirty && !frameDirty && ex.mode !== 'EXPOSING') return

    hud.placeViewfinder(rect)
    vfCamera.fov = MathUtils.radToDeg(derived.vfov)
    vfCamera.updateProjectionMatrix()
    contour.lens.value.copy(vfCamera.position)
    contour.kPerM.value = derived.kPerM
    contour.tanW.value = 18 / optics.si
    contour.tanH.value = 12 / optics.si

    contour.strength.value = 0
    if (ex.mode === 'LIVE' && frameDirty) {
      const u = blurUniforms(optics, W)
      dof.render(scene, vfCamera, { kPerM: u.kPerM, cocScalePx: u.cocScalePx, aperture: optics.aperture }, ui.view === 'blur' ? 'blur' : 'beauty')
      exposure.resolve(0, split)
    } else if (ex.mode === 'EXPOSING') {
      const n = Math.min(samplesPerFrame, ex.target - ex.samples)
      exposure.renderSamples(
        scene,
        vfCamera,
        {
          kPerM: derived.kPerM,
          apertureRadiusM: apertureRadiusM(optics),
          aperture: optics.aperture,
          tanW: 18 / optics.si,
          tanH: 12 / optics.si,
        },
        ex.samples,
        n,
      )
      ex = addSamples(ex, n)
      samplesSinceResolve += n
      samplesLastFrame = n
      exposure.resolve(ex.mode === 'DEVELOPED' ? 1 : MathUtils.smoothstep(ex.samples, FADE_FROM, 2 * FADE_FROM), split)
      // The image plane on the bench shows the photograph once it has developed.
      if (ex.mode === 'DEVELOPED') benchDirty = true
    }

    if (ui.viewfinder === 'card' && benchDirty) {
      benchCamera.aspect = innerWidth / innerHeight
      benchCamera.updateProjectionMatrix()
      bench.update(optics, { nearM: derived.dofNearM, farM: derived.dofFarM })
      rays.update(optics, optics.aperture, chooseSubjects(world.subjects, world.far, derived.kPerM))
      const size = renderer.getDrawingBufferSize(new Vector2())
      if (benchOut.width !== size.x || benchOut.height !== size.y) benchOut.setSize(size.x, size.y)
      contour.strength.value = 1
      renderer.setRenderTarget(benchOut)
      benchPipeline.render()
      renderer.setRenderTarget(null)
      const labels: LabelPositions = {
        sheet: rays.sheetAnchor === null ? null : project(rays.sheetAnchor),
        plane: project(bench.anchors.planeTop),
        lens: project(bench.anchors.lensTop),
      }
      hud.placeLabels(labels)
    }

    renderer.setViewport(0, 0, innerWidth, innerHeight)
    if (ui.viewfinder === 'card') blitPipeline.render()
    else renderer.clear()
    renderer.autoClear = false
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h)
    cardPipeline.render()
    renderer.autoClear = true
    renderer.setViewport(0, 0, innerWidth, innerHeight)

    hud.setExposure(ex)
    adaptSamples()
    rendered++
    benchDirty = false
    frameDirty = false

    const waiters = frameWaiters
    frameWaiters = []
    for (const w of waiters) w()
  })

  const frame = (): Promise<void> =>
    new Promise((resolve) => {
      frameWaiters.push(resolve)
      frameDirty = true
    })

  return {
    renderer,
    benchCamera,
    controls,
    bench,
    rays,
    frame,
    async settled() {
      for (;;) {
        await frame()
        const o = store.get().optics
        if (o.si === o.siTarget && velocity === 0) break
      }
      await frame()
    },
    exposeNow() {
      ex = exposeNow(ex)
      frameDirty = true
    },
    async developed() {
      while (ex.mode !== 'DEVELOPED') await frame()
    },
    exposure: () => ex,
    framesRendered: () => rendered,
    async frameIntervalMs(frames, sweep = false) {
      // Frames are re-rendered back to back (the photo stays live), so the GPU
      // stays clocked up and the interval is what someone dragging focus sees.
      await frame()
      const t0 = performance.now()
      const base = store.get().optics.si
      for (let i = 0; i < frames; i++) {
        if (sweep) {
          const si = base + 0.002 * Math.sin(i / 8)
          store.setOptics({ si, siTarget: si })
        }
        await frame()
      }
      if (sweep) store.setOptics({ si: base, siTarget: base })
      return (performance.now() - t0) / frames
    },
    readAccumulation: () => exposure.readAccumulation(),
    async readLive() {
      const { width, height } = dof.output
      const raw = (await renderer.readRenderTargetPixelsAsync(dof.output, 0, 0, width, height)) as Uint16Array
      const data = new Float32Array(raw.length)
      for (let i = 0; i < raw.length; i++) data[i] = DataUtils.fromHalfFloat(raw[i])
      return { data, width, height }
    },
    ringScreenPoint() {
      // The point of the ring (centred on the axis) that faces the bench camera.
      const r = bench.ring
      r.geometry.computeBoundingBox()
      const radius = r.geometry.boundingBox!.max.y
      const cam = benchCamera.position.clone().sub(rig.position)
      const len = Math.hypot(cam.x, cam.y) || 1
      return project([(radius * cam.x) / len, (radius * cam.y) / len, r.position.z])
    },
    resetView,
    dispose() {
      renderer.setAnimationLoop(null)
      removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', visibility)
      unsubscribe()
      controls.dispose()
      bench.dispose()
      rays.dispose()
      exposure.dispose()
      dof.dispose()
      for (const p of [benchPipeline, blitPipeline, cardPipeline]) p.dispose()
      benchOut.dispose()
      env.dispose()
      pmrem.dispose()
      scene.remove(world.root)
      renderer.dispose()
    },
  }
}
