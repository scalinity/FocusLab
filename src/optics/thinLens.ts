/**
 * Thin-lens optics. Pure functions, millimetres throughout; `world.ts` is the
 * only place that converts to metres.
 *
 * Focus is carried as the focus power k = 1/f − 1/s_i (1/mm): 0 at the
 * infinity stop, positive for real focus (s_o = 1/k), negative past infinity
 * where no real object is in focus. Every blur and depth-of-field result is
 * written in terms of k so it stays finite at infinity and valid past it.
 */

export const SENSOR_WIDTH_MM = 36
export const SENSOR_HEIGHT_MM = 24
/** Acceptable circle of confusion for 36 × 24 mm. */
export const COC_MM = 0.03

export interface Lens {
  /** Focal length, mm. */
  f: number
  /** f-number. */
  N: number
  /** Lens-to-sensor distance, mm. */
  si: number
}

export const apertureDiameter = (f: number, N: number): number => f / N

/** k = 1/f − 1/s_i, in 1/mm. */
export const focusPower = (f: number, si: number): number => 1 / f - 1 / si

/** Object distance in focus (mm). Infinity at the infinity stop; null past it. */
export function focusDistance(f: number, si: number): number | null {
  const k = focusPower(f, si)
  if (k < 0) return null
  return k === 0 ? Infinity : 1 / k
}

/** Lens-to-sensor distance (mm) that focuses an object at `so` mm (Infinity allowed). */
export const sensorDistance = (f: number, so: number): number => 1 / (1 / f - 1 / so)

/**
 * Signed blur-circle diameter on the sensor (mm) for an object at axial
 * distance `d` mm (Infinity for sky): c = A·s_i·(k − 1/d).
 * Negative in the near field, positive in the far field.
 *
 * An aperture point `a` (camera frame) moves the image point by a·s_i·(1/d − k)
 * on the sensor, which is inverted; in the displayed photo that becomes
 * a·s_i·(k − 1/d), the same sign as c. So far-field bokeh shows the aperture
 * upright in the photo, and near-field bokeh shows it rotated 180°.
 */
export function signedBlur(lens: Lens, d: number): number {
  const A = apertureDiameter(lens.f, lens.N)
  return A * lens.si * (focusPower(lens.f, lens.si) - 1 / d)
}

export const blur = (lens: Lens, d: number): number => Math.abs(signedBlur(lens, d))

/** Hyperfocal distance H = f²/(N·c₀) + f, mm. */
export const hyperfocal = (f: number, N: number, c0 = COC_MM): number => (f * f) / (N * c0) + f

export interface DepthOfField {
  /** Near limit, mm. */
  near: number
  /** Far limit, mm (Infinity when it reaches infinity). */
  far: number
}

/**
 * Depth of field as the roots of |c(d)| = c₀, solved in 1/d:
 * 1/d = k ± c₀/(A·s_i). For real focus this equals the textbook
 * s_o·H′/(H′ ± (s_o − f)); it also holds at infinity focus and past it.
 * Returns null when nothing at any distance is within c₀.
 */
export function depthOfField(lens: Lens, c0 = COC_MM): DepthOfField | null {
  const A = apertureDiameter(lens.f, lens.N)
  const k = focusPower(lens.f, lens.si)
  const half = c0 / (A * lens.si)
  const invNear = k + half
  const invFar = k - half
  if (invNear <= 0) return null
  return { near: 1 / invNear, far: invFar > 0 ? 1 / invFar : Infinity }
}

/** Lateral magnification s_i/s_o, written as s_i·k: 0 at infinity, negative past it. */
export const magnification = (lens: Lens): number => lens.si * focusPower(lens.f, lens.si)

/** Horizontal field of view (radians). The projection uses s_i, not f: focus breathing. */
export const horizontalFov = (si: number): number => 2 * Math.atan(SENSOR_WIDTH_MM / 2 / si)

export const verticalFov = (si: number): number => 2 * Math.atan(SENSOR_HEIGHT_MM / 2 / si)

/** Blur in pixels for a render whose width spans the 36 mm sensor. */
export const blurPixels = (cMm: number, renderWidthPx: number): number =>
  (cMm / SENSOR_WIDTH_MM) * renderWidthPx
