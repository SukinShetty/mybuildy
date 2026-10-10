// Launch policy: minimizing or any observed capture-list gap requires reselection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.' }, screen: {}, BrowserWindow: class {} }))

const ID = 'window:854860:0'
const PID = 6604

const env = vi.hoisted(() => ({
  listed: true,           // is the watched id in the window list right now?
  title: '✳ Tally',
  exists: true,           // does the window still exist (OS)?
  minimized: false,
}))

vi.mock('./capturer', () => ({
  captureWatchedWindow: vi.fn(async () => null), // no analysis needed for this test
  listLiveWindowSources: vi.fn(async () => (env.listed ? [{ id: ID, name: env.title }] : [{ id: 'window:1:0', name: 'Browser' }])),
  capturePollThumbnail: vi.fn(async () => null),
}))
vi.mock('./window-presence', () => ({
  probeWindowPresence: vi.fn(async () =>
    env.exists ? { exists: true, minimized: env.minimized, ownerPid: PID } : { exists: false, minimized: false, ownerPid: null }),
}))
vi.mock('./watch-log', () => ({ logWatchEvent: vi.fn() }))
vi.mock('./ai/provider-registry', () => ({ getProvider: () => ({ analyzeScreen: vi.fn() }) }))
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
vi.mock('./ai/prompt-quality-check', () => ({ checkPromptQuality: vi.fn(), buildQualityPatch: vi.fn() }))
vi.mock('./ai/verifier-check', () => ({ verifyPromptOutcome: vi.fn() }))

import { startWatching, stopAnalysisLoop, stopSignal, isAnalysisLoopRunning, setWatchBroadcast } from './analysis-loop'
import { defaultSettings, type WatchStatus } from '../renderer/src/types'
import { logWatchEvent } from './watch-log'
import { captureWatchedWindow } from './capturer'

const send = vi.fn()
const fakeWindow = { isDestroyed: () => false, webContents: { send } } as never
const settings = { ...defaultSettings(), provider: 'openai' as const, modelId: 'gpt-test', apiKey: 'sk-test-0000000000000000' }

// What the robot and the Guidance tab are told (the one watch status).
const statuses: WatchStatus[] = []
setWatchBroadcast({ status: (s) => statuses.push(s), analysis: () => {} })
function watchMessages(): Array<{ windowName: string | null; message: string | null }> {
  return statuses.map((s) => ({ windowName: s.windowName, message: s.message }))
}

beforeEach(() => {
  vi.useFakeTimers()
  send.mockClear()
  statuses.length = 0
  vi.mocked(logWatchEvent).mockClear()
  Object.assign(env, { listed: true, title: '✳ Tally', exists: true, minimized: false })
})

afterEach(() => {
  stopAnalysisLoop()
  vi.useRealTimers()
})

async function startAndSettle(): Promise<void> {
  startWatching(fakeWindow, ID, '✳ Tally', async () => settings, async () => null)
  await vi.advanceTimersByTimeAsync(3000) // owner process recorded, a poll or two
}

describe('a capture gap requires explicit reselection', () => {
  it('stops on a minimized-window gap and aborts active work', async () => {
    await startAndSettle()
    const activeSignal = stopSignal()
    Object.assign(env, { listed: false, minimized: true })
    await vi.advanceTimersByTimeAsync(3000)
    expect(activeSignal.aborted).toBe(true)
    expect(isAnalysisLoopRunning()).toBe(false)
    expect(watchMessages().at(-1)?.message).toMatch(/select it again/)
    expect(watchMessages().at(-1)?.windowName).toBeNull()
  })

  it('does not resume after the same source id returns, even with a matching title', async () => {
    await startAndSettle()
    Object.assign(env, { listed: false, minimized: true })
    await vi.advanceTimersByTimeAsync(3000)
    const capturesAfterStop = vi.mocked(captureWatchedWindow).mock.calls.length
    Object.assign(env, { listed: true, minimized: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isAnalysisLoopRunning()).toBe(false)
    expect(vi.mocked(captureWatchedWindow).mock.calls.length).toBe(capturesAfterStop)
  })

  it('still permits continuously present windows to change title', async () => {
    await startAndSettle()
    env.title = 'Working on invoice totals'
    await vi.advanceTimersByTimeAsync(3000)
    expect(isAnalysisLoopRunning()).toBe(true)
    expect(watchMessages().at(-1)?.windowName).toBe(env.title)
  })
})
