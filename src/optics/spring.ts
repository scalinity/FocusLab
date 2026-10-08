/**
 * Critically damped spring, integrated in closed form so the result is the
 * same at any frame rate. ω = 40 rad/s reaches 95% of a step in ~120 ms with
 * no overshoot.
 */
export const FOCUS_OMEGA = 40

export interface SpringState {
  x: number
  v: number
}

export function stepSpring(s: SpringState, target: number, dt: number, omega = FOCUS_OMEGA): SpringState {
  const e0 = s.x - target
  const a = s.v + omega * e0
  const decay = Math.exp(-omega * dt)
  return {
    x: target + (e0 + a * dt) * decay,
    v: (s.v - omega * a * dt) * decay,
  }
}
