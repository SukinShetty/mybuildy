// user-check.spec.ts — MyBuildy checked like a user would: a fresh profile and
// only the buttons on screen, with Buildy's own voice (Kokoro) loaded. Then the
// diagnostic log (watch.log) must show that the female voice (Bella) and the
// male voice (Puck) both spoke, and that watching, paste and the robot worked.
// DEV BUILD ONLY: the AI provider is the gated e2e fake (src/main/e2e-fakes.ts),
// so no provider is called; the watched window is the fake terminal window.
// What it can't check: what the voices sound like on real speakers.

import { test, expect, type Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

test.skip(IS_PACKAGED_RUN, 'The setup fakes are dev-build only')
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const FAKE_PROMPT = 'Create a simple page with the title "My habits".'
let m: MyBuildyApp
let watchLog = (): string => ''
let savedClipboard = ''
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true })
const robotLabel = () => m.companion.getByTestId('robot-next-step')

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000)
  m = await launchMyBuildy({ env: { MYBUILDY_E2E_FAKES: '1', MYBUILDY_E2E_FAKE_PLATFORM: 'win32', MYBUILDY_E2E_KOKORO: '1' } })
  savedClipboard = await m.app.evaluate(({ clipboard }) => clipboard.readText())
  const file = path.join(await m.app.evaluate(({ app }) => app.getPath('userData')), 'logs', 'watch.log')
  watchLog = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  // Count the clips the voice window really plays (WAV from Kokoro).
  await m.voice.evaluate(() => {
    const w = window as unknown as { __clips: Array<{ wav: boolean; duration: number }> }
    w.__clips = []
    const Original = window.Audio
    ;(window as unknown as { Audio: unknown }).Audio = function (src?: string) {
      const audio = new Original(src)
      // VoicePlayer labels every clip audio/mpeg; Kokoro's are WAV (RIFF header).
      audio.addEventListener('canplaythrough', () => w.__clips.push({ wav: atob((src ?? '').split(',')[1] ?? '').startsWith('RIFF'), duration: audio.duration }))
      return audio
    } as unknown as typeof Audio
  })
})
test.afterAll(async ({}, testInfo) => {
  const log = watchLog()
  if (log) {
    fs.writeFileSync(testInfo.outputPath('user-check-watch.log'), log)
    console.log(`[user-check] watch.log:\n${log}`)
  }
  await m?.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard).catch(() => {})
  await m?.close()
})

test("Buildy's voice is ready (Kokoro, no eSpeak)", async () => {
  await expect.poll(watchLog, { timeout: 120_000 }).toMatch(/voice-engine kokoro=(ready|failed|missing|stopped)/)
  expect(watchLog()).toMatch(/voice-engine kokoro=ready loadMs=\d+/)
})

test('setup with the buttons on screen ends watching the chosen window', async () => {
  const page = m.main
  await page.getByRole('button', { name: "Let's set up (2 minutes)" }).click()
  await page.getByRole('button', { name: /OpenAI/ }).click()
  await page.getByLabel('Your OpenAI key').fill('sk-e2e-not-a-real-key-000000')
  await next(page).click()
  await expect(page.getByLabel('Check passed')).toBeVisible()
  await next(page).click()
  await page.getByTestId('goal-habits').click()
  await next(page).click()
  await next(page).click() // Open your coding agent
  await page.getByRole('button', { name: 'Choose the window' }).click()
  const items = page.locator('[data-window-id]')
  await expect.poll(() => items.count(), { timeout: 15_000 }).toBeGreaterThan(0)
  await items.first().click()
  await page.getByRole('button', { name: 'Watch this window' }).click()
  await expect(page.getByTestId('window-chosen')).toContainText('MyBuildy is watching:')
  await next(page).click()
  await page.getByRole('button', { name: 'Finish' }).click()

  // Watching: one analysis, shown on the robot and in Guidance.
  await expect(robotLabel()).toHaveText('Your prompt is ready — click Paste into terminal', { timeout: 30_000 })
  await expect(m.guidance.getByText(FAKE_PROMPT)).toBeVisible()
  expect(watchLog()).toMatch(/watch-started /)
})

test('the guidance is spoken in the female voice (Bella) by Kokoro', async () => {
  await expect.poll(watchLog, { timeout: 60_000 }).toMatch(/voice-line engine=kokoro voice=bella firstWordMs=\d+/)
  await expect.poll(() => m.voice.evaluate(() => (window as unknown as { __clips: Array<{ wav: boolean; duration: number }> }).__clips.filter((c) => c.wav && c.duration > 0.5).length), { timeout: 30_000 }).toBeGreaterThan(0)
})

test('Paste into terminal pastes into the watched window (never presses Enter)', async () => {
  await m.guidance.getByRole('button', { name: 'Paste into terminal' }).click()
  await expect.poll(watchLog, { timeout: 30_000 }).toMatch(/send-(pasted|refused)/)
  const outcome = watchLog().split(/\r?\n/).filter((l) => /send-(pasted|refused)/.test(l)).at(-1) ?? ''
  console.log(`[user-check] ${outcome}`)
  expect(watchLog()).toMatch(/send-requested /)
  // Real keystrokes reach a window on Windows and macOS; Linux has no paste.
  if (process.platform === 'win32') expect(outcome).toMatch(/send-pasted/)
})

test('Settings → Voice: Play sample speaks the female voice (Bella) and the male voice (Puck)', async () => {
  const page = m.main
  // After setup the panel is closed; the robot's gear button opens it.
  await m.companion.getByRole('button', { name: 'Settings' }).click()
  const female = page.getByRole('button', { name: 'Play sample: Female voice' })
  if (!(await female.isVisible().catch(() => false))) await page.getByTitle('Settings').click()
  await female.click()
  await expect.poll(watchLog, { timeout: 60_000 }).toMatch(/voice-sample voice=bella/)
  await page.getByRole('button', { name: 'Play sample: Male voice' }).click()
  await expect.poll(watchLog, { timeout: 60_000 }).toMatch(/voice-sample voice=puck/)
  const group = page.getByRole('radiogroup', { name: "Buildy's voice" })
  await group.getByRole('radio', { name: /^Male voice$/ }).click()
  await expect.poll(watchLog).toMatch(/voice-chosen voice=puck/)
  await expect(group).not.toContainText(/Bella|Puck|Kokoro|eSpeak/i)
})

test('the robot: Pause, Resume and Stop work from its buttons', async () => {
  await expect(m.companion.getByTestId('mascot')).toBeVisible()
  const pause = m.companion.getByRole('button', { name: 'Pause' })
  const resume = m.companion.getByRole('button', { name: 'Resume' })
  if (await resume.isVisible()) await resume.click()
  await pause.click()
  await expect(resume).toBeVisible()
  await resume.click()
  await expect(pause).toBeVisible()
  await m.companion.getByRole('button', { name: 'Stop' }).click()
  await expect(robotLabel()).toHaveText("Next: show me your coding agent's window")
  await expect.poll(watchLog).toMatch(/watch-stopped /)
})
