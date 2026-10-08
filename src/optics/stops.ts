/**
 * The 1/3-stop f-number ladder as marked on lenses. Calculations use the
 * marked values so the formula panel's arithmetic matches the dial; they
 * differ from the exact √2^(n/3) series by under 3%.
 */
export const F_STOPS = [
  1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18,
  20, 22,
] as const

export const FOCAL_LENGTHS = [24, 35, 50, 85, 135] as const

/** Index of the ladder value nearest to N. */
export function nearestStop(N: number): number {
  let best = 0
  for (let i = 1; i < F_STOPS.length; i++) {
    if (Math.abs(F_STOPS[i] - N) < Math.abs(F_STOPS[best] - N)) best = i
  }
  return best
}
