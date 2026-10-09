import { Raycaster, Vector2 } from 'three/webgpu'
import { RING_SWEEP } from '../bench/geometry'
import { BENCH_LAYER } from '../bench/benchModel'
import { maxSensorDistance } from '../optics/travel'
import { dragFocus, focusAtDistance, nudgeFocus, setLab } from '../state/actions'
import { store } from '../state/store'
import type { FocusRenderer } from '../render/renderer'
import type { WorldSource } from '../worlds/WorldSource'

/** Ring rotation per pixel of drag, and Option's fine factor. */
const RAD_PER_PX = 0.006
const FINE = 0.1
const NUDGE = 1 / 60

/**
 * Focus by dragging the ring (Option for fine), keys, and the wheel over the
 * controls; every other drag orbits the bench camera.
 */
export function bindInput(canvas: HTMLCanvasElement, view: FocusRenderer, world: WorldSource): () => void {
  const raycaster = new Raycaster()
  raycaster.layers.set(BENCH_LAYER)
  const ndc = new Vector2()
  let drag: { x: number; y: number; si: number; raw: number } | null = null

  const hitsRing = (e: PointerEvent): boolean => {
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    raycaster.setFromCamera(ndc, view.benchCamera)
    return raycaster.intersectObject(view.bench.ring, false).length > 0
  }

  // Capture phase, so OrbitControls sees `enabled = false` before it starts an orbit.
  const down = (e: PointerEvent): void => {
    if (e.button !== 0 || store.get().ui.viewfinder === 'full' || !hitsRing(e)) return
    view.controls.enabled = false
    canvas.setPointerCapture(e.pointerId)
    const si = store.get().optics.siTarget
    drag = { x: e.clientX, y: e.clientY, si, raw: si }
  }
  const move = (e: PointerEvent): void => {
    if (drag === null) return
    const { f } = store.get().optics
    const px = (e.clientX - drag.x - (e.clientY - drag.y)) * (e.altKey ? FINE : 1)
    drag.raw = drag.si - ((px * RAD_PER_PX) / RING_SWEEP) * (maxSensorDistance(f) - f)
    dragFocus(drag.raw, false)
  }
  const up = (): void => {
    if (drag === null) return
    dragFocus(drag.raw, true)
    drag = null
    view.controls.enabled = true
  }
  canvas.addEventListener('pointerdown', down, { capture: true })
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)

  const key = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey) return
    const presets = world.presets
    switch (e.key) {
      case '1':
      case '2':
      case '3':
        focusAtDistance(presets[Number(e.key) - 1].distanceM)
        break
      case '[':
      case 'ArrowLeft':
        nudgeFocus(NUDGE * (e.altKey ? FINE : 1))
        break
      case ']':
      case 'ArrowRight':
        nudgeFocus(-NUDGE * (e.altKey ? FINE : 1))
        break
      case 'v':
      case 'V':
        store.setUi({ viewfinder: store.get().ui.viewfinder === 'card' ? 'full' : 'card' })
        break
      case 'l':
      case 'L':
        setLab(!store.get().optics.lab)
        break
      case '/':
        store.setUi({ hidden: !store.get().ui.hidden })
        break
      case 'r':
      case 'R':
        view.resetView()
        break
      case ' ':
        view.exposeNow()
        break
      default:
        return
    }
    e.preventDefault()
  }
  addEventListener('keydown', key)

  const wheel = (e: WheelEvent): void => {
    if (!(e.target instanceof HTMLElement) || e.target.closest('.slide') === null) return
    e.preventDefault()
    nudgeFocus(Math.sign(e.deltaY) * NUDGE * 0.5 * (e.altKey ? FINE : 1))
  }
  addEventListener('wheel', wheel, { passive: false })

  return () => {
    canvas.removeEventListener('pointerdown', down, { capture: true })
    canvas.removeEventListener('pointermove', move)
    canvas.removeEventListener('pointerup', up)
    canvas.removeEventListener('pointercancel', up)
    removeEventListener('keydown', key)
    removeEventListener('wheel', wheel)
  }
}
