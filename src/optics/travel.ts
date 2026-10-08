import { focusDistance, sensorDistance } from './thinLens'

/**
 * Lens travel. The infinity stop sits at s_i = f. Close focus is set by a
 * maximum magnification of 0.2 (1:5) for every focal length, which puts the
 * minimum focus distance at 6f: 0.3 m for 50 mm, 0.81 m for 135 mm.
 */
export const MAX_MAGNIFICATION = 0.2

export const closeFocusDistance = (f: number): number => f * (1 + 1 / MAX_MAGNIFICATION)

/** Largest s_i the helicoid allows (close focus), mm. */
export const maxSensorDistance = (f: number): number => f * (1 + MAX_MAGNIFICATION)

/** Lab mode lets the lens travel this far inside the infinity stop (fraction of f). */
export const LAB_PAST_INFINITY = 0.05

export const minSensorDistance = (f: number, lab: boolean): number =>
  lab ? f * (1 - LAB_PAST_INFINITY) : f

/**
 * Overshoot past a hard stop, compressed with resistance: grows almost 1:1 at
 * first and approaches `limit` asymptotically.
 */
export function rubberBand(overshoot: number, limit: number): number {
  return limit * (1 - 1 / ((overshoot * 0.55) / limit + 1))
}

/** Rubber-band reach past either stop, as a fraction of f. */
const BAND_LIMIT = 0.01

/** Map a requested s_i onto the travel the lens allows, rubber-banding past the stops. */
export function constrainTravel(f: number, si: number, lab: boolean): number {
  const lo = minSensorDistance(f, lab)
  const hi = maxSensorDistance(f)
  const limit = BAND_LIMIT * f
  if (si < lo) return lo - rubberBand(lo - si, limit)
  if (si > hi) return hi + rubberBand(si - hi, limit)
  return si
}

/** Hard clamp to the stops, used when a drag is released. */
export function clampTravel(f: number, si: number, lab: boolean): number {
  return Math.min(maxSensorDistance(f), Math.max(minSensorDistance(f, lab), si))
}

/**
 * New s_i after swapping to focal length `fNew`, holding the focus distance
 * (clamped to the new lens's close focus). Past infinity there is no focus
 * distance to hold, so the relative extension s_i/f is kept instead.
 */
export function swapLens(f: number, si: number, fNew: number, lab: boolean): number {
  const so = focusDistance(f, si)
  if (so === null) return clampTravel(fNew, (si / f) * fNew, lab)
  return clampTravel(fNew, sensorDistance(fNew, Math.max(so, closeFocusDistance(fNew))), lab)
}
