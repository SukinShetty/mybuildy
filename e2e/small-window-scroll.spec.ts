// small-window-scroll.spec.ts — in a small (not maximized) main window the
// Settings page still scrolls to its last section. Regression for: the model
// list's own 320px scroll area filled most of a small window, so the mouse
// wheel scrolled the list and never the page, and the page looked cut off.
// DEV BUILD ONLY (e2e fakes: a long canned model list; no provider is called).

import { test, expect } from '@playwright/test'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

test.skip(IS_PACKAGED_RUN, 'The fakes are dev-build only')

type Settings = Record<string, unknown>
type Api = {
  mybuildy: {
    setup: { finish(): Promise<void> }
    acceptCaptureNotice(): Promise<void>
    loadSettings(): Promise<Settings>
    saveSettings(s: Settings): Promise<void>
  }
}

let m: MyBuildyApp
test.beforeAll(async () => {
  m = await launchMyBuildy({ env: { MYBUILDY_E2E_FAKES: '1', MYBUILDY_E2E_FAKE_MANY_MODELS: '1' } })
})
test.afterAll(async () => { await m?.close() })

test('Settings: the model list leaves room to scroll the page, and the last section is reachable', async () => {
  const page = m.main
  // Past setup, on a keyless local provider so the model list loads (canned).
  await page.evaluate(async () => {
    const api = (window as unknown as Api).mybuildy
    const s = await api.loadSettings()
    await api.saveSettings({ ...s, provider: 'ollama', baseUrl: 'http://localhost:11434' })
    await api.acceptCaptureNotice()
    await api.setup.finish()
  })
  await page.reload()

  // The smallest window MyBuildy allows (560×600).
  await m.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((b) => !/companion=|guidance=|voice=|^data:/.test(b.webContents.getURL()))
    win?.unmaximize()
    win?.setContentSize(560, 600)
  })
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(600)

  await page.locator('.app-titlebar button', { hasText: 'Settings' }).click()
  const modelList = page.getByRole('button', { name: /Fake Model 0/ }).locator('xpath=..')
  await expect(modelList).toBeVisible()

  const box = await modelList.evaluate((list) => {
    let scroller = list.parentElement
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
    return {
      list: list.clientHeight,
      listScrolls: list.scrollHeight > list.clientHeight,
      page: scroller!.clientHeight,
      pageScrolls: scroller!.scrollHeight > scroller!.clientHeight,
    }
  })
  expect(box.listScrolls).toBe(true)
  expect(box.pageScrolls).toBe(true)
  // The inner list must not take most of the page, or the wheel gets trapped in it.
  expect(box.list).toBeLessThanOrEqual(box.page * 0.5)

  // Wheel over the page below the header: the last section comes into view.
  const last = page.getByRole('button', { name: 'Delete all MyBuildy data' })
  await page.mouse.move(540, 590)
  for (let i = 0; i < 30 && !(await last.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight)); i++) {
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(50)
  }
  const r = await last.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, h: window.innerHeight }))
  expect(r.bottom).toBeLessThanOrEqual(r.h)
})
