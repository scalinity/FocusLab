import { describe, expect, it } from 'vitest'
import { blurPixels, sensorDistance, signedBlur } from './thinLens'
import { blurUniforms, derive, metresToMm } from './world'

describe('mm ↔ m boundary', () => {
  it('shader blur uniforms reproduce signedBlur in pixels from metres', () => {
    const lens = { f: 50, N: 2, si: sensorDistance(50, 3000) }
    const u = blurUniforms(lens, 1920)
    for (const dM of [0.35, 1.5, 3, 6, 40, Infinity]) {
      const shader = u.cocScalePx * (u.kPerM - 1 / dM)
      const reference = blurPixels(signedBlur(lens, metresToMm(dM)), 1920)
      expect(shader).toBeCloseTo(reference, 9)
    }
  })

  it('derived values are reported in metres on the object side', () => {
    const d = derive({ f: 50, N: 8, si: sensorDistance(50, 3000), lab: false })
    expect(d.focusM).toBeCloseTo(3, 9)
    expect(d.hyperfocalM).toBeCloseTo(10.467, 3)
    expect(d.dofNearM).toBeCloseTo(2.338, 3)
    expect(d.dofFarM).toBeCloseTo(4.185, 3)
    expect(d.extensionMm).toBeCloseTo(0.847, 3)
  })

  it('past infinity there is no focus distance', () => {
    const d = derive({ f: 50, N: 2, si: 49, lab: true })
    expect(d.focusM).toBeNull()
    expect(d.kPerM).toBeLessThan(0)
  })
})
