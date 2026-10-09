/**
 * The viewfinder's two ways of seeing. LIVE is the electronic viewfinder;
 * after a pause (or Space) it EXPOSES, accumulating exact aperture samples,
 * and once the target count is reached it is DEVELOPED and the GPU idles.
 * Any change to what the photo would show returns it to LIVE.
 */
export type Mode = 'LIVE' | 'EXPOSING' | 'DEVELOPED'

export interface Exposure {
  mode: Mode
  samples: number
  target: number
  /** Time of the last input that changed the photo, ms. */
  lastInput: number
}

export const IDLE_MS = 350

export const TIER_SAMPLES = { low: 128, high: 256, ultra: 512 } as const

export const initialExposure = (now: number, target: number = TIER_SAMPLES.high): Exposure => ({
  mode: 'LIVE',
  samples: 0,
  target,
  lastInput: now,
})

/** Anything that changes the photo: back to live, accumulation discarded. */
export const onInput = (e: Exposure, now: number): Exposure => ({ ...e, mode: 'LIVE', samples: 0, lastInput: now })

/** Space: start exposing now. */
export const exposeNow = (e: Exposure): Exposure => (e.mode === 'LIVE' ? { ...e, mode: 'EXPOSING', samples: 0 } : e)

/** Auto-exposure after a pause without input. */
export function tick(e: Exposure, now: number, auto: boolean): Exposure {
  if (e.mode === 'LIVE' && auto && now - e.lastInput >= IDLE_MS) return { ...e, mode: 'EXPOSING', samples: 0 }
  return e
}

export function addSamples(e: Exposure, n: number): Exposure {
  if (e.mode !== 'EXPOSING') return e
  const samples = Math.min(e.target, e.samples + n)
  return { ...e, samples, mode: samples >= e.target ? 'DEVELOPED' : 'EXPOSING' }
}
