import { sensorDistance } from '../optics/thinLens'
import { clampTravel, closeFocusDistance, constrainTravel, minSensorDistance } from '../optics/travel'
import { metresToMm, mmToMetres } from '../optics/world'
import { store } from './store'

/**
 * Focus intents. Every control writes `siTarget`; the spring in the frame
 * loop moves `si`, which the render, the bench and the readouts all follow.
 */

/** Focus power k in 1/m for a lens-to-sensor distance. */
const kPerM = (f: number, si: number): number => metresToMm(1 / f - 1 / si)

const siForK = (f: number, k: number): number => 1 / (1 / f - mmToMetres(k))

/** Range of the distance control in dioptres: close focus … ∞ (or past it in Lab mode). */
export function dioptreRange(): { max: number; min: number } {
  const { f, lab } = store.get().optics
  return { max: 1 / mmToMetres(closeFocusDistance(f)), min: kPerM(f, minSensorDistance(f, lab)) }
}

export function focusAtDioptres(k: number, dragging = false): void {
  const { f, lab } = store.get().optics
  const si = siForK(f, k)
  store.setOptics({ siTarget: dragging ? constrainTravel(f, si, lab) : clampTravel(f, si, lab) })
}

export function focusAtDistance(dM: number): void {
  const { f, lab } = store.get().optics
  store.setOptics({ siTarget: clampTravel(f, sensorDistance(f, metresToMm(dM)), lab) })
}

/** Move the target by a fraction of the full dioptre range. */
export function nudgeFocus(fraction: number): void {
  const { f, siTarget } = store.get().optics
  const r = dioptreRange()
  focusAtDioptres(kPerM(f, siTarget) + fraction * (r.max - r.min))
}

/** Unconstrained drag on s_i (mm); release clamps back inside the stops. */
export function dragFocus(siRaw: number, release: boolean): void {
  const { f, lab } = store.get().optics
  store.setOptics({ siTarget: release ? clampTravel(f, siRaw, lab) : constrainTravel(f, siRaw, lab) })
}

export function setLab(lab: boolean): void {
  const { f, si, siTarget } = store.get().optics
  store.setOptics({ lab, siTarget: clampTravel(f, siTarget, lab), si: lab ? si : Math.max(si, f) })
}
