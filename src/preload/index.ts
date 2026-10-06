// preload/index.ts
// Secure bridge between the main process and the renderer.
// contextBridge.exposeInMainWorld() is the only safe way to give the renderer
// access to Electron/Node.js capabilities without enabling nodeIntegration.
//
// The renderer accesses everything via window.mybuildy.*

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../renderer/src/types'
import type { HandoffRef } from '../renderer/src/handoff'
import type {
  VisionCheckResult,
  WindowSource,
  CaptureResult,
  CaptureOutcome,
  WatchStartResult,
  DeleteProjectResult,
  SetupInfo,
  SetupPermissionStatus,
  AnalysisResult,
  ProjectMemory,
  NonSecretSettings,
  RedactedSettings,
  SecretName,
  ChatMessage,
  ExtractedProjectData,
  Goal,
  GuidancePayload,
  QuestionAnswer,
  MemoryEntry,
  MemorySnapshot,
  SendEligibility,
  SendPromptResult,
  MacPermission,
  ProjectRecord,
  ProjectSummary,
  ProviderType,
  ModelListResult,
} from '../renderer/src/types'

// The API exposed to window.mybuildy in the renderer
const mybuildyAPI = {

  // OS platform ('win32' | 'darwin' | 'linux') — the send button is Windows-only;
  // macOS/Linux fall back to clipboard copy.
  platform: process.platform as string,

  // ─── Window listing ──────────────────────────────────────────────────────
  listWindows: (): Promise<WindowSource[]> =>
    ipcRenderer.invoke(IPC.LIST_WINDOWS),

  // ─── Screen capture ──────────────────────────────────────────────────────
  // Returns a halt outcome (never a full-screen image) when the window is missing.
  captureWindow: (sourceId: string | null, expectedName?: string | null): Promise<CaptureOutcome> =>
    ipcRenderer.invoke(IPC.CAPTURE_WINDOW, sourceId, expectedName ?? null),

  // ─── Analysis ────────────────────────────────────────────────────────────
  analyze: (
    capture: CaptureResult,
    project: ProjectMemory,
    settings: NonSecretSettings
  ): Promise<AnalysisResult> =>
    ipcRenderer.invoke(IPC.ANALYZE, capture, project, settings),

  // ─── Brainstorm streaming ─────────────────────────────────────────────────
  // Start the stream — chunks arrive via onBrainstormChunk
  startBrainstorm: (
    userMessage: string,
    history: ChatMessage[],
    settings: NonSecretSettings
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.BRAINSTORM_START, userMessage, history, settings),

  // Subscribe to brainstorm events — returns an unsubscribe function
  onBrainstormChunk: (handler: (chunk: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: string) => handler(chunk)
    ipcRenderer.on(IPC.BRAINSTORM_CHUNK, listener)
    return () => ipcRenderer.removeListener(IPC.BRAINSTORM_CHUNK, listener)
  },

  onBrainstormDone: (
    handler: (result: { fullText: string; extractedProjectData: ExtractedProjectData | null }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      result: { fullText: string; extractedProjectData: ExtractedProjectData | null }
    ) => handler(result)
    ipcRenderer.on(IPC.BRAINSTORM_DONE, listener)
    return () => ipcRenderer.removeListener(IPC.BRAINSTORM_DONE, listener)
  },

  onBrainstormError: (handler: (errorMessage: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, errorMessage: string) =>
      handler(errorMessage)
    ipcRenderer.on(IPC.BRAINSTORM_ERROR, listener)
    return () => ipcRenderer.removeListener(IPC.BRAINSTORM_ERROR, listener)
  },

  // ─── Project memory ───────────────────────────────────────────────────────
  loadProject: (): Promise<ProjectMemory> =>
    ipcRenderer.invoke(IPC.LOAD_PROJECT),

  saveProject: (project: ProjectMemory): Promise<void> =>
    ipcRenderer.invoke(IPC.SAVE_PROJECT, project),

  // ─── Goal (local only — stored alongside project memory) ───────────────────
  goal: {
    get: (): Promise<Goal | null> =>
      ipcRenderer.invoke(IPC.GOAL_GET),
    set: (goal: Partial<Goal>): Promise<Goal> =>
      ipcRenderer.invoke(IPC.GOAL_SET, goal),
    update: (partial: Partial<Goal>): Promise<Goal | null> =>
      ipcRenderer.invoke(IPC.GOAL_UPDATE, partial),
  },

  // ─── Projects (project-scoped memory) ─────────────────────────────────────
  // One record per project; ALL memory (project memory, goal, Nemp store,
  // verifier outcomes) follows the active project. create/switch re-point the
  // whole memory layer; rename never touches memory.
  projects: {
    list: (): Promise<ProjectSummary[]> =>
      ipcRenderer.invoke(IPC.PROJECTS_LIST),
    create: (input: { name?: string; goalText?: string }): Promise<ProjectRecord> =>
      ipcRenderer.invoke(IPC.PROJECTS_CREATE, input),
    rename: (id: string, name: string): Promise<ProjectRecord> =>
      ipcRenderer.invoke(IPC.PROJECTS_RENAME, { id, name }),
    switch: (id: string): Promise<ProjectRecord> =>
      ipcRenderer.invoke(IPC.PROJECTS_SWITCH, id),
    delete: (id: string): Promise<DeleteProjectResult> =>
      ipcRenderer.invoke(IPC.PROJECTS_DELETE, id),
    getActive: (): Promise<ProjectRecord | null> =>
      ipcRenderer.invoke(IPC.PROJECTS_GET_ACTIVE),
  },

  // ─── Provider info ────────────────────────────────────────────────────────
  getProviderInfos: (): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.GET_PROVIDER_INFOS),

  // ─── Connection test (= vision check with a red test image) ─────────────
  testConnection: (settings: NonSecretSettings): Promise<VisionCheckResult> =>
    ipcRenderer.invoke(IPC.TEST_CONNECTION, settings),

  // ─── Live model lists (fetched in MAIN with the stored key, 10-min cache) ─
  listModels: (provider: ProviderType, baseUrl: string): Promise<ModelListResult> =>
    ipcRenderer.invoke(IPC.LIST_MODELS, { provider, baseUrl }),

  // Has this provider+model passed the vision check (with the current key)?
  getVisionStatus: (provider: ProviderType, modelId: string): Promise<{ passed: boolean }> =>
    ipcRenderer.invoke(IPC.VISION_STATUS, { provider, modelId }),

  // ─── Settings ─────────────────────────────────────────────────────────────
  // Returns REDACTED settings only (no raw keys — just has* booleans).
  loadSettings: (): Promise<RedactedSettings> =>
    ipcRenderer.invoke(IPC.LOAD_SETTINGS),

  // Saves NON-SECRET settings only. API keys go through setSecret (one-way).
  saveSettings: (settings: NonSecretSettings): Promise<void> =>
    ipcRenderer.invoke(IPC.SAVE_SETTINGS, settings),

  // Store an API key in the encrypted main-process store. The renderer never reads it back.
  setSecret: (name: SecretName, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SET_SECRET, { name, value }),

  // Persist the one-time privacy disclosure ("MyBuildy sends screenshots…") as accepted.
  acceptCaptureNotice: (): Promise<void> =>
    ipcRenderer.invoke(IPC.CAPTURE_NOTICE_ACCEPT),

  // Delete ALL MyBuildy data (keys, settings, every project's memory) and restart
  // to first run. Main re-confirms nothing — the Settings UI owns the confirm.
  deleteAllData: (): Promise<void> =>
    ipcRenderer.invoke(IPC.DELETE_ALL_DATA),

  // First-run setup wizard (main window only; see setup-state.ts / setup-permissions.ts).
  setup: {
    info: (): Promise<SetupInfo> => ipcRenderer.invoke(IPC.SETUP_INFO),
    saveStep: (step: string): Promise<void> => ipcRenderer.invoke(IPC.SETUP_SAVE_STEP, step),
    finish: (): Promise<void> => ipcRenderer.invoke(IPC.SETUP_FINISH),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.SETUP_RESET),
    permissions: (): Promise<SetupPermissionStatus> => ipcRenderer.invoke(IPC.SETUP_PERMISSIONS),
    openPane: (pane: 'screen' | 'accessibility' | 'automation'): Promise<void> => ipcRenderer.invoke(IPC.SETUP_OPEN_PANE, pane),
    registerScreen: (): Promise<void> => ipcRenderer.invoke(IPC.SETUP_REGISTER_SCREEN),
    requestPaste: (): Promise<SetupPermissionStatus> => ipcRenderer.invoke(IPC.SETUP_REQUEST_PASTE),
    restart: (): Promise<void> => ipcRenderer.invoke(IPC.SETUP_RESTART),
  },

  // The robot: Hide (watching continues), Quit (after its confirmation), size.
  robot: {
    hide: (): void => ipcRenderer.send(IPC.ROBOT_HIDE),
    quitApp: (): void => ipcRenderer.send(IPC.APP_QUIT),
    getScale: (): Promise<number> => ipcRenderer.invoke(IPC.ROBOT_SCALE_GET),
    setScale: (scale: number): Promise<number> => ipcRenderer.invoke(IPC.ROBOT_SCALE_SET, scale),
    zoom: (direction: 'in' | 'out'): Promise<number> => ipcRenderer.invoke(IPC.ROBOT_ZOOM, direction),
    onScaleChanged: (handler: (scale: number) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, scale: number) => handler(scale)
      ipcRenderer.on(IPC.ROBOT_SCALE_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.ROBOT_SCALE_CHANGED, listener)
    },
  },

  // Settings → Diagnostics: open the folder holding the local watch log.
  openLogFolder: (): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_LOG_FOLDER),

  // ─── Companion mode ───────────────────────────────────────────────────────
  startCompanion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.COMPANION_START),

  stopCompanion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.COMPANION_STOP),

  selectWatchSource: (sourceId: string, windowName: string): Promise<WatchStartResult> =>
    ipcRenderer.invoke(IPC.SELECT_WATCH_SOURCE, sourceId, windowName),

  onWatchedSourceChanged: (handler: (event: unknown, data: { windowName: string | null; message: string | null }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { windowName: string | null; message: string | null }
    ) => handler(_event, data)
    ipcRenderer.on(IPC.COMPANION_WATCHED_SOURCE, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_WATCHED_SOURCE, listener)
  },

  pauseCompanion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.COMPANION_PAUSE),

  resumeCompanion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.COMPANION_RESUME),

  setQuietMode: (quiet: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.COMPANION_QUIET, quiet),

  askQuestion: (question: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ASK_QUESTION, question),

  transcribeAudio: (audioBuffer: ArrayBuffer): Promise<{ success: boolean; text: string; error?: string }> =>
    ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, Buffer.from(audioBuffer)),

  onCompanionAnswer: (handler: (event: unknown, data: { question: string; answer: string }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { question: string; answer: string }
    ) => handler(_event, data)
    ipcRenderer.on(IPC.COMPANION_ANSWER, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_ANSWER, listener)
  },

  openPanel: (): void =>
    ipcRenderer.send(IPC.OPEN_PANEL),

  resetCompanion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.RESET_COMPANION),

  showCompanion: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SHOW_COMPANION),

  onCompanionAnalysis: (handler: (event: unknown, analysis: AnalysisResult) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, analysis: AnalysisResult) =>
      handler(_event, analysis)
    ipcRenderer.on(IPC.COMPANION_ANALYSIS, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_ANALYSIS, listener)
  },

  onCompanionState: (handler: (event: unknown, state: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: string) =>
      handler(_event, state)
    ipcRenderer.on(IPC.COMPANION_STATE, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_STATE, listener)
  },

  onCompanionSpeak: (handler: (event: unknown, data: { text: string; type: string }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { text: string; type: string }
    ) => handler(_event, data)
    ipcRenderer.on(IPC.COMPANION_SPEAK, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_SPEAK, listener)
  },

  onCompanionAudio: (handler: (event: unknown, data: { audioBase64: string; text: string; type: string }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { audioBase64: string; text: string; type: string }
    ) => handler(_event, data)
    ipcRenderer.on(IPC.COMPANION_AUDIO, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_AUDIO, listener)
  },

  onCompanionShutdown: (handler: () => void): (() => void) => {
    const listener = () => handler()
    ipcRenderer.on(IPC.COMPANION_SHUTDOWN, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_SHUTDOWN, listener)
  },

  // ─── Guidance panel (secondary floating window) ────────────────────────────
  // The companion forwards guidance here so it renders in its own window instead
  // of overflowing the mascot window.
  showGuidance: (analysis: AnalysisResult): void =>
    ipcRenderer.send(IPC.GUIDANCE_SHOW, { kind: 'analysis', analysis } as GuidancePayload),

  showGuidanceAnswer: (answer: QuestionAnswer): void =>
    ipcRenderer.send(IPC.GUIDANCE_SHOW, { kind: 'answer', answer } as GuidancePayload),

  hideGuidance: (): void =>
    ipcRenderer.send(IPC.GUIDANCE_HIDE),

  showLastGuidance: (): void =>
    ipcRenderer.send(IPC.GUIDANCE_SHOW_LAST),

  resizeGuidance: (height: number): void =>
    ipcRenderer.send(IPC.GUIDANCE_RESIZE, height),

  // Phase 3B: temporarily allow keyboard focus while typing a hand-off answer
  // (the guidance window is otherwise non-focusable). Always restore false.
  setGuidanceFocusable: (focusable: boolean): void =>
    ipcRenderer.send(IPC.GUIDANCE_SET_FOCUSABLE, focusable),

  // Hand-off card: the user clicked "I'll decide" or "Skip for now". Main
  // forwards it to the companion, which clears the "!" badge for this hand-off.
  resolveHandoff: (ref: HandoffRef): void =>
    ipcRenderer.send(IPC.HANDOFF_RESOLVED, ref),

  // Companion: a hand-off was answered or dismissed in the guidance window.
  onHandoffResolved: (handler: (ref: HandoffRef) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ref: HandoffRef) => handler(ref)
    ipcRenderer.on(IPC.HANDOFF_RESOLVED, listener)
    return () => ipcRenderer.removeListener(IPC.HANDOFF_RESOLVED, listener)
  },

  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.COPY_TEXT, text),

  // Approve-and-send: sends ONLY the displayed prompt's id — main resolves the
  // text and performs the send (Windows and macOS).
  sendPromptToWindow: (promptId: string): Promise<SendPromptResult> =>
    ipcRenderer.invoke(IPC.SEND_PROMPT, promptId),

  // macOS: open System Settings at the pane for a missing permission (main owns
  // the URL; only the kind crosses IPC).
  openPermissionSettings: (permission: MacPermission): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_PERMISSION_SETTINGS, permission),

  // Main pushes canSend + blocked reason; the renderer only renders it.
  onSendEligibility: (handler: (event: unknown, state: SendEligibility) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SendEligibility) =>
      handler(_event, state)
    ipcRenderer.on(IPC.SEND_ELIGIBILITY, listener)
    return () => ipcRenderer.removeListener(IPC.SEND_ELIGIBILITY, listener)
  },

  // Settings: link a key saved by an earlier version to the custom endpoint now saved.
  confirmCustomKeyEndpoint: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONFIRM_CUSTOM_KEY_ENDPOINT),

  // Stop was pressed: cancel the Guidance screen's runs and auto-analysis.
  onStopped: (handler: () => void): (() => void) => {
    const listener = () => handler()
    ipcRenderer.on(IPC.STOPPED, listener)
    return () => ipcRenderer.removeListener(IPC.STOPPED, listener)
  },

  // The active project changed: drop per-project state (brainstorm, cached guidance).
  onProjectSwitched: (handler: () => void): (() => void) => {
    const listener = () => handler()
    ipcRenderer.on(IPC.PROJECTS_SWITCHED, listener)
    return () => ipcRenderer.removeListener(IPC.PROJECTS_SWITCHED, listener)
  },

  // Companion mascot: transient send status (e.g. 'sent') for the status label.
  onSendStatus: (handler: (event: unknown, status: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) =>
      handler(_event, status)
    ipcRenderer.on(IPC.SEND_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC.SEND_STATUS, listener)
  },

  // Companion mascot: true while the window is being dragged (main watches the
  // window's 'move' events — app-region drags emit no renderer mouse events).
  onCompanionDrag: (handler: (event: unknown, dragging: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dragging: boolean) =>
      handler(_event, dragging)
    ipcRenderer.on(IPC.COMPANION_DRAG, listener)
    return () => ipcRenderer.removeListener(IPC.COMPANION_DRAG, listener)
  },

  onGuidanceData: (handler: (event: unknown, payload: GuidancePayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GuidancePayload) =>
      handler(_event, payload)
    ipcRenderer.on(IPC.GUIDANCE_DATA, listener)
    return () => ipcRenderer.removeListener(IPC.GUIDANCE_DATA, listener)
  },

  // ─── Voice player (hidden main-owned window) ───────────────────────────────
  voice: {
    // Used by the hidden voice window:
    onPlayAudio: (handler: (event: unknown, data: { id: string; audioBase64: string }) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: { id: string; audioBase64: string }) => handler(_e, data)
      ipcRenderer.on(IPC.VOICE_PLAY_AUDIO, listener)
      return () => ipcRenderer.removeListener(IPC.VOICE_PLAY_AUDIO, listener)
    },
    onPlayTts: (handler: (event: unknown, data: { id: string; text: string }) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: { id: string; text: string }) => handler(_e, data)
      ipcRenderer.on(IPC.VOICE_PLAY_TTS, listener)
      return () => ipcRenderer.removeListener(IPC.VOICE_PLAY_TTS, listener)
    },
    onStop: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on(IPC.VOICE_STOP, listener)
      return () => ipcRenderer.removeListener(IPC.VOICE_STOP, listener)
    },
    ended: (id: string): void => ipcRenderer.send(IPC.VOICE_ENDED, id),
    error: (id: string): void => ipcRenderer.send(IPC.VOICE_ERROR, id),
    // Used by the companion window to control playback (explicit user actions):
    stop: (): void => ipcRenderer.send(IPC.VOICE_CTL_STOP),
    setMuted: (muted: boolean): void => ipcRenderer.send(IPC.VOICE_CTL_MUTE, muted),
    resetDedup: (): void => ipcRenderer.send(IPC.VOICE_CTL_RESET),
  },

  // Used by the guidance window to highlight the sentence being spoken:
  onSpeechProgress: (handler: (event: unknown, chunkText: string | null) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, chunkText: string | null) => handler(_e, chunkText)
    ipcRenderer.on(IPC.VOICE_SPEAK_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC.VOICE_SPEAK_PROGRESS, listener)
  },

  // ─── Memory layer (Nemp bridge) ────────────────────────────────────────────
  memory: {
    get: (): Promise<MemorySnapshot> => ipcRenderer.invoke(IPC.MEMORY_GET),
    getContextSummary: (maxTokens?: number): Promise<string> =>
      ipcRenderer.invoke(IPC.MEMORY_GET_CONTEXT, maxTokens),
    search: (query: string): Promise<MemoryEntry[]> =>
      ipcRenderer.invoke(IPC.MEMORY_SEARCH, query),
    addObservation: (text: string, sourceAnalysisId?: string): Promise<void> =>
      ipcRenderer.invoke(IPC.MEMORY_ADD_OBSERVATION, text, sourceAnalysisId),
    addCompletion: (feature: string): Promise<void> =>
      ipcRenderer.invoke(IPC.MEMORY_ADD_COMPLETION, feature),
    addBlocker: (description: string): Promise<void> =>
      ipcRenderer.invoke(IPC.MEMORY_ADD_BLOCKER, description),
    resolveBlocker: (blockerId: string, resolution: string): Promise<void> =>
      ipcRenderer.invoke(IPC.MEMORY_RESOLVE_BLOCKER, blockerId, resolution),
    addDecision: (question: string, choice: string, reasoning?: string): Promise<void> =>
      ipcRenderer.invoke(IPC.MEMORY_ADD_DECISION, question, choice, reasoning),
    addPattern: (observation: string, confidence: 'low' | 'medium' | 'high'): Promise<void> =>
      ipcRenderer.invoke(IPC.MEMORY_ADD_PATTERN, observation, confidence),
    exportMyBuildyMd: (): Promise<{ saved: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.MEMORY_EXPORT_MYBUILDYMD),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.MEMORY_RESET),
  },
}

contextBridge.exposeInMainWorld('mybuildy', mybuildyAPI)

// The renderer declares `window.mybuildy` in src/renderer/src/env.d.ts via a
// type-only import of this alias — keep it in sync by construction.
export type MyBuildyAPI = typeof mybuildyAPI
