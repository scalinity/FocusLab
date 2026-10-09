import {
  AgXToneMapping,
  Color,
  Group,
  HalfFloatType,
  MathUtils,
  PMREMGenerator,
  PerspectiveCamera,
  RenderPipeline,
  RenderTarget,
  SRGBColorSpace,
  Scene,
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
import { maxSensorDistance } from '../optics/travel'
import { mmToMetres } from '../optics/world'
import { createRayView, type RayView } from '../bench/rays'
import { stepSpring } from '../optics/spring'
import { store } from '../state/store'
import type { Hud, LabelPositions } from '../ui/hud'
import type { WorldSource } from '../worlds/WorldSource'
import { contour } from './focusContour'
import { viewfinderRect } from './layout'

/**
 * Owns the frame loop. One scene, two cameras: the viewfinder camera is the
 * lens (layer 0, the world only) and renders into an HDR target; the bench
 * camera orbits (layers 0 and 1) and renders the full window with bloom. The
 * viewfinder is then composited as an exact-pixel card, never resampled
 * through 3D. Rendering happens only when something changed.
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
  /** Screen position (CSS px) of the top of the focus ring, for the harness. */
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
  scene.backgroundNode = skyNode()
  scene.add(world.root)

  const pmrem = new PMREMGenerator(renderer)
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  const vfTarget = new RenderTarget(1, 1, { type: HalfFloatType, samples: 4 })
  const vfCamera = new PerspectiveCamera(30, 1.5, 0.02, 3000)
  vfCamera.position.set(LENS_WORLD.x, LENS_WORLD.y, LENS_WORLD.z)
  vfCamera.layers.set(0)

  const rig = new Group()
  rig.position.copy(vfCamera.position)
  const bench = createBenchModel(env, vfTarget.texture)
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

  // Bench view: HDR scene → bloom → explicit tone map and output transform.
  const benchPass = pass(scene, benchCamera)
  const benchColor = benchPass.getTextureNode()
  const benchPipeline = new RenderPipeline(renderer)
  benchPipeline.outputColorTransform = false
  benchPipeline.outputNode = renderOutput(benchColor.add(bloom(benchColor, 0.6, 0.35, 1.6)), AgXToneMapping, SRGBColorSpace)

  // Viewfinder card: the HDR render, tone mapped once, at its own pixels.
  const cardPipeline = new RenderPipeline(renderer)
  cardPipeline.outputColorTransform = false
  cardPipeline.outputNode = renderOutput(texture(vfTarget.texture), AgXToneMapping, SRGBColorSpace)

  let dirty = true
  let velocity = 0
  let frameWaiters: Array<() => void> = []
  const markDirty = (): void => {
    dirty = true
  }
  const resize = (): void => {
    renderer.setPixelRatio(devicePixelRatio)
    renderer.setSize(innerWidth, innerHeight, false)
    dirty = true
  }
  resize()
  addEventListener('resize', resize)
  const unsubscribe = store.subscribe(markDirty)
  controls.addEventListener('change', markDirty)

  const project = (p: number[]): { x: number; y: number } | null => {
    const v = new Vector3(p[0], p[1], p[2]).add(rig.position).project(benchCamera)
    if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight }
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
    if (controls.update(dt)) dirty = true
    if (!dirty) return
    dirty = false

    const { optics, derived, ui } = store.get()
    const rect = viewfinderRect(innerWidth, innerHeight, ui.viewfinder)
    hud.placeViewfinder(rect)
    const vw = Math.max(1, Math.floor(rect.w * devicePixelRatio))
    const vh = Math.max(1, Math.floor(rect.h * devicePixelRatio))
    if (vfTarget.width !== vw || vfTarget.height !== vh) vfTarget.setSize(vw, vh)

    vfCamera.fov = MathUtils.radToDeg(derived.vfov)
    vfCamera.updateProjectionMatrix()
    benchCamera.aspect = innerWidth / innerHeight
    benchCamera.updateProjectionMatrix()

    contour.lens.value.copy(vfCamera.position)
    contour.kPerM.value = derived.kPerM
    contour.tanW.value = 18 / optics.si
    contour.tanH.value = 12 / optics.si

    bench.update(optics, { nearM: derived.dofNearM, farM: derived.dofFarM })
    rays.update(optics, optics.aperture, chooseSubjects(world.subjects, world.far, derived.kPerM))

    contour.strength.value = 0
    renderer.setRenderTarget(vfTarget)
    renderer.render(scene, vfCamera)
    renderer.setRenderTarget(null)

    if (ui.viewfinder === 'card') {
      contour.strength.value = 1
      renderer.setViewport(0, 0, innerWidth, innerHeight)
      benchPipeline.render()
    } else {
      renderer.setViewport(0, 0, innerWidth, innerHeight)
      renderer.clear()
    }
    renderer.autoClear = false
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h)
    cardPipeline.render()
    renderer.autoClear = true
    renderer.setViewport(0, 0, innerWidth, innerHeight)

    const labels: LabelPositions = {
      sheet: rays.sheetAnchor === null ? null : project(rays.sheetAnchor),
      plane: project(bench.anchors.planeTop),
      lens: project(bench.anchors.lensTop),
    }
    hud.placeLabels(labels)

    const waiters = frameWaiters
    frameWaiters = []
    for (const w of waiters) w()
  })

  const frame = (): Promise<void> =>
    new Promise((resolve) => {
      frameWaiters.push(resolve)
      dirty = true
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
    resetView,
    ringScreenPoint() {
      // The point of the ring (centred on the axis) that faces the bench camera.
      const r = bench.ring
      r.geometry.computeBoundingBox()
      const radius = r.geometry.boundingBox!.max.y
      const cam = benchCamera.position.clone().sub(rig.position)
      const len = Math.hypot(cam.x, cam.y) || 1
      return project([(radius * cam.x) / len, (radius * cam.y) / len, r.position.z])
    },
    dispose() {
      renderer.setAnimationLoop(null)
      removeEventListener('resize', resize)
      unsubscribe()
      controls.dispose()
      bench.dispose()
      rays.dispose()
      benchPipeline.dispose()
      cardPipeline.dispose()
      vfTarget.dispose()
      env.dispose()
      pmrem.dispose()
      scene.remove(world.root)
      renderer.dispose()
    },
  }
}
