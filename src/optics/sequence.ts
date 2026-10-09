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
 * coverage for every prefix length, with no count fixed in advance. The live
 * gather draws its aperture kernel from it.
 */
export function r2(i: number): [number, number] {
  return [(0.5 + A1 * i) % 1, (0.5 + A2 * i) % 1]
}

const GOLDEN = (Math.sqrt(5) - 1) / 2
const orders = new Map<number, number[]>()

/** 0 … n−1 in bit-reversed order (indices past n skipped), so prefixes are stratified. */
function bitReversedOrder(n: number): number[] {
  let order = orders.get(n)
  if (order === undefined) {
    const bits = Math.ceil(Math.log2(Math.max(n, 2)))
    order = []
    for (let s = 0; s < 1 << bits; s++) {
      let j = 0
      for (let b = 0; b < bits; b++) j |= ((s >> b) & 1) << (bits - 1 - b)
      if (j < n) order.push(j)
    }
    orders.set(n, order)
  }
  return order
}

/**
 * The i-th of n points of a Fibonacci lattice in the unit square, in
 * bit-reversed order. Mapped onto the aperture (u1 → angle, u2 → radius) the
 * whole set is Vogel's sunflower spiral, the most even spread of n points over
 * a disc. R2 is a rank-1 lattice too, but at some counts one family of its
 * lines is spaced widely, and a point source's bokeh then shows those lines
 * as the arms of a pinwheel. Bit-reversed order makes every power-of-two
 * prefix a coarser copy of the set, so an exposure in progress covers the
 * whole aperture.
 */
export function fibonacci(i: number, n: number): [number, number] {
  const j = bitReversedOrder(n)[i % n]
  return [(j * GOLDEN) % 1, (j + 0.5) / n]
}
