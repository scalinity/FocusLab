import { apertureOutline, type Aperture } from '../optics/aperture'
import { singletFor } from '../optics/glass'
import {
  SENSOR_HEIGHT_MM,
  SENSOR_WIDTH_MM,
  apertureDiameter,
  focusDistance,
  sensorDistance,
  signedBlur,
  type Lens,
} from '../optics/thinLens'
import { maxSensorDistance } from '../optics/travel'
import { metresToMm, mmToMetres } from '../optics/world'

/**
 * Everything the bench draws, in rig-local metres: the lens centre is the
 * origin, the camera looks along −z (object space, true scale) and image
 * space lies along +z, magnified ×N so blur circles are visible. Uniform
 * scaling keeps angles and convergence exact inside image space; the only
 * discontinuity is the lens plane, where the scale break is labelled.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Axis height of the camera (low tripod). */
export const LENS_HEIGHT_M = 0.45

/** The lens centre in world metres. The rig is level and looks along −z. */
export const LENS_WORLD: Vec3 = { x: 0, y: LENS_HEIGHT_M, z: 0 }

/** World metres → rig-local metres. */
export const toRig = (v: Vec3): Vec3 => ({ x: v.x - LENS_WORLD.x, y: v.y - LENS_WORLD.y, z: v.z - LENS_WORLD.z })

const MAX_IMAGE_SCALE = 8
/** The magnified barrel must clear the ground under the axis. */
const MAX_BARREL_RADIUS_M = 0.4
const BARREL_PER_ELEMENT = 1.15

export const barrelRadiusMm = (f: number): number => (singletFor(f).diameter / 2) * BARREL_PER_ELEMENT

/** Image-space magnification N for a focal length. */
export const imageScale = (f: number): number =>
  Math.min(MAX_IMAGE_SCALE, MAX_BARREL_RADIUS_M / mmToMetres(barrelRadiusMm(f)))

/** Image-space millimetres → rig metres at magnification N. */
const imageToRig = (mm: number, N: number): number => mmToMetres(mm * N)

export interface Subject {
  name: string
  /** Rig-local metres, object space (z < 0). */
  position: Vec3
}

export interface ImageRay {
  /** On the lens plane, image space. */
  from: Vec3
  /** Where the ray meets the image plane. */
  to: Vec3
  /** Continuation to the convergence point when it lies behind the image plane. */
  past: Vec3 | null
}

export interface Bundle {
  subject: Subject
  /** Axial distance, m. */
  axialM: number
  /** Signed blur on the sensor, mm (near −, far +). */
  blurMm: number
  /** Object-space rays: subject → points on the true aperture rim. */
  objectRays: Array<[Vec3, Vec3]>
  imageRays: ImageRay[]
  /** Convergence point, image space. */
  imagePoint: Vec3
  /** Blur outline on the image plane, image space. */
  ring: Vec3[]
}

/**
 * Ray bundle from a subject through the iris rim. Null when the subject is
 * closer than f, where a thin lens forms no real image.
 */
export function rayBundle(lens: Lens, ap: Aperture, subject: Subject, rim = 24): Bundle | null {
  const N = imageScale(lens.f)
  const p = subject.position
  const dMm = metresToMm(-p.z)
  if (dMm <= lens.f) return null
  const sd = sensorDistance(lens.f, dMm)
  // Image point (mm, lens-local, image space along +z): inverted and scaled by s_d/d.
  const ix = (-metresToMm(p.x) * sd) / dMm
  const iy = (-metresToMm(p.y) * sd) / dMm
  const imagePoint = { x: imageToRig(ix, N), y: imageToRig(iy, N), z: imageToRig(sd, N) }
  const t = lens.si / sd
  const behind = sd > lens.si

  const objectRays: Array<[Vec3, Vec3]> = []
  const imageRays: ImageRay[] = []
  const ring: Vec3[] = []
  for (const [ax, ay] of apertureOutline(ap, apertureDiameter(lens.f, lens.N), rim)) {
    objectRays.push([p, { x: mmToMetres(ax), y: mmToMetres(ay), z: 0 }])
    const hit = {
      x: imageToRig(ax + (ix - ax) * t, N),
      y: imageToRig(ay + (iy - ay) * t, N),
      z: imageToRig(lens.si, N),
    }
    ring.push(hit)
    imageRays.push({
      from: { x: imageToRig(ax, N), y: imageToRig(ay, N), z: 0 },
      to: hit,
      past: behind ? imagePoint : null,
    })
  }
  return {
    subject,
    axialM: -p.z,
    blurMm: signedBlur(lens, dMm),
    objectRays,
    imageRays,
    imagePoint,
    ring,
  }
}

/** Image plane: the sensor at s_i, image space. */
export function imagePlane(lens: Lens): { z: number; halfW: number; halfH: number } {
  const N = imageScale(lens.f)
  return {
    z: imageToRig(lens.si, N),
    halfW: imageToRig(SENSOR_WIDTH_MM / 2, N),
    halfH: imageToRig(SENSOR_HEIGHT_MM / 2, N),
  }
}

/** Far limit for drawing the plane-of-focus sheet. */
export const SHEET_MAX_M = 400

/**
 * The plane of focus as the viewfinder's frustum cross-section at s_o.
 * Null past the infinity stop, where no real plane is in focus.
 */
export function focusSheet(lens: Lens): { z: number; halfW: number; halfH: number; atInfinity: boolean } | null {
  const so = focusDistance(lens.f, lens.si)
  if (so === null) return null
  const dM = Math.min(mmToMetres(so), SHEET_MAX_M)
  return {
    z: -dM,
    halfW: (dM * SENSOR_WIDTH_MM) / 2 / lens.si,
    halfH: (dM * SENSOR_HEIGHT_MM) / 2 / lens.si,
    atInfinity: mmToMetres(so) >= SHEET_MAX_M,
  }
}

/** Focus ring sweep from ∞ to close focus. */
export const RING_SWEEP = (270 * Math.PI) / 180

/** Engraved distances (m) on the focus ring. */
export const RING_DISTANCES_M = [Infinity, 10, 5, 3, 2, 1.5, 1, 0.7, 0.5, 0.3] as const

/**
 * Ring angle of a lens extension. Extension e = s_i − f = f²/(s_o − f) is near
 * linear in 1/s_o, so the engraved scale is crowded towards ∞ as on real lenses.
 */
export const ringAngle = (f: number, si: number): number =>
  (RING_SWEEP * (si - f)) / (maxSensorDistance(f) - f)

/** Angle (relative to the index mark) where a distance sits on the turned ring. */
export const ringMarkAngle = (lens: Lens, dM: number): number =>
  ringAngle(lens.f, sensorDistance(lens.f, metresToMm(dM))) - ringAngle(lens.f, lens.si)

/**
 * The three bundles drawn: nearest subject, the subject closest to focus (in
 * dioptres) among the others, and the far subject.
 */
export function chooseSubjects(subjects: Subject[], far: Subject, kPerM: number): Subject[] {
  const byDepth = [...subjects].sort((a, b) => b.position.z - a.position.z)
  const near = byDepth[0]
  const middle = byDepth.filter((s) => s !== near && s !== far)
  let focus = middle[0]
  for (const s of middle) {
    if (Math.abs(-1 / s.position.z - kPerM) < Math.abs(-1 / focus.position.z - kPerM)) focus = s
  }
  return [near, focus, far]
}
