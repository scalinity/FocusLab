import { derive, metresToMm, type Derived, type OpticsState } from '../optics/world'
import { sensorDistance } from '../optics/thinLens'

export interface StoreState {
  optics: OpticsState
  derived: Derived
}

type Listener = (s: StoreState) => void

function createStore(initial: OpticsState) {
  let state: StoreState = { optics: initial, derived: derive(initial) }
  const listeners = new Set<Listener>()
  return {
    get: (): StoreState => state,
    setOptics(patch: Partial<OpticsState>): void {
      const optics = { ...state.optics, ...patch }
      state = { optics, derived: derive(optics) }
      for (const fn of listeners) fn(state)
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

/** Default: 50 mm at f/2, focused at 3 m. */
export const store = createStore({ f: 50, N: 2, si: sensorDistance(50, metresToMm(3)), lab: false })
