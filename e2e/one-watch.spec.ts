// one-watch.spec.ts — the robot and the Guidance tab are one system: one watched
// window, one analysis, one Auto/watching state, one Stop. Started from either
// place, both always show the same state.
// DEV BUILD ONLY: uses the gated e2e fakes (src/main/e2e-fakes.ts) — the fake
// provider answers each analysis with canned data after a short delay, so the
// "while it runs" state can be checked. No provider is ever called.

import { test, expect, type Page } from '@playwright/test'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

test.skip(IS_PACKAGED_RUN, 'The fakes are dev-build only')
test.describe.configure({ mode: 'serial' })

const FAKE_PROMPT = 'Create a simple page with the title "My habits".'

type Api = {
  mybuildy: {
    setup: { finish(): Promise<void> }
    acceptCaptureNotice(): Promise<void>
    stopCompanion(): Promise<void>
  }
}

async function hooks<T>(m: MyBuildyApp, fn: string): Promise<T> {
  return m.app.evaluate((_e, name) => {
    const h = (globalThis as Record<string, unknown>)['__mybuildyE2E'] as Record<string, () => unknown>
    return h[name]() as never
  }, fn) as Promise<T>
}

/** Key + model through the setup wizard (the fake vision check passes), then finish setup. */
async function configure(m: MyBuildyApp): Promise<void> {
  const page = m.main
  await page.getByRole('button', { name: "Let's set up (2 minutes)" }).click()
  await page.getByRole('button', { name: /OpenAI/ }).click()
  await page.getByLabel('Your OpenAI key').fill('sk-e2e-not-a-real-key-000000')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByLabel('Check passed')).toBeVisible()
  await page.evaluate(async () => {
    const api = (window as unknown as Api).mybuildy
    await api.acceptCaptureNotice()
    await api.setup.finish()
  })
  await page.reload()
  await page.getByTitle('Guidance').click()
}

const robotLabel = (m: MyBuildyApp) => m.companion.getByTestId('robot-next-step')
const robot = (m: MyBuildyApp) => m.companion.getByTestId('mascot')

/** Pick the first window in whichever picker is open on `page`. */
async function pickFirstWindow(page: Page, confirm: string | null): Promise<string> {
  const item = page.locator('[data-window-id]').first()
  await expect(item).toBeVisible({ timeout: 15_000 })
  const name = (await item.getAttribute('data-window-name')) ?? ''
  await item.click()
  if (confirm) await page.getByRole('button', { name: confirm }).click()
  return name
}

test.describe('robot and Guidance tab share one watch', () => {
  let m: MyBuildyApp

  test.beforeAll(async () => {
    m = await launchMyBuildy({ env: { MYBUILDY_E2E_FAKES: '1', MYBUILDY_E2E_FAKE_ANALYSIS_MS: '2500' } })
    await configure(m)
  })
  test.afterAll(async () => {
    await m?.close()
  })

  test('Analyze Now in the Guidance tab: the robot works, thinks, and shows the same result', async () => {
    const page = m.main
    await expect(robotLabel(m)).toHaveText("Next: show me your coding agent's window")
    const callsBefore = await hooks<number>(m, 'fakeAnalysisCalls')

    await page.getByRole('button', { name: '📸 Analyze Now' }).click()
    const windowName = await pickFirstWindow(page, 'Analyze this window')

    // While it runs: the Guidance tab and the robot both say so.
    await expect(page.getByText('MyBuildy is reading your screen and thinking…')).toBeVisible()
    await expect(robot(m)).toHaveAttribute('data-animation', 'working')
    await expect(robotLabel(m)).toContainText('Thinking')

    // Both show the same window.
    await expect(page.getByTestId('watched-window')).toHaveText(windowName)
    await expect(robotLabel(m)).toHaveAttribute('data-window', windowName)

    // One result, in the Guidance tab, the robot's panel and the robot's line.
    await expect(page.getByText(FAKE_PROMPT)).toBeVisible({ timeout: 10_000 })
    await expect(m.guidance.getByText(FAKE_PROMPT)).toBeVisible()
    await expect(robotLabel(m)).toHaveText('Your prompt is ready — click Paste into terminal')
    await expect(robot(m)).not.toHaveAttribute('data-animation', 'working')
    expect(await hooks<number>(m, 'fakeAnalysisCalls')).toBe(callsBefore + 1) // one analysis, not two

    // Analyze Now doesn't turn Auto on: the robot isn't watching continuously.
    await expect(page.getByRole('button', { name: 'Turn Auto on' })).toBeVisible()
    await expect(m.companion.getByRole('button', { name: 'Resume' })).toBeVisible()
  })

  test('Auto in the Guidance tab is the robot watching, and back', async () => {
    const page = m.main
    await page.getByRole('button', { name: 'Turn Auto on' }).click()
    await expect(m.companion.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect(robotLabel(m)).not.toContainText('Paused')

    // Pause on the robot turns Auto off in the Guidance tab.
    await m.companion.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Turn Auto on' })).toBeVisible()
    // Resume on the robot turns it back on.
    await m.companion.getByRole('button', { name: 'Resume' }).click()
    await expect(page.getByRole('button', { name: 'Turn Auto off' })).toBeVisible()
  })

  test('Stop in the Guidance tab stops everything in both places', async () => {
    const page = m.main
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(robotLabel(m)).toHaveText("Next: show me your coding agent's window")
    await expect(page.getByTestId('watched-window')).toHaveCount(0)
    await expect(page.getByText(FAKE_PROMPT)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Turn Auto on' })).toBeVisible()
    await expect(m.companion.getByRole('button', { name: 'Pause' })).toBeVisible() // nothing paused: nothing watched
  })

  test('choosing a window on the robot sets it for the Guidance tab; Stop on the robot clears both', async () => {
    const page = m.main
    await m.companion.getByRole('button', { name: 'Show MyBuildy your coding agent' }).click()
    const windowName = await pickFirstWindow(m.companion, null)

    // The robot watches (Auto on) and analyses at once; the Guidance tab follows.
    await expect(page.getByTestId('watched-window')).toHaveText(windowName)
    await expect(page.getByRole('button', { name: 'Turn Auto off' })).toBeVisible()
    await expect(robot(m)).toHaveAttribute('data-animation', 'working')
    await expect(page.getByText('MyBuildy is reading your screen and thinking…')).toBeVisible()
    await expect(page.getByText(FAKE_PROMPT)).toBeVisible({ timeout: 10_000 })
    await expect(robotLabel(m)).toHaveText('Your prompt is ready — click Paste into terminal')

    await m.companion.getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByTestId('watched-window')).toHaveCount(0)
    await expect(page.getByText(FAKE_PROMPT)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Turn Auto on' })).toBeVisible()
    await expect(robotLabel(m)).toHaveText("Next: show me your coding agent's window")
  })

  test('Auto on in the Guidance tab with no window: one pick, and the robot watches it', async () => {
    const page = m.main
    await page.getByRole('button', { name: 'Turn Auto on' }).click()
    const windowName = await pickFirstWindow(page, 'Watch this window')
    await expect(robotLabel(m)).toHaveAttribute('data-window', windowName)
    await expect(m.companion.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect(robotLabel(m)).toHaveText('Your prompt is ready — click Paste into terminal', { timeout: 10_000 })
    await expect(page.getByText(FAKE_PROMPT)).toBeVisible()
    await page.evaluate(() => (window as unknown as Api).mybuildy.stopCompanion())
    await expect(robotLabel(m)).toHaveText("Next: show me your coding agent's window")
  })
})
