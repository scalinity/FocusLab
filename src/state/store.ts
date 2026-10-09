import { CIRCULAR, type Aperture } from '../optics/aperture'
import { sensorDistance } from '../optics/thinLens'
import { swapLens } from '../optics/travel'
import { derive, metresToMm, type Derived, type OpticsState } from '../optics/world'

export interface Settings extends OpticsState {
  /** Where the focus spring is heading; `si` follows it. */
  siTarget: number
  aperture: Aperture
}

export interface UiState {
  viewfinder: 'card' | 'full'
  hidden: boolean
  /** Develop the exact exposure after a pause without input. */
  autoExpose: boolean
  tier: 'low' | 'high' | 'ultra'
  /** Fixed viewfinder render width in px (tests); null follows the card. */
  renderWidth: number | null
}

export interface StoreState {
  optics: Settings
  derived: Derived
  ui: UiState
}

type Listener = (s: StoreState) => void

function createStore(optics: Settings, ui: UiState) {
  let state: StoreState = { optics, derived: derive(optics), ui }
  const listeners = new Set<Listener>()
  const emit = (): void => {
    for (const fn of listeners) fn(state)
  }
  return {
    get: (): StoreState => state,
    setOptics(patch: Partial<Settings>): void {
      const next = { ...state.optics, ...patch }
      state = { ...state, optics: next, derived: derive(next) }
      emit()
    },
    /** Swap focal length holding the focus distance; s_i jumps, it is not sprung. */
    setFocalLength(f: number): void {
      const o = state.optics
      const si = swapLens(o.f, o.si, f, o.lab)
      this.setOptics({ f, si, siTarget: si })
    },
    setUi(patch: Partial<UiState>): void {
      state = { ...state, ui: { ...state.ui, ...patch } }
      emit()
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

const si = sensorDistance(50, metresToMm(3))

/** Default: 50 mm at f/2, focused at 3 m, circular iris. */
export const store = createStore(
  { f: 50, N: 2, si, siTarget: si, lab: false, aperture: CIRCULAR },
  { viewfinder: 'card', hidden: false, autoExpose: true, tier: 'high', renderWidth: null },
)
