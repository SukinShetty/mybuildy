// Paste into terminal is bound to the EXACT picked window: the real analysis
// loop hands the send the window's source id (its handle) AND the process that
// owned it when it was picked — never just a title. Drives the real loop
// (Electron-bound neighbours mocked) with the platform set to Windows.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AnalysisResult } from '../renderer/src/types'

vi.mock('electron', () => ({ app: { getPath: () => '.' }, screen: {}, BrowserWindow: class {} }))

const mocks = vi.hoisted(() => {
  const capture = { imageBase64: 'AAAA', windowTitle: 'Terminal', sourceId: 'window:1:0', capturedAt: '2026-01-01T00:00:00Z' }
  const writer = {
    recordObservation: vi.fn(async () => {}),
    recordCompletion: vi.fn(async () => {}),
    recordBlocker: vi.fn(async () => {}),
    recordDecision: vi.fn(async () => {}),
    recordPattern: vi.fn(async () => {}),
  }
  return {
    capture,
    writer,
    analysis: null as unknown as AnalysisResult,
    captureWatchedWindow: vi.fn(async () => capture),
    listLiveWindowSources: vi.fn(async () => [{ id: 'window:1:0', name: 'Terminal' }]),
    capturePollThumbnail: vi.fn(async () => 'AAAA'),
    checkPromptQuality: vi.fn(),
    verifyPromptOutcome: vi.fn(),
    pending: null as null | { id: string; promptText: string; expectedOutcome: string },
  }
})

vi.mock('./capturer', () => ({
  captureWatchedWindow: mocks.captureWatchedWindow,
  listLiveWindowSources: mocks.listLiveWindowSources,
  capturePollThumbnail: mocks.capturePollThumbnail,
}))
vi.mock('./ai/provider-registry', () => ({
  getProvider: () => ({ analyzeScreen: vi.fn(async () => ({ ...mocks.analysis })) }),
}))
vi.mock('./guidance-window', () => ({ showGuidanceWindow: vi.fn(), sendGuidanceSendState: vi.fn(), hideGuidanceWindow: vi.fn() }))
vi.mock('./voice-player', () => ({ enqueueSpeech: vi.fn() }))
vi.mock('./nemp-bridge', () => ({
  getContextSummary: vi.fn(async () => 'Recent activity:\n- Claude Code is currently reading the existing code'),
  memoryScope: () => 'store-A',
  writerFor: () => mocks.writer,
}))
vi.mock('./projects', () => ({ getActiveProject: () => ({ id: 'proj-A' }) }))
vi.mock('./prompt-sender', () => ({ executeSend: vi.fn(async () => ({ sent: true })), isSendInFlight: () => false, isWatchedWindowPresent: vi.fn(async () => true) }))
const presence = vi.hoisted(() => ({ ownerPid: 4321 as number | null, calls: 0 }))
vi.mock('./window-presence', () => ({
  probeWindowPresence: vi.fn(async () => { presence.calls++; return { exists: true, minimized: false, ownerPid: presence.ownerPid } }),
}))
vi.mock('./vision-approvals', () => ({ hasVisionPass: () => true }))
// The REAL buildQualityPatch policy; only the grader's AI call is mocked.
vi.mock('./ai/prompt-quality-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai/prompt-quality-check')>()),
  checkPromptQuality: mocks.checkPromptQuality,
}))
vi.mock('./ai/verifier-check', () => ({ verifyPromptOutcome: mocks.verifyPromptOutcome }))
vi.mock('./verifier', () => ({
  getMostRecentPending: () => mocks.pending,
  resolveOutcome: vi.fn(),
  clearOutcomes: vi.fn(),
  replacePendingOutcome: vi.fn(),
}))

import { startWatching, stopAnalysisLoop, handleSendPromptRequest } from './analysis-loop'
import { defaultSettings, IPC } from '../renderer/src/types'
import { executeSend } from './prompt-sender'

const send = vi.fn()
const fakeWindow = { isDestroyed: () => false, webContents: { send } } as never
const settings = { ...defaultSettings(), provider: 'openai' as const, modelId: 'gpt-test', apiKey: 'sk-test-0000000000000000' }

function baseAnalysis(): AnalysisResult {
  return {
    screenContentVisible: true,
    whatIsHappening: 'Claude Code is waiting for your next instruction.',
    whatItMeans: 'The invoices screen is done.',
    whatIsBuilt: ['Invoices screen'],
    whatIsMissing: [],
    whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'Add CSV export.',
    nextPrompt: 'Add a CSV export button to the invoices screen.',
    expectedOutcome: 'A CSV downloads.',
    builderNote: 'Nice work.',
    goalAlignment: 'on-track',
    alignmentNote: '',
    terminalState: 'awaiting_prompt',
    agentName: 'claude_code',
    analyzedAt: '2026-01-01T00:00:05.000Z',
    analysisDurationMs: 10,
  }
}

const shownPromptId = () =>
  send.mock.calls.filter((c) => c[0] === IPC.COMPANION_ANALYSIS).map((c) => (c[1] as AnalysisResult).promptId).filter(Boolean).at(-1)

const realPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  send.mockClear()
  vi.mocked(executeSend).mockClear()
  mocks.analysis = baseAnalysis()
  mocks.checkPromptQuality.mockResolvedValue({ valid: true })
  presence.ownerPid = 4321
})

afterEach(() => {
  stopAnalysisLoop()
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

describe('Paste into terminal → the exact picked window', () => {
  it('the send gets the picked window id and its pick-time owner process', async () => {
    startWatching(fakeWindow, 'window:1:0', 'Terminal', async () => settings, async () => null)
    await vi.waitFor(() => expect(shownPromptId()).toBeTruthy())

    const result = await handleSendPromptRequest(shownPromptId()!)
    expect(result).toEqual({ sent: true })
    expect(vi.mocked(executeSend)).toHaveBeenCalledTimes(1)
    const target = vi.mocked(executeSend).mock.calls[0][1]
    expect(target).toMatchObject({ sourceId: 'window:1:0', ownerPid: 4321 })
  })

  it('the owner is the one recorded at PICK time — not re-read at paste time', async () => {
    startWatching(fakeWindow, 'window:1:0', 'Terminal', async () => settings, async () => null)
    await vi.waitFor(() => expect(shownPromptId()).toBeTruthy())
    presence.ownerPid = 9999 // the handle now belongs to someone else
    await handleSendPromptRequest(shownPromptId()!)
    expect(vi.mocked(executeSend).mock.calls[0][1]).toMatchObject({ ownerPid: 4321 }) // the script will see 9999 and refuse
  })

  it('no owner could be recorded at pick time: the send is told so (and then refuses)', async () => {
    presence.ownerPid = null
    startWatching(fakeWindow, 'window:1:0', 'Terminal', async () => settings, async () => null)
    await vi.waitFor(() => expect(shownPromptId()).toBeTruthy())
    await handleSendPromptRequest(shownPromptId()!)
    expect(vi.mocked(executeSend).mock.calls[0][1]).toMatchObject({ ownerPid: null })
  })
})
