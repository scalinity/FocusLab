import { describe, expect, it } from 'vitest'
import {
  COC_MM,
  blur,
  blurPixels,
  depthOfField,
  focusDistance,
  focusPower,
  hyperfocal,
  magnification,
  sensorDistance,
  signedBlur,
  type Lens,
} from './thinLens'
import { F_STOPS } from './stops'

const lensAt = (f: number, N: number, soMm: number): Lens => ({ f, N, si: sensorDistance(f, soMm) })

describe('spec test vectors', () => {
  it('f=50 focused at 3 m → s_i ≈ 50.847 mm', () => {
    expect(sensorDistance(50, 3000)).toBeCloseTo(50.847, 3)
  })

  it('f=50, f/2, focused 3 m, object at 6 m → c ≈ 0.2119 mm ≈ 11.3 px at 1920', () => {
    const c = blur(lensAt(50, 2, 3000), 6000)
    expect(c).toBeCloseTo(0.2119, 4)
    expect(blurPixels(c, 1920)).toBeCloseTo(11.3, 1)
  })

  it('f=50, f/8, c₀=0.03 → H ≈ 10.467 m; focused 3 m → near ≈ 2.338 m, far ≈ 4.185 m', () => {
    expect(hyperfocal(50, 8, 0.03)).toBeCloseTo(10466.67, 1)
    const dof = depthOfField(lensAt(50, 8, 3000), 0.03)!
    expect(dof.near).toBeCloseTo(2337.9, 0)
    expect(dof.far).toBeCloseTo(4185.3, 0)
  })

  it('s_i = f → s_o = ∞ and c(∞) = 0', () => {
    const lens = { f: 50, N: 2, si: 50 }
    expect(focusDistance(50, 50)).toBe(Infinity)
    expect(blur(lens, Infinity)).toBe(0)
  })

  it('an object exactly at s_o has c = 0 for every N', () => {
    for (const N of F_STOPS) {
      const lens = lensAt(50, N, 3000)
      expect(blur(lens, focusDistance(lens.f, lens.si)!)).toBeLessThan(1e-12)
    }
  })
})

describe('edge cases', () => {
  it('s_i < f has no real focus but finite blur everywhere, including sky', () => {
    const lens = { f: 50, N: 2, si: 49 }
    expect(focusPower(50, 49)).toBeLessThan(0)
    expect(focusDistance(50, 49)).toBeNull()
    for (const d of [300, 3000, 1e6, Infinity]) {
      const c = blur(lens, d)
      expect(Number.isFinite(c)).toBe(true)
      expect(c).toBeGreaterThan(0)
    }
  })

  it('sky (1/d = 0) blur is A·s_i·k when focused closer than infinity', () => {
    const lens = lensAt(50, 2, 3000)
    expect(blur(lens, Infinity)).toBeCloseTo(25 * lens.si * focusPower(50, lens.si), 12)
  })

  it('signed blur is negative in the near field and positive in the far field', () => {
    const lens = lensAt(50, 2, 3000)
    expect(signedBlur(lens, 1000)).toBeLessThan(0)
    expect(signedBlur(lens, 10000)).toBeGreaterThan(0)
  })

  it('DoF limits are exactly where |c(d)| = c₀', () => {
    for (const N of [1.4, 4, 16]) {
      for (const so of [500, 3000, 20000]) {
        const lens = lensAt(85, N, so)
        const dof = depthOfField(lens)!
        expect(blur(lens, dof.near)).toBeCloseTo(COC_MM, 10)
        if (dof.far !== Infinity) expect(blur(lens, dof.far)).toBeCloseTo(COC_MM, 10)
      }
    }
  })

  it('DoF matches the textbook s_o·H′/(H′ ± (s_o − f)) form', () => {
    const f = 35
    const N = 5.6
    const so = 4000
    const Hp = (f * f) / (N * COC_MM)
    const dof = depthOfField(lensAt(f, N, so))!
    expect(dof.near).toBeCloseTo((so * Hp) / (Hp + (so - f)), 8)
    expect(dof.far).toBeCloseTo((so * Hp) / (Hp - (so - f)), 6)
  })

  it('focused at the hyperfocal distance, the far limit is ∞ and the near limit is ≈ H/2', () => {
    const H = hyperfocal(50, 8)
    const dof = depthOfField(lensAt(50, 8, H))!
    expect(dof.far).toBeGreaterThan(1e9)
    expect(dof.near).toBeCloseTo(H / 2, -1)
  })

  it('at infinity focus the near limit is H′ = f²/(N·c₀)', () => {
    const dof = depthOfField({ f: 50, N: 8, si: 50 })!
    expect(dof.near).toBeCloseTo(2500 / (8 * COC_MM), 6)
    expect(dof.far).toBe(Infinity)
  })

  it('past infinity, DoF is null when even the sky is outside c₀', () => {
    expect(depthOfField({ f: 50, N: 1.4, si: 47.5 })).toBeNull()
  })

  it('magnification is s_i/s_o, 0 at infinity and negative past it', () => {
    const lens = lensAt(50, 2, 3000)
    expect(magnification(lens)).toBeCloseTo(lens.si / 3000, 12)
    expect(magnification({ f: 50, N: 2, si: 50 })).toBe(0)
    expect(magnification({ f: 50, N: 2, si: 49 })).toBeLessThan(0)
  })
})
