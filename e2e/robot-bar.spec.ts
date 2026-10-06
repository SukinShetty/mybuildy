// robot-bar.spec.ts — the floating robot bar: bright icons, the size setting
// (remembered), Ctrl/Cmd + scroll zoom, Hide (and the shortcut that brings it
// back) and Quit. DEV BUILD ONLY for the shortcut/fixture hooks.

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

test.skip(IS_PACKAGED_RUN, 'Uses dev-only e2e hooks')
test.describe.configure({ mode: 'serial' })

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuildy-e2e-robot-'))
let m: MyBuildyApp
let mediumWidth = 0 // the Medium window width as this display reports it (DPI rounding)
// Within 2%: display scaling rounds window bounds (the zoom factor itself is checked exactly).
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected) / expected).toBeLessThan(0.02)

async function robotWindow(app: MyBuildyApp) {
  return app.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('companion=true'))!
    const g = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('guidance=true'))!
    // On screen: shown and not minimized (Windows hides the robot by minimizing it, keeping its taskbar button).
    return { bounds: w.getBounds(), zoom: w.webContents.getZoomFactor(), visible: w.isVisible() && !w.isMinimized(), minimized: w.isMinimized(), guidanceVisible: g.isVisible() }
  })
}

/** The whole toolbar is inside the robot window (nothing clipped at either end). */
async function expectBarFits(app: MyBuildyApp): Promise<void> {
  const r = await app.companion.evaluate(() => { const b = document.querySelector('.robot-bar')!.getBoundingClientRect(); return { left: b.left, right: b.right, win: window.innerWidth } })
  expect(r.left).toBeGreaterThanOrEqual(0)
  expect(r.right).toBeLessThanOrEqual(r.win)
}

async function openSettings(app: MyBuildyApp): Promise<void> {
  await app.main.evaluate(async () => { await (window as unknown as { mybuildy: { setup: { finish(): Promise<void> } } }).mybuildy.setup.finish() })
  await app.companion.evaluate(() => (window as unknown as { mybuildy: { openPanel(): void } }).mybuildy.openPanel())
  await app.main.reload()
  await app.main.getByTitle('Settings').click()
}

test.beforeAll(async () => {
  m = await launchMyBuildy({ profileDir, keepProfile: true })
})
test.afterAll(async () => {
  await m?.close().catch(() => {})
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
})

test('toolbar icons are near-white at rest and orange on hover; Hide then Quit sit after the gear', async () => {
  const buttons = m.companion.locator('.robot-bar button')
  const titles = await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('title') || ''))
  const gear = titles.indexOf('Settings')
  expect(titles[gear + 1]).toMatch(/^Hide the robot \(keeps watching\)/)
  expect(titles[gear + 2]).toBe('Quit MyBuildy')
  await expectBarFits(m)

  const color = (i: number) => buttons.nth(i).evaluate((e) => getComputedStyle(e).color)
  expect(await color(0)).toBe('rgb(242, 242, 247)')
  await buttons.nth(0).hover()
  await expect.poll(() => color(0)).toBe('rgb(255, 107, 43)')
  expect(await buttons.nth(0).evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
})

test('Settings → Robot size slider: 150% zooms robot, bar, icons and text together; Reset goes back to 100%', async () => {
  const before = await robotWindow(m)
  mediumWidth = before.bounds.width
  near(mediumWidth, 340)
  expect(before.zoom).toBeCloseTo(1)
  await openSettings(m)
  const slider = m.main.getByRole('slider', { name: 'Robot size' })
  await expect(slider).toHaveAttribute('min', '60')
  await expect(slider).toHaveAttribute('max', '200')
  await slider.fill('150')
  await expect.poll(async () => (await robotWindow(m)).zoom).toBeCloseTo(1.5)
  const after = await robotWindow(m)
  near(after.bounds.width, mediumWidth * 1.5)
  near(after.bounds.height, 450)
  await expect(m.main.getByText('150%', { exact: true })).toBeVisible()
  await expectBarFits(m)
  await expect(m.companion.getByRole('status')).toHaveText('Robot size: 150%')

  await m.main.getByRole('button', { name: 'Reset' }).click()
  await expect.poll(async () => (await robotWindow(m)).zoom).toBeCloseTo(1)
  await expect(slider).toHaveValue('100')
  await expect(m.main.getByRole('button', { name: 'Reset' })).toBeDisabled()

  await slider.fill('150') // back to 150% for the zoom test below
  await expect.poll(async () => (await robotWindow(m)).zoom).toBeCloseTo(1.5)
})

test('Ctrl/Cmd + scroll wheel over the robot zooms it and shows the size', async () => {
  await m.companion.evaluate(() => {
    const target = document.querySelector('[title^="Click to interact"]')!
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }))
  })
  await expect.poll(async () => (await robotWindow(m)).zoom).toBeCloseTo(1.6)
  await expect(m.companion.getByRole('status')).toHaveText('Robot size: 160%')
})

test('Hide: says how to bring him back, then robot and panel go; the taskbar / Dock icon or opening MyBuildy again brings him back', async () => {
  await m.app.evaluate(() => (globalThis as unknown as Record<string, { showFixtureGuidance(): void }>)['__mybuildyE2E'].showFixtureGuidance())
  await expect.poll(async () => (await robotWindow(m)).guidanceVisible).toBe(true)

  const hideButton = m.companion.getByRole('button', { name: /^Hide the robot/ })
  const place = process.platform === 'darwin' ? 'Dock' : 'taskbar'
  await expect(hideButton).toHaveAttribute('title', new RegExp(`click MyBuildy in your ${place}$`))
  await hideButton.click()
  await expect(m.companion.getByRole('alert')).toHaveText(`Buildy is hidden. Click MyBuildy in your ${place} to bring him back.`)
  await expect.poll(async () => (await robotWindow(m)).visible, { timeout: 6000 }).toBe(false)
  expect((await robotWindow(m)).guidanceVisible).toBe(false)
  // Windows: minimized, so MyBuildy's taskbar button is still there to click.
  if (process.platform === 'win32') expect((await robotWindow(m)).minimized).toBe(true)

  // Guidance arriving while hidden is kept, not popped up.
  await m.app.evaluate(() => (globalThis as unknown as Record<string, { showFixtureGuidance(): void }>)['__mybuildyE2E'].showFixtureGuidance())
  await m.companion.waitForTimeout(400)
  expect((await robotWindow(m)).guidanceVisible).toBe(false)

  // Clicking MyBuildy in the taskbar (Windows: the window is restored) / Dock (macOS: the app is activated).
  await m.app.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === 'darwin') { app.emit('activate'); return }
    BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('companion=true'))!.restore()
  })
  await expect.poll(async () => (await robotWindow(m)).visible).toBe(true)

  // Opening MyBuildy again from the Start menu / Applications brings him back too.
  await hideButton.click()
  await expect.poll(async () => (await robotWindow(m)).visible, { timeout: 6000 }).toBe(false)
  await m.app.evaluate(({ app }) => { app.emit(process.platform === 'darwin' ? 'activate' : 'second-instance') })
  await expect.poll(async () => (await robotWindow(m)).visible).toBe(true)

  // The shortcut still works (it is just never offered as the way).
  await hideButton.click()
  await expect.poll(async () => (await robotWindow(m)).visible, { timeout: 6000 }).toBe(false)
  expect(await m.app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Alt+B'))).toBe(true)
  await m.app.evaluate(() => (globalThis as unknown as Record<string, { pressRobotShortcut(): void }>)['__mybuildyE2E'].pressRobotShortcut())
  await expect.poll(async () => (await robotWindow(m)).visible).toBe(true)
})

test('the robot size is remembered after a restart', async () => {
  await m.close()
  m = await launchMyBuildy({ profileDir, keepProfile: true })
  await expect.poll(async () => (await robotWindow(m)).zoom).toBeCloseTo(1.6)
  near((await robotWindow(m)).bounds.width, mediumWidth * 1.6)
})

test('Quit asks first; Cancel keeps everything; Quit shuts MyBuildy down', async () => {
  await m.companion.getByRole('button', { name: 'Quit MyBuildy' }).click()
  const dialog = m.companion.getByRole('dialog')
  await expect(dialog).toContainText('Quit MyBuildy?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await robotWindow(m)).visible).toBe(true)

  const exited = new Promise((resolve) => m.app.process().once('exit', resolve))
  await m.companion.getByRole('button', { name: 'Quit MyBuildy' }).click()
  await m.companion.getByRole('dialog').getByRole('button', { name: 'Quit', exact: true }).click()
  await exited // every window, the robot, watching and the voice queue: the process is gone
})
