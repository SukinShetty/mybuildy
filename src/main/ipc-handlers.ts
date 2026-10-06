// ipc-handlers.ts — main process
// All IPC channels registered in one place.
// Every channel name is defined in types.ts (IPC constant) to prevent typos.

import { app, BrowserWindow as ElectronWindow, ipcMain, clipboard, dialog, shell, systemPreferences, webContents } from 'electron'
import { originOf, customKeyActionOnSave } from './provider-origins'
import { providerHttpError, readJson, mapProviderError } from './ai/provider-errors'
import { providerFetch, withCancellation, CancelledError } from './ai/fetch-with-timeout'
import { guardedSender } from './project-guard'
import { watchLogDir } from './watch-log'
import { e2eFakes, FAKE_MODELS, fakeTerminalSourceId } from './e2e-fakes'
import { hideRobot } from './robot-visibility'
import { applyRobotScale, getRobotScale } from './companion-window'
import { saveRobotScale } from './robot-prefs'
import { zoomedRobotScale } from '../renderer/src/robot-size'
import { loadSetupState, saveSetupState, needsSetup } from './setup-state'
import {
  setupPlatform, getSetupPermissions, openPermissionPane, registerForScreenRecording,
  requestPastePermissions, restartApp,
} from './setup-permissions'
import { mkdirSync } from 'fs'
import type { BrowserWindow } from 'electron'
import { isModelConfigured } from '../renderer/src/types'
import { IPC, CHOOSE_MODEL_MESSAGE, CAPTURE_NOTICE_REQUIRED_MESSAGE, MAC_PERMISSION_MESSAGES, MAC_BLANK_CAPTURE_MESSAGE } from '../renderer/src/types'
import type { AppSettings, NonSecretSettings, GuidancePayload, WatchStartResult, AnalyzeNowResult } from '../renderer/src/types'
import { showGuidanceWindow, hideGuidanceWindow, resizeGuidanceWindow, showLastGuidance, getGuidanceWebContentsId, setGuidanceFocusable, clearGuidanceCache } from './guidance-window'
import { handleVoiceEnded, handleVoiceError, stopVoice, setVoiceMuted, resetVoiceDedup, setVoiceFallbackNotice, getVoiceFallback, resetVoiceHealth } from './voice-player'
import * as nemp from './nemp-bridge'
import { listOpenWindows, probeWatchedWindowFrame } from './capturer'
import {
  loadProjectMemory, saveProjectMemory, loadGoal, setGoal, updateGoal,
  loadSettings, loadNonSecretSettings, loadRedactedSettings, saveNonSecretSettings, resolveSettings,
  deleteAllMyBuildyData,
} from './memory'
import { setSecret, redactKnownSecrets, hasSecret, deleteSecret, getCustomKeyOrigin, confirmCustomKeyOrigin } from './secure-store'
import { debugLog, debugError } from './debug-log'
import { getProvider } from './ai/provider-registry'
import { allProviderInfos } from './ai/provider-registry'
import { testProviderConnection } from './ai/connection-test'
import { fetchModelsForProvider } from './ai/model-fetch'
import { hasVisionPass, recordVisionPass } from './vision-approvals'
import {
  startWatching, stopAnalysisLoop, pauseAnalysisLoop, resumeAnalysisLoop, setQuietMode, handleQuestion, handleSendPromptRequest, stopSignal,
  analyzeNow, getWatchStatus, getDisplayedAnalysis, setWatchBroadcast, setWatchMessage,
} from './analysis-loop'
import {
  parseInput, assertFromMainWindow, assertFromGuidanceWindow, assertFromWindowIds, isAllowedBaseUrl,
  nonSecretSettingsSchema, setSecretSchema, projectMemorySchema,
  goalPartialSchema, shortText, sourceId as sourceIdSchema, windowName as windowNameSchema,
  confidenceEnum, chatHistorySchema, promptIdSchema,
  projectIdSchema, projectCreateSchema, projectRenameSchema,
  listModelsSchema, visionStatusSchema, macPermissionEnum,
} from './ipc-schemas'
import { permissionSettingsUrl, screenPermissionMissing } from './mac-permissions-core'
import {
  listProjectSummaries, getActiveProject, createProjectAndSwitch, switchProject, deleteProject,
  renameProject, noteGoalSaved,
} from './projects'

// Registered ONCE at startup. Window references are GETTERS so handlers always
// target the current window even if a window is recreated (no re-registration,
// no duplicate-handler throws, no stacked listeners).
export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow,
  getCompanionWindow: () => BrowserWindow | null,
  quitApp: () => void
): void {

  const mainWcId = (): number => getMainWindow().webContents.id

  // Companion settings cache (resolved AppSettings, secrets injected). Invalidated
  // whenever settings/secrets change so API calls use the latest key.
  let cachedSettings: AppSettings | null = null
  let lastSettingsLoad = 0
  const SETTINGS_REFRESH_MS = 10_000

  async function getFreshSettings(): Promise<AppSettings> {
    if (!cachedSettings || Date.now() - lastSettingsLoad > SETTINGS_REFRESH_MS) {
      cachedSettings = await loadSettings()
      lastSettingsLoad = Date.now()
    }
    return cachedSettings
  }
  function invalidateSettingsCache(): void { cachedSettings = null; lastSettingsLoad = 0 }

  /**
   * The one-time capture disclosure is enforced HERE, before every capture or
   * upload path (watching, the Guidance analysis flow, manual analysis, spoken
   * questions) — regardless of what any renderer does or skips.
   */
  async function captureNoticeAccepted(channel: string): Promise<boolean> {
    const accepted = (await loadNonSecretSettings()).captureNoticeAccepted === true
    if (!accepted) console.warn(`[Privacy] ${channel} refused — the capture notice has not been accepted`)
    return accepted
  }

  // Cancels in-flight per-project work (a streaming brainstorm) on project switch.
  let projectSwitchAbort = new AbortController()

  /** After ANY project switch: cancel old-project work and let every window drop its state. */
  function onProjectSwitched(): void {
    projectSwitchAbort.abort()
    projectSwitchAbort = new AbortController()
    clearGuidanceCache()
    for (const win of [getMainWindow(), getCompanionWindow()]) {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.PROJECTS_SWITCHED)
    }
    const guidanceId = getGuidanceWebContentsId()
    if (guidanceId !== null) webContents.fromId(guidanceId)?.send(IPC.PROJECTS_SWITCHED)
  }

  // Validate renderer-supplied non-secret settings + base-URL allowlist, then
  // resolve the (main-owned) secrets. Renderer keys are never trusted here.
  function resolveValidatedSettings(channel: string, input: unknown): AppSettings {
    const nonSecret = parseInput(nonSecretSettingsSchema, channel, input) as NonSecretSettings
    if (!isAllowedBaseUrl(nonSecret.provider, nonSecret.baseUrl)) {
      console.warn(`[IPC] rejected invalid input on channel ${channel}: baseUrl not allowed for provider ${nonSecret.provider}`)
      throw new Error(`Disallowed base URL on ${channel}`)
    }
    return resolveSettings(nonSecret)
  }

  // Providers that cannot work without a stored API key.
  const KEYED_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'openrouter'])

  // With no key or no model, analysis and Brainstorm refuse — there is no
  // default model anywhere, so the user must pick one first.
  function assertModelUsable(settings: AppSettings): void {
    if (!settings.modelId.trim()) throw new Error(CHOOSE_MODEL_MESSAGE)
    if (KEYED_PROVIDERS.has(settings.provider) && !settings.apiKey) throw new Error(CHOOSE_MODEL_MESSAGE)
  }

  // ─── Window listing ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.LIST_WINDOWS, async () => {
    try {
      // Never offer MyBuildy's own windows (robot, panel, main, voice).
      const ownIds = new Set(ElectronWindow.getAllWindows().map((w) => w.getMediaSourceId()))
      const fakeTerminal = fakeTerminalSourceId() // e2e only: the stand-in window to watch
      if (fakeTerminal) ownIds.delete(fakeTerminal)
      return await listOpenWindows(ownIds)
    } catch (error) {
      console.error('[IPC] LIST_WINDOWS error:', error)
      throw error
    }
  })

  // ─── The one watch (robot + Guidance tab) ───────────────────────────────────
  // Main owns the watch: which window, Auto on/off, whether an analysis is
  // running. Every change goes to both the robot and the main window, and every
  // analysis the robot gets goes to the Guidance tab too (analysis-loop.ts).

  setWatchBroadcast({
    status: (status) => {
      for (const win of [getCompanionWindow(), getMainWindow()]) {
        if (win && !win.isDestroyed()) win.webContents.send(IPC.WATCH_STATUS, status)
      }
    },
    analysis: (analysis) => {
      const main = getMainWindow()
      if (!main.isDestroyed()) main.webContents.send(IPC.ANALYSIS_RESULT, analysis)
    },
  })

  ipcMain.handle(IPC.WATCH_STATUS_GET, async () => ({ status: getWatchStatus(), analysis: getDisplayedAnalysis() }))

  // ─── Voice: never a silent fallback to the computer's voice ─────────────────
  // While a set ElevenLabs key fails, the robot and Settings say so, with why.
  setVoiceFallbackNotice((state) => {
    const fallback = state ? { code: state.code, reason: state.reason } : null
    for (const win of [getCompanionWindow(), getMainWindow()]) {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.VOICE_FALLBACK, fallback)
    }
  })
  ipcMain.handle(IPC.VOICE_FALLBACK_GET, async () => {
    const state = getVoiceFallback()
    return state ? { code: state.code, reason: state.reason } : null
  })

  // The robot's "Open Settings": the panel, on Settings.
  ipcMain.on(IPC.OPEN_SETTINGS, () => {
    const main = getMainWindow()
    if (main.isDestroyed()) return
    main.webContents.send(IPC.SHOW_SCREEN, 'settings')
    main.show()
    main.focus()
  })

  // Analyze Now (Guidance tab): the watch's own analysis cycle, run now.
  ipcMain.handle(IPC.ANALYZE_NOW, async (): Promise<AnalyzeNowResult> => analyzeNow())

  // ─── Brainstorm streaming (provider-agnostic) ───────────────────────────────

  ipcMain.handle(IPC.BRAINSTORM_START, async (_event, userMessageRaw: unknown, historyRaw: unknown, settingsRaw: unknown) => {
    try {
      const userMessage = parseInput(shortText, 'BRAINSTORM_START', userMessageRaw)
      const history = parseInput(chatHistorySchema, 'BRAINSTORM_START', historyRaw)
      const settings = resolveValidatedSettings('BRAINSTORM_START', settingsRaw)
      assertModelUsable(settings)
      const provider = getProvider(settings.provider)
      // Tag the reply with the project it was asked in: after a switch, late
      // chunks are dropped and the request itself is cancelled.
      const projectId = getActiveProject()?.id ?? null
      const target = guardedSender(getMainWindow().webContents, projectId, () => getActiveProject()?.id ?? null)
      await withCancellation(projectSwitchAbort.signal, () =>
        provider.streamBrainstorm(target as never, userMessage, history as never, settings))
    } catch (error) {
      if (error instanceof CancelledError) return
      console.error('[IPC] BRAINSTORM_START error:', error)
      getMainWindow().webContents.send(IPC.BRAINSTORM_ERROR, mapProviderError(redactKnownSecrets(String(error))).message)
    }
  })

  // ─── Provider info (for Settings UI) ────────────────────────────────────────

  ipcMain.handle(IPC.GET_PROVIDER_INFOS, async () => {
    return allProviderInfos
  })

  // ─── Connection test (= vision check) ────────────────────────────────────────
  // Sends the red test image to the selected provider+model; a pass is persisted
  // and unlocks watching. Only the main (Settings) window may run it, because it
  // records vision approvals.

  ipcMain.handle(IPC.TEST_CONNECTION, async (event, settingsRaw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'TEST_CONNECTION')
      const settings = resolveValidatedSettings('TEST_CONNECTION', settingsRaw)
      if (e2eFakes()) {
        // e2e only (e2e-fakes.ts): a local "pass" — no provider is called.
        recordVisionPass(settings.provider, settings.modelId, settings.apiKey)
        return { success: true, message: 'Vision check passed — this model can see your screen. (1ms)', latencyMs: 1, visionPassed: true, errorKind: null }
      }
      return await testProviderConnection(settings)
    } catch (error) {
      const mapped = mapProviderError(redactKnownSecrets(String(error)))
      return { success: false, message: mapped.message, latencyMs: null, visionPassed: false, errorKind: mapped.kind }
    }
  })

  // ─── Live model lists (fetched in MAIN with the stored key) ──────────────────

  ipcMain.handle(IPC.LIST_MODELS, async (event, raw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'LIST_MODELS')
      const { provider, baseUrl } = parseInput(listModelsSchema, 'LIST_MODELS', raw)
      if (!isAllowedBaseUrl(provider, baseUrl)) {
        console.warn(`[IPC] rejected invalid input on channel LIST_MODELS: baseUrl not allowed for provider ${provider}`)
        throw new Error('Disallowed base URL on LIST_MODELS')
      }
      // Use the on-disk settings but target the REQUESTED provider/baseUrl so
      // the Settings UI can browse models before saving. Keys stay main-owned.
      if (e2eFakes()) return { models: FAKE_MODELS, error: null } // e2e only (e2e-fakes.ts)
      const nonSecret = await loadNonSecretSettings()
      const settings = resolveSettings({ ...nonSecret, provider, baseUrl })
      return await fetchModelsForProvider(settings)
    } catch (error) {
      console.error('[IPC] LIST_MODELS error:', error)
      return { models: [], error: mapProviderError(redactKnownSecrets(String(error))).message }
    }
  })

  // ─── Vision-gate status (has this provider+model passed the check?) ──────────
  // Read-only boolean — no sender check, matching the other read channels
  // (LOAD_SETTINGS, GOAL_GET, MEMORY_GET). Mutations stay main-window-only.

  ipcMain.handle(IPC.VISION_STATUS, async (_event, raw: unknown) => {
    try {
      const { provider, modelId } = parseInput(visionStatusSchema, 'VISION_STATUS', raw)
      const settings = resolveSettings({ ...(await loadNonSecretSettings()), provider })
      return { passed: hasVisionPass(provider, modelId, settings.apiKey) }
    } catch (error) {
      console.error('[IPC] VISION_STATUS error:', error)
      return { passed: false }
    }
  })

  // ─── Project memory persistence ──────────────────────────────────────────────

  ipcMain.handle(IPC.LOAD_PROJECT, async () => {
    try {
      return await loadProjectMemory()
    } catch (error) {
      console.error('[IPC] LOAD_PROJECT error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC.SAVE_PROJECT, async (_event, projectRaw: unknown) => {
    try {
      const projectMemory = parseInput(projectMemorySchema, 'SAVE_PROJECT', projectRaw)
      await saveProjectMemory(projectMemory as never)
    } catch (error) {
      console.error('[IPC] SAVE_PROJECT error:', error)
      throw error
    }
  })

  // ─── Goal persistence (stored on the local project memory file) ──────────────

  ipcMain.handle(IPC.GOAL_GET, async () => {
    try {
      return await loadGoal()
    } catch (error) {
      console.error('[IPC] GOAL_GET error:', error)
      return null
    }
  })

  ipcMain.handle(IPC.GOAL_SET, async (_event, goalRaw: unknown) => {
    try {
      const goal = parseInput(goalPartialSchema, 'GOAL_SET', goalRaw)
      // The project this save is for, captured BEFORE any await: a save that
      // finishes after a switch only ever touches this project's record.
      const projectId = getActiveProject()?.id ?? null
      const saved = await setGoal(goal)
      // Keep that project record's goalText in sync. Editing the goal NEVER
      // creates a new project or touches memory — same project, new text.
      if (projectId) noteGoalSaved(projectId, saved.purpose)
      return saved
    } catch (error) {
      console.error('[IPC] GOAL_SET error:', error)
      throw error
    }
  })

  // ─── Projects (project-scoped memory) ────────────────────────────────────────
  // Everything memory-related is namespaced by project id; these channels manage
  // the records and the active project. Mutations are main-window-only.

  ipcMain.handle(IPC.PROJECTS_LIST, async () => {
    try {
      return listProjectSummaries()
    } catch (error) {
      console.error('[IPC] PROJECTS_LIST error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC.PROJECTS_GET_ACTIVE, async () => {
    try {
      return getActiveProject()
    } catch (error) {
      console.error('[IPC] PROJECTS_GET_ACTIVE error:', error)
      return null
    }
  })

  ipcMain.handle(IPC.PROJECTS_CREATE, async (event, inputRaw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'PROJECTS_CREATE')
      const input = parseInput(projectCreateSchema, 'PROJECTS_CREATE', inputRaw)
      const created = await createProjectAndSwitch(input)
      onProjectSwitched()
      return created
    } catch (error) {
      console.error('[IPC] PROJECTS_CREATE error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC.PROJECTS_RENAME, async (event, renameRaw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'PROJECTS_RENAME')
      const { id, name } = parseInput(projectRenameSchema, 'PROJECTS_RENAME', renameRaw)
      return renameProject(id, name)
    } catch (error) {
      console.error('[IPC] PROJECTS_RENAME error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC.PROJECTS_SWITCH, async (event, idRaw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'PROJECTS_SWITCH')
      const id = parseInput(projectIdSchema, 'PROJECTS_SWITCH', idRaw)
      const switched = await switchProject(id)
      onProjectSwitched()
      return switched
    } catch (error) {
      console.error('[IPC] PROJECTS_SWITCH error:', error)
      throw error
    }
  })

  // ─── The robot: Hide, Quit, size ───────────────────────────────────────────

  const isRobot = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    event.sender.id === getCompanionWindow()?.webContents.id
  const isMainWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    event.sender.id === mainWcId()

  /** Apply + remember a robot size, and let the robot show it briefly. */
  const setRobotScale = (scale: number): number => {
    const applied = applyRobotScale(scale)
    saveRobotScale(app.getPath('userData'), applied)
    const robot = getCompanionWindow()
    if (robot && !robot.isDestroyed()) robot.webContents.send(IPC.ROBOT_SCALE_CHANGED, applied)
    return applied
  }

  // Hide: the robot and its guidance panel go away; watching carries on.
  ipcMain.on(IPC.ROBOT_HIDE, (event) => {
    if (!isRobot(event)) return
    hideRobot()
  })

  // Quit (after the robot's "Quit MyBuildy?" confirmation): shut everything down.
  ipcMain.on(IPC.APP_QUIT, (event) => {
    if (!isRobot(event) && !isMainWindow(event)) return
    console.log('[App] Quit confirmed from the robot')
    quitApp()
  })

  ipcMain.handle(IPC.ROBOT_SCALE_GET, async () => getRobotScale())

  ipcMain.handle(IPC.ROBOT_SCALE_SET, async (event, scaleRaw: unknown) => {
    if (!isRobot(event) && !isMainWindow(event)) throw new Error('Unauthorized sender')
    if (typeof scaleRaw !== 'number' || !Number.isFinite(scaleRaw)) throw new Error('Invalid robot size')
    return setRobotScale(scaleRaw)
  })

  // Ctrl/Cmd + scroll wheel over the robot.
  ipcMain.handle(IPC.ROBOT_ZOOM, async (event, directionRaw: unknown) => {
    if (!isRobot(event)) throw new Error('Unauthorized sender')
    if (directionRaw !== 'in' && directionRaw !== 'out') throw new Error('Invalid zoom direction')
    return setRobotScale(zoomedRobotScale(getRobotScale(), directionRaw))
  })

  // Delete a project (Goal screen → Manage projects). Main applies every rule
  // (projects-core.planProjectDeletion): never the last project, never the one
  // being watched; the active one is switched away from first.
  ipcMain.handle(IPC.PROJECTS_DELETE, async (event, idRaw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'PROJECTS_DELETE')
      const id = parseInput(projectIdSchema, 'PROJECTS_DELETE', idRaw)
      const result = await deleteProject(id)
      if (result.deleted && result.switched) onProjectSwitched()
      return result
    } catch (error) {
      console.error('[IPC] PROJECTS_DELETE error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC.GOAL_UPDATE, async (_event, partialRaw: unknown) => {
    try {
      const partial = parseInput(goalPartialSchema, 'GOAL_UPDATE', partialRaw)
      return await updateGoal(partial)
    } catch (error) {
      console.error('[IPC] GOAL_UPDATE error:', error)
      throw error
    }
  })

  // ─── Settings persistence ────────────────────────────────────────────────────

  // Renderer ONLY ever gets the redacted view (no raw keys, just has* booleans).
  ipcMain.handle(IPC.LOAD_SETTINGS, async () => {
    try {
      return await loadRedactedSettings()
    } catch (error) {
      console.error('[IPC] LOAD_SETTINGS error:', error)
      throw error
    }
  })

  // Save NON-SECRET settings only. Any stray key fields are stripped by the schema.
  ipcMain.handle(IPC.SAVE_SETTINGS, async (event, settingsRaw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'SAVE_SETTINGS')
      // Cast: zod fills captureNoticeAccepted via .default(false) at runtime,
      // but ZodType<T> unification reports the (optional) input shape.
      const nonSecret = parseInput(nonSecretSettingsSchema, 'SAVE_SETTINGS', settingsRaw) as NonSecretSettings
      if (!isAllowedBaseUrl(nonSecret.provider, nonSecret.baseUrl)) {
        console.warn(`[IPC] rejected invalid input on channel SAVE_SETTINGS: baseUrl not allowed for provider ${nonSecret.provider}`)
        throw new Error('Disallowed base URL on SAVE_SETTINGS')
      }
      await saveNonSecretSettings(nonSecret)
      // A custom endpoint moved to a different origin: its key is not carried
      // over — the user enters it again for the new endpoint.
      if (nonSecret.provider === 'custom' && hasSecret('customApiKey') &&
          customKeyActionOnSave(getCustomKeyOrigin(), originOf(nonSecret.baseUrl)) === 'clear') {
        deleteSecret('customApiKey')
        console.log('[SecureStore] custom endpoint changed — its stored key was cleared')
      }
      invalidateSettingsCache()
    } catch (error) {
      console.error('[IPC] SAVE_SETTINGS error:', error)
      throw error
    }
  })

  // Settings: the user confirms that a key saved by an earlier version (not yet
  // linked to an endpoint, so unused) belongs to the custom endpoint now saved.
  ipcMain.handle(IPC.CONFIRM_CUSTOM_KEY_ENDPOINT, async (event) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'CONFIRM_CUSTOM_KEY_ENDPOINT')
      const nonSecret = await loadNonSecretSettings()
      const origin = nonSecret.provider === 'custom' ? originOf(nonSecret.baseUrl) : null
      if (!origin) return false
      const linked = confirmCustomKeyOrigin(origin)
      invalidateSettingsCache()
      return linked
    } catch (error) {
      console.error('[IPC] CONFIRM_CUSTOM_KEY_ENDPOINT error:', error)
      return false
    }
  })

  // One-time privacy disclosure (first window pick): persist acceptance. The
  // notice UI lives in the companion (window-picker host), so the companion —
  // or the main settings window — may set the flag. It can only go TRUE here.
  ipcMain.handle(IPC.CAPTURE_NOTICE_ACCEPT, async (event) => {
    try {
      const companionId = getCompanionWindow()?.webContents.id ?? null
      assertFromWindowIds(event, [mainWcId(), companionId], 'CAPTURE_NOTICE_ACCEPT')
      const nonSecret = await loadNonSecretSettings()
      await saveNonSecretSettings({ ...nonSecret, captureNoticeAccepted: true })
      invalidateSettingsCache()
    } catch (error) {
      console.error('[IPC] CAPTURE_NOTICE_ACCEPT error:', error)
      throw error
    }
  })

  // Delete ALL MyBuildy data (keys, settings, every project's memory) and restart
  // to first run. User-confirmed in the Settings UI; main-window-only.
  ipcMain.handle(IPC.DELETE_ALL_DATA, async (event) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'DELETE_ALL_DATA')
      console.log('[IPC] DELETE_ALL_DATA — user-confirmed wipe, restarting to first run')
      stopAnalysisLoop('delete-all-data')
      await deleteAllMyBuildyData()
      app.relaunch()
      app.exit(0)
    } catch (error) {
      console.error('[IPC] DELETE_ALL_DATA error:', error)
      throw error
    }
  })

  // Store an API key (one-way renderer→main). Only the main settings window may do this.
  ipcMain.handle(IPC.SET_SECRET, async (event, raw: unknown) => {
    try {
      assertFromMainWindow(event, mainWcId(), 'SET_SECRET')
      const { name, value } = parseInput(setSecretSchema, 'SET_SECRET', raw)
      // A custom key is bound to the endpoint origin saved just before it.
      const boundOrigin = name === 'customApiKey' ? originOf((await loadNonSecretSettings()).baseUrl) : null
      setSecret(name, value, boundOrigin) // never logged
      invalidateSettingsCache()
      if (name === 'elevenLabsApiKey') resetVoiceHealth() // a new (or no) key: try ElevenLabs afresh
    } catch (error) {
      console.error('[IPC] SET_SECRET error:', error)
      throw error
    }
  })

  // ─── Companion mode ─────────────────────────────────────────────────────────

  // COMPANION_START is a no-op — watching only begins when user picks a window
  ipcMain.handle(IPC.COMPANION_START, async () => {
    // Intentionally empty — companion stays idle until SELECT_WATCH_SOURCE
  })

  // User explicitly picks a window to watch
  // NOTE: Companion uses NO project memory — it analyzes only what it sees on screen
  ipcMain.handle(
    IPC.SELECT_WATCH_SOURCE,
    // Returns whether watching started and, if not, the plain-English reason
    // (the setup wizard shows it; the mascot gets the same message as before).
    // `auto` false: the Guidance tab's Analyze Now on a new window — one first
    // analysis, then the watch stays paused (Auto off) on that window.
    async (_event, sourceIdRaw: unknown, windowNameRaw: unknown, autoRaw: unknown): Promise<WatchStartResult> => {
      const companion = getCompanionWindow()
      if (!companion) return { started: false, message: null }
      const refuse = (message: string): WatchStartResult => {
        setWatchMessage(message)
        return { started: false, message }
      }
      try {
        const sid = parseInput(sourceIdSchema, 'SELECT_WATCH_SOURCE', sourceIdRaw)
        const wname = parseInput(windowNameSchema, 'SELECT_WATCH_SOURCE', windowNameRaw)
        const auto = autoRaw !== false

        // Gate 1: no key / no model → refuse (no default model exists).
        const settings = await loadSettings()
        const missingModel = !settings.modelId.trim() ||
          (KEYED_PROVIDERS.has(settings.provider) && !settings.apiKey)
        if (missingModel) return refuse(CHOOSE_MODEL_MESSAGE)
        // Gate 2: watching is allowed ONLY after the vision check passed for
        // this exact provider+model (with the current key).
        if (!hasVisionPass(settings.provider, settings.modelId, settings.apiKey)) {
          return refuse("This model can't see your screen. Pick one that passes the check.")
        }
        // Gate 3: the one-time capture disclosure — enforced in main, before
        // any capture (including the macOS frame probe below).
        if (!(await captureNoticeAccepted('SELECT_WATCH_SOURCE'))) return refuse(CAPTURE_NOTICE_REQUIRED_MESSAGE)
        // Gate 4 (macOS): Screen Recording. Without it macOS returns captures
        // with nothing in them, so watching would analyse blank frames forever.
        // Check the reported status, then one real frame of the chosen window.
        if (process.platform === 'darwin') {
          const status = systemPreferences.getMediaAccessStatus('screen')
          const blank = (await probeWatchedWindowFrame(sid)) === 'blank'
          if (screenPermissionMissing(process.platform, status) || (blank && status !== 'granted')) {
            console.log(`[Watch] macOS Screen Recording not granted (status ${status}) — watch not started`)
            showGuidanceWindow({ kind: 'permission', permission: 'screen' })
            return refuse(MAC_PERMISSION_MESSAGES.screen)
          }
          if (blank) {
            // Granted, yet nothing visible: granted this session (restart
            // pending) or the window is minimized / on another Space.
            console.log('[Watch] macOS capture of the chosen window is blank — watch not started')
            showGuidanceWindow({ kind: 'message', message: MAC_BLANK_CAPTURE_MESSAGE })
            return refuse(MAC_BLANK_CAPTURE_MESSAGE)
          }
        }

        // The loop reloads settings + goal at the START of each cycle (async getters),
        // so editing the goal or settings mid-watch takes effect without restarting.
        startWatching(companion, sid, wname, () => loadSettings(), () => loadGoal(), auto)
        return { started: true, message: null }
      } catch (error) {
        console.error('[IPC] SELECT_WATCH_SOURCE error:', error)
        return { started: false, message: null }
      }
    }
  )

  // Stop (on the robot or in the Guidance tab): end the watch and cancel
  // everything in flight (stopAnalysisLoop aborts the Stop signal: analysis,
  // transcription, spoken questions; both windows get the new status), silence
  // the voice, and tell both windows so the robot drops a recording in progress.
  ipcMain.handle(IPC.COMPANION_STOP, async () => {
    stopAnalysisLoop('user-stop')
    stopVoice()
    resetVoiceDedup()
    hideGuidanceWindow()
    for (const win of [getMainWindow(), getCompanionWindow()]) {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.STOPPED)
    }
  })

  // Auto off (Pause on the robot, Auto in the Guidance tab): stop watching for
  // now, keep the window; whatever is being said stops too.
  ipcMain.handle(IPC.COMPANION_PAUSE, async () => {
    pauseAnalysisLoop()
    stopVoice()
  })

  ipcMain.handle(IPC.COMPANION_RESUME, async () => {
    resumeAnalysisLoop()
  })

  ipcMain.handle(IPC.COMPANION_QUIET, async (_event, quiet: boolean) => {
    setQuietMode(quiet)
  })

  // User asks a spoken question — answer using current watched window context
  ipcMain.handle(IPC.ASK_QUESTION, async (_event, questionRaw: unknown) => {
    const companion = getCompanionWindow()
    if (!companion) return
    try {
      const question = parseInput(shortText, 'ASK_QUESTION', questionRaw)
      if (!(await captureNoticeAccepted('ASK_QUESTION'))) {
        setWatchMessage(CAPTURE_NOTICE_REQUIRED_MESSAGE)
        return
      }
      const settings = await getFreshSettings()
      await handleQuestion(companion, question, settings)
    } catch (error) {
      console.error('[IPC] ASK_QUESTION error:', error)
    }
  })

  // Transcribe audio via ElevenLabs Speech-to-Text
  ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBuffer: Buffer) => {
    try {
      if (!(await captureNoticeAccepted('TRANSCRIBE_AUDIO'))) {
        return { success: false, text: '', error: CAPTURE_NOTICE_REQUIRED_MESSAGE }
      }
      const settings = await getFreshSettings()
      // Stop cancels the upload itself, not only what happens after it.
      return await withCancellation(stopSignal(), () => transcribeWithElevenLabs(audioBuffer, settings))
    } catch (error) {
      if (error instanceof CancelledError) return { success: false, text: '', error: 'Stopped.' }
      console.error('[IPC] TRANSCRIBE_AUDIO error:', error)
      return { success: false, text: '', error: "Couldn't turn your voice into text. Try again, or type your question." }
    }
  })

  ipcMain.on(IPC.OPEN_PANEL, () => {
    const mw = getMainWindow()
    if (!mw.isDestroyed()) {
      mw.show()
      mw.focus()
    }
  })

  ipcMain.handle(IPC.RESET_COMPANION, async () => {
    const { resetCompanionPosition } = require('./companion-window')
    resetCompanionPosition()
  })

  ipcMain.handle(IPC.SHOW_COMPANION, async () => {
    const { showCompanion } = require('./companion-window')
    showCompanion()
  })

  // ─── Guidance panel (secondary window) ───────────────────────────────────────

  ipcMain.on(IPC.GUIDANCE_SHOW, (_event, payload: GuidancePayload) => {
    showGuidanceWindow(payload)
  })

  ipcMain.on(IPC.GUIDANCE_HIDE, () => {
    hideGuidanceWindow()
  })

  ipcMain.on(IPC.GUIDANCE_SHOW_LAST, () => {
    showLastGuidance()
  })

  ipcMain.on(IPC.GUIDANCE_RESIZE, (_event, height: number) => {
    resizeGuidanceWindow(height)
  })

  // Phase 3B: the hand-off answer box needs keyboard focus in the otherwise
  // non-focusable guidance window. Only the guidance window may toggle this.
  ipcMain.on(IPC.GUIDANCE_SET_FOCUSABLE, (event, focusable: unknown) => {
    if (event.sender.id !== getGuidanceWebContentsId()) return
    setGuidanceFocusable(focusable === true)
  })

  // Settings → "Open log folder": the local watch log (watch-log.ts). Main
  // window only; opens a fixed folder, takes no path from the renderer.
  ipcMain.handle(IPC.OPEN_LOG_FOLDER, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'OPEN_LOG_FOLDER')
    const dir = watchLogDir()
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) console.warn('[IPC] OPEN_LOG_FOLDER failed to open the folder')
  })

  // ─── First-run setup wizard (main window only) ─────────────────────────────
  // Where setup is up to lives in main (setup-state.ts) so it survives the
  // restart the macOS Screen Recording step needs.

  const setupDir = (): string => app.getPath('userData')

  ipcMain.handle(IPC.SETUP_INFO, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_INFO')
    const state = loadSetupState(setupDir())
    const [redacted, goal] = await Promise.all([loadRedactedSettings(), loadGoal().catch(() => null)])
    return {
      needed: needsSetup(state, isModelConfigured(redacted), !!goal?.purpose?.trim()),
      step: state?.step ?? null,
      platform: setupPlatform(),
    }
  })

  ipcMain.handle(IPC.SETUP_SAVE_STEP, async (event, stepRaw: unknown) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_SAVE_STEP')
    if (typeof stepRaw !== 'string' || !/^[a-z-]{1,40}$/.test(stepRaw)) throw new Error('Invalid setup step')
    saveSetupState(setupDir(), { completed: false, step: stepRaw })
  })

  ipcMain.handle(IPC.SETUP_FINISH, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_FINISH')
    saveSetupState(setupDir(), { completed: true, step: null })
    // Setup done: tuck the panel away so the mascot is in view (never destroy it).
    const main = getMainWindow()
    if (!main.isDestroyed()) main.hide()
  })

  ipcMain.handle(IPC.SETUP_RESET, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_RESET')
    saveSetupState(setupDir(), { completed: false, step: null })
  })

  ipcMain.handle(IPC.SETUP_PERMISSIONS, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_PERMISSIONS')
    return getSetupPermissions()
  })

  ipcMain.handle(IPC.SETUP_OPEN_PANE, async (event, paneRaw: unknown) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_OPEN_PANE')
    if (paneRaw !== 'screen' && paneRaw !== 'accessibility' && paneRaw !== 'automation') throw new Error('Invalid pane')
    await openPermissionPane(paneRaw)
  })

  ipcMain.handle(IPC.SETUP_REGISTER_SCREEN, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_REGISTER_SCREEN')
    await registerForScreenRecording()
  })

  ipcMain.handle(IPC.SETUP_REQUEST_PASTE, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_REQUEST_PASTE')
    return requestPastePermissions()
  })

  ipcMain.handle(IPC.SETUP_RESTART, async (event) => {
    assertFromMainWindow(event, mainWcId(), 'SETUP_RESTART')
    restartApp()
  })

  // Hand-off card buttons ("I'll decide" / "Skip for now"): forward to the
  // companion so the "!" badge clears for this hand-off. Only the guidance
  // window may send it; the payload is two short strings and nothing else.
  ipcMain.on(IPC.HANDOFF_RESOLVED, (event, ref: unknown) => {
    if (event.sender.id !== getGuidanceWebContentsId()) return
    const r = ref as { analyzedAt?: unknown; question?: unknown } | null
    if (!r || typeof r.analyzedAt !== 'string' || typeof r.question !== 'string') return
    if (r.analyzedAt.length > 64 || r.question.length > 1000) return
    const companion = getCompanionWindow()
    if (companion && !companion.isDestroyed()) {
      companion.webContents.send(IPC.HANDOFF_RESOLVED, { analyzedAt: r.analyzedAt, question: r.question })
    }
  })

  // Clipboard via main — reliable even from the non-focusable guidance window,
  // where navigator.clipboard would throw "Document is not focused".
  ipcMain.handle(IPC.COPY_TEXT, async (_event, text: string) => {
    clipboard.writeText(text)
  })

  // macOS: open System Settings at the pane for a missing permission. The
  // renderer names only the KIND (Zod enum); the URL is fixed in main.
  ipcMain.handle(IPC.OPEN_PERMISSION_SETTINGS, async (event, permissionRaw: unknown) => {
    try {
      assertFromGuidanceWindow(event, getGuidanceWebContentsId(), 'OPEN_PERMISSION_SETTINGS')
      const permission = parseInput(macPermissionEnum, 'OPEN_PERMISSION_SETTINGS', permissionRaw)
      if (process.platform !== 'darwin') return
      await shell.openExternal(permissionSettingsUrl(permission))
    } catch (error) {
      console.error('[IPC] OPEN_PERMISSION_SETTINGS error:', error)
    }
  })

  // Approve-and-send: the guidance window sends ONLY the displayed prompt's id;
  // main resolves the text itself and rejects stale/unknown ids. Windows + macOS.
  ipcMain.handle(IPC.SEND_PROMPT, async (event, promptIdRaw: unknown) => {
    try {
      assertFromGuidanceWindow(event, getGuidanceWebContentsId(), 'SEND_PROMPT')
      const promptId = parseInput(promptIdSchema, 'SEND_PROMPT', promptIdRaw)
      return await handleSendPromptRequest(promptId)
    } catch (error) {
      console.error('[IPC] SEND_PROMPT error:', error)
      return { sent: false, reason: 'unknown' }
    }
  })

  // ─── Memory layer (Nemp bridge) ──────────────────────────────────────────────

  ipcMain.handle(IPC.MEMORY_GET, async () => nemp.getSnapshot())
  ipcMain.handle(IPC.MEMORY_GET_CONTEXT, async (_e, maxTokens?: unknown) =>
    nemp.getContextSummary(typeof maxTokens === 'number' ? maxTokens : undefined))
  ipcMain.handle(IPC.MEMORY_SEARCH, async (_e, query: unknown) =>
    nemp.searchMemories(parseInput(shortText, 'MEMORY_SEARCH', query)))
  ipcMain.handle(IPC.MEMORY_ADD_OBSERVATION, async (_e, text: unknown, sourceAnalysisId?: unknown) =>
    nemp.recordObservation(parseInput(shortText, 'MEMORY_ADD_OBSERVATION', text), typeof sourceAnalysisId === 'string' ? sourceAnalysisId : undefined))
  ipcMain.handle(IPC.MEMORY_ADD_COMPLETION, async (_e, feature: unknown) =>
    nemp.recordCompletion(parseInput(shortText, 'MEMORY_ADD_COMPLETION', feature)))
  ipcMain.handle(IPC.MEMORY_ADD_BLOCKER, async (_e, description: unknown) =>
    nemp.recordBlocker(parseInput(shortText, 'MEMORY_ADD_BLOCKER', description)))
  ipcMain.handle(IPC.MEMORY_RESOLVE_BLOCKER, async (_e, blockerId: unknown, resolution: unknown) =>
    nemp.resolveBlocker(parseInput(shortText, 'MEMORY_RESOLVE_BLOCKER', blockerId), parseInput(shortText, 'MEMORY_RESOLVE_BLOCKER', resolution)))
  ipcMain.handle(IPC.MEMORY_ADD_DECISION, async (_e, question: unknown, choice: unknown, reasoning?: unknown) =>
    nemp.recordDecision(parseInput(shortText, 'MEMORY_ADD_DECISION', question), parseInput(shortText, 'MEMORY_ADD_DECISION', choice), typeof reasoning === 'string' ? reasoning : undefined))
  ipcMain.handle(IPC.MEMORY_ADD_PATTERN, async (_e, observation: unknown, confidence: unknown) =>
    nemp.recordPattern(parseInput(shortText, 'MEMORY_ADD_PATTERN', observation), parseInput(confidenceEnum, 'MEMORY_ADD_PATTERN', confidence)))
  ipcMain.handle(IPC.MEMORY_EXPORT_MYBUILDYMD, async () => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export MYBUILDY.md',
      defaultPath: 'MYBUILDY.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await nemp.exportToMyBuildyMd(result.filePath)
    return { saved: true, path: result.filePath }
  })
  ipcMain.handle(IPC.MEMORY_RESET, async () => nemp.resetMemory())

  // ─── Voice player ─────────────────────────────────────────────────────────────

  // From the hidden voice window:
  ipcMain.on(IPC.VOICE_ENDED, (_e, id: string) => handleVoiceEnded(id))
  ipcMain.on(IPC.VOICE_ERROR, (_e, id: string) => handleVoiceError(id))
  // From the companion (explicit user actions only):
  ipcMain.on(IPC.VOICE_CTL_STOP, () => stopVoice())
  ipcMain.on(IPC.VOICE_CTL_MUTE, (_e, muted: boolean) => setVoiceMuted(muted))
  ipcMain.on(IPC.VOICE_CTL_RESET, () => resetVoiceDedup())
}

// ─── ElevenLabs Speech-to-Text ───────────────────────────────────────────────

async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  settings: AppSettings
): Promise<{ success: boolean; text: string; error?: string }> {
  const apiKey = settings.elevenLabsApiKey
  if (!apiKey) {
    console.log('[ElevenLabs STT] No ElevenLabs API key configured')
    return { success: false, text: '', error: 'No ElevenLabs API key configured. Add it in Settings.' }
  }

  const url = 'https://api.elevenlabs.io/v1/speech-to-text'
  console.log(`[ElevenLabs STT] Transcribing ${audioBuffer.length} bytes → ${url}`)

  try {
    // Use native FormData (Node 18+) — avoids manual boundary issues with undici
    const { FormData, Blob } = require('buffer')
    const formData = new globalThis.FormData()

    // Create a proper Blob from the audio buffer
    const audioBlob = new Blob([audioBuffer], { type: 'audio/webm' })
    formData.append('file', audioBlob, 'audio.webm')
    formData.append('model_id', 'scribe_v1')

    console.log('[ElevenLabs STT] Sending request with FormData...')
    const startTime = Date.now()

    const response = await providerFetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
    }, { timeoutMs: 30_000 })

    const elapsed = Date.now() - startTime
    console.log(`[ElevenLabs STT] Response: ${response.status} in ${elapsed}ms`)

    if (!response.ok) {
      const err = await providerHttpError('ElevenLabs speech-to-text', response)
      console.error(`[ElevenLabs STT] API error HTTP ${response.status} (${err.kind})`)
      return { success: false, text: '', error: err.message }
    }

    const json = await readJson<{ text?: string }>(response, 'ElevenLabs speech-to-text')
    debugLog('[ElevenLabs STT] Response body:', JSON.stringify(json).slice(0, 300))

    const text = json.text?.trim() || ''

    if (!text) {
      console.log('[ElevenLabs STT] No speech detected in audio')
      return { success: false, text: '', error: 'No speech detected. Try speaking louder or longer.' }
    }

    // Transcribed user speech — content-bearing, gated.
    debugLog(`[ElevenLabs STT] Transcribed: "${text}"`)
    return { success: true, text }
  } catch (error: any) {
    const msg = String(error?.message || error)
    debugError(`[ElevenLabs STT] Exception: ${msg}`)

    if (msg.includes('abort') || msg.includes('TIMEOUT')) {
      return { success: false, text: '', error: 'ElevenLabs STT timed out (30s). Check your internet connection.' }
    }
    return { success: false, text: '', error: `STT failed: ${msg.slice(0, 120)}` }
  }
}
