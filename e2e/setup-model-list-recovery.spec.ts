import { test, expect } from '@playwright/test'
import { launchMyBuildy, IS_PACKAGED_RUN } from './helpers'

test.skip(IS_PACKAGED_RUN, 'Uses isolated dev-only provider fakes, never a real API key')

test('a failed model list exposes safe diagnostics and recovers through Retry', async () => {
  const m = await launchMyBuildy({ env: { MYBUILDY_E2E_FAKES: '1', MYBUILDY_E2E_FAKE_PLATFORM: 'win32' } })
  try {
    await m.app.evaluate(({ ipcMain }) => {
      let attempts = 0
      ipcMain.removeHandler('mybuildy:list-models')
      ipcMain.handle('mybuildy:list-models', () => {
        if (++attempts === 1) return {
          models: [],
          error: "This model didn't accept MyBuildy's request. Try the next recommended model.",
          diagnostic: { stage: 'model-list', status: 400, kind: 'bad-request' },
        }
        return { models: [{ id: 'fake-mini', label: 'Fake Mini', suggested: true, curated: true }], error: null }
      })
    })
    const page = m.main
    await page.getByRole('button', { name: "Let's set up (2 minutes)" }).click()
    await page.getByRole('button', { name: /Anthropic/ }).click()
    await page.getByLabel('Your Anthropic key').fill('sk-e2e-not-a-real-key-000000')
    const next = page.getByRole('button', { name: 'Next', exact: true })
    await next.click()
    await expect(page.getByTestId('model-list-error')).toBeVisible()
    await expect(page.getByTestId('model-list-error')).not.toContainText('next recommended')
    await expect(page.getByTestId('model-list-diagnostic')).toHaveText('Model list · HTTP 400 · bad-request')
    await expect(next).toBeDisabled()
    await page.getByTestId('retry-model-list').click()
    await expect(page.getByRole('button', { name: /Fake Mini/ })).toBeVisible()
    await expect(page.getByTestId('model-check')).toContainText('This model can see your screen')
    await expect(next).toBeEnabled()
    await expect(page.getByTestId('model-list-error')).toHaveCount(0)
  } finally {
    await m.close()
  }
})
