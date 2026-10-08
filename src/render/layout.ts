import { SENSOR_HEIGHT_MM, SENSOR_WIDTH_MM } from '../optics/thinLens'

/** CSS pixels, top-left origin (WebGPU viewport convention). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  bench: Rect
  /** The viewfinder panel. */
  panel: Rect
  /** The 3:2 sensor frame inside the panel: its width is exactly 36 mm. */
  frame: Rect
  stacked: boolean
}

const BENCH_SHARE = 0.38
const FRAME_MARGIN = 24
const STACK_BELOW_WIDTH = 820

export function computeLayout(width: number, height: number): Layout {
  const stacked = width < STACK_BELOW_WIDTH
  let bench: Rect
  let panel: Rect
  if (stacked) {
    const panelH = Math.round(height * (1 - BENCH_SHARE))
    panel = { x: 0, y: 0, w: width, h: panelH }
    bench = { x: 0, y: panelH, w: width, h: height - panelH }
  } else {
    const benchW = Math.round(width * BENCH_SHARE)
    bench = { x: 0, y: 0, w: benchW, h: height }
    panel = { x: benchW, y: 0, w: width - benchW, h: height }
  }
  return { bench, panel, frame: fitFrame(panel), stacked }
}

function fitFrame(panel: Rect): Rect {
  const aspect = SENSOR_WIDTH_MM / SENSOR_HEIGHT_MM
  const availW = Math.max(1, panel.w - 2 * FRAME_MARGIN)
  const availH = Math.max(1, panel.h - 2 * FRAME_MARGIN)
  const w = Math.floor(Math.min(availW, availH * aspect))
  const h = Math.floor(w / aspect)
  return {
    x: panel.x + Math.floor((panel.w - w) / 2),
    y: panel.y + Math.floor((panel.h - h) / 2),
    w,
    h,
  }
}
