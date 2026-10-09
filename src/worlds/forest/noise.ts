/**
 * Deterministic randomness for terrain and scatter. A seeded PRNG
 * (mulberry32) and smooth value noise with fractal octaves.
 */

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash of an integer lattice point to [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Smooth value noise in [−1, 1]. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = smooth(x - xi)
  const fy = smooth(y - yi)
  const a = hash(xi, yi, seed)
  const b = hash(xi + 1, yi, seed)
  const c = hash(xi, yi + 1, seed)
  const d = hash(xi + 1, yi + 1, seed)
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * 2 - 1
}

/** Fractal value noise: `octaves` octaves, each at twice the frequency and half the amplitude. */
export function fbm(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x, y, seed + i * 17)
    norm += amp
    amp *= 0.5
    x *= 2
    y *= 2
  }
  return sum / norm
}
