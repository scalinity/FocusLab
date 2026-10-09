/**
 * Visual harness. Opens the running dev server in a headed, chrome-less
 * Google Chrome window (Metal WebGPU), refuses to continue unless the page
 * has a real Apple hardware adapter on the WebGPU backend, then captures.
 *
 *   npm run dev            (in another terminal)
 *   npm run shoot -- <name> [state-json]
 *
 * The optional state is passed to the app's harness hook (focus, f, N, ui…)
 * and the capture waits until the focus has settled on screen.
 *
 * Screenshots land in shots/<name>.png (git-ignored).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ORIGIN = 'http://localhost:5190'
const [name = 'shot', stateJson = ''] = process.argv.slice(2)

class HarnessFailure extends Error {}

function fail(reason: string): never {
  throw new HarnessFailure(reason)
}

try {
  await fetch(ORIGIN)
} catch {
  console.error(`shoot: FAILED — no dev server at ${ORIGIN}; start it with \`npm run dev\``)
  process.exit(1)
}

const url = `${ORIGIN}/?harness`
const profile = mkdtempSync(join(tmpdir(), 'focus-lab-shoot-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  args: [`--app=${url}`, '--window-size=1600,1000'],
  ignoreDefaultArgs: ['--enable-automation'],
  viewport: null,
})

try {
  // The --app window replaces its first page during startup; wait for the one
  // that holds the app.
  let page = context.pages().find((p) => p.url().startsWith(ORIGIN))
  for (let i = 0; page === undefined && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    page = context.pages().find((p) => p.url().startsWith(ORIGIN))
  }
  if (page === undefined) fail('the app window never opened')
  const logs: string[] = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  // Load again so every message from a clean start is captured.
  await page.goto(url, { waitUntil: 'load' })

  const adapter = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return { error: 'navigator.gpu is missing' }
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (a === null) return { error: 'requestAdapter() returned null' }
    const i = a.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }
    return {
      vendor: i.vendor,
      architecture: i.architecture,
      description: i.description,
      isFallbackAdapter: i.isFallbackAdapter ?? null,
    }
  })
  if ('error' in adapter && adapter.error) fail(adapter.error)
  const ident = `${adapter.vendor} ${adapter.architecture} ${adapter.description}`.toLowerCase()
  if (adapter.vendor !== 'apple') fail(`adapter vendor is "${adapter.vendor}", expected "apple"`)
  if (adapter.isFallbackAdapter !== false) fail(`adapter isFallbackAdapter = ${adapter.isFallbackAdapter}`)
  if (ident.includes('swiftshader')) fail(`software adapter: ${ident}`)

  const report = await page.evaluate(() => window.__focusLab?.ready ?? Promise.reject(new Error('no harness hook')))
  if (report.backend !== 'webgpu') fail(`app backend is ${report.backend}`)
  console.log(`shoot: adapter ${ident.trim()} · ${report.features.length} features`)

  if (stateJson) await page.evaluate((s) => window.__focusLab!.set(JSON.parse(s)), stateJson)
  await page.waitForTimeout(300)
  mkdirSync('shots', { recursive: true })
  const path = `shots/${name}.png`
  await page.screenshot({ path })
  console.log(`shoot: ${path}`)

  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
  for (const l of logs) console.log(`  ${l}`)
  if (errors.length > 0) fail(`${errors.length} console error(s)`)
} catch (err) {
  console.error(`shoot: FAILED — ${err instanceof HarnessFailure ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
