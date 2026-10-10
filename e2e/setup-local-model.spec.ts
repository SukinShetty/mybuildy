// setup-local-model.spec.ts — first-run setup, "Use a local model instead":
// Ollama or LM Studio, no cloud key. DEV BUILD ONLY. The local servers are REAL
// HTTP servers started by this test (src/main/ai/testing/fake-local-server.ts);
// MYBUILDY_E2E_OLLAMA_URL / MYBUILDY_E2E_LMSTUDIO_URL point MyBuildy's detection
// at them instead of the default addresses (honoured only in e2e dev runs). The
// vision check runs for real against them. The platform fakes (e2e-fakes.ts)
// keep the Windows step list on any OS.

import { test, expect, type Page } from '@playwright/test'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'
import { startFakeLocalServer, closedLocalPort, type FakeLocalServer } from '../src/main/ai/testing/fake-local-server'

test.skip(IS_PACKAGED_RUN, 'The setup fakes are dev-build only')

type Api = {
  mybuildy: {
    setup: { info(): Promise<{ needed: boolean }> }
    loadSettings(): Promise<{ provider: string; modelId: string; baseUrl: string; secretFlags?: Record<string, boolean> }>
  }
}
const settingsOf = (page: Page) => page.evaluate(() => (window as unknown as Api).mybuildy.loadSettings())
const wizardStep = (page: Page) => page.getByTestId('setup-wizard')
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true })

test.describe('first-run setup with a local model, no cloud key', () => {
  let m: MyBuildyApp
  let ollamaPort = 0
  let ollama: FakeLocalServer | null = null
  let lmstudio: FakeLocalServer

  test.beforeAll(async () => {
    ollamaPort = await closedLocalPort() // Ollama isn't running yet
    lmstudio = await startFakeLocalServer({ kind: 'lmstudio', models: [{ name: 'text-only-model' }, { name: 'an-embedding', embeddings: true }] })
    m = await launchMyBuildy({
      env: {
        MYBUILDY_E2E_FAKES: '1',
        MYBUILDY_E2E_FAKE_PLATFORM: 'win32',
        MYBUILDY_E2E_OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
        MYBUILDY_E2E_LMSTUDIO_URL: lmstudio.url,
      },
    })
  })
  test.afterAll(async () => {
    await m?.close()
    await ollama?.close()
    await lmstudio?.close()
  })

  test('not running → guidance → Check again → pick a model that can read images → setup finishes', async () => {
    const page = m.main
    await page.getByRole('button', { name: "Let's set up (2 minutes)" }).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'key')

    // The cloud-key path is still the first thing shown, unchanged.
    await expect(page.getByRole('button', { name: /OpenAI/ })).toBeVisible()
    await page.getByRole('button', { name: 'Use a local model instead (Ollama or LM Studio)' }).click()
    await expect(page.getByRole('heading', { name: 'Use a model on this computer' })).toBeVisible()
    await expect(next(page)).toBeDisabled()

    // LM Studio is running here, but has no model that can read images.
    await page.getByRole('button', { name: /LM Studio/ }).click()
    await expect(page.getByTestId('local-status-lmstudio')).toHaveAttribute('data-running', 'true')
    await expect(next(page)).toBeEnabled()
    await next(page).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'model')
    await expect(page.getByTestId('local-model-guidance')).toContainText('None of your LM Studio models can read images')
    await expect(page.getByRole('button', { name: /text-only-model/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /an-embedding/ })).toHaveCount(0) // never an embeddings model
    await expect(next(page)).toBeDisabled()
    // Trying it anyway: the real vision check says it can't see.
    await page.getByRole('button', { name: /text-only-model/ }).click()
    await expect(page.getByTestId('model-check')).not.toContainText('This model can see your screen', { timeout: 30_000 })
    await expect(page.getByTestId('model-check')).toBeVisible()
    await expect(next(page)).toBeDisabled()

    // Back, and Ollama instead: not running yet.
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'key')
    await expect(page.getByRole('heading', { name: 'Use a model on this computer' })).toBeVisible()
    await page.getByRole('button', { name: /^Ollama/ }).click()
    await expect(page.getByTestId('local-status-ollama')).toHaveAttribute('data-running', 'false')
    await expect(page.getByTestId('local-guidance')).toHaveText(
      "Ollama isn't running on this computer. Install it from ollama.com, or open it if it's installed, then click Check again."
    )
    await expect(next(page)).toBeDisabled()

    // The user starts Ollama (with one text model and one that can read images).
    ollama = await startFakeLocalServer({ kind: 'ollama', models: [{ name: 'words-only:7b' }, { name: 'sees-images:7b', vision: true }] }, ollamaPort)
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByTestId('local-status-ollama')).toHaveAttribute('data-running', 'true')
    await expect(page.getByTestId('local-guidance')).toHaveCount(0)
    await next(page).click()

    // Your model: the one that can read images comes first, marked, and is checked automatically.
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'model')
    const rows = page.getByTestId('local-models').getByRole('button')
    await expect(rows.first()).toContainText('sees-images:7b')
    await expect(rows.first()).toContainText('Can read images')
    await expect(page.getByTestId('local-model-guidance')).toHaveCount(0)
    await expect(page.getByTestId('model-check')).toContainText('This model can see your screen', { timeout: 30_000 })
    await expect(next(page)).toBeEnabled()

    const s = await settingsOf(page)
    expect(s.provider).toBe('ollama')
    expect(s.modelId).toBe('sees-images:7b')
    expect(s.baseUrl).toBe(`http://127.0.0.1:${ollamaPort}`) // not the default address, so it is saved
    expect(Object.values(s.secretFlags ?? {}).some(Boolean)).toBe(false) // no key of any kind
    expect(ollama.requests).toContain('POST /api/chat') // the vision check really reached the local server
    await next(page).click()

    // The rest of setup is unchanged: goal, agent, window (skipped), done.
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'goal')
    await page.getByTestId('goal-habits').click()
    await next(page).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'agent')
    await next(page).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'window')
    await page.getByRole('button', { name: /Skip for now/ }).click()
    await expect(wizardStep(page)).toHaveAttribute('data-step', 'done')
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect.poll(async () => (await m.main.evaluate(() => (window as unknown as Api).mybuildy.setup.info())).needed).toBe(false)
    await expect(m.companion.getByText("Next: show me your coding agent's window")).toBeVisible()
  })
})
