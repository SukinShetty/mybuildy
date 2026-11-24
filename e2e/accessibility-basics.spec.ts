// accessibility-basics.spec.ts — names, landmarks, headings and text contrast
// that the pre-launch audit's axe scan failed (LA-13, LA-14, LA-15). No extra
// dependency: roles/names through Playwright, contrast computed from the real
// rendered colors (WCAG 2 formula). Throwaway profile.
import { test, expect, type Page } from '@playwright/test'
import { launchMyBuildy, type MyBuildyApp } from './helpers'

let m: MyBuildyApp
test.beforeAll(async () => { m = await launchMyBuildy() })
test.afterAll(async () => { await m?.close() })

/** WCAG contrast of an element's text against the first opaque background behind it. */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const rgba = (c: string): number[] => (c.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number)
    const lum = ([r, g, b]: number[]): number => {
      const f = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    // Composite translucent backgrounds from the element up to the first opaque one.
    const layers: number[][] = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bg = rgba(getComputedStyle(node).backgroundColor)
      if ((bg[3] ?? 1) > 0) layers.push(bg)
      if ((bg[3] ?? 1) >= 1) break
    }
    let base = [0, 0, 0]
    for (const [r, g, b, a = 1] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]
    const fg = rgba(getComputedStyle(el).color)
    const [hi, lo] = [lum(fg), lum(base)].sort((a, b) => b - a)
    return (hi + 0.05) / (lo + 0.05)
  })
}

test('setup welcome: a main landmark, and the primary button text is readable (>= 4.5:1)', async () => {
  await expect(m.main.getByTestId('setup-wizard')).toHaveAttribute('data-step', 'welcome')
  await expect(m.main.getByRole('main')).toHaveCount(1)
  expect(await contrastOf(m.main, '.btn-primary')).toBeGreaterThanOrEqual(4.5)
})

test('each main screen has one main landmark and a level-1 heading; the active tab text is readable', async () => {
  await m.main.evaluate(async () => (window as unknown as { mybuildy: { setup: { finish(): Promise<void> } } }).mybuildy.setup.finish())
  await m.companion.evaluate(() => (window as unknown as { mybuildy: { openPanel(): void } }).mybuildy.openPanel())
  await m.main.reload()
  for (const title of ['Set Goal', 'Brainstorm', 'Guidance', 'Memory', 'Settings']) {
    await m.main.getByTitle(title, { exact: true }).click()
    await expect(m.main.getByRole('main')).toHaveCount(1)
    await expect(m.main.getByRole('heading', { level: 1 })).toHaveCount(1)
    expect(await contrastOf(m.main, `button[title="${title}"] span:last-child`), `${title} tab`).toBeGreaterThanOrEqual(4.5)
  }
})

test('the project picker and the hourly limit have names', async () => {
  await m.main.getByTitle('Set Goal', { exact: true }).click()
  await expect(m.main.getByRole('combobox', { name: /project/i })).toBeVisible()
  await m.main.getByTitle('Settings', { exact: true }).click()
  await expect(m.main.getByRole('spinbutton', { name: 'Maximum AI requests per hour' })).toBeVisible()
})

test('hint text in Settings is readable on the page and on provider cards (>= 4.5:1)', async () => {
  await m.main.getByTitle('Settings', { exact: true }).click()
  expect(await contrastOf(m.main, '#settings-hourly-cap-hint')).toBeGreaterThanOrEqual(4.5)
  const cardHint = m.main.locator('button div[style*="--color-text-dim"]')
  const count = await cardHint.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    await cardHint.nth(i).evaluate((el) => el.setAttribute('data-contrast-probe', '1'))
    expect(await contrastOf(m.main, '[data-contrast-probe="1"]')).toBeGreaterThanOrEqual(4.5)
    await cardHint.nth(i).evaluate((el) => el.removeAttribute('data-contrast-probe'))
  }
})

test('the robot window has a main landmark and a heading', async () => {
  await expect(m.companion.getByRole('main', { name: 'MyBuildy robot' })).toHaveCount(1)
  await expect(m.companion.getByRole('heading', { level: 1 })).toHaveCount(1)
})
