import { F_STOPS, FOCAL_LENGTHS } from '../optics/stops'
import { signedBlur } from '../optics/thinLens'
import { metresToMm } from '../optics/world'
import { dioptreRange, focusAtDioptres, focusAtDistance, setLab } from '../state/actions'
import { store, type StoreState } from '../state/store'
import { LENS_WORLD, imageScale as imageScaleFor } from '../bench/geometry'
import { BUNDLE_CSS } from '../bench/rays'
import type { Rect } from '../render/layout'
import type { Exposure } from '../state/renderState'
import type { WorldSource } from '../worlds/WorldSource'
import { formatDistance, formatStop } from './format'
import { createSlider } from './slider'

/** Screen-space label positions from the renderer (CSS px), or null when off screen. */
export type LabelPositions = Record<'sheet' | 'plane' | 'lens', { x: number; y: number } | null>

export interface Hud {
  placeLabels(p: LabelPositions): void
  placeViewfinder(rect: Rect): void
  setExposure(e: Exposure): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}

function segmented(
  items: Array<{ label: string; value: number }>,
  onPick: (v: number) => void,
  mono = false,
): { root: HTMLElement; select(v: number | null): void } {
  const root = el('div', mono ? 'seg mono' : 'seg')
  root.setAttribute('role', 'group')
  const buttons = items.map((it) => {
    const b = el('button', '', it.label)
    b.type = 'button'
    b.addEventListener('click', () => onPick(it.value))
    root.append(b)
    return { b, v: it.value }
  })
  return {
    root,
    select(v) {
      for (const x of buttons) x.b.classList.toggle('on', x.v === v)
    },
  }
}

function group(label: string, control: HTMLElement, grow = false): { root: HTMLElement; value: HTMLElement } {
  const root = el('div', grow ? 'grp grow' : 'grp')
  const lab = el('span', 'lab', label)
  const value = el('em', 'v')
  lab.append(value)
  root.append(lab, control)
  return { root, value }
}

export function createHud(world: WorldSource): Hud {
  const ui = document.getElementById('ui')!
  ui.replaceChildren()
  ui.append(el('div', 'vignette'))

  // Title, chips, note
  const side = el('aside', 'side')
  const brand = el(
    'div',
    'brand',
    '<h1>Focus <b>Lab</b></h1><small>A thin lens on the forest floor. Drag the focus ring and the sheet of sharpness sweeps through the world.</small>',
  )
  const stats = el('div', 'stats')
  const chip = (label: string, hot = false) => {
    const c = el('div', hot ? 'stat hot' : 'stat', `<i>${label}</i><b></b>`)
    stats.append(c)
    return c
  }
  const chipFocus = chip('Focus', true)
  const chipAperture = chip('Aperture')
  const chipZone = chip('Sharp zone')
  const why = el('p', 'why')
  why.setAttribute('aria-live', 'polite')
  side.append(brand, stats, why)

  // Controls card
  const ctl = el('section', 'card ctl')
  ctl.setAttribute('aria-label', 'Controls')
  const presetSeg = segmented(
    world.presets.map((p, i) => ({ label: p.name, value: i })),
    (i) => focusAtDistance(world.presets[i].distanceM),
  )
  const distance = createSlider('Focus distance', (p, _fine, release) => {
    const r = dioptreRange()
    focusAtDioptres(r.max - p * (r.max - r.min), !release)
  })
  const aperture = createSlider('Aperture', (p) => {
    store.setOptics({ N: F_STOPS[Math.round(p * (F_STOPS.length - 1))] })
  })
  const lensSeg = segmented(
    FOCAL_LENGTHS.map((f) => ({ label: String(f), value: f })),
    (f) => store.setFocalLength(f),
    true,
  )
  const tools = el('div', 'tools')
  const labBtn = el('button', 'amber', 'Lab')
  labBtn.title = 'Lab mode: let the lens travel past infinity (L)'
  labBtn.addEventListener('click', () => setLab(!store.get().optics.lab))
  const autoBtn = el('button', '', 'Auto')
  autoBtn.title = 'Develop the exact exposure when you pause (Space exposes now)'
  autoBtn.addEventListener('click', () => store.setUi({ autoExpose: !store.get().ui.autoExpose }))
  const vfBtn = el('button', '', 'VF')
  vfBtn.title = 'Viewfinder full screen (V)'
  vfBtn.addEventListener('click', () =>
    store.setUi({ viewfinder: store.get().ui.viewfinder === 'card' ? 'full' : 'card' }),
  )
  tools.append(labBtn, autoBtn, vfBtn)

  const gFocus = group('Focus', presetSeg.root)
  gFocus.value.textContent = '1 2 3'
  const gDistance = group('Distance', distance.el, true)
  const gAperture = group('Aperture', aperture.el, true)
  const gLens = group('Lens', lensSeg.root)
  gLens.value.textContent = 'mm'
  const row1 = el('div', 'row')
  row1.append(gFocus.root, gDistance.root)
  const row2 = el('div', 'row')
  row2.append(gAperture.root, gLens.root, tools)
  const VIEWS = ['beauty', 'blur', 'split'] as const
  const viewSeg = segmented(
    [
      { label: 'Beauty', value: 0 },
      { label: 'Blur map', value: 1 },
      { label: 'Live | exact', value: 2 },
    ],
    (i) => store.setUi({ view: VIEWS[i] }),
  )
  const gView = group('View', viewSeg.root)
  const row3 = el('div', 'row')
  row3.append(gView.root)
  ctl.append(row1, row2, row3)

  // Viewfinder frame and 3D-anchored labels
  const vf = el('div', 'vf-frame')
  const vfTag = el('span', 'tag')
  const divider = el('div', 'divider', '<span>live</span><span>exact</span>')
  const progress = el(
    'div',
    'progress',
    '<svg viewBox="0 0 20 20"><circle class="bg" cx="10" cy="10" r="8"/><circle class="fg" cx="10" cy="10" r="8"/></svg>',
  )
  vf.append(vfTag, progress, divider)
  const progressArc = progress.querySelector<SVGCircleElement>('.fg')!
  let lastTag = ''
  const pills = {
    sheet: el('div', 'pill'),
    plane: el('div', 'pill', 'Image plane <em>upside down</em>'),
    lens: el('div', 'pill amber'),
  }
  ui.append(side, ctl, vf, pills.sheet, pills.plane, pills.lens)

  const fullStops = new Set([1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22])
  aperture.ticks(F_STOPS.map((N, i) => (fullStops.has(N) ? i / (F_STOPS.length - 1) : -1)).filter((p) => p >= 0))

  const render = (s: StoreState): void => {
    const { optics: o, derived: d } = s
    const r = dioptreRange()
    const toP = (k: number): number => (r.max - k) / (r.max - r.min)

    chipFocus.classList.toggle('warn', d.focusM === null)
    chipFocus.classList.toggle('hot', d.focusM !== null)
    chipFocus.querySelector('b')!.textContent = d.focusM === null ? 'past ∞' : formatDistance(d.focusM)
    chipAperture.querySelector('b')!.textContent = formatStop(o.N)
    chipZone.querySelector('b')!.textContent =
      d.dofNearM === null || d.dofFarM === null
        ? '—'
        : Number.isFinite(d.dofFarM)
          ? formatDistance(d.dofFarM - d.dofNearM)
          : '∞'

    distance.set(toP(d.kPerM))
    gDistance.value.textContent = d.focusM === null ? 'past ∞' : formatDistance(d.focusM)
    distance.band(
      d.dofNearM === null ? null : toP(1 / d.dofNearM),
      d.dofFarM === null ? null : toP(Number.isFinite(d.dofFarM) ? 1 / d.dofFarM : 0),
    )
    distance.ticks(world.subjects.map((sub) => toP(1 / (LENS_WORLD.z - sub.position.z))), 'subject')
    distance.past(o.lab ? toP(0) : null)

    aperture.set(F_STOPS.indexOf(o.N as (typeof F_STOPS)[number]) / (F_STOPS.length - 1))
    gAperture.value.textContent = formatStop(o.N)
    lensSeg.select(o.f)
    const preset = world.presets.findIndex((p) => d.focusM !== null && Math.abs(1 / p.distanceM - 1 / d.focusM) < 0.02)
    presetSeg.select(preset >= 0 ? preset : null)
    labBtn.classList.toggle('on', o.lab)
    autoBtn.classList.toggle('on', s.ui.autoExpose)
    viewSeg.select(VIEWS.indexOf(s.ui.view))
    divider.hidden = s.ui.view !== 'split'
    vfBtn.classList.toggle('on', s.ui.viewfinder === 'full')
    ui.classList.toggle('off', s.ui.hidden)
    ui.classList.toggle('vf-full', s.ui.viewfinder === 'full')

    if (d.focusM === null) {
      why.innerHTML =
        '<b class="a">Past infinity.</b> The image plane is closer to the lens than its focal length, so every image forms behind it. Nothing at any distance can be sharp.'
    } else {
      const blurs = [world.subjects[0], world.far].map((sub, i) => {
        const dMm = metresToMm(LENS_WORLD.z - sub.position.z)
        const c = Math.abs(signedBlur(o, dMm))
        return `<b style="color:${BUNDLE_CSS[i * 2]}">${sub.name}</b> ${c.toFixed(c < 1 ? 2 : 1)} mm`
      })
      why.innerHTML = `The <b class="c">plane of focus</b> is ${formatDistance(d.focusM)} from the lens. Points on it meet in a point on the image plane; anything nearer or farther arrives as a disc, the <b>circle of confusion</b>: ${blurs.join(' · ')}.`
    }
    pills.sheet.innerHTML = `Plane of focus <em>${formatDistance(d.focusM)}</em>`
    pills.lens.innerHTML = `Lens plane <em>image space ×${(Math.round(imageScaleFor(o.f) * 10) / 10).toString()}</em>`
  }
  store.subscribe(render)
  render(store.get())

  return {
    placeLabels(p) {
      for (const key of ['sheet', 'plane', 'lens'] as const) {
        const pos = p[key]
        const pill = pills[key]
        pill.hidden = pos === null || store.get().ui.viewfinder === 'full'
        if (pos !== null) pill.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -130%)`
      }
    },
    setExposure(e) {
      const tag =
        e.mode === 'LIVE'
          ? 'Viewfinder · <b>live</b>'
          : e.mode === 'EXPOSING'
            ? `Exposing · <b>${e.samples}/${e.target}</b>`
            : `Photograph · <b>${e.target} samples</b>`
      if (tag !== lastTag) {
        vfTag.innerHTML = tag
        lastTag = tag
      }
      progress.hidden = e.mode !== 'EXPOSING'
      progressArc.style.strokeDashoffset = String(50.27 * (1 - e.samples / e.target))
    },
    placeViewfinder(rect) {
      Object.assign(vf.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
      })
    },
  }
}
