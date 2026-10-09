import {
  SENSOR_WIDTH_MM,
  apertureDiameter,
  depthOfField,
  focusDistance,
  focusPower,
  horizontalFov,
  hyperfocal,
  magnification,
  verticalFov,
  type Lens,
} from './thinLens'

/**
 * The one boundary between the camera (millimetres) and the world (metres).
 * Nothing else in the codebase converts units.
 */
const MM_PER_M = 1000

export const metresToMm = (m: number): number => m * MM_PER_M

export const mmToMetres = (mm: number): number => mm / MM_PER_M

export interface OpticsState extends Lens {
  /** Lab mode: the lens may travel past the infinity stop. */
  lab: boolean
}

/** Values every view reads; names carry their unit. */
export interface Derived {
  apertureMm: number
  /** Focus power k, 1/m (0 at infinity, negative past it). */
  kPerM: number
  /** Focus distance, m. Infinity at the stop, null past it. */
  focusM: number | null
  /** Lens extension from the infinity stop, mm. */
  extensionMm: number
  magnification: number
  hyperfocalM: number
  dofNearM: number | null
  dofFarM: number | null
  hfov: number
  vfov: number
}

export function derive(s: OpticsState): Derived {
  const so = focusDistance(s.f, s.si)
  const dof = depthOfField(s)
  return {
    apertureMm: apertureDiameter(s.f, s.N),
    kPerM: focusPower(s.f, s.si) * MM_PER_M,
    focusM: so === null ? null : mmToMetres(so),
    extensionMm: s.si - s.f,
    magnification: magnification(s),
    hyperfocalM: mmToMetres(hyperfocal(s.f, s.N)),
    dofNearM: dof === null ? null : mmToMetres(dof.near),
    dofFarM: dof === null ? null : mmToMetres(dof.far),
    hfov: horizontalFov(s.si),
    vfov: verticalFov(s.si),
  }
}

/**
 * Shader-facing constants for per-pixel blur from view depth in metres:
 * cocPx = cocScalePx · (kPerM − 1/d_m). Same formula as `signedBlur`.
 */
export interface BlurUniforms {
  kPerM: number
  cocScalePx: number
}

export function blurUniforms(lens: Lens, renderWidthPx: number): BlurUniforms {
  const A = apertureDiameter(lens.f, lens.N)
  return {
    kPerM: focusPower(lens.f, lens.si) * MM_PER_M,
    cocScalePx: (A * lens.si * renderWidthPx) / (SENSOR_WIDTH_MM * MM_PER_M),
  }
}

/** Aperture radius in world metres, for the exact path's camera offsets. */
export const apertureRadiusM = (lens: Lens): number => mmToMetres(apertureDiameter(lens.f, lens.N) / 2)
