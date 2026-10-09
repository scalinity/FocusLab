import { describe, expect, it } from 'vitest'
import { CIRCULAR, apertureRadius, sampleAperture, type Aperture } from './aperture'
import { halton, r2 } from './sequence'
import { addSamples, exposeNow, initialExposure, onInput, tick } from '../state/renderState'
import { measureDisc } from '../render/measure'

describe('low-discrepancy sequences', () => {
  it('Halton base 2 is the bit-reversed index', () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125])
  })

  it('R2 covers the unit square evenly for any prefix', () => {
    const n = 256
    const cells = new Set<number>()
    for (let i = 0; i < n; i++) {
      const [x, y] = r2(i)
      cells.add(Math.floor(x * 16) * 16 + Math.floor(y * 16))
    }
    expect(cells.size).toBeGreaterThan(0.6 * n)
  })
})

describe('aperture sampling', () => {
  const shapes: Aperture[] = [CIRCULAR, { blades: 5, roundness: 0, rotation: Math.PI / 2 }, { blades: 9, roundness: 0.6, rotation: 0.1 }]

  it('every sample lies inside the opening', () => {
    for (const ap of shapes) {
      for (let i = 0; i < 2000; i++) {
        const [x, y] = sampleAperture(ap, ...r2(i))
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(apertureRadius(ap, 2, Math.atan2(y, x)) + 1e-6)
      }
    }
  })

  it('is area-uniform: centred, with the second moment of the shape', () => {
    // A uniform unit disc has E[r²] = 1/2; area-equivalent polygons are close to it.
    for (const ap of shapes) {
      let mx = 0
      let my = 0
      let r2sum = 0
      const n = 8192
      for (let i = 0; i < n; i++) {
        const [x, y] = sampleAperture(ap, ...r2(i))
        mx += x
        my += y
        r2sum += x * x + y * y
      }
      expect(Math.abs(mx / n)).toBeLessThan(0.01)
      expect(Math.abs(my / n)).toBeLessThan(0.01)
      expect(r2sum / n).toBeGreaterThan(0.49)
      expect(r2sum / n).toBeLessThan(0.53)
    }
  })
})

describe('render state machine', () => {
  it('auto-exposes after 350 ms idle, develops at the target and returns to live on input', () => {
    let e = initialExposure(0, 256)
    expect(tick(e, 300, true).mode).toBe('LIVE')
    expect(tick(e, 400, false).mode).toBe('LIVE')
    e = tick(e, 400, true)
    expect(e.mode).toBe('EXPOSING')
    e = addSamples(e, 200)
    expect(e.mode).toBe('EXPOSING')
    e = addSamples(e, 100)
    expect(e).toMatchObject({ mode: 'DEVELOPED', samples: 256 })
    e = onInput(e, 1000)
    expect(e).toMatchObject({ mode: 'LIVE', samples: 0 })
    expect(exposeNow(e).mode).toBe('EXPOSING')
  })
})

/** A uniform shape rendered with 8×8 supersampling into an RGBA float image. */
function synthetic(size: number, inside: (x: number, y: number) => boolean): Float32Array {
  const img = new Float32Array(size * size * 4)
  const c = size / 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0
      for (let sy = 0; sy < 8; sy++) {
        for (let sx = 0; sx < 8; sx++) {
          if (inside(px + (sx + 0.5) / 8 - c, py + (sy + 0.5) / 8 - c)) cover++
        }
      }
      const i = (py * size + px) * 4
      img[i] = img[i + 1] = img[i + 2] = (3 * cover) / 64
      img[i + 3] = 1
    }
  }
  return img
}

describe('disc measurement', () => {
  it('recovers an 11.3 px disc diameter', () => {
    const m = measureDisc(synthetic(48, (x, y) => Math.hypot(x, y) <= 11.3 / 2), 48, 48)
    expect(m.diameterPx).toBeCloseTo(11.3, 1)
    expect(Math.abs(m.thresholdDiameterPx / 11.3 - 1)).toBeLessThan(0.03)
  })

  it('tells a vertex-up pentagon from a vertex-down one (image y points down)', () => {
    const pentagon = (sign: number) => (x: number, y: number) =>
      Math.hypot(x, y) <= apertureRadius({ blades: 5, roundness: 0, rotation: Math.PI / 2 }, 20, Math.atan2(-sign * y, x))
    const up = measureDisc(synthetic(48, pentagon(1)), 48, 48)
    const down = measureDisc(synthetic(48, pentagon(-1)), 48, 48)
    expect(up.upDownRatio).toBeGreaterThan(1.12)
    expect(down.upDownRatio).toBeLessThan(0.9)
    expect(up.pentagonUp).toBeGreaterThan(0.95)
    expect(down.pentagonUp).toBeLessThan(-0.95)
  })
})
