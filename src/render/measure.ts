/**
 * Measurements on a read-back HDR image (RGBA float, row-major, y down) of
 * a single out-of-focus point: the acceptance checks for the exact path.
 */
export interface DiscMeasure {
  /** Area-equivalent diameter from energy: 2·√(ΣL / (π·plateau)), px. */
  diameterPx: number
  /** Area-equivalent diameter of the region above half the plateau, px. */
  thresholdDiameterPx: number
  plateau: number
  centroid: { x: number; y: number }
  /** Extent above / below the centroid at half plateau: > 1 when a vertex points up. */
  upDownRatio: number
  /**
   * Pentagon orientation from the energy-weighted 5th complex moment
   * Σ L·(dx + i·dy)⁵ (image y down): its phase is 5× a vertex direction, so
   * +1 means a vertex points up and −1 down. Lower harmonics vanish for a
   * 5-fold symmetric shape (a pentagon has no skew), and no threshold is
   * involved, so noise at a sharp tip cannot flip it.
   */
  pentagonUp: number
}

const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function measureDisc(rgba: Float32Array, width: number, height: number): DiscMeasure {
  const L = new Float32Array(width * height)
  let max = 0
  let sum = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < width * height; i++) {
    const w = rgba[i * 4 + 3] || 1
    const l = luminance(rgba[i * 4] / w, rgba[i * 4 + 1] / w, rgba[i * 4 + 2] / w)
    L[i] = l
    max = Math.max(max, l)
    sum += l
    sx += l * (i % width)
    sy += l * Math.floor(i / width)
  }
  // Plateau: mean of the flat interior, robust to sampling noise at the peak.
  let pSum = 0
  let pN = 0
  for (const l of L) {
    if (l > 0.7 * max) {
      pSum += l
      pN++
    }
  }
  const plateau = pSum / Math.max(1, pN)
  const centroid = { x: sx / sum, y: sy / sum }
  let above = 0
  let up = 0
  let down = 0
  for (let i = 0; i < width * height; i++) {
    if (L[i] < 0.5 * plateau) continue
    above++
    const dy = Math.floor(i / width) + 0.5 - (centroid.y + 0.5)
    up = Math.max(up, -dy)
    down = Math.max(down, dy)
  }
  let re = 0
  let im = 0
  for (let i = 0; i < width * height; i++) {
    const dx = (i % width) - centroid.x
    const dy = Math.floor(i / width) - centroid.y
    const r = Math.hypot(dx, dy)
    const a = 5 * Math.atan2(dy, dx)
    re += L[i] * r ** 5 * Math.cos(a)
    im += L[i] * r ** 5 * Math.sin(a)
  }
  return {
    pentagonUp: -im / Math.max(1e-12, Math.hypot(re, im)),
    diameterPx: 2 * Math.sqrt(sum / (Math.PI * plateau)),
    thresholdDiameterPx: 2 * Math.sqrt(above / Math.PI),
    plateau,
    centroid,
    upDownRatio: up / Math.max(1e-6, down),
  }
}
