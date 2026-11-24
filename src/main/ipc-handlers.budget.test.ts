// ipc-handlers.budget.test.ts — Brainstorm requests count toward the hourly
// AI request limit and are not sent once it is reached (pre-launch audit LA-04).
// The real BRAINSTORM_START handler; the provider is a stub (no network).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  sent: [] as Array<[string, unknown]>,
  streamBrainstorm: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '.', isPackaged: false, getVersion: () => '0.1.0' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn), on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: {}, dialog: {}, shell: {}, systemPreferences: {}, webContents: {},
  screen: {}, desktopCapturer: {}, safeStorage: {}, utilityProcess: {}, nativeImage: {}, Menu: {}, Tray: {},
}))
vi.mock('./memory', () => ({
  loadSettings: vi.fn(), loadNonSecretSettings: vi.fn(), loadRedactedSettings: vi.fn(),
  updateNonSecretSettings: vi.fn(), saveGeneralSettings: vi.fn(),
  resolveSettings: (s: Record<string, unknown>) => ({ ...s, apiKey: 'synthetic-key', elevenLabsApiKey: '' }),
  loadProjectMemory: vi.fn(), saveProjectMemory: vi.fn(), loadGoal: vi.fn(), setGoal: vi.fn(), updateGoal: vi.fn(),
  deleteAllMyBuildyData: vi.fn(), settingsFilePath: 'settings.json', ProjectChangedError: class extends Error {},
}))
vi.mock('./ai/provider-registry', () => ({
  getProvider: () => ({ streamBrainstorm: h.streamBrainstorm }),
  allProviderInfos: () => [], getProviderInfo: () => ({ defaultBaseUrl: 'https://api.openai.com/v1' }),
}))
vi.mock('./projects', () => ({ getActiveProject: () => ({ id: 'p1' }) }))
vi.mock('./listen-engine', () => ({}))
vi.mock('./voice-player', () => ({ setVoicePreparingNotice: vi.fn(), setVoiceFallbackNotice: vi.fn(),}))
vi.mock('./capturer', () => ({}))
vi.mock('./companion-window', () => ({}))
vi.mock('./guidance-window', () => ({}))
vi.mock('./analysis-loop', () => ({ setWatchBroadcast: vi.fn() }))
vi.mock('./nemp-bridge', () => ({}))
vi.mock('./secure-store', () => ({ redactKnownSecrets: (s: string) => s }))

import { registerIpcHandlers } from './ipc-handlers'
import { getCallsThisHour, recordProviderCall } from './cost-guard'
import { IPC, defaultNonSecretSettings } from '../renderer/src/types'

const mainWindow = { webContents: { id: 1, send: (channel: string, payload: unknown) => h.sent.push([channel, payload]) }, isDestroyed: () => false }
registerIpcHandlers(() => mainWindow as never, () => null, () => undefined)

const settings = { ...defaultNonSecretSettings(), provider: 'openai', modelId: 'synthetic-model', hourlyCallCap: 20 }
const brainstorm = (): Promise<unknown> => h.handlers.get(IPC.BRAINSTORM_START)!({ sender: { id: 1 } }, 'Help me plan', [], settings)

beforeEach(() => { h.sent.length = 0; h.streamBrainstorm.mockClear() })

describe('Brainstorm and the hourly AI request limit (LA-04)', () => {
  it('at the limit, nothing is sent and the user is told why', async () => {
    while (getCallsThisHour() < 20) recordProviderCall()
    await brainstorm()
    expect(h.streamBrainstorm).not.toHaveBeenCalled()
    expect(getCallsThisHour()).toBe(20)
    expect(h.sent).toContainEqual([IPC.BRAINSTORM_ERROR, expect.stringContaining('limit of 20 AI requests')])
  })
})
