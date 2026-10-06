// providers.live.test.ts — REAL provider tests (npm run test:live). Not part of
// `npm test` or CI: it spends money and needs real keys.
//
// For Anthropic, OpenAI and OpenRouter, against the live API and through the
// app's own code paths (model-fetch, connection-test, the providers'
// analyzeScreen):
//   1. list models; the curated list and the Suggested model must all exist;
//   2. for every curated model (the Suggested one first): the real setup check
//      (red test image → "red") and one real screen analysis of
//      live/fixtures/terminal.jpg, which must parse into a usable analysis.
// Prints a pass/fail table. Spend is estimated from each response's token
// usage and the run stops before it can pass SPEND_LIMIT_USD.
//
// Keys come from MYBUILDY_TEST_KEYS (default C:\Users\User\mybuildy-test-keys.env)
// and are never printed: provider errors are classified without their body.

import { describe, it, expect, vi, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('no userData in live tests') } },
  safeStorage: { isEncryptionAvailable: () => false },
}))
// A check must not try to persist a vision pass (no userData here).
vi.mock('../src/main/vision-approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/vision-approvals')>()),
  recordVisionPass: () => {},
  recordVisionFail: () => {},
}))

import { defaultSettings, emptyProjectMemory, type AppSettings, type ProviderType } from '../src/renderer/src/types'
import { fetchModelsForProvider } from '../src/main/ai/model-fetch'
import { testProviderConnection } from '../src/main/ai/connection-test'
import { getProvider } from '../src/main/ai/provider-registry'
import { CURATED_MODELS } from '../src/main/ai/model-suggestions'

const SPEND_LIMIT_USD = 1.8
const KEY_FILE = process.env.MYBUILDY_TEST_KEYS || 'C:\\Users\\User\\mybuildy-test-keys.env'
const PROVIDERS: Array<{ provider: ProviderType; keyName: string }> = [
  { provider: 'anthropic', keyName: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', keyName: 'OPENAI_API_KEY' },
  { provider: 'openrouter', keyName: 'OPENROUTER_API_KEY' },
]

// $ per million tokens [input, output]. Unknown models are priced high on purpose.
const PRICES: Record<string, [number, number]> = {
  'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5-20251001': [1, 5], 'claude-sonnet-5': [2, 10], 'claude-opus-5-5': [4, 20],
  'gpt-6-luna': [0.1, 0.5], 'gpt-5.6-luna': [0.2, 1.2], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-6-sol': [2, 10], 'gpt-4.1-mini': [0.4, 1.6],
  'anthropic/claude-haiku-4.5': [1, 5], 'anthropic/claude-sonnet-5.5': [2, 10], 'openai/gpt-6-luna': [0.1, 0.5],
  'google/gemini-3.8-flash': [0.75, 3.75], 'qwen/qwen3.8-flash': [0.15, 0.47],
}
const FALLBACK_PRICE: [number, number] = [10, 50]

function loadKeys(): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const line of fs.readFileSync(KEY_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
    if (m) keys[m[1]] = m[2].trim()
  }
  return keys
}

// ─── Spend tracking: read token usage from every provider response ───────────
let spentUsd = 0
let currentModel = ''
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === 'POST' && spentUsd >= SPEND_LIMIT_USD) {
    throw new Error(`live spend limit reached ($${spentUsd.toFixed(3)})`)
  }
  const response = await realFetch(input, init)
  if (init?.method === 'POST' && response.ok) {
    try {
      const json = (await response.clone().json()) as {
        usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
      }
      const inTok = json.usage?.input_tokens ?? json.usage?.prompt_tokens ?? 0
      const outTok = json.usage?.output_tokens ?? json.usage?.completion_tokens ?? 0
      const [pin, pout] = PRICES[currentModel] ?? FALLBACK_PRICE
      spentUsd += (inTok * pin + outTok * pout) / 1_000_000
    } catch {
      // not JSON (e.g. a stream) — nothing to count
    }
  }
  return response
}) as typeof fetch

// ─── Results table ───────────────────────────────────────────────────────────
interface Row { provider: string; model: string; suggested: boolean; check: string; analysis: string; seconds: string }
const rows: Row[] = []

afterAll(() => {
  const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
  const lines = [
    '',
    `| ${pad('Provider', 10)} | ${pad('Model', 28)} | ${pad('Suggested', 9)} | ${pad('Setup check', 11)} | ${pad('Analysis', 8)} | Seconds |`,
    `|${'-'.repeat(12)}|${'-'.repeat(30)}|${'-'.repeat(11)}|${'-'.repeat(13)}|${'-'.repeat(10)}|---------|`,
    ...rows.map((r) => `| ${pad(r.provider, 10)} | ${pad(r.model, 28)} | ${pad(r.suggested ? 'yes' : '', 9)} | ${pad(r.check, 11)} | ${pad(r.analysis, 8)} | ${pad(r.seconds, 7)} |`),
    '',
    `Estimated spend: $${spentUsd.toFixed(3)} (limit $${SPEND_LIMIT_USD.toFixed(2)})`,
    `Passed: ${rows.filter((r) => r.check === 'PASS' && r.analysis === 'PASS').length} of ${rows.length}`,
    '',
  ]
  fs.writeFileSync(path.join(__dirname, 'last-results.md'), lines.join('\n'))
  console.log(lines.join('\n'))
})

const keys = loadKeys()
const screenshot = fs.readFileSync(path.join(__dirname, 'fixtures', 'terminal.jpg')).toString('base64')

for (const { provider, keyName } of PROVIDERS) {
  describe(`${provider} (live)`, () => {
    const apiKey = keys[keyName] ?? ''
    const settingsFor = (modelId: string): AppSettings => ({ ...defaultSettings(), provider, modelId, apiKey, baseUrl: '' })
    const curated = [...(CURATED_MODELS[provider] ?? [])]

    it('lists models; the curated list and the Suggested model exist on the account', async () => {
      expect(apiKey, `${keyName} missing from the key file`).not.toBe('')
      const result = await fetchModelsForProvider(settingsFor(''))
      expect(result.error).toBeNull()
      const ids = result.models.map((m) => m.id)
      const missing = curated.filter((id) => !ids.includes(id))
      expect(missing, `curated models missing on the account: ${missing.join(', ')}`).toEqual([])
      const suggested = result.models.filter((m) => m.suggested).map((m) => m.id)
      expect(suggested).toEqual([curated[0]])
      expect(result.models.filter((m) => m.curated).map((m) => m.id)).toEqual(curated)
    }, 60_000)

    for (const modelId of curated) {
      it(`${modelId}: setup check + one screen analysis`, async () => {
        currentModel = modelId
        const row: Row = { provider, model: modelId, suggested: modelId === curated[0], check: 'FAIL', analysis: 'not run', seconds: '' }
        rows.push(row)
        const started = Date.now()
        try {
          const check = await testProviderConnection(settingsFor(modelId))
          row.check = check.visionPassed ? 'PASS' : `FAIL (${check.errorKind ?? 'no answer'})`
          expect(check.visionPassed, `setup check: ${check.message}`).toBe(true)

          const analysis = await getProvider(provider).analyzeScreen(
            { imageBase64: screenshot, windowTitle: 'Windows PowerShell - claude', sourceId: 'live-test', capturedAt: new Date().toISOString() },
            emptyProjectMemory(),
            settingsFor(modelId)
          )
          const usable = analysis.screenContentVisible && analysis.whatIsHappening.trim().length > 10
            && !analysis.whatItMeans.includes('had trouble reading the response')
          row.analysis = usable ? 'PASS' : 'FAIL'
          expect(usable, `analysis was not usable: ${analysis.whatIsHappening.slice(0, 120)}`).toBe(true)
        } catch (error) {
          if (row.check.startsWith('PASS') && row.analysis === 'not run') row.analysis = 'FAIL (error)'
          throw error
        } finally {
          row.seconds = ((Date.now() - started) / 1000).toFixed(1)
        }
      }, 180_000)
    }
  })
}
