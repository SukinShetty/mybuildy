// useAppStore.ts
// Zustand store — all app state in one place.
// Every screen reads from and writes to this store via hooks.

import { create } from 'zustand'
import type {
  ProjectMemory,
  ProjectRecord,
  ProjectSummary,
  RedactedSettings,
  AnalysisResult,
  WatchStatus,
  ChatMessage,
  ExtractedProjectData,
} from '../types'
import { emptyProjectMemory, defaultRedactedSettings } from '../types'

// ─── Screen navigation ────────────────────────────────────────────────────────

export type AppScreen = 'goal' | 'brainstorm' | 'guidance' | 'memory' | 'settings'

// ─── The watch (owned by main, shared with the robot) ─────────────────────────

export const NO_WATCH: WatchStatus = { windowName: null, auto: false, analyzing: false, message: null }

// ─── Brainstorm state ─────────────────────────────────────────────────────────

export type BrainstormPhase = 'idle' | 'waiting-for-response' | 'streaming' | 'done' | 'error'

// ─── Full store ───────────────────────────────────────────────────────────────

interface AppState {
  // ── Navigation
  currentScreen: AppScreen
  // The first-run setup wizard, when it is showing (platform + step to resume at).
  setupWizard: { platform: string; step: string | null } | null
  setSetupWizard: (wizard: { platform: string; step: string | null } | null) => void

  // ── Project memory (persisted via IPC)
  project: ProjectMemory
  projectIsLoaded: boolean

  // ── Project records (project-scoped memory — switcher UI)
  projects: ProjectSummary[]
  activeProject: ProjectRecord | null

  // ── Settings (REDACTED — non-secret fields + has* booleans; never raw keys)
  settings: RedactedSettings
  settingsAreLoaded: boolean

  // ── The watch, as main sends it (the robot shows the same), and the analysis on display
  watchStatus: WatchStatus
  latestAnalysis: AnalysisResult | null

  // ── Brainstorm chat
  brainstormMessages: ChatMessage[]
  brainstormPhase: BrainstormPhase
  brainstormStreamingBuffer: string   // Accumulates chunks mid-stream
  brainstormErrorMessage: string | null
  lastExtractedProjectData: ExtractedProjectData | null

  // ── Actions
  setCurrentScreen: (screen: AppScreen) => void

  setProject: (project: ProjectMemory) => void
  patchProject: (partial: Partial<ProjectMemory>) => void
  setProjectIsLoaded: (loaded: boolean) => void

  setProjects: (projects: ProjectSummary[]) => void
  setActiveProject: (activeProject: ProjectRecord | null) => void

  setSettings: (settings: RedactedSettings) => void
  setSettingsAreLoaded: (loaded: boolean) => void

  // A new watch status from main. Nothing watched any more: the analysis goes too.
  applyWatchStatus: (status: WatchStatus) => void
  setLatestAnalysis: (result: AnalysisResult | null) => void

  addBrainstormUserMessage: (content: string) => void
  appendBrainstormStreamChunk: (chunk: string) => void
  finalizeBrainstormAssistantMessage: (
    fullText: string,
    extractedData: ExtractedProjectData | null
  ) => void
  setBrainstormPhase: (phase: BrainstormPhase) => void
  setBrainstormError: (message: string | null) => void
  clearBrainstormMessages: () => void
  /** The active project changed: drop everything that belonged to the old one. */
  resetForProjectSwitch: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // ── Navigation
  currentScreen: 'brainstorm',
  setupWizard: null,
  setSetupWizard: (setupWizard) => set({ setupWizard }),

  // ── Project
  project: emptyProjectMemory(),
  projectIsLoaded: false,

  // ── Project records
  projects: [],
  activeProject: null,

  // ── Settings
  settings: defaultRedactedSettings(),
  settingsAreLoaded: false,

  // ── The watch
  watchStatus: NO_WATCH,
  latestAnalysis: null,

  // ── Brainstorm
  brainstormMessages: [],
  brainstormPhase: 'idle',
  brainstormStreamingBuffer: '',
  brainstormErrorMessage: null,
  lastExtractedProjectData: null,

  // ── Actions

  setCurrentScreen: (screen) => set({ currentScreen: screen }),

  setProject: (project) => set({ project }),
  patchProject: (partial) =>
    set((state) => ({ project: { ...state.project, ...partial } })),
  setProjectIsLoaded: (projectIsLoaded) => set({ projectIsLoaded }),

  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProject) => set({ activeProject }),

  setSettings: (settings) => set({ settings }),
  setSettingsAreLoaded: (settingsAreLoaded) => set({ settingsAreLoaded }),

  applyWatchStatus: (watchStatus) =>
    set((state) => ({ watchStatus, latestAnalysis: watchStatus.windowName ? state.latestAnalysis : null })),
  setLatestAnalysis: (latestAnalysis) => set({ latestAnalysis }),

  addBrainstormUserMessage: (content) => {
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    set((state) => ({
      brainstormMessages: [...state.brainstormMessages, userMessage],
      brainstormStreamingBuffer: '',
      brainstormPhase: 'waiting-for-response',
    }))
  },

  appendBrainstormStreamChunk: (chunk) => {
    set((state) => ({
      brainstormStreamingBuffer: state.brainstormStreamingBuffer + chunk,
      brainstormPhase: 'streaming',
    }))
  },

  finalizeBrainstormAssistantMessage: (fullText, extractedData) => {
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: fullText,
      timestamp: new Date().toISOString(),
    }
    set((state) => ({
      brainstormMessages: [...state.brainstormMessages, assistantMessage],
      brainstormStreamingBuffer: '',
      brainstormPhase: 'done',
      lastExtractedProjectData: extractedData,
    }))
  },

  setBrainstormPhase: (brainstormPhase) => set({ brainstormPhase }),
  setBrainstormError: (brainstormErrorMessage) =>
    set({ brainstormErrorMessage, brainstormPhase: 'error' }),

  clearBrainstormMessages: () =>
    set({
      brainstormMessages: [],
      brainstormPhase: 'idle',
      brainstormStreamingBuffer: '',
      brainstormErrorMessage: null,
      lastExtractedProjectData: null,
    }),

  resetForProjectSwitch: () =>
    set({
      brainstormMessages: [],
      brainstormPhase: 'idle',
      brainstormStreamingBuffer: '',
      brainstormErrorMessage: null,
      lastExtractedProjectData: null,
      // Nothing from the old project's window survives (main ends the watch too).
      latestAnalysis: null,
    }),
}))
