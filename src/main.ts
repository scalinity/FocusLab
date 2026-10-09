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
import { createHaloTargets } from './worlds/haloTargets'
import { createForest } from './worlds/forest'
import type { WorldSource } from './worlds/WorldSource'
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
      frameIntervalMs(frames: number, sweep?: boolean): Promise<number>
      /** Measures the developed disc in a square crop centred on (x, y), px. */
      measure(x: number, y: number, size: number): Promise<DiscMeasure>
      /** The same measurement on the live depth-of-field image. */
      measureLive(x: number, y: number, size: number): Promise<DiscMeasure>
      /** Luminance averaged over rows [y0, y1) for each column in [x0, x1). */
      profile(source: 'live' | 'exact', x0: number, x1: number, y0: number, y1: number): Promise<number[]>
    }
  }
}

let gpu: Gpu | null = null
let view: FocusRenderer | null = null
let unbind: (() => void) | null = null
// Canvas textures (chart labels, the ring scale) are drawn once; wait for the
// bundled fonts so they use them.
await Promise.all([document.fonts.load('600 46px "Outfit Variable"'), document.fonts.load('500 30px "DM Mono"')])
const worldName = new URLSearchParams(location.search).get('world')
const WORLDS: Record<string, () => WorldSource | Promise<WorldSource>> = {
  points: createPointTargets,
  halo: createHaloTargets,
  cards: createTestCards,
  forest: createForest,
}
const world = await (WORLDS[worldName ?? 'forest'] ?? createForest)()
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
      frameIntervalMs: (frames, sweep) => view!.frameIntervalMs(frames, sweep),
      develop: async () => {
        view!.exposeNow()
        await view!.developed()
        return { samples: view!.exposure().samples }
      },
      measure: async (x, y, size) => measureCrop(await view!.readAccumulation(), x, y, size),
      measureLive: async (x, y, size) => measureCrop(await view!.readLive(), x, y, size),
      profile: async (source, x0, x1, y0, y1) => {
        const img = source === 'live' ? await view!.readLive() : await view!.readAccumulation()
        const out: number[] = []
        for (let x = Math.round(x0); x < Math.round(x1); x++) {
          let sum = 0
          for (let y = Math.round(y0); y < Math.round(y1); y++) {
            const i = (y * img.width + x) * 4
            const w = img.data[i + 3] || 1
            sum += (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / w
          }
          out.push(sum / (Math.round(y1) - Math.round(y0)))
        }
        return out
      },
    }
  }
  return ready
}

run()

function measureCrop(img: { data: Float32Array; width: number }, x: number, y: number, size: number): DiscMeasure {
  const crop = new Float32Array(size * size * 4)
  const x0 = Math.round(x - size / 2)
  const y0 = Math.round(y - size / 2)
  for (let r = 0; r < size; r++) {
    const start = ((y0 + r) * img.width + x0) * 4
    crop.set(img.data.subarray(start, start + size * 4), r * size * 4)
  }
  return measureDisc(crop, size, size)
}
