// A provider that sends its headers and then stalls must not leave the watch
// stuck "analysing": at the timeout the analysis ends with a plain timeout
// message, the robot goes back to idle, and an Analyze Now pressed meanwhile
// still gets its analysis. Drives the REAL loop and the REAL OpenAI adapter;
// fetch is stubbed with a response whose body never arrives (and errors when
// the request is aborted, as Node's fetch does).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WatchStatus } from '../renderer/src/types'

vi.mock('electron', () => ({ app: { getPath: () => '.' }, screen: {}, BrowserWindow: class {} }))
vi.mock('./secure-store', () => ({ redactKnownSecrets: (s: string) => s }))
vi.mock('./e2e-fakes', () => ({ e2eFakes: () => null, fakeAnalyzeScreen: vi.fn() }))

const mocks = vi.hoisted(() => ({
  captureWatchedWindow: vi.fn(async () => ({ imageBase64: 'AAAA', windowTitle: 'Terminal', sourceId: 'window:1:0', capturedAt: '2026-01-01T00:00:00Z' })),
}))
vi.mock('./capturer', () => ({
  captureWatchedWindow: mocks.captureWatchedWindow,
  listLiveWindowSources: vi.fn(async () => [{ id: 'window:1:0', name: 'Terminal' }]),
  capturePollThumbnail: vi.fn(async () => 'AAAA'),
}))
vi.mock('./window-presence', () => ({ probeWindowPresence: vi.fn(async () => ({ exists: true, minimized: false, ownerPid: 1 })) }))
vi.mock('./watch-log', () => ({ logWatchEvent: vi.fn() }))
vi.mock('./guidance-window', () => ({ showGuidanceWindow: vi.fn(), sendGuidanceSendState: vi.fn(), hideGuidanceWindow: vi.fn() }))
vi.mock('./voice-player', () => ({ enqueueSpeech: vi.fn() }))
vi.mock('./nemp-bridge', () => ({
  getContextSummary: vi.fn(async () => ''),
  memoryScope: () => 'store-A',
  writerFor: () => ({ recordObservation: vi.fn(), recordCompletion: vi.fn(), recordBlocker: vi.fn(), recordDecision: vi.fn(), recordPattern: vi.fn() }),
}))
vi.mock('./projects', () => ({ getActiveProject: () => ({ id: 'proj-A' }) }))
vi.mock('./prompt-sender', () => ({ executeSend: vi.fn(), isSendInFlight: () => false, isWatchedWindowPresent: vi.fn(async () => true) }))
vi.mock('./vision-approvals', () => ({ hasVisionPass: () => true }))
vi.mock('./ai/prompt-quality-check', () => ({ checkPromptQuality: vi.fn(async () => null), buildQualityPatch: vi.fn(() => null) }))
vi.mock('./ai/verifier-check', () => ({ verifyPromptOutcome: vi.fn() }))

import { startWatching, stopAnalysisLoop, analyzeNow, getWatchStatus, setWatchBroadcast } from './analysis-loop'
import { defaultSettings, IPC } from '../renderer/src/types'
import { PROVIDER_ERROR_MESSAGES } from './ai/provider-errors'

const send = vi.fn()
const robotWindow = { isDestroyed: () => false, webContents: { send } } as never
const settings = { ...defaultSettings(), provider: 'openai' as const, modelId: 'gpt-test', apiKey: 'sk-test-0000000000000000' }
const statuses: WatchStatus[] = []
setWatchBroadcast({ status: (s) => statuses.push(s), analysis: () => {} })
const robotAnalyses = () => send.mock.calls.filter((c) => c[0] === IPC.COMPANION_ANALYSIS)

const GOOD = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ whatIsHappening: 'Waiting for a prompt.', nextPrompt: 'Add a login page.', terminalState: 'awaiting_prompt' }) } }] })

/** Headers now, body never — and the body errors when the request is aborted. */
function stalledResponse(signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

let fetchCalls = 0
beforeEach(() => {
  vi.useFakeTimers()
  send.mockClear()
  statuses.length = 0
  fetchCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    fetchCalls++
    return fetchCalls === 1 ? stalledResponse(init.signal ?? undefined) : new Response(GOOD, { status: 200 })
  }))
})

afterEach(() => {
  stopAnalysisLoop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a provider that stalls after its headers', () => {
  it('ends at the 60 s timeout with a plain message; the watch is usable and the Analyze Now pressed meanwhile is answered', async () => {
    startWatching(robotWindow, 'window:1:0', 'Terminal', async () => settings, async () => null)
    await vi.waitFor(() => expect(fetchCalls).toBe(1))
    await vi.advanceTimersByTimeAsync(10)
    expect(getWatchStatus().analyzing).toBe(true)
    expect(analyzeNow()).toBe('already-running') // pressed while the stalled analysis runs

    await vi.advanceTimersByTimeAsync(59_000)
    expect(getWatchStatus().analyzing).toBe(true) // not cut off early

    await vi.advanceTimersByTimeAsync(1_500) // past 60 s
    expect(fetchCalls).toBeGreaterThan(1) // the stalled analysis ended (no stuck spinner) and the owed Analyze Now started
    // The timeout was shown (plain English, no stuck spinner) ...
    expect(statuses.some((s) => s.message === PROVIDER_ERROR_MESSAGES.timeout)).toBe(true)
    // ... and the owed Analyze Now ran straight after, and answered.
    expect(fetchCalls).toBe(2)
    expect(robotAnalyses()).toHaveLength(1)
    expect(getWatchStatus()).toMatchObject({ analyzing: false, message: null })
    expect(analyzeNow()).toBe('started') // Analyze Now works again
  })

  it('Stop during the stalled body ends it at once, without a timeout message', async () => {
    startWatching(robotWindow, 'window:1:0', 'Terminal', async () => settings, async () => null)
    await vi.waitFor(() => expect(fetchCalls).toBe(1))
    await vi.advanceTimersByTimeAsync(10)
    stopAnalysisLoop()
    await vi.advanceTimersByTimeAsync(10)
    expect(getWatchStatus().analyzing).toBe(false)
    expect(statuses.some((s) => s.message === PROVIDER_ERROR_MESSAGES.timeout)).toBe(false)
  })
})
