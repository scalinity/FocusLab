/** Low-discrepancy sequences for progressive sampling. */

/** Radical inverse in `base` of index i (Halton component). */
export function halton(i: number, base: number): number {
  let f = 1
  let r = 0
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

const PLASTIC = 1.324717957244746
const A1 = 1 / PLASTIC
const A2 = 1 / (PLASTIC * PLASTIC)

/**
 * Roberts' R2 sequence: additive recurrence on the plastic number, even
 * coverage for every prefix length. Used for aperture positions, so they
 * stay decorrelated from the Halton(2,3) sub-pixel jitter.
 */
export function r2(i: number): [number, number] {
  return [(0.5 + A1 * i) % 1, (0.5 + A2 * i) % 1]
}
