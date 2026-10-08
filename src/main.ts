import { WebGPUUnavailable, requestGpu, type Gpu } from './gpu/device'
import { createRenderer, type FocusRenderer } from './render/renderer'
import { showFatal } from './ui/fatal'

const canvas = document.getElementById('view') as HTMLCanvasElement

interface HarnessReport {
  backend: 'webgpu'
  adapter: { vendor: string; architecture: string; description: string; isFallbackAdapter: boolean | null }
  features: string[]
}

declare global {
  interface Window {
    __focusLab?: { ready: Promise<HarnessReport>; device(): GPUDevice | null }
  }
}

let gpu: Gpu | null = null
let view: FocusRenderer | null = null

/**
 * Builds every GPU resource from scratch. Device loss tears everything down
 * and runs this again; optics state lives in the store and survives.
 */
async function start(): Promise<HarnessReport> {
  gpu = await requestGpu()
  view = await createRenderer(canvas, gpu)
  gpu.lost.then((info) => {
    console.warn(`[gpu] device lost (${info.reason}): ${info.message}. Rebuilding.`)
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

function run(): Promise<HarnessReport> {
  const ready = start()
  ready.catch((err: unknown) => {
    if (err instanceof WebGPUUnavailable) {
      showFatal('Focus Lab needs WebGPU', `${err.message} Use a current Chrome or Safari on a machine with a supported GPU.`)
    } else {
      showFatal('Focus Lab could not start', String(err))
    }
    console.error(err)
  })
  if (new URLSearchParams(location.search).has('harness')) {
    window.__focusLab = { ready, device: () => gpu?.device ?? null }
  }
  return ready
}

run()
