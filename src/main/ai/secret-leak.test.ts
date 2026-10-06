// A provider error body that ECHOES the API key must never surface anywhere:
// not in the thrown exception, not in any console output, not in the payload
// sent back to a window over IPC.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('no userData in unit tests') } },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { defaultSettings, emptyProjectMemory, type AppSettings } from '../../renderer/src/types'
import { fetchModelsForProvider } from './model-fetch'
import { getProvider } from './provider-registry'
import { PROVIDER_ERROR_MESSAGES } from './provider-errors'

const FAKE_KEY = 'sk-proj-LEAKTESTLEAKTESTLEAKTEST0123456789'
const echo = JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}`, type: 'invalid_request_error' } })

let logged: string[] = []

beforeEach(() => {
  logged = []
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '))
    })
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(echo, { status: 401 })))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  ...defaultSettings(),
  provider: 'openai',
  modelId: 'gpt-test',
  apiKey: FAKE_KEY,
  ...over,
})

describe('a key echoed in a provider error body never leaks', () => {
  it('model list (IPC payload to Settings)', async () => {
    const result = await fetchModelsForProvider(settings())
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
    expect(result.error).toBe(PROVIDER_ERROR_MESSAGES.keyRejected)
    expect(logged.join('\n')).not.toContain(FAKE_KEY)
  })

  it('screen analysis (thrown exception + logs)', async () => {
    const provider = getProvider('openai')
    const capture = { imageBase64: 'AAAA', windowTitle: 'Terminal', sourceId: 'window:1:0', capturedAt: new Date().toISOString() }
    let thrown: unknown = null
    try {
      await provider.analyzeScreen(capture, emptyProjectMemory(), settings())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const e = thrown as Error
    expect(`${e.message} ${e.stack}`).not.toContain(FAKE_KEY)
    expect(e.message).toContain('HTTP 401')
    expect(logged.join('\n')).not.toContain(FAKE_KEY)
  })
})
