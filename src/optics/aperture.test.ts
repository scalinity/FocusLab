import { describe, expect, it } from 'vitest'
import { CIRCULAR, apertureOutline, apertureRadius, type Aperture } from './aperture'
import { N_D, WAVELENGTH_UM, refractiveIndex, singletFor, thickFocalLength } from './glass'

function polygonArea(pts: Array<[number, number]>): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

describe('aperture', () => {
  it('a circular iris has radius A/2', () => {
    expect(apertureRadius(CIRCULAR, 25, 1.234)).toBe(12.5)
  })

  it('bladed openings are area-equivalent to the circle of diameter A', () => {
    for (const blades of [5, 6, 9, 15]) {
      for (const roundness of [0, 0.5]) {
        const ap: Aperture = { blades, roundness, rotation: 0.3 }
        const area = polygonArea(apertureOutline(ap, 25, 3600))
        expect(area / (Math.PI * 12.5 * 12.5)).toBeCloseTo(1, 3)
      }
    }
  })

  it('a straight-bladed polygon has its vertices at the rotation angle', () => {
    const ap: Aperture = { blades: 6, roundness: 0, rotation: 0.2 }
    const vertex = apertureRadius(ap, 25, 0.2)
    const edgeMid = apertureRadius(ap, 25, 0.2 + Math.PI / 6)
    expect(edgeMid / vertex).toBeCloseTo(Math.cos(Math.PI / 6), 9)
  })
})

describe('N-BK7 singlet', () => {
  it('Sellmeier gives n_d = 1.5168 and Abbe number 64.17', () => {
    expect(N_D).toBeCloseTo(1.5168, 4)
    const nF = refractiveIndex(WAVELENGTH_UM.F)
    const nC = refractiveIndex(WAVELENGTH_UM.C)
    expect((N_D - 1) / (nF - nC)).toBeCloseTo(64.17, 1)
  })

  it('the solved thick element has the requested focal length', () => {
    for (const f of [24, 35, 50, 85, 135]) {
      const s = singletFor(f)
      expect(thickFocalLength(s)).toBeCloseTo(f, 6)
      expect(s.thickness).toBeGreaterThan(0)
      expect(s.radius).toBeGreaterThan(s.diameter / 2)
    }
  })

  it('approaches the thin-lens radius 2(n−1)f', () => {
    const s = singletFor(50)
    expect(s.radius / (2 * (N_D - 1) * 50)).toBeGreaterThan(0.9)
    expect(s.radius / (2 * (N_D - 1) * 50)).toBeLessThan(1)
  })
})
