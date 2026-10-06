// first-run.spec.ts — a completely empty profile behaves like a first launch:
// the guided setup opens (its key step leads with the three recommended
// providers, Gemini under Advanced as "Not yet tested"; local models stay in
// Settings → Advanced), no model is selected anywhere, and trying to watch a window
// is refused with the exact "Choose a model in Settings" message — proving the
// app is inert (no provider calls possible) until the user configures it.

import { test, expect } from '@playwright/test'
import { launchMyBuildy, type MyBuildyApp } from './helpers'
import { CHOOSE_MODEL_MESSAGE } from '../src/renderer/src/types'

let mybuildy: MyBuildyApp

test.beforeAll(async () => {
  mybuildy = await launchMyBuildy()
})

test.afterAll(async () => {
  await mybuildy?.close()
})

test('first launch opens the guided setup; its key step offers the 3 recommended providers', async () => {
  const wizard = mybuildy.main.getByTestId('setup-wizard')
  await expect(wizard).toHaveAttribute('data-step', 'welcome')
  await expect(mybuildy.main.getByText(/MyBuildy watches your AI coding agent and tells you/)).toBeVisible()
  await mybuildy.main.getByRole('button', { name: /Let's set up/ }).click()

  await expect(wizard).toHaveAttribute('data-step', 'key')
  for (const name of ['Anthropic', 'OpenAI', 'OpenRouter']) {
    await expect(mybuildy.main.getByText(name, { exact: true })).toBeVisible()
  }
  // Subscriptions are not API credits — said up front.
  await expect(mybuildy.main.getByTestId('credits-note')).toContainText("ChatGPT Plus and Claude Pro subscriptions don't include these")
  // Gemini is not recommended: it sits under Advanced, labelled "Not yet tested".
  await expect(mybuildy.main.getByText('Google Gemini', { exact: true })).toHaveCount(0)
  await mybuildy.main.getByRole('button', { name: 'Advanced: more providers' }).click()
  await expect(mybuildy.main.getByText('Google Gemini', { exact: true })).toBeVisible()
  await expect(mybuildy.main.getByText('Not yet tested', { exact: true })).toBeVisible()
  // Local models are not offered here (Settings → Advanced has them).
  await expect(mybuildy.main.getByText('Ollama', { exact: true })).toHaveCount(0)
  await expect(mybuildy.main.getByText('LM Studio', { exact: true })).toHaveCount(0)
})

test('no model is selected and no key is stored on a fresh profile', async () => {
  const settings = await mybuildy.main.evaluate(async () => {
    const api = (window as unknown as { mybuildy: { loadSettings(): Promise<unknown> } }).mybuildy
    return api.loadSettings()
  }) as { modelId: string; hasApiKey: boolean; captureNoticeAccepted: boolean }
  expect(settings.modelId).toBe('')
  expect(settings.hasApiKey).toBe(false)
  expect(settings.captureNoticeAccepted).toBe(false)
})

test('watching is blocked with the "Choose a model in Settings" message', async () => {
  // Drive the real companion flow: pick a (fake) window to watch; main must
  // refuse before any capture or provider call because no model is configured.
  const result = await mybuildy.companion.evaluate(async () => {
    const api = (window as unknown as {
      mybuildy: {
        onWatchedSourceChanged(
          handler: (event: unknown, data: { windowName: string | null; message: string | null }) => void
        ): () => void
        selectWatchSource(sourceId: string, windowName: string): Promise<void>
      }
    }).mybuildy
    return new Promise<{ windowName: string | null; message: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no watched-source response within 10s')), 10_000)
      const unsubscribe = api.onWatchedSourceChanged((_event, data) => {
        clearTimeout(timer)
        unsubscribe()
        resolve(data)
      })
      void api.selectWatchSource('e2e-fake-source-id', 'Sample Window')
    })
  })
  expect(result.windowName).toBeNull()
  expect(result.message).toBe(CHOOSE_MODEL_MESSAGE)
})
