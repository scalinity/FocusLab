/**
 * Visual harness: capture the app in a given state on a verified Apple GPU.
 *
 *   npm run dev            (in another terminal)
 *   npm run shoot -- <name> [state-json] [query]
 *
 * The optional state is passed to the app's harness hook (focus, f, N, ui…)
 * and the capture waits until the focus has settled on screen; with
 * "develop": true it also waits for the exact exposure. The query selects
 * e.g. world=points. Screenshots land in shots/<name>.png (git-ignored).
 */
import { mkdirSync } from 'node:fs'
import { HarnessFailure, consoleErrors, fail, openApp } from './browser.ts'

const [name = 'shot', stateJson = '', query = ''] = process.argv.slice(2)

try {
  const app = await openApp(query)
  try {
    const { page } = app
    console.log(`shoot: adapter ${app.adapter}`)
    if (stateJson) await page.evaluate((s) => window.__focusLab!.set(JSON.parse(s)), stateJson)
    if (stateJson.includes('"develop":true')) {
      const t0 = Date.now()
      const { samples } = await page.evaluate(() => window.__focusLab!.develop())
      console.log(`shoot: developed ${samples} samples in ${Date.now() - t0} ms`)
    }
    await page.waitForTimeout(300)
    mkdirSync('shots', { recursive: true })
    const path = `shots/${name}.png`
    await page.screenshot({ path })
    console.log(`shoot: ${path}`)
    const errors = consoleErrors(app.logs)
    for (const l of app.logs) console.log(`  ${l}`)
    if (errors.length > 0) fail(`${errors.length} console error(s)`)
  } finally {
    await app.close()
  }
} catch (err) {
  console.error(`shoot: FAILED — ${err instanceof HarnessFailure ? err.message : String(err)}`)
  process.exitCode = 1
}
