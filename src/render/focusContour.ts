import { Fn, abs, float, fwidth, positionWorld, smoothstep, step, uniform, vec3 } from 'three/tsl'
import { Vector3 } from 'three/webgpu'

/**
 * The bright line where the plane of focus cuts the world: the zero crossing
 * of (1/d − k), with d the axial distance from the lens. fwidth keeps it about
 * one pixel wide at every distance, with no gaps on steep surfaces. Only drawn
 * inside the viewfinder's field of view. World materials add it to emission;
 * `strength` is set per view before rendering.
 *
 * A surface lying exactly on the plane (a test card at s_o) has no crossing,
 * only g ≈ 0 everywhere, so the glow also needs a measurable gradient.
 */
export const contour = {
  lens: uniform(new Vector3()),
  kPerM: uniform(0),
  /** tan of the half field of view: 18/s_i and 12/s_i. */
  tanW: uniform(0),
  tanH: uniform(0),
  strength: uniform(0),
}

const CYAN_LINEAR = vec3(0.212, 0.768, 1.0)
const GLOW = 6

export const focusContour = Fn(() => {
  const p = positionWorld.sub(contour.lens)
  const d = p.z.negate()
  const g = float(1).div(d).sub(contour.kPerM)
  const w = fwidth(g)
  const line = float(1).sub(smoothstep(0, w.mul(1.5), abs(g))).mul(smoothstep(2e-6, 2e-5, w))
  const inside = step(abs(p.x), d.mul(contour.tanW)).mul(step(abs(p.y), d.mul(contour.tanH)))
  return CYAN_LINEAR.mul(line.mul(inside).mul(contour.strength).mul(GLOW))
})
