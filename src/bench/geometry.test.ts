import { describe, expect, it } from 'vitest'
import { CIRCULAR, type Aperture } from '../optics/aperture'
import { blur, sensorDistance, type Lens } from '../optics/thinLens'
import { closeFocusDistance, minSensorDistance } from '../optics/travel'
import { metresToMm, mmToMetres } from '../optics/world'
import {
  barrelRadiusMm,
  chooseSubjects,
  focusSheet,
  imagePlane,
  imageScale,
  ringMarkAngle,
  rayBundle,
  type Subject,
} from './geometry'

const subject = (name: string, x: number, y: number, d: number): Subject => ({
  name,
  position: { x, y, z: -d },
})

const SUBJECTS = [subject('near', 0.05, -0.03, 0.35), subject('mid', -0.4, 0.2, 3), subject('far', 2, 1.5, 40)]

function lensStates(): Lens[] {
  const states: Lens[] = []
  for (const f of [24, 50, 135]) {
    for (const N of [1.4, 8]) {
      for (const si of [
        f,
        sensorDistance(f, 3000),
        sensorDistance(f, closeFocusDistance(f)),
        minSensorDistance(f, true),
      ]) {
        states.push({ f, N, si })
      }
    }
  }
  return states
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

describe('bench geometry (M1 acceptance)', () => {
  it('image points sit at N·s_d behind the lens, inverted', () => {
    for (const lens of lensStates()) {
      const N = imageScale(lens.f)
      for (const s of SUBJECTS) {
        const b = rayBundle(lens, CIRCULAR, s)!
        const d = metresToMm(-s.position.z)
        const sd = sensorDistance(lens.f, d)
        expect(b.imagePoint.z).toBeCloseTo(mmToMetres(N * sd), 12)
        expect(b.imagePoint.y).toBeCloseTo(-mmToMetres(N * metresToMm(s.position.y) * (sd / d)), 12)
      }
    }
  })

  it('the blur ring on the image plane has diameter N·c(d)', () => {
    for (const lens of lensStates()) {
      const N = imageScale(lens.f)
      for (const s of SUBJECTS) {
        const b = rayBundle(lens, CIRCULAR, s, 48)!
        const c = blur(lens, metresToMm(-s.position.z))
        let diameter = 0
        for (let i = 0; i < 24; i++) diameter = Math.max(diameter, dist(b.ring[i], b.ring[i + 24]))
        expect(diameter).toBeCloseTo(mmToMetres(N * c), 12)
        expect(Math.abs(b.blurMm)).toBeCloseTo(c, 12)
      }
    }
  })

  it('rays end on the image plane and continue to the image point only when it lies behind it', () => {
    for (const lens of lensStates()) {
      const plane = imagePlane(lens)
      for (const s of SUBJECTS) {
        const b = rayBundle(lens, CIRCULAR, s)!
        for (const r of b.imageRays) {
          expect(r.to.z).toBeCloseTo(plane.z, 12)
          expect(r.from.z).toBe(0)
          expect(r.past !== null).toBe(b.imagePoint.z > plane.z)
        }
      }
    }
  })

  it('the bundle orientation on the image plane flips across focus', () => {
    const lens: Lens = { f: 50, N: 2, si: sensorDistance(50, 3000) }
    const pentagon: Aperture = { blades: 5, roundness: 0, rotation: Math.PI / 2 }
    const onAxis = (d: number): Subject => subject('axis', 0, 0, d)
    const near = rayBundle(lens, pentagon, onAxis(1))!
    const far = rayBundle(lens, pentagon, onAxis(20))!
    // Rim point 6 of 24 is the vertex at +90°: on the inverted sensor it stays up
    // for near subjects (a·s_i·(1/d − k) > 0) and points down for far ones.
    expect(near.ring[6].y).toBeGreaterThan(0)
    expect(far.ring[6].y).toBeLessThan(0)
  })

  it('object-space rays run from the subject to the true aperture rim', () => {
    const lens: Lens = { f: 50, N: 2, si: sensorDistance(50, 3000) }
    const b = rayBundle(lens, CIRCULAR, SUBJECTS[1], 8)!
    for (const [from, to] of b.objectRays) {
      expect(from).toEqual(SUBJECTS[1].position)
      expect(Math.hypot(to.x, to.y)).toBeCloseTo(mmToMetres(25 / 2), 12)
      expect(to.z).toBe(0)
    }
  })

  it('the plane-of-focus sheet is the frustum cross-section at s_o', () => {
    const lens: Lens = { f: 50, N: 2, si: sensorDistance(50, 3000) }
    const sheet = focusSheet(lens)!
    expect(sheet.z).toBeCloseTo(-3, 9)
    expect(sheet.halfW).toBeCloseTo((3 * 18) / lens.si, 9)
    expect(sheet.halfH).toBeCloseTo((3 * 12) / lens.si, 9)
    expect(focusSheet({ f: 50, N: 2, si: 49 })).toBeNull()
    expect(focusSheet({ f: 50, N: 2, si: 50 })!.atInfinity).toBe(true)
  })

  it('the focus ring index reads the current focus distance; DoF marks straddle it', () => {
    const lens: Lens = { f: 50, N: 8, si: sensorDistance(50, 3000) }
    expect(ringMarkAngle(lens, 3)).toBeCloseTo(0, 12)
    expect(ringMarkAngle(lens, 2)).toBeGreaterThan(0)
    expect(ringMarkAngle(lens, 5)).toBeLessThan(0)
    expect(ringMarkAngle(lens, Infinity)).toBeLessThan(ringMarkAngle(lens, 10))
  })

  it('the magnified barrel clears the ground for every lens', () => {
    for (const f of [24, 35, 50, 85, 135]) {
      expect(mmToMetres(barrelRadiusMm(f) * imageScale(f))).toBeLessThanOrEqual(0.4 + 1e-12)
    }
    expect(imageScale(50)).toBe(8)
  })

  it('picks the nearest, the in-focus and the far subject', () => {
    const cards = [0.35, 0.8, 1.5, 3, 7, 15, 40].map((d) => subject(`${d}`, 0, 0, d))
    const far = cards[6]
    expect(chooseSubjects(cards, far, 1 / 3).map((s) => s.name)).toEqual(['0.35', '3', '40'])
    expect(chooseSubjects(cards, far, 0).map((s) => s.name)).toEqual(['0.35', '15', '40'])
  })
})
