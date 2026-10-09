/**
 * Track slider from DESIGN.md: glowing fill, knob, ticks, an optional band.
 * Positions are 0…1 left to right; the owner maps them to values.
 */
export interface Slider {
  el: HTMLElement
  set(p: number): void
  band(from: number | null, to: number | null): void
  ticks(positions: number[], cls?: string): void
  past(from: number | null): void
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

export function createSlider(
  label: string,
  onInput: (p: number, fine: boolean, release: boolean) => void,
): Slider {
  const el = document.createElement('div')
  el.className = 'slide'
  el.tabIndex = 0
  el.setAttribute('role', 'slider')
  el.setAttribute('aria-label', label)
  const tr = Object.assign(document.createElement('div'), { className: 'tr' })
  const past = Object.assign(document.createElement('div'), { className: 'past' })
  const dz = Object.assign(document.createElement('div'), { className: 'dz' })
  const fl = Object.assign(document.createElement('div'), { className: 'fl' })
  const kn = Object.assign(document.createElement('div'), { className: 'kn' })
  const tickLayer = document.createElement('div')
  el.append(tr, past, tickLayer, dz, fl, kn)

  let drag: { startX: number; startP: number; width: number } | null = null
  let current = 0

  const fromEvent = (e: PointerEvent): number => {
    const r = el.getBoundingClientRect()
    if (drag === null) return clamp01((e.clientX - r.left) / r.width)
    const scale = e.altKey ? 0.1 : 1
    return clamp01(drag.startP + ((e.clientX - drag.startX) / drag.width) * scale)
  }
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    const p = e.altKey ? current : clamp01((e.clientX - r.left) / r.width)
    drag = { startX: e.clientX, startP: p, width: r.width }
    onInput(p, e.altKey, false)
  })
  el.addEventListener('pointermove', (e) => {
    if (drag !== null) onInput(fromEvent(e), e.altKey, false)
  })
  const end = (e: PointerEvent): void => {
    if (drag === null) return
    onInput(fromEvent(e), e.altKey, true)
    drag = null
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)

  return {
    el,
    set(p) {
      current = clamp01(p)
      const pct = `${current * 100}%`
      kn.style.left = pct
      fl.style.width = pct
      el.setAttribute('aria-valuenow', current.toFixed(3))
    },
    band(from, to) {
      dz.hidden = from === null || to === null
      if (from === null || to === null) return
      const a = clamp01(Math.min(from, to))
      const b = clamp01(Math.max(from, to))
      dz.style.left = `${a * 100}%`
      dz.style.width = `${Math.max(0.6, (b - a) * 100)}%`
    },
    ticks(positions, cls = '') {
      tickLayer.replaceChildren(
        ...positions.map((p) => {
          const t = document.createElement('div')
          t.className = `tk ${cls}`.trim()
          t.style.left = `${clamp01(p) * 100}%`
          return t
        }),
      )
    },
    past(from) {
      past.hidden = from === null
      if (from !== null) past.style.left = `${clamp01(from) * 100}%`
    },
  }
}
