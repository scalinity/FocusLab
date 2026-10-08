/**
 * WebGPU bring-up. Focus Lab requests its own adapter and device so three.js
 * never chooses a backend: there is no WebGL path anywhere. The adapter is
 * kept for its info, features and limits (three discards its own).
 */

export class WebGPUUnavailable extends Error {}

export interface Gpu {
  adapter: GPUAdapter
  device: GPUDevice
  /** Resolves with the loss info, unless the loss came from `dispose()`. */
  lost: Promise<GPUDeviceLostInfo>
  dispose(): void
}

export async function requestGpu(): Promise<Gpu> {
  if (!('gpu' in navigator)) {
    throw new WebGPUUnavailable('This browser does not expose navigator.gpu.')
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (adapter === null) {
    throw new WebGPUUnavailable('No WebGPU adapter is available on this device.')
  }

  // Every feature the adapter offers, every limit at the adapter's best value.
  const requiredLimits: Record<string, number> = {}
  for (const key in adapter.limits) {
    const value = adapter.limits[key as keyof GPUSupportedLimits]
    if (typeof value === 'number') requiredLimits[key] = value
  }
  const device = await adapter.requestDevice({
    requiredFeatures: [...adapter.features] as GPUFeatureName[],
    requiredLimits,
  })

  // Every loss except our own dispose() is reported, including a destroy()
  // from outside: the harness uses one to rehearse recovery.
  let disposing = false
  const lost = device.lost.then((info) =>
    disposing ? new Promise<GPUDeviceLostInfo>(() => {}) : info,
  )
  const dispose = (): void => {
    disposing = true
    device.destroy()
  }

  logAdapter(adapter, device)
  return { adapter, device, lost, dispose }
}

function logAdapter(adapter: GPUAdapter, device: GPUDevice): void {
  const info = adapter.info
  console.groupCollapsed(
    `[gpu] ${info.vendor} ${info.architecture} ${info.description || info.device}`.trim(),
  )
  console.log('adapter info', {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: (info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter,
  })
  console.log('features', [...device.features].sort())
  const limits: Record<string, number> = {}
  for (const key in device.limits) limits[key] = device.limits[key as keyof GPUSupportedLimits] as number
  console.log('limits', JSON.stringify(limits))
  console.groupEnd()
}
