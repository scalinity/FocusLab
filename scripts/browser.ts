/**
 * Opens the running dev server in a headed, chrome-less Google Chrome window
 * (Metal WebGPU) and refuses to continue unless the page has a real Apple
 * hardware adapter on the app's WebGPU backend. Shared by shoot.ts and
 * check.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

export const ORIGIN = 'http://localhost:5190'

export class HarnessFailure extends Error {}

export function fail(reason: string): never {
  throw new HarnessFailure(reason)
}

export interface App {
  page: Page
  logs: string[]
  /** Adapter identity, e.g. "apple metal-3". */
  adapter: string
  close(): Promise<void>
}

export async function openApp(query = ''): Promise<App> {
  try {
    await fetch(ORIGIN)
  } catch {
    fail(`no dev server at ${ORIGIN}; start it with \`npm run dev\``)
  }
  const url = `${ORIGIN}/?harness${query ? `&${query}` : ''}`
  const profile = mkdtempSync(join(tmpdir(), 'focus-lab-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    args: [`--app=${url}`, '--window-size=1600,1000'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: null,
  })
  const close = async (): Promise<void> => {
    await context.close()
    rmSync(profile, { recursive: true, force: true })
  }
  try {
    // The --app window replaces its first page during startup; wait for the
    // one that holds the app.
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

    const a = await page.evaluate(async () => {
      if (!('gpu' in navigator)) return { error: 'navigator.gpu is missing' }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (adapter === null) return { error: 'requestAdapter() returned null' }
      const i = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }
      return { vendor: i.vendor, architecture: i.architecture, description: i.description, fallback: i.isFallbackAdapter ?? null }
    })
    if ('error' in a && a.error) fail(a.error)
    const ident = `${a.vendor} ${a.architecture} ${a.description}`.trim().toLowerCase()
    if (a.vendor !== 'apple') fail(`adapter vendor is "${a.vendor}", expected "apple"`)
    if (a.fallback !== false) fail(`adapter isFallbackAdapter = ${a.fallback}`)
    if (ident.includes('swiftshader')) fail(`software adapter: ${ident}`)

    const report = await page.evaluate(() => window.__focusLab?.ready ?? Promise.reject(new Error('no harness hook')))
    if (report.backend !== 'webgpu') fail(`app backend is ${report.backend}`)
    return { page, logs, adapter: ident, close }
  } catch (err) {
    await close()
    throw err
  }
}

export const consoleErrors = (logs: string[]): string[] =>
  logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
