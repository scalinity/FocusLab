/**
 * Numeric acceptance checks on a verified Apple GPU.
 *
 *   npm run dev            (in another terminal)
 *   npm run check -- m2
 *
 * Each check prints its measurement next to the expected value and the
 * tolerance; the script exits non-zero if any check fails or did not run.
 */
import { HarnessFailure, consoleErrors, openApp, type App } from './browser.ts'

interface Result {
  name: string
  value: string
  expected: string
  pass: boolean
}

const results: Result[] = []
const record = (name: string, value: string, expected: string, pass: boolean): void => {
  results.push({ name, value, expected, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${value} (expected ${expected})`)
}

const within = (x: number, target: number, tol: number): boolean => Math.abs(x / target - 1) <= tol

/** Pixel x of a point at tangent offset tx in a render `width` wide, lens at s_i (mm). */
const pixelX = (tx: number, si: number, width: number): number => (width / 2) * (1 + (tx * si) / 18)

async function m2(app: App): Promise<void> {
  const { page } = app
  const W = 1920
  const H = 1280
  const base = { f: 50, N: 2, focusM: 3, ui: { renderWidth: W, tier: 'ultra' as const, autoExpose: false } }
  const measure = (x: number, y: number, size: number) =>
    page.evaluate(([x, y, size]) => window.__focusLab!.measure(x, y, size), [x, y, size] as const)
  const develop = async () => {
    const t0 = Date.now()
    const { samples } = await page.evaluate(() => window.__focusLab!.develop())
    return { samples, ms: Date.now() - t0 }
  }

  // 1. Circular iris: the 6 m point focused at 3 m is an 11.3 px disc at 1920 px.
  await page.evaluate((s) => window.__focusLab!.set(s), { ...base, aperture: { blades: 0, roundness: 1, rotation: 0 } })
  const si = await page.evaluate(() => window.__focusLab!.state().optics.si)
  const d1 = await develop()
  console.log(`      developed ${d1.samples} samples at ${W}×${H} in ${d1.ms} ms`)
  const far = await measure(W / 2, H / 2, 48)
  record('6 m disc diameter (energy)', `${far.diameterPx.toFixed(2)} px`, '11.30 px ±5%', within(far.diameterPx, 11.3, 0.05))
  record('6 m disc diameter (half max)', `${far.thresholdDiameterPx.toFixed(2)} px`, '11.30 px ±5%', within(far.thresholdDiameterPx, 11.3, 0.05))

  const nearX = pixelX(-0.14, si, W)
  const near = await measure(nearX, H / 2, 64)
  record('1.5 m disc diameter (near field)', `${near.diameterPx.toFixed(2)} px`, '22.60 px ±5%', within(near.diameterPx, 22.6, 0.05))
  const sharp = await measure(pixelX(0.14, si, W), H / 2, 16)
  record('3 m point stays sharp (bead is 3.5 px)', `${sharp.diameterPx.toFixed(2)} px`, '< 5 px', sharp.diameterPx < 5)

  // 2. Pentagon with a vertex up: upright in the far field, rotated 180° in the near field.
  await page.evaluate((s) => window.__focusLab!.set(s), { ...base, aperture: { blades: 5, roundness: 0, rotation: Math.PI / 2 } })
  await develop()
  const farP = await measure(W / 2, H / 2, 48)
  const nearP = await measure(nearX, H / 2, 64)
  record('far-field pentagon points up', `5th-moment orientation ${farP.pentagonUp.toFixed(3)}`, '> +0.9 (vertex up)', farP.pentagonUp > 0.9)
  record('near-field pentagon points down', `5th-moment orientation ${nearP.pentagonUp.toFixed(3)}`, '< −0.9 (vertex down)', nearP.pentagonUp < -0.9)
  record('pentagon area-equivalent diameter', `${farP.diameterPx.toFixed(2)} px`, '11.30 px ±5%', within(farP.diameterPx, 11.3, 0.05))

  await page.evaluate((s) => window.__focusLab!.set(s), { ...base, aperture: { blades: 6, roundness: 0, rotation: 0 } })
  await develop()
  const hex = await measure(W / 2, H / 2, 48)
  record('hexagon area-equivalent diameter', `${hex.diameterPx.toFixed(2)} px`, '11.30 px ±5%', within(hex.diameterPx, 11.3, 0.05))

  // 3. Developed means idle: no frames are rendered while nothing changes.
  const f0 = await page.evaluate(() => window.__focusLab!.framesRendered())
  await page.waitForTimeout(1000)
  const f1 = await page.evaluate(() => window.__focusLab!.framesRendered())
  record('developed: GPU idle for 1 s', `${f1 - f0} frames rendered`, '0', f1 === f0)

  // 4. Device loss: everything is rebuilt and the state survives.
  // The loss is handled asynchronously: until then device() is still the
  // destroyed device and `ready` the first start's. Wait for a new device;
  // by then `ready` is the rebuild's.
  await page.evaluate(() => {
    const d = window.__focusLab!.device()!
    ;(window as unknown as { lostDevice: GPUDevice }).lostDevice = d
    d.destroy()
  })
  await page.waitForFunction(() => {
    const d = window.__focusLab?.device()
    return d != null && d !== (window as unknown as { lostDevice?: GPUDevice }).lostDevice
  })
  await page.evaluate(() => window.__focusLab!.ready)
  const after = await page.evaluate(() => {
    const s = window.__focusLab!.state()
    return { f: s.optics.f, N: s.optics.N, blades: s.optics.aperture.blades, focusM: s.derived.focusM }
  })
  const kept = after.f === 50 && after.N === 2 && after.blades === 6 && Math.abs((after.focusM ?? 0) - 3) < 1e-9
  record('device loss: state survives the rebuild', JSON.stringify(after), 'f 50, f/2, 6 blades, 3 m', kept)
  await develop()
  const again = await measure(W / 2, H / 2, 48)
  record('device loss: exposure works after rebuild', `${again.diameterPx.toFixed(2)} px`, '11.30 px ±5%', within(again.diameterPx, 11.3, 0.05))
}

async function m3perf(app: App): Promise<void> {
  const { page } = app
  for (const [label, ui, sweep] of [
    ['viewfinder card, still', { viewfinder: 'card' as const, renderWidth: null }, false],
    ['viewfinder card + bench, focus pulling', { viewfinder: 'card' as const, renderWidth: null }, true],
    ['full-screen viewfinder, focus pulling', { viewfinder: 'full' as const, renderWidth: null }, true],
  ] as const) {
    await page.evaluate((s) => window.__focusLab!.set(s), { f: 50, N: 2, focusM: 3, ui: { ...ui, autoExpose: false, view: 'beauty' as const } })
    const ms = await page.evaluate((s) => window.__focusLab!.frameIntervalMs(120, s), sweep)
    // The display may refresh at 120 Hz; 60 fps is the target, so allow one 60 Hz frame.
    record(`live frame interval, ${label}`, `${ms.toFixed(2)} ms (${(1000 / ms).toFixed(0)} fps)`, '≤ 16.7 ms (60 fps)', ms <= 16.7 + 0.5)
  }
}

async function m3points(app: App): Promise<void> {
  const { page } = app
  const W = 1920
  const H = 1280
  const base = { f: 50, N: 2, focusM: 3, ui: { renderWidth: W, tier: 'ultra' as const, autoExpose: false, view: 'beauty' as const } }
  const live = (x: number, y: number, size: number) =>
    page.evaluate(([x, y, size]) => window.__focusLab!.measureLive(x, y, size), [x, y, size] as const)
  const exact = (x: number, y: number, size: number) =>
    page.evaluate(([x, y, size]) => window.__focusLab!.measure(x, y, size), [x, y, size] as const)

  for (const [label, aperture] of [
    ['circular', { blades: 0, roundness: 1, rotation: 0 }],
    ['pentagon', { blades: 5, roundness: 0, rotation: Math.PI / 2 }],
  ] as const) {
    await page.evaluate((s) => window.__focusLab!.set(s), { ...base, aperture })
    const si = await page.evaluate(() => window.__focusLab!.state().optics.si)
    const nearX = pixelX(-0.14, si, W)
    const liveFar = await live(W / 2, H / 2, 48)
    const liveNear = await live(nearX, H / 2, 64)
    await page.evaluate(() => window.__focusLab!.develop())
    const exactFar = await exact(W / 2, H / 2, 48)
    const exactNear = await exact(nearX, H / 2, 64)
    for (const [where, l, e] of [
      ['6 m (far field)', liveFar, exactFar],
      ['1.5 m (near field)', liveNear, exactNear],
    ] as const) {
      const ratio = l.diameterPx / e.diameterPx
      record(
        `${label} ${where}: live vs exact blur size`,
        `live ${l.diameterPx.toFixed(2)} px, exact ${e.diameterPx.toFixed(2)} px (×${ratio.toFixed(3)})`,
        'within ±10%',
        Math.abs(ratio - 1) <= 0.1,
      )
      if (label === 'pentagon') {
        const same = Math.sign(l.pentagonUp) === Math.sign(e.pentagonUp) && Math.abs(l.pentagonUp) > 0.8
        record(
          `pentagon ${where}: live bokeh orientation matches exact`,
          `live ${l.pentagonUp.toFixed(3)}, exact ${e.pentagonUp.toFixed(3)}`,
          'same sign, |live| > 0.8',
          same,
        )
      }
    }
  }
}

/** 10–90% width of a step in a profile, px (plateaus from the ends). */
function edgeWidth(p: number[]): number {
  const a = p.slice(0, 6).reduce((s, v) => s + v, 0) / 6
  const b = p.slice(-6).reduce((s, v) => s + v, 0) / 6
  const at = (t: number): number => {
    const level = a + (b - a) * t
    for (let i = 1; i < p.length; i++) {
      if ((p[i - 1] - level) * (p[i] - level) <= 0 && p[i] !== p[i - 1]) return i - 1 + (level - p[i - 1]) / (p[i] - p[i - 1])
    }
    return NaN
  }
  return Math.abs(at(0.9) - at(0.1))
}

async function m3halo(app: App): Promise<void> {
  const { page } = app
  const W = 1920
  const H = 1280
  await page.evaluate((s) => window.__focusLab!.set(s), {
    f: 50,
    N: 2,
    focusM: 3,
    aperture: { blades: 0, roundness: 1, rotation: 0 },
    ui: { renderWidth: W, tier: 'ultra' as const, autoExpose: false, view: 'beauty' as const },
  })
  const si = await page.evaluate(() => window.__focusLab!.state().optics.si)
  const X = (tx: number): number => (W / 2) * (1 + (tx * si) / 18)
  const Y = (ty: number): number => (H / 2) * (1 - (ty * si) / 12)
  const cases = [
    { name: 'sharp card in front of blurred wall', x: X(-0.15), half: 40, y0: Y(0.05), y1: Y(-0.05), contrast: 1.9, kind: 'halo' },
    { name: 'blurred wall edge (far-field gather)', x: X(-0.05), half: 40, y0: Y(0.18), y1: Y(0.1), contrast: 2, kind: 'width' },
    { name: 'blurred near card over sharp checker', x: X(0.18), half: 60, y0: Y(0.1), y1: Y(-0.1), contrast: 0.74, kind: 'halo' },
    { name: 'blurred near card edge (near-field gather)', x: X(0.18), half: 60, y0: Y(0.1), y1: Y(-0.1), contrast: 0.74, kind: 'width' },
  ] as const
  const profile = (src: 'live' | 'exact', c: (typeof cases)[number]) =>
    page.evaluate(([s, x0, x1, y0, y1]) => window.__focusLab!.profile(s, x0, x1, y0, y1), [src, c.x - c.half, c.x + c.half, c.y0, c.y1] as const)
  const live = await Promise.all(cases.map((c) => profile('live', c)))
  await page.evaluate(() => window.__focusLab!.develop())
  const exact = await Promise.all(cases.map((c) => profile('exact', c)))
  cases.forEach((c, i) => {
    if (c.kind === 'halo') {
      // A halo spans the blur radius (several px); anti-aliasing differs within
      // ±1 px of a sharp edge. Comparing after a 5 px moving average keeps the
      // first at nearly full strength and dilutes the second fivefold.
      const smooth = (p: number[]): number[] =>
        p.map((_, j) => {
          const s = p.slice(Math.max(0, j - 2), j + 3)
          return s.reduce((a, b) => a + b, 0) / s.length
        })
      const ls = smooth(live[i])
      const es = smooth(exact[i])
      const dev = Math.max(...ls.map((v, j) => Math.abs(v - es[j]))) / c.contrast
      const raw = Math.max(...live[i].map((v, j) => Math.abs(v - exact[i][j]))) / c.contrast
      record(
        `no halo: ${c.name}`,
        `max |live − exact| at 5 px scale = ${(dev * 100).toFixed(1)}% of edge contrast (per-pixel max ${(raw * 100).toFixed(1)}%, edge anti-aliasing)`,
        '< 10%',
        dev < 0.1,
      )
    } else {
      const wl = edgeWidth(live[i])
      const we = edgeWidth(exact[i])
      record(`blur size: ${c.name}`, `10–90% width live ${wl.toFixed(1)} px, exact ${we.toFixed(1)} px (×${(wl / we).toFixed(3)})`, 'within ±10%', Math.abs(wl / we - 1) <= 0.1)
    }
  })
}

const SUITES: Record<string, { query: string; run(app: App): Promise<void> }> = {
  m2: { query: 'world=points', run: m2 },
  m3points: { query: 'world=points', run: m3points },
  m3halo: { query: 'world=halo', run: m3halo },
  m3perf: { query: '', run: m3perf },
}

const suite = SUITES[process.argv[2] ?? '']
if (suite === undefined) {
  console.error(`check: name a suite: ${Object.keys(SUITES).join(', ')}`)
  process.exit(1)
}

try {
  const app = await openApp(suite.query)
  try {
    console.log(`check: adapter ${app.adapter}`)
    await suite.run(app)
    const errors = consoleErrors(app.logs)
    record('no console errors', errors.length === 0 ? 'none' : errors.join(' | '), 'none', errors.length === 0)
  } finally {
    await app.close()
  }
} catch (err) {
  console.error(`check: FAILED — ${err instanceof HarnessFailure ? err.message : String(err)}`)
  process.exitCode = 1
}
const failed = results.filter((r) => !r.pass).length
console.log(`check: ${results.length - failed}/${results.length} passed`)
if (failed > 0 || results.length === 0) process.exitCode = 1
