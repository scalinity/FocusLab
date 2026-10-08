import { describe, expect, it } from 'vitest'
import { focusDistance, sensorDistance } from './thinLens'
import {
  clampTravel,
  closeFocusDistance,
  constrainTravel,
  maxSensorDistance,
  minSensorDistance,
  swapLens,
} from './travel'
import { FOCUS_OMEGA, stepSpring } from './spring'

describe('lens travel', () => {
  it('close focus is 0.3 m for 50 mm and scales with f', () => {
    expect(closeFocusDistance(50)).toBeCloseTo(300, 9)
    expect(closeFocusDistance(135)).toBeCloseTo(810, 9)
    expect(focusDistance(50, maxSensorDistance(50))).toBeCloseTo(300, 6)
  })

  it('the infinity stop is s_i = f; Lab mode allows travel past it', () => {
    expect(minSensorDistance(50, false)).toBe(50)
    expect(minSensorDistance(50, true)).toBeLessThan(50)
    expect(clampTravel(50, 40, false)).toBe(50)
  })

  it('rubber-bands past the stops with resistance and a bounded reach', () => {
    const a = constrainTravel(50, 49.9, false)
    const b = constrainTravel(50, 45, false)
    const c = constrainTravel(50, 0, false)
    expect(a).toBeLessThan(50)
    expect(b).toBeLessThan(a)
    expect(50 - b).toBeLessThan(50 - 45)
    expect(c).toBeGreaterThan(50 - 0.01 * 50)
    expect(constrainTravel(50, 52, false)).toBe(52)
  })

  it('a lens swap holds the focus distance', () => {
    const si = sensorDistance(50, 3000)
    for (const fNew of [24, 35, 85, 135]) {
      expect(focusDistance(fNew, swapLens(50, si, fNew, false))).toBeCloseTo(3000, 6)
    }
  })

  it('a lens swap clamps to the new close focus', () => {
    const si = sensorDistance(50, 400)
    expect(focusDistance(135, swapLens(50, si, 135, false))).toBeCloseTo(810, 6)
  })

  it('a lens swap at the infinity stop stays at infinity', () => {
    expect(swapLens(50, 50, 135, false)).toBeCloseTo(135, 9)
  })
})

describe('focus spring', () => {
  it('converges to the target without overshoot, ~95% in 120 ms', () => {
    let s = { x: 50, v: 0 }
    const target = 55
    let max = s.x
    let at120 = 0
    for (let t = 1; t <= 600; t++) {
      s = stepSpring(s, target, 0.001)
      max = Math.max(max, s.x)
      if (t === 120) at120 = (s.x - 50) / (target - 50)
    }
    expect(max).toBeLessThanOrEqual(target)
    expect(at120).toBeGreaterThan(0.94)
    expect(at120).toBeLessThan(0.97)
    expect(s.x).toBeCloseTo(target, 6)
  })

  it('is frame-rate independent', () => {
    let fine = { x: 0, v: 0 }
    for (let i = 0; i < 100; i++) fine = stepSpring(fine, 1, 0.001)
    const coarse = stepSpring({ x: 0, v: 0 }, 1, 0.1)
    expect(coarse.x).toBeCloseTo(fine.x, 9)
    expect(FOCUS_OMEGA).toBe(40)
  })
})
