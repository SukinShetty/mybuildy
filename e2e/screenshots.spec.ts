// screenshots.spec.ts — README screenshots (Phase 10 links them from docs/assets/).
// DEV BUILD ONLY: the guidance fixture hook exists only under
// MYBUILDY_E2E=1 && !app.isPackaged (src/main/e2e-hooks.ts), so this whole file
// self-skips in the packaged run. The guidance panel is rendered from a canned
// fixture analysis — no AI provider is ever called.

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

const ASSETS_DIR = path.resolve(__dirname, '..', 'docs', 'assets')

test.skip(IS_PACKAGED_RUN, 'Screenshots + fixture hook are dev-build only')

let mybuildy: MyBuildyApp

test.beforeAll(async () => {
  fs.mkdirSync(ASSETS_DIR, { recursive: true })
  mybuildy = await launchMyBuildy()
})

test.afterAll(async () => {
  await mybuildy?.close()
})

test('mascot (companion window)', async () => {
  // Wait for the robot's animation strip (a CSS background) to finish loading
  // so the PNG isn't blank.
  await mybuildy.companion.waitForFunction(async () => {
    const sprite = document.querySelector('[data-testid="mascot"] [role="img"]')
    const url = sprite ? /url\("?([^")]+)"?\)/.exec(getComputedStyle(sprite).backgroundImage)?.[1] : null
    if (!url) return false
    const img = new Image()
    img.src = url
    try { await img.decode() } catch { return false }
    return img.naturalWidth > 0
  })
  await mybuildy.companion.waitForTimeout(500)
  await mybuildy.companion.screenshot({
    path: path.join(ASSETS_DIR, 'mascot.png'),
    omitBackground: true, // transparent floating window
  })
})

test('setup wizard (first launch)', async () => {
  await expect(mybuildy.main.getByTestId('setup-wizard')).toHaveAttribute('data-step', 'welcome')
  await mybuildy.main.screenshot({ path: path.join(ASSETS_DIR, 'setup.png') })
})

test('Settings screen (after setup, nothing configured)', async () => {
  // Finish setup without configuring anything: the panel then opens on Settings.
  await mybuildy.main.evaluate(async () => {
    await (window as unknown as { mybuildy: { setup: { finish(): Promise<void> } } }).mybuildy.setup.finish()
  })
  // Finishing hides the panel; reopen it the way the mascot's gear does.
  await mybuildy.companion.evaluate(() => (window as unknown as { mybuildy: { openPanel(): void } }).mybuildy.openPanel())
  await mybuildy.main.reload()
  await expect(mybuildy.main.getByText('Anthropic', { exact: true })).toBeVisible()
  await mybuildy.main.screenshot({ path: path.join(ASSETS_DIR, 'settings.png') })
})

test('Set Goal screen', async () => {
  await mybuildy.main.getByTitle('Set Goal').click()
  await mybuildy.main.waitForTimeout(400)
  await mybuildy.main.screenshot({ path: path.join(ASSETS_DIR, 'set-goal.png') })
})

test('Memory screen', async () => {
  await mybuildy.main.getByTitle('Memory').click()
  await mybuildy.main.waitForTimeout(400)
  await mybuildy.main.screenshot({ path: path.join(ASSETS_DIR, 'memory.png') })
})

test('guidance panel rendered from the canned fixture analysis', async () => {
  // Push the neutral fixture through the app's REAL display pathway
  // (showGuidanceWindow -> GUIDANCE_DATA -> GuidancePanel).
  await mybuildy.app.evaluate(() => {
    const hooks = (globalThis as Record<string, unknown>)['__mybuildyE2E'] as
      | { showFixtureGuidance(): void }
      | undefined
    if (!hooks) throw new Error('e2e fixture hook missing — is MYBUILDY_E2E=1 set?')
    hooks.showFixtureGuidance()
  })

  await expect(mybuildy.guidance.getByText('Prompt to paste')).toBeVisible()
  // Let the window finish its content-height resize animation before capturing.
  await mybuildy.guidance.waitForTimeout(800)
  await mybuildy.guidance.screenshot({
    path: path.join(ASSETS_DIR, 'guidance-panel.png'),
    omitBackground: true, // transparent floating window
  })
})

test('all screenshots exist and are non-trivial PNGs', async () => {
  for (const name of ['mascot.png', 'setup.png', 'settings.png', 'set-goal.png', 'memory.png', 'guidance-panel.png']) {
    const file = path.join(ASSETS_DIR, name)
    expect(fs.existsSync(file), `${name} missing`).toBe(true)
    expect(fs.statSync(file).size, `${name} suspiciously small`).toBeGreaterThan(5_000)
  }
})
