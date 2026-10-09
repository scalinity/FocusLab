import { WebGPUUnavailable, requestGpu, type Gpu } from './gpu/device'
import { createRenderer, type FocusRenderer } from './render/renderer'
import { sensorDistance } from './optics/thinLens'
import { clampTravel } from './optics/travel'
import { metresToMm } from './optics/world'
import { store, type Settings, type StoreState, type UiState } from './state/store'
import type { Bundle } from './bench/geometry'
import { createHud } from './ui/hud'
import { bindInput } from './ui/input'
import { showFatal } from './ui/fatal'
import { createTestCards } from './worlds/testCards'
import { createPointTargets } from './worlds/pointTargets'
import { measureDisc, type DiscMeasure } from './render/measure'

const canvas = document.getElementById('view') as HTMLCanvasElement

interface HarnessReport {
  backend: 'webgpu'
  adapter: { vendor: string; architecture: string; description: string; isFallbackAdapter: boolean | null }
  features: string[]
}

/** Fixed states for the capture harness. Focus jumps; it is not sprung. */
interface HarnessState extends Partial<Pick<Settings, 'f' | 'N' | 'lab' | 'aperture'>> {
  focusM?: number
  siMm?: number
  ui?: Partial<UiState>
  resetView?: boolean
  /** Bench camera pose in world metres. */
  camera?: { position: [number, number, number]; target: [number, number, number] }
}

declare global {
  interface Window {
    __focusLab?: {
      ready: Promise<HarnessReport>
      device(): GPUDevice | null
      set(s: HarnessState): Promise<void>
      state(): StoreState
      bundles(): Bundle[]
      ringScreenPoint(): { x: number; y: number } | null
      /** Starts an exposure and resolves when it has developed. */
      develop(): Promise<{ samples: number }>
      framesRendered(): number
      /** Measures the developed disc in a square crop centred on (x, y), px. */
      measure(x: number, y: number, size: number): Promise<DiscMeasure>
    }
  }
}

let gpu: Gpu | null = null
let view: FocusRenderer | null = null
let unbind: (() => void) | null = null
// Canvas textures (chart labels, the ring scale) are drawn once; wait for the
// bundled fonts so they use them.
await Promise.all([document.fonts.load('600 46px "Outfit Variable"'), document.fonts.load('500 30px "DM Mono"')])
const world = new URLSearchParams(location.search).get('world') === 'points' ? createPointTargets() : createTestCards()
const hud = createHud(world)

/**
 * Builds every GPU resource from scratch. Device loss tears everything down
 * and runs this again; optics state lives in the store and survives.
 */
async function start(): Promise<HarnessReport> {
  gpu = await requestGpu()
  view = await createRenderer(canvas, gpu, world, hud)
  unbind = bindInput(canvas, view, world)
  gpu.lost.then((info) => {
    console.warn(`[gpu] device lost (${info.reason}): ${info.message}. Rebuilding.`)
    unbind?.()
    view?.dispose()
    view = null
    gpu = null
    run()
  })
  const info = gpu.adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }
  return {
    backend: 'webgpu',
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter ?? null,
    },
    features: [...gpu.device.features].sort(),
  }
}

async function harnessSet(s: HarnessState): Promise<void> {
  if (s.f !== undefined) store.setFocalLength(s.f)
  const patch: Partial<Settings> = {}
  if (s.N !== undefined) patch.N = s.N
  if (s.lab !== undefined) patch.lab = s.lab
  if (s.aperture !== undefined) patch.aperture = s.aperture
  store.setOptics(patch)
  const { f, lab } = store.get().optics
  let si: number | null = null
  if (s.siMm !== undefined) si = s.siMm
  if (s.focusM !== undefined) si = clampTravel(f, sensorDistance(f, metresToMm(s.focusM)), lab)
  if (si !== null) store.setOptics({ si, siTarget: si })
  if (s.ui !== undefined) store.setUi(s.ui)
  if (s.resetView) view?.resetView()
  if (s.camera !== undefined && view !== null) {
    view.controls.target.set(...s.camera.target)
    view.benchCamera.position.set(...s.camera.position)
    view.controls.update()
  }
  await view?.settled()
}

function run(): Promise<HarnessReport> {
  const ready = start()
  ready.catch((err: unknown) => {
    if (err instanceof WebGPUUnavailable) {
      showFatal('Focus Lab needs WebGPU', `${err.message} Use a current Chrome on a machine with a supported GPU.`)
    } else {
      showFatal('Focus Lab could not start', String(err))
    }
    console.error(err)
  })
  if (new URLSearchParams(location.search).has('harness')) {
    window.__focusLab = {
      ready,
      device: () => gpu?.device ?? null,
      set: harnessSet,
      state: () => store.get(),
      bundles: () => view?.rays.bundles ?? [],
      ringScreenPoint: () => view?.ringScreenPoint() ?? null,
      framesRendered: () => view?.framesRendered() ?? 0,
      develop: async () => {
        view!.exposeNow()
        await view!.developed()
        return { samples: view!.exposure().samples }
      },
      measure: async (x, y, size) => {
        const { data, width } = await view!.readAccumulation()
        const crop = new Float32Array(size * size * 4)
        const x0 = Math.round(x - size / 2)
        const y0 = Math.round(y - size / 2)
        for (let r = 0; r < size; r++) {
          crop.set(data.subarray(((y0 + r) * width + x0) * 4, ((y0 + r) * width + x0 + size) * 4), r * size * 4)
        }
        return measureDisc(crop, size, size)
      },
    }
  }
  return ready
}

run()
