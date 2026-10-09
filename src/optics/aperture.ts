/**
 * Iris shape. `blades` = 0 is a circular iris; otherwise a regular polygon
 * whose straight edges bow towards a circle as `roundness` goes 0 → 1.
 * `rotation` is in the camera frame, so it is also the orientation of
 * far-field bokeh in the photo.
 *
 * The opening is area-equivalent to a circle of diameter A = f/N (how
 * f-numbers are calibrated), so blade count never changes exposure.
 */
export interface Aperture {
  blades: number
  roundness: number
  rotation: number
}

export const CIRCULAR: Aperture = { blades: 0, roundness: 1, rotation: 0 }

/** Radius at angle φ for a unit circumradius, before area normalisation. */
function shapeRadius(ap: Aperture, phi: number): number {
  if (ap.blades < 3) return 1
  const seg = (2 * Math.PI) / ap.blades
  // Angle from the nearest edge midpoint; vertices sit at rotation + i·seg.
  let delta = (phi - ap.rotation) % seg
  if (delta < 0) delta += seg
  delta -= seg / 2
  const polygon = Math.cos(Math.PI / ap.blades) / Math.cos(delta)
  return polygon + (1 - polygon) * ap.roundness
}

const AREA_STEPS = 720

/** Scale that makes the shape's area equal π (a unit-radius circle). */
function areaScale(ap: Aperture): number {
  if (ap.blades < 3) return 1
  let area = 0
  for (let i = 0; i < AREA_STEPS; i++) {
    const r = shapeRadius(ap, ((i + 0.5) / AREA_STEPS) * 2 * Math.PI)
    area += 0.5 * r * r * ((2 * Math.PI) / AREA_STEPS)
  }
  return Math.sqrt(Math.PI / area)
}

/** Opening radius (same unit as `diameter`) at angle φ for an area-equivalent diameter. */
export function apertureRadius(ap: Aperture, diameter: number, phi: number): number {
  return (diameter / 2) * areaScale(ap) * shapeRadius(ap, phi)
}

/** Closed outline of the opening as [x, y] points, `segments` long. */
export function apertureOutline(ap: Aperture, diameter: number, segments = 96): Array<[number, number]> {
  const scale = (diameter / 2) * areaScale(ap)
  const pts: Array<[number, number]> = []
  for (let i = 0; i < segments; i++) {
    const phi = (i / segments) * 2 * Math.PI
    const r = scale * shapeRadius(ap, phi)
    pts.push([r * Math.cos(phi), r * Math.sin(phi)])
  }
  return pts
}

const CDF_BINS = 1024
const cdfCache = new Map<string, Float64Array>()

/** Cumulative angle distribution with density ∝ R(φ)², so area sampling is uniform. */
function angleCdf(ap: Aperture): Float64Array {
  const key = `${ap.blades}|${ap.roundness}|${ap.rotation}`
  let cdf = cdfCache.get(key)
  if (cdf === undefined) {
    cdf = new Float64Array(CDF_BINS + 1)
    for (let i = 0; i < CDF_BINS; i++) {
      const r = shapeRadius(ap, ((i + 0.5) / CDF_BINS) * 2 * Math.PI)
      cdf[i + 1] = cdf[i] + r * r
    }
    for (let i = 1; i <= CDF_BINS; i++) cdf[i] /= cdf[CDF_BINS]
    cdfCache.set(key, cdf)
  }
  return cdf
}

/**
 * Area-uniform point in the opening from two numbers in [0, 1): the angle
 * from the R(φ)² distribution, the radius as R(φ)·√u. Units: the radius of the
 * area-equivalent circle, so a circular iris fills the unit disc. Feeding a
 * low-discrepancy sequence keeps every prefix of samples well spread.
 */
export function sampleAperture(ap: Aperture, u1: number, u2: number): [number, number] {
  let phi: number
  if (ap.blades < 3) {
    phi = u1 * 2 * Math.PI
  } else {
    const cdf = angleCdf(ap)
    let lo = 0
    let hi = CDF_BINS
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] <= u1) lo = mid
      else hi = mid
    }
    const t = (u1 - cdf[lo]) / (cdf[lo + 1] - cdf[lo] || 1)
    phi = ((lo + t) / CDF_BINS) * 2 * Math.PI
  }
  const r = areaScale(ap) * shapeRadius(ap, phi) * Math.sqrt(u2)
  return [r * Math.cos(phi), r * Math.sin(phi)]
}
