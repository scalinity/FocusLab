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
import { createViewfinderPost } from './post'
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
  /** Internal render scale of the live viewfinder and the bench, 0.5–1. */
  renderScale(): number
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
/** GPU budget for a live frame, ms; over it the internal render scale drops. */
const LIVE_BUDGET_MS = 13
const MIN_SCALE = 0.5
const SCALE_STEP = 0.05
/** Measurements in a row with room to spare before the scale steps back up. */
const RAISE_AFTER = 20
/** Crossfade from the live frame once this many samples exist, complete at twice that. */
const FADE_FROM = 16
/** Linear exposure of the viewfinder before tone mapping (aperture priority keeps it constant). */
const VIEWFINDER_EXPOSURE = 0.6

export async function createRenderer(
  canvas: HTMLCanvasElement,
  gpu: Gpu,
  world: WorldSource,
  hud: Hud,
): Promise<FocusRenderer> {
  const renderer = new WebGPURenderer({ canvas, device: gpu.device, alpha: false, antialias: false})
  renderer.setClearColor(new Color(0x0b0f1a), 1)
  renderer.shadowMap.enabled = true
  await renderer.init()
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
    throw new WebGPUUnavailable('three.js did not start its WebGPU backend.')
  }

  const scene = new Scene()
  if (world.environment) {
    scene.environment = world.environment
    scene.environmentRotation.y = world.environmentRotation ?? 0
  }
  if (world.background) {
    scene.backgroundNode = world.background
  } else if (world.environment) {
    scene.background = world.environment
    scene.backgroundRotation.y = world.environmentRotation ?? 0
  } else {
    scene.backgroundNode = skyNode()
  }
  if (world.fog) scene.fogNode = world.fog
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
  const benchPass = pass(scene, benchCamera)
  const benchColor = benchPass.getTextureNode()
  const benchPipeline = new RenderPipeline(renderer)
  benchPipeline.outputColorTransform = false
  benchPipeline.outputNode = renderOutput(benchColor.add(bloom(benchColor, 0.6, 0.35, 1.6)), AgXToneMapping, SRGBColorSpace)
  const blitPipeline = new RenderPipeline(renderer)
  blitPipeline.outputColorTransform = false
  blitPipeline.outputNode = texture(benchOut.texture)

  // Viewfinder card: the HDR image through the photographic finish, at its own pixels.
  const post = createViewfinderPost(renderer, exposure.image.texture)
  const cardPipeline = post.pipeline

  let ex = initialExposure(performance.now(), TIER_SAMPLES[store.get().ui.tier])
  let photoKey = ''
  let benchDirty = true
  let frameDirty = true
  let velocity = 0
  let frameWaiters: Array<() => void> = []
  let samplesPerFrame = 2
  let samplesLastFrame = 0
  /** What the last rendered frame's GPU time measures, if it has not been read yet. */
  let gpuWork: 'none' | 'live' | 'samples' = 'none'
  /** When the GPU last finished a frame, ms (performance.now). */
  let lastDone = 0
  let rendered = 0
  /** Internal render scale of the live viewfinder and the bench (the photograph is always native). */
  let renderScale = 1
  let underBudget = 0

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
   * A frame's GPU time steers the next: while exposing, how many samples fit
   * a frame; while live, the internal render scale. It is the span the GPU
   * spent finishing the frame, from when its work could start (the frame's
   * first submission, or the previous frame's completion if the GPU was still
   * busy) to its completion (queue.onSubmittedWorkDone); the queue completes
   * in order. Timestamp queries are not used: on Apple's tile-based GPUs
   * consecutive passes overlap, and the sum of per-pass durations counted the
   * same time about three times over (40 ms for frames 14 ms apart).
   */
  function measureGpu(frameStart: number): void {
    const work = gpuWork
    const n = samplesLastFrame
    gpuWork = 'none'
    gpu.device.queue.onSubmittedWorkDone().then(() => {
      const done = performance.now()
      const ms = done - Math.max(lastDone, frameStart)
      lastDone = done
      if (work === 'samples') samplesPerFrame = Math.max(1, Math.min(MAX_SAMPLES_PER_FRAME, Math.floor((n * SAMPLE_BUDGET_MS) / ms)))
      if (work === 'live') adaptScale(ms)
    })
  }

  /**
   * GPU time is roughly proportional to pixels, i.e. to the scale squared: an
   * over-budget frame drops the scale at once to what should fit; it steps
   * back up only after RAISE_AFTER measurements in a row with room for the
   * next step, so render targets are not reallocated every frame.
   */
  function adaptScale(ms: number): void {
    const fit = renderScale * Math.sqrt(LIVE_BUDGET_MS / ms)
    if (fit < renderScale - SCALE_STEP / 2) {
      renderScale = Math.max(MIN_SCALE, Math.floor(fit / SCALE_STEP) * SCALE_STEP)
      underBudget = 0
    } else if (fit > renderScale + SCALE_STEP) {
      if (++underBudget >= RAISE_AFTER) {
        renderScale = Math.min(1, renderScale + SCALE_STEP)
        underBudget = 0
      }
    } else {
      underBudget = 0
    }
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
    // A fixed render width (tests) is never scaled.
    const scale = ui.renderWidth === null ? renderScale : 1
    const liveW = Math.max(1, Math.round(W * scale))
    const liveH = Math.max(1, Math.round((liveW * 2) / 3))
    if (scale !== benchPass.getResolutionScale()) {
      benchPass.setResolutionScale(scale)
      markDirty()
    }
    dof.resize(liveW, liveH)
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
    post.si.value = optics.si
    post.N.value = optics.N
    post.exposure.value = VIEWFINDER_EXPOSURE
    if (ex.mode !== 'DEVELOPED') post.grainSeed.value = Math.random() * 100
    vfCamera.fov = MathUtils.radToDeg(derived.vfov)
    vfCamera.updateProjectionMatrix()
    contour.lens.value.copy(vfCamera.position)
    contour.kPerM.value = derived.kPerM
    contour.tanW.value = 18 / optics.si
    contour.tanH.value = 12 / optics.si

    contour.strength.value = 0
    if (ex.mode === 'LIVE' && frameDirty) {
      const u = blurUniforms(optics, liveW)
      dof.render(scene, vfCamera, { kPerM: u.kPerM, cocScalePx: u.cocScalePx, aperture: optics.aperture }, ui.view === 'blur' ? 'blur' : 'beauty')
      exposure.resolve(0, split)
      gpuWork = 'live'
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
          cocScalePx: blurUniforms(optics, W).cocScalePx,
          samples: ex.target,
        },
        ex.samples,
        n,
      )
      ex = addSamples(ex, n)
      samplesLastFrame = n
      gpuWork = 'samples'
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
    measureGpu(now)
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
    renderScale: () => renderScale,
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
