import { SENSOR_HEIGHT_MM, SENSOR_WIDTH_MM } from '../optics/thinLens'

/** CSS pixels, top-left origin (WebGPU viewport convention). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const ASPECT = SENSOR_WIDTH_MM / SENSOR_HEIGHT_MM
const MARGIN = 24
const CARD_SHARE = 0.34
const CARD_MIN_W = 300
const CARD_MAX_W = 620

/**
 * The viewfinder's 3:2 frame: a card at the bottom centre of the bench view,
 * or the whole window when looking through the lens. Its width is exactly the
 * 36 mm sensor width.
 */
export function viewfinderRect(width: number, height: number, mode: 'card' | 'full'): Rect {
  if (mode === 'full') {
    const w = Math.floor(Math.min(width - 2 * MARGIN, (height - 2 * MARGIN) * ASPECT))
    const h = Math.floor(w / ASPECT)
    return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), w, h }
  }
  const w = Math.floor(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, width * CARD_SHARE), width - 2 * MARGIN))
  const h = Math.floor(w / ASPECT)
  return { x: Math.floor((width - w) / 2), y: height - h - MARGIN, w, h }
}
