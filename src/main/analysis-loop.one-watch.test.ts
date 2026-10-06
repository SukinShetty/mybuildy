// The robot and the Guidance tab are one system: main's analysis loop owns the
// one watch and tells both windows the same thing. Drives the real loop
// (Electron-bound neighbours mocked, no provider call): Analyze Now from the
// Guidance tab runs the watch's own cycle, the status says an analysis is
// running while it does, the result goes to both windows, and Auto, Pause and
// Stop are one state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AnalysisResult, WatchStatus } from '../renderer/src/types'

vi.mock('electron', () => ({ app: { getPath: () => '.' }, screen: {}, BrowserWindow: class {} }))

const mocks = vi.hoisted(() => ({
  analyzeScreen: vi.fn(),
  captureWatchedWindow: vi.fn(async () => ({ imageBase64: 'AAAA', windowTitle: 'Terminal', sourceId: 'window:1:0', capturedAt: '2026-01-01T00:00:00Z' })),
}))

vi.mock('./capturer', () => ({
  captureWatchedWindow: mocks.captureWatchedWindow,
  listLiveWindowSources: vi.fn(async () => [{ id: 'window:1:0', name: 'Terminal' }]),
  capturePollThumbnail: vi.fn(async () => 'AAAA'),
}))
vi.mock('./window-presence', () => ({ probeWindowPresence: vi.fn(async () => ({ exists: true, minimized: false, ownerPid: 1 })) }))
vi.mock('./watch-log', () => ({ logWatchEvent: vi.fn() }))
vi.mock('./ai/provider-registry', () => ({ getProvider: () => ({ analyzeScreen: mocks.analyzeScreen }) }))
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

import {
  startWatching, stopAnalysisLoop, analyzeNow, pauseAnalysisLoop, resumeAnalysisLoop,
  getWatchStatus, setWatchBroadcast,
} from './analysis-loop'
import { defaultSettings, IPC } from '../renderer/src/types'

const send = vi.fn()
const robotWindow = { isDestroyed: () => false, webContents: { send } } as never
const settings = { ...defaultSettings(), provider: 'openai' as const, modelId: 'gpt-test', apiKey: 'sk-test-0000000000000000' }

// What the robot and the main window (Guidance tab) are told.
const statuses: WatchStatus[] = []
const tabAnalyses: AnalysisResult[] = []
setWatchBroadcast({ status: (s) => statuses.push(s), analysis: (a) => tabAnalyses.push(a) })
const robotAnalyses = (): AnalysisResult[] => send.mock.calls.filter((c) => c[0] === IPC.COMPANION_ANALYSIS).map((c) => c[1])

function analysis(): AnalysisResult {
  return {
    screenContentVisible: true, whatIsHappening: 'Waiting for a prompt.', whatItMeans: '', whatIsBuilt: [], whatIsMissing: [],
    whatIsBroken: [], whereUserIsStuck: null, bestNextMove: 'Ask for the login page.', nextPrompt: 'Add a login page.',
    expectedOutcome: 'A login page.', builderNote: '', goalAlignment: 'on-track', terminalState: 'awaiting_prompt',
    agentName: 'claude_code', analyzedAt: '2026-01-01T00:00:00Z', analysisDurationMs: 1,
  }
}

/** Let the provider call take `ms`, so the "running" state can be checked. */
function providerTakes(ms: number): void {
  mocks.analyzeScreen.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(analysis()), ms)))
}

beforeEach(() => {
  vi.useFakeTimers()
  send.mockClear()
  mocks.analyzeScreen.mockReset()
  statuses.length = 0
  tabAnalyses.length = 0
  providerTakes(1000)
})

afterEach(() => {
  stopAnalysisLoop()
  vi.useRealTimers()
})

const watch = (auto = true): void => startWatching(robotWindow, 'window:1:0', 'Terminal', async () => settings, async () => null, auto)

describe('one watch for the robot and the Guidance tab', () => {
  it('Analyze Now with nothing watched captures nothing and asks for a window', () => {
    expect(analyzeNow()).toBe('no-window')
    expect(mocks.captureWatchedWindow).not.toHaveBeenCalled()
    expect(mocks.analyzeScreen).not.toHaveBeenCalled()
  })

  it('a window chosen in the Guidance tab with Analyze Now: one analysis, both told it runs, the result goes to both, Auto stays off', async () => {
    watch(false)
    expect(getWatchStatus()).toEqual({ windowName: 'Terminal', auto: false, analyzing: false, message: null })

    await vi.advanceTimersByTimeAsync(10)
    expect(getWatchStatus().analyzing).toBe(true) // the robot plays "working", the tab says it's thinking
    await vi.advanceTimersByTimeAsync(1000)

    expect(getWatchStatus()).toEqual({ windowName: 'Terminal', auto: false, analyzing: false, message: null })
    expect(mocks.analyzeScreen).toHaveBeenCalledTimes(1)
    expect(robotAnalyses()).toHaveLength(1)
    expect(tabAnalyses).toHaveLength(1)
    expect(tabAnalyses[0].promptId).toBe(robotAnalyses()[0].promptId) // the very same result

    // Auto is off: no more analyses on their own.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.analyzeScreen).toHaveBeenCalledTimes(1)
  })

  it('Analyze Now while paused runs the watch cycle once, even when the screen has not changed', async () => {
    watch(true)
    await vi.advanceTimersByTimeAsync(1100) // the first look
    pauseAnalysisLoop()
    expect(getWatchStatus().auto).toBe(false)

    expect(analyzeNow()).toBe('started')
    expect(analyzeNow()).toBe('already-running') // one analysis, never two at once
    await vi.advanceTimersByTimeAsync(1100)
    expect(mocks.analyzeScreen).toHaveBeenCalledTimes(2)
    expect(tabAnalyses).toHaveLength(2)
    expect(getWatchStatus()).toMatchObject({ windowName: 'Terminal', auto: false, analyzing: false })
  })

  it('Analyze Now during a look that ends with no analysis (screen unchanged) still gets its analysis', async () => {
    watch(true)
    await vi.advanceTimersByTimeAsync(1100) // the first look (an analysis)
    expect(mocks.analyzeScreen).toHaveBeenCalledTimes(1)
    // The next scheduled look: same screen, so it ends without analysing — but
    // Analyze Now is pressed while it is capturing.
    let release: () => void = () => {}
    mocks.captureWatchedWindow.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ imageBase64: 'AAAA', windowTitle: 'Terminal', sourceId: 'window:1:0', capturedAt: '2026-01-01T00:00:00Z' })
    }) as never)
    await vi.advanceTimersByTimeAsync(10_000) // the 10 s cycle starts and waits on its capture
    expect(analyzeNow()).toBe('already-running')
    release()
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.analyzeScreen).toHaveBeenCalledTimes(2) // the click was answered with an analysis
    expect(tabAnalyses).toHaveLength(2)
  })

  it('Auto on/off is the robot watching or paused, and every change reaches both windows', async () => {
    watch(true)
    await vi.advanceTimersByTimeAsync(1100)
    pauseAnalysisLoop()
    resumeAnalysisLoop()
    const autos = statuses.map((s) => s.auto)
    expect(autos.slice(-2)).toEqual([false, true])
  })

  it('Stop ends it everywhere, even mid-analysis: nothing watched, nothing running, no late result', async () => {
    watch(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(getWatchStatus().analyzing).toBe(true)
    stopAnalysisLoop('user-stop')
    expect(statuses.at(-1)).toEqual({ windowName: null, auto: false, analyzing: false, message: null })
    await vi.advanceTimersByTimeAsync(5000)
    expect(tabAnalyses).toHaveLength(0)
    expect(robotAnalyses()).toHaveLength(0)
  })
})
