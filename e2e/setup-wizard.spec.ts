// setup-wizard.spec.ts — the guided first-run setup, every step, on both
// platforms' paths. DEV BUILD ONLY: uses the gated e2e fakes (src/main/e2e-fakes.ts)
// for the platform, the macOS permissions and the AI provider, so no provider is
// ever called and the Mac steps run on any OS (and the Windows steps on macOS).
// The user's clipboard is saved before and restored after.

import { test, expect, type Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'
import { READY_GOALS } from '../src/renderer/src/setup/setup-model'

test.skip(IS_PACKAGED_RUN, 'The setup fakes are dev-build only')
test.describe.configure({ mode: 'serial' })

const fakesEnv = (platform: 'win32' | 'darwin', extra: Record<string, string> = {}): Record<string, string> => ({
  MYBUILDY_E2E_FAKES: '1',
  MYBUILDY_E2E_FAKE_PLATFORM: platform,
  ...extra,
})

type Api = {
  mybuildy: {
    goal: { get(): Promise<{ purpose: string; successCriteria?: string } | null> }
    setup: { info(): Promise<{ needed: boolean; step: string | null; platform: string }> }
    loadSettings(): Promise<{ provider: string; modelId: string; captureNoticeAccepted: boolean }>
  }
}

const wizardStep = (page: Page) => page.getByTestId('setup-wizard')

/** Optional review screenshots: set E2E_SHOTS_DIR to save one per step. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['E2E_SHOTS_DIR']
  if (!dir) return
  await page.waitForTimeout(300) // let button colour transitions settle
  await page.screenshot({ path: path.join(dir, `setup-${name}.png`) })
}
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true })

async function hooks<T>(m: MyBuildyApp, fn: string, arg?: unknown): Promise<T> {
  return m.app.evaluate((_e, [name, a]) => {
    const h = (globalThis as Record<string, unknown>)['__mybuildyE2E'] as Record<string, (x?: unknown) => unknown>
    return h[name as string](a) as never
  }, [fn, arg] as const) as Promise<T>
}

/** Welcome → key → model, shared by both platforms. */
async function throughModel(page: Page, total: number): Promise<void> {
  await expect(wizardStep(page)).toHaveAttribute('data-step', 'welcome')
  await expect(page.getByText('Step 1 of ' + total)).toBeVisible()
  await expect(page.getByText('MyBuildy watches your AI coding agent and tells you, in plain English, what happened and what to type next.')).toBeVisible()
  await page.getByRole('button', { name: "Let's set up (2 minutes)" }).click()

  // Your AI key: nothing chosen yet → Next is off.
  await expect(wizardStep(page)).toHaveAttribute('data-step', 'key')
  await expect(page.getByText('Step 2 of ' + total)).toBeVisible()
  await expect(next(page)).toBeDisabled()
  await page.getByRole('button', { name: /OpenAI/ }).click()
  await expect(page.getByRole('link', { name: 'Where do I get a key?' })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
  await page.getByLabel('Your OpenAI key').fill('sk-e2e-not-a-real-key-000000')
  await shot(page, 'key')
  await next(page).click()

  // Your model: the Suggested one is highlighted and checked automatically.
  await expect(wizardStep(page)).toHaveAttribute('data-step', 'model')
  await expect(page.getByRole('button', { name: /Fake Mini\s*Suggested/ })).toBeVisible() // the Suggested model is highlighted
  await expect(page.getByTestId('model-check')).toContainText('This model can see your screen')
  await expect(page.getByLabel('Check passed')).toBeVisible()
  await shot(page, 'model')
  await next(page).click()
}

test.describe('Windows path', () => {
  let m: MyBuildyApp
  let savedClipboard = ''

  test.beforeAll(async () => {
    m = await launchMyBuildy({ env: fakesEnv('win32') })
    savedClipboard = await m.app.evaluate(({ clipboard }) => clipboard.readText())
  })
  test.afterAll(async () => {
    await m?.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard).catch(() => {})
    await m?.close()
  })

  test('every step, with a ready-made goal, ends watching and finished', async () => {
    const page = m.main
    await throughModel(page, 7)
    expect((await page.evaluate(() => (window as unknown as Api).mybuildy.loadSettings())).modelId).toBe('fake-mini')

    // What do you want to build? — the four ready-made goals, each with Done when…
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'goal')
    await expect(page.getByText('Step 4 of 7')).toBeVisible()
    for (const g of READY_GOALS) {
      const card = page.getByTestId(`goal-${g.id}`)
      await expect(card).toContainText(g.title)
      await expect(card).toContainText('Done when')
    }
    await expect(page.getByTestId('goal-own')).toContainText('For example')
    await expect(next(page)).toBeDisabled()
    await page.getByTestId('goal-habits').click()
    await shot(page, 'goal')
    await next(page).click()
    // The wizard moves on only after the goal save finishes; read it after that.
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'agent')
    const goal = await page.evaluate(() => (window as unknown as Api).mybuildy.goal.get())
    expect(goal?.purpose).toBe(READY_GOALS[0].purpose)
    expect(goal?.successCriteria).toBe(READY_GOALS[0].doneWhen)

    // Open your coding agent — PowerShell, copyable commands.
    await expect(page.getByText('PowerShell', { exact: true })).toBeVisible()
    await expect(page.getByText('mkdir my-project; cd my-project', { exact: true })).toBeVisible()
    await shot(page, 'agent')
    await page.getByRole('button', { name: 'Copy claude' }).click()
    await expect.poll(() => m.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('claude')
    await next(page).click()

    // Show MyBuildy your coding agent — the window picker, then which window was chosen.
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'window')
    await expect(page.getByText(/only looks at the one window you choose/)).toBeVisible()
    await expect(next(page)).toBeDisabled()
    await page.getByRole('button', { name: 'Choose the window' }).click()
    await expect(page.getByText('Show MyBuildy your coding agent').last()).toBeVisible()
    const items = page.locator('[data-window-id]')
    await expect.poll(() => items.count(), { timeout: 15_000 }).toBeGreaterThan(0)
    await items.first().click()
    await page.getByRole('button', { name: 'Watch this window' }).click()
    await expect(page.getByTestId('window-chosen')).toContainText('MyBuildy is watching:')
    await shot(page, 'window')
    expect((await page.evaluate(() => (window as unknown as Api).mybuildy.loadSettings())).captureNoticeAccepted).toBe(true)
    await next(page).click()

    // Done.
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'done')
    await expect(page.getByText(/MyBuildy is watching\. When it suggests a prompt, click Paste into terminal, then press Enter/)).toBeVisible()
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect.poll(async () => (await m.main.evaluate(() => (window as unknown as Api).mybuildy.setup.info())).needed).toBe(false)

    // The robot says what to do next, in plain words (never "pick a window").
    await expect(m.companion.getByText(/Your prompt is ready — click Paste into terminal|Looking at your coding agent|Watching/)).toBeVisible({ timeout: 20_000 })
    await m.companion.evaluate(async () => {
      await (window as unknown as { mybuildy: { stopCompanion(): Promise<void> } }).mybuildy.stopCompanion()
    })
  })

  test('Settings → Run setup again starts the guided setup from the beginning', async () => {
    const page = m.main
    await page.reload()
    await page.getByTitle('Settings').click()
    await page.getByRole('button', { name: 'Run setup again' }).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'welcome')
  })
})

test.describe('Mac path (on any OS, with fake permissions)', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuildy-e2e-mac-'))
  test.afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }))

  test('screen step: Open System Settings, Restart MyBuildy, then resumes at the same step', async () => {
    const m = await launchMyBuildy({ profileDir, keepProfile: true, env: fakesEnv('darwin') })
    try {
      const page = m.main
      await throughModel(page, 9)

      await expect(wizardStep(page)).toHaveAttribute('data-step', 'screen')
      await expect(page.getByText('Step 4 of 9')).toBeVisible()
      await expect(page.getByTestId('screen-status')).toHaveAttribute('data-ok', 'false')
      await expect(next(page)).toBeDisabled()
      await page.getByRole('button', { name: 'Open System Settings' }).click()
      await shot(page, 'screen')
      const fakes = await hooks<{ openedPanes: string[] }>(m, 'setupFakes')
      expect(fakes.openedPanes).toContain('screen')

      // macOS applies the permission only after a restart: the app quits…
      const exited = new Promise((resolve) => m.app.process().once('exit', resolve))
      await page.getByRole('button', { name: 'Restart MyBuildy' }).click()
      await exited
    } finally {
      await m.close()
    }

    // …and reopens where it was, now with the permission applied.
    const again = await launchMyBuildy({ profileDir, keepProfile: true, env: fakesEnv('darwin', { MYBUILDY_E2E_FAKE_SCREEN: 'granted' }) })
    try {
      const page = again.main
      await expect(wizardStep(page)).toHaveAttribute('data-step', 'screen')
      await expect(page.getByTestId('screen-status')).toHaveAttribute('data-ok', 'true')
      await next(page).click()

      // Let MyBuildy paste for you — live status turns green by itself.
      await expect(wizardStep(page)).toHaveAttribute('data-step', 'paste')
      await expect(next(page)).toBeDisabled()
      await page.getByRole('button', { name: 'Allow pasting' }).click()
      expect((await hooks<{ pastePermissionRequests: number }>(again, 'setupFakes')).pastePermissionRequests).toBe(1)
      await hooks(again, 'setFakePermissions', { accessibility: true, automation: 'granted' })
      await expect(page.getByTestId('accessibility-status')).toHaveAttribute('data-ok', 'true')
      await expect(page.getByTestId('automation-status')).toHaveAttribute('data-ok', 'true')
      await shot(page, 'paste')
      await expect(next(page)).toBeEnabled()

      // Back, then the skip path.
      await page.getByRole('button', { name: 'Back' }).click()
      await next(page).click()
      await hooks(again, 'setFakePermissions', { accessibility: false, automation: 'unknown' })
      await page.getByRole('button', { name: "Skip — I'll paste myself" }).click()

      // Write my own goal.
      await expect(wizardStep(page)).toHaveAttribute('data-step', 'goal')
      await page.getByTestId('goal-own').click()
      await page.getByLabel('What do you want to build?').fill('A page that lists my favourite books.')
      await page.getByLabel(/Done when/).fill('the page shows five books with their authors.')
      await next(page).click()
      await expect(wizardStep(page)).toHaveAttribute('data-step', 'agent') // the goal save has finished
      const goal = await page.evaluate(() => (window as unknown as Api).mybuildy.goal.get())
      expect(goal?.purpose).toBe('A page that lists my favourite books.')

      // Mac instructions: Terminal.
      await expect(page.getByText('Terminal', { exact: true })).toBeVisible()
      await expect(page.getByText('mkdir my-project && cd my-project', { exact: true })).toBeVisible()
      await next(page).click()

      // Skipping the window still finishes cleanly, with the right Done text.
      await expect(wizardStep(page)).toHaveAttribute('data-step', 'window')
      await page.getByRole('button', { name: /Skip for now/ }).click()
      await expect(wizardStep(page)).toHaveAttribute('data-step', 'done')
      await expect(page.getByText(/click the robot and show MyBuildy your coding agent/)).toBeVisible()
      await page.getByRole('button', { name: 'Finish' }).click()
      await expect.poll(async () => (await again.main.evaluate(() => (window as unknown as Api).mybuildy.setup.info())).needed).toBe(false)
      await expect(again.companion.getByText("Next: show me your coding agent's window")).toBeVisible()
    } finally {
      await again.close()
    }
  })
})
