// A minimized watched window must not drop the watch.
//
// Reproduces the installed-build report ("Tally is no longer open. Pick a window
// to watch" while the terminal was still open). Measured on Windows: Electron's
// window list (desktopCapturer) leaves out a window while it is MINIMIZED and
// lists it again, same id, when it is restored. Before the fix the continuity
// rules read that gap as a closed window: minimized for 60 s → lost; restored
// after 15 s with the new title Claude Code sets every turn → lost.
//
// Drives the real analysis loop with fake timers; the live window list and the
// OS presence probe are mocked to behave exactly as measured.
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

import { startWatching, stopAnalysisLoop, isAnalysisLoopRunning, setWatchBroadcast } from './analysis-loop'
import { defaultSettings, type WatchStatus } from '../renderer/src/types'
import { logWatchEvent } from './watch-log'

const send = vi.fn()
const fakeWindow = { isDestroyed: () => false, webContents: { send } } as never
const settings = { ...defaultSettings(), provider: 'openai' as const, modelId: 'gpt-test', apiKey: 'sk-test-0000000000000000' }

// What the robot and the Guidance tab are told (the one watch status).
const statuses: WatchStatus[] = []
setWatchBroadcast({ status: (s) => statuses.push(s), analysis: () => {} })
function watchMessages(): Array<{ windowName: string | null; message: string | null }> {
  return statuses.map((s) => ({ windowName: s.windowName, message: s.message }))
}
const dropped = () => watchMessages().some((m) => m.windowName === null && /no longer open/.test(m.message || ''))

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

describe('a minimized watched window keeps the watch', () => {
  it('minimized for 10 minutes: never "no longer open", and the watch is still on', async () => {
    await startAndSettle()
    Object.assign(env, { listed: false, minimized: true }) // user minimizes the terminal
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(dropped()).toBe(false)
    expect(watchMessages().some((m) => /minimized/.test(m.message || ''))).toBe(true)
    // The analysis loop is paused only by the user or a real loss.
    expect(isAnalysisLoopRunning()).toBe(true)
  })

  it('restored after 30 s with a NEW title (Claude Code renamed the tab): watch resumes', async () => {
    await startAndSettle()
    Object.assign(env, { listed: false, minimized: true })
    await vi.advanceTimersByTimeAsync(30_000)
    Object.assign(env, { listed: true, minimized: false, title: '⠋ Fix invoice totals' })
    await vi.advanceTimersByTimeAsync(4000)

    expect(dropped()).toBe(false)
    const last = watchMessages().at(-1)!
    expect(last).toEqual({ windowName: '⠋ Fix invoice totals', message: null })
    expect(isAnalysisLoopRunning()).toBe(true)
  })

  it('a window that is really closed still halts, with the reason logged', async () => {
    await startAndSettle()
    Object.assign(env, { listed: false, exists: false }) // user closes the terminal
    await vi.advanceTimersByTimeAsync(61_000 + 4000)

    expect(dropped()).toBe(true)
    expect(isAnalysisLoopRunning()).toBe(false)
    expect(vi.mocked(logWatchEvent)).toHaveBeenCalledWith('lost', expect.objectContaining({ reason: 'closed' }))
  })
})
