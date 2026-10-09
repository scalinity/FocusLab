/**
 * N-BK7 and the singlet's shape. Dispersion from the Schott Sellmeier
 * coefficients (λ in µm).
 */
const B = [1.03961212, 0.231792344, 1.01046945]
const C = [0.00600069867, 0.0200179144, 103.560653]

export const WAVELENGTH_UM = { C: 0.6562725, d: 0.5875618, F: 0.4861327 } as const

export function refractiveIndex(lambdaUm: number): number {
  const l2 = lambdaUm * lambdaUm
  let n2 = 1
  for (let i = 0; i < 3; i++) n2 += (B[i] * l2) / (l2 - C[i])
  return Math.sqrt(n2)
}

export const N_D = refractiveIndex(WAVELENGTH_UM.d)

export interface Singlet {
  /** Surface radius of the symmetric biconvex element, mm (R1 = R, R2 = −R). */
  radius: number
  /** Centre thickness, mm. */
  thickness: number
  /** Clear diameter, mm. */
  diameter: number
}

/** Glass is sized for the widest stop on the ladder so it never reshapes with N. */
const WIDEST_N = 1.4
const RIM = 1.1
const EDGE_THICKNESS_PER_MM = 0.04

/**
 * Symmetric biconvex singlet of focal length f (mm) in N-BK7, from the thick
 * lensmaker's equation 1/f = (n−1)[2/R − (n−1)t/(nR²)], solved jointly with the
 * centre thickness t = edge + 2·sag(R). Solving the quadratic for R at fixed t
 * gives R = f(n−1)[1 + √(1 − t/(n·f))]; a few fixed-point steps converge.
 */
export function singletFor(f: number, n = N_D): Singlet {
  const diameter = (f / WIDEST_N) * RIM
  const h = diameter / 2
  const edge = EDGE_THICKNESS_PER_MM * diameter
  let radius = 2 * (n - 1) * f
  let thickness = 0
  for (let i = 0; i < 20; i++) {
    thickness = edge + 2 * (radius - Math.sqrt(radius * radius - h * h))
    radius = f * (n - 1) * (1 + Math.sqrt(1 - thickness / (n * f)))
  }
  return { radius, thickness, diameter }
}

/** Focal length of a thick symmetric biconvex element. */
export function thickFocalLength(s: Singlet, n = N_D): number {
  const power = (n - 1) * (2 / s.radius - ((n - 1) * s.thickness) / (n * s.radius * s.radius))
  return 1 / power
}
