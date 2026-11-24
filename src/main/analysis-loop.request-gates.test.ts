// analysis-loop.request-gates.test.ts — questions, the prompt grader and the
// verifier honour the hourly AI request limit (LA-04), questions use the
// configured base URL once (LA-05), and a question never sends a screenshot
// to a model that has not passed the vision check (LA-06).
// Pre-launch audit (Codex, 2026-11-11), reproductions inverted into
// prevention tests. All provider traffic is a stubbed fetch: no real key,
// screenshot, provider request or paste.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.' }, screen: {}, BrowserWindow: class {} }))
vi.mock('./capturer', () => ({
  captureWatchedWindow: vi.fn(async () => null),
  listLiveWindowSources: vi.fn(async () => []),
  capturePollThumbnail: vi.fn(async () => null),
}))
vi.mock('./window-presence', () => ({ probeWindowPresence: vi.fn(async () => ({ exists: true, minimized: false, ownerPid: 1 })) }))
vi.mock('./watch-log', () => ({ logWatchEvent: vi.fn() }))
vi.mock('./ai/provider-registry', () => {
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1', openrouter: 'https://openrouter.ai/api/v1', lmstudio: 'http://localhost:1234/v1',
    custom: 'http://localhost:8080/v1', ollama: 'http://localhost:11434', gemini: 'https://generativelanguage.googleapis.com/v1beta',
  }
  return { getProvider: () => ({}), getProviderInfo: (id: string) => ({ defaultBaseUrl: defaults[id] }) }
})
vi.mock('./guidance-window', () => ({ showGuidanceWindow: vi.fn(), sendGuidanceSendState: vi.fn() }))
vi.mock('./voice-player', () => ({ enqueueSpeech: vi.fn() }))
vi.mock('./nemp-bridge', () => ({ getContextSummary: vi.fn(), memoryScope: () => 'audit', writerFor: () => ({}) }))
vi.mock('./projects', () => ({ getActiveProject: () => ({ id: 'audit' }) }))
vi.mock('./prompt-sender', () => ({ executeSend: vi.fn(), isSendInFlight: () => false, isWatchedWindowPresent: vi.fn() }))
vi.mock('./vision-approvals', () => ({ hasVisionPass: vi.fn(() => true) }))
vi.mock('./robot-visibility', () => ({ noteAnalysisForRobot: vi.fn() }))
vi.mock('./secure-store', () => ({ redactKnownSecrets: (s: string) => s }))

import { handleQuestion, startWatching, stopAnalysisLoop, getWatchStatus } from './analysis-loop'
import { getCallsThisHour, HOUR_MS, recordProviderCall } from './cost-guard'
import { hasVisionPass } from './vision-approvals'
import { captureWatchedWindow } from './capturer'
import { checkPromptQuality } from './ai/prompt-quality-check'
import { verifyPromptOutcome } from './ai/verifier-check'
import { defaultSettings, IPC, type AnalysisResult } from '../renderer/src/types'

const sent: Array<[string, unknown]> = []
const fakeWindow = { isDestroyed: () => false, webContents: { send: (c: string, p: unknown) => sent.push([c, p]) } } as never
const settings = { ...defaultSettings(), provider: 'openai' as const, modelId: 'audit-model', apiKey: 'audit-synthetic-key', hourlyCallCap: 20 }
const analysis = { nextPrompt: 'Build the audit fixture page.', whatIsHappening: 'A fixture.', whatIsBroken: [] } as unknown as AnalysisResult
let clock = Date.parse('2026-01-01T12:00:00Z')
const exhaustBudget = (): void => { while (getCallsThisHour() < 20) recordProviderCall() }
const answers = (): unknown[] => sent.filter(([c]) => c === IPC.COMPANION_ANSWER).map(([, p]) => p)

beforeEach(() => {
  vi.useFakeTimers()
  clock += HOUR_MS + 1 // a fresh rolling hour for every test
  vi.setSystemTime(clock)
  sent.length = 0
  vi.mocked(hasVisionPass).mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"reply":"Audit reply","suggestion":null}' } }],
    content: [{ type: 'text', text: '{"reply":"Audit reply"}' }],
    message: { content: '{"reply":"Audit reply"}' },
  }), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { stopAnalysisLoop(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('hourly AI request limit (LA-04)', () => {
  it('a question at the limit sends nothing and says why', async () => {
    exhaustBudget()
    await handleQuestion(fakeWindow, 'What should I do next?', settings)
    expect(fetch).not.toHaveBeenCalled()
    expect(getCallsThisHour()).toBe(20)
    expect(JSON.stringify(answers())).toContain('limit of 20 AI requests')
  })

  it('a question under the limit is sent and counted', async () => {
    await handleQuestion(fakeWindow, 'What should I do next?', settings)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getCallsThisHour()).toBe(1)
  })

  it('the prompt grader sends nothing at the limit (the prompt is kept)', async () => {
    exhaustBudget()
    await checkPromptQuality(analysis, '', null, { ...settings, provider: 'anthropic' })
    expect(fetch).not.toHaveBeenCalled()
    expect(getCallsThisHour()).toBe(20)
  })

  it('the verifier sends nothing at the limit (the prompt stays pending)', async () => {
    exhaustBudget()
    const result = await verifyPromptOutcome({ id: 'audit', suggestedAt: '', promptText: 'Build the fixture.', expectedOutcome: 'Fixture visible.', status: 'pending' }, analysis, null, '', settings)
    expect(fetch).not.toHaveBeenCalled()
    expect(getCallsThisHour()).toBe(20)
    expect(result.status).toBe('still_pending')
  })
})

describe('question requests use the configured base URL once (LA-05)', () => {
  const urlFor = async (overrides: Record<string, unknown>): Promise<string> => {
    await handleQuestion(fakeWindow, 'Explain this.', { ...settings, ...overrides } as never)
    return String(vi.mocked(fetch).mock.calls.at(-1)?.[0])
  }
  it('a custom endpoint ending in /v1', async () => {
    expect(await urlFor({ provider: 'custom', baseUrl: 'https://audit.example/v1' })).toBe('https://audit.example/v1/chat/completions')
  })
  it('a custom endpoint ending in /v1/ (trailing slash)', async () => {
    expect(await urlFor({ provider: 'custom', baseUrl: 'https://audit.example/v1/' })).toBe('https://audit.example/v1/chat/completions')
  })
  it('a custom endpoint with its own prefix (/api/v1)', async () => {
    expect(await urlFor({ provider: 'custom', baseUrl: 'https://audit.example/api/v1' })).toBe('https://audit.example/api/v1/chat/completions')
  })
  it('LM Studio at its usual address', async () => {
    expect(await urlFor({ provider: 'lmstudio', apiKey: '', baseUrl: 'http://localhost:1234/v1' })).toBe('http://localhost:1234/v1/chat/completions')
  })
  it('OpenAI and OpenRouter defaults', async () => {
    expect(await urlFor({ provider: 'openai', baseUrl: '' })).toBe('https://api.openai.com/v1/chat/completions')
    expect(await urlFor({ provider: 'openrouter', baseUrl: '' })).toBe('https://openrouter.ai/api/v1/chat/completions')
  })
  it('Ollama uses its own /api/chat', async () => {
    expect(await urlFor({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434' })).toBe('http://localhost:11434/api/chat')
  })
})

describe('questions and the vision check (LA-06)', () => {
  it('after watching paused because the model failed the vision check, a question captures and sends nothing', async () => {
    vi.mocked(hasVisionPass).mockReturnValue(false)
    const unapproved = { ...settings, modelId: 'audit-unapproved-model' }
    vi.mocked(captureWatchedWindow).mockClear()
    vi.mocked(captureWatchedWindow).mockResolvedValue({ imageBase64: 'QVVESVQ=', windowTitle: 'Audit fixture', sourceId: 'window:1:0', capturedAt: '' })

    startWatching(fakeWindow, 'window:1:0', 'Audit fixture', async () => unapproved, async () => null, false)
    await vi.advanceTimersByTimeAsync(1)
    expect(getWatchStatus().auto).toBe(false)
    expect(fetch).not.toHaveBeenCalled()

    await handleQuestion(fakeWindow, 'What is happening?', unapproved)
    expect(fetch).not.toHaveBeenCalled()
    expect(captureWatchedWindow).not.toHaveBeenCalled()
    expect(JSON.stringify(answers())).toContain("can't see your screen")
  })

  it('with a passed vision check, the question goes with the screenshot', async () => {
    vi.mocked(captureWatchedWindow).mockResolvedValue({ imageBase64: 'QVVESVQ=', windowTitle: 'Audit fixture', sourceId: 'window:1:0', capturedAt: '' })
    startWatching(fakeWindow, 'window:1:0', 'Audit fixture', async () => settings, async () => null, false)
    await vi.advanceTimersByTimeAsync(1)
    vi.mocked(fetch).mockClear()
    await handleQuestion(fakeWindow, 'What is happening?', settings)
    const body = String((vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit).body)
    expect(body).toContain('data:image/jpeg;base64,QVVESVQ=')
  })
})
