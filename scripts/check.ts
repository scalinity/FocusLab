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
  await page.evaluate(() => window.__focusLab!.device()!.destroy())
  await page.waitForFunction(() => window.__focusLab?.device() !== null && window.__focusLab?.device() !== undefined)
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

const SUITES: Record<string, { query: string; run(app: App): Promise<void> }> = {
  m2: { query: 'world=points', run: m2 },
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
