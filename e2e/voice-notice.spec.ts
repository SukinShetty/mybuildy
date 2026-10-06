// voice-notice.spec.ts — MyBuildy never falls back to the computer's voice
// silently. With an ElevenLabs key set and ElevenLabs failing (faked: e2e never
// calls ElevenLabs), the robot says "Your voice key isn't working, so MyBuildy
// is using your computer's voice" with the reason and an Open Settings button,
// which opens Settings showing the same. DEV BUILD ONLY (e2e fakes).

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'
import { VOICE_FALLBACK_HEADLINE } from '../src/renderer/src/types'

test.skip(IS_PACKAGED_RUN, 'The fakes are dev-build only')

type Api = {
  mybuildy: {
    setup: { finish(): Promise<void> }
    acceptCaptureNotice(): Promise<void>
    setSecret(name: string, value: string): Promise<void>
    stopCompanion(): Promise<void>
  }
}

let m: MyBuildyApp
test.beforeAll(async () => {
  m = await launchMyBuildy({ env: { MYBUILDY_E2E_FAKES: '1', MYBUILDY_E2E_FAKE_VOICE: 'quota' } })
})
test.afterAll(async () => { await m?.close() })

test('ElevenLabs out of credits: the robot says so with the reason, and Open Settings shows it there too', async () => {
  const page = m.main
  // Set up: key + model (the fake check passes), an ElevenLabs key, setup done.
  await page.getByRole('button', { name: "Let's set up (2 minutes)" }).click()
  await page.getByRole('button', { name: /OpenAI/ }).click()
  await page.getByLabel('Your OpenAI key').fill('sk-e2e-not-a-real-key-000000')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByLabel('Check passed')).toBeVisible()
  await page.evaluate(async () => {
    const api = (window as unknown as Api).mybuildy
    await api.setSecret('elevenLabsApiKey', 'sk_e2enotarealelevenlabskey0000')
    await api.acceptCaptureNotice()
    await api.setup.finish()
  })
  await page.reload() // the panel, past the setup wizard

  // Watch a window from the robot: the first look is spoken → ElevenLabs "fails".
  await m.companion.getByRole('button', { name: 'Show MyBuildy your coding agent' }).click()
  const item = m.companion.locator('[data-window-id]').first()
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click()

  const notice = m.companion.getByTestId('voice-fallback')
  await expect(notice).toBeVisible({ timeout: 15_000 })
  await expect(notice).toContainText(VOICE_FALLBACK_HEADLINE)
  await expect(notice).toContainText('Your ElevenLabs credits for this month are used up.')

  await notice.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByTestId('settings-voice-fallback')).toContainText('Your ElevenLabs credits for this month are used up.')
  await expect.poll(() => m.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((b) => !/companion=|guidance=|voice=/.test(b.webContents.getURL()))!.isVisible())).toBe(true)

  // Logged for diagnosis (the reason only — never the key or the spoken text).
  const userData = await m.app.evaluate(({ app }) => app.getPath('userData'))
  const log = fs.readFileSync(path.join(userData, 'logs', 'watch.log'), 'utf8')
  expect(log).toMatch(/voice-fallback reason=quota/)
  expect(log).not.toContain('sk_e2e')

  await page.evaluate(() => (window as unknown as Api).mybuildy.stopCompanion())
})

test('Delete all MyBuildy data warns that the voice key goes too', async () => {
  const page = m.main
  await page.getByTitle('Settings').click()
  await page.getByRole('button', { name: 'Delete all MyBuildy data' }).click()
  await expect(page.getByText(/including your voice \(ElevenLabs\) key/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
})
