// useCompanionStore.ts
// State for the floating companion window.

import { create } from 'zustand'
import type { AnalysisResult, WatchStatus } from '../types'

export type CompanionState = 'idle' | 'thinking' | 'speaking'
export type MicState = 'idle' | 'listening' | 'transcribing' | 'answering'

interface CompanionStoreState {
  avatarState: CompanionState
  latestAnalysis: AnalysisResult | null
  isMuted: boolean
  isPaused: boolean
  isQuietMode: boolean
  lastSpokenText: string
  showPromptCard: boolean

  // The one watch, as main sends it (the Guidance tab shows the same)
  watchedWindowName: string | null
  watchedSourceMessage: string | null
  analyzing: boolean
  // The prompt the user pasted (its promptId): that step is done, never "ready" again
  pastedPromptId: string | null

  // Window picker
  showWindowPicker: boolean

  // Voice conversation
  micState: MicState
  micError: string | null
  lastAnswer: { question: string; answer: string } | null

  // Actions
  setAvatarState: (state: CompanionState) => void
  setLatestAnalysis: (analysis: AnalysisResult) => void
  setMuted: (muted: boolean) => void
  setWatchStatus: (status: WatchStatus) => void
  setPastedPromptId: (promptId: string | null) => void
  setQuietMode: (quiet: boolean) => void
  setLastSpokenText: (text: string) => void
  setShowPromptCard: (show: boolean) => void
  setShowWindowPicker: (show: boolean) => void
  setMicState: (state: MicState) => void
  setMicError: (error: string | null) => void
  setLastAnswer: (answer: { question: string; answer: string } | null) => void
  clearAnalysis: () => void
}

export const useCompanionStore = create<CompanionStoreState>((set) => ({
  avatarState: 'idle',
  latestAnalysis: null,
  isMuted: false,
  isPaused: false,
  isQuietMode: false,
  lastSpokenText: '',
  showPromptCard: false,
  watchedWindowName: null,
  watchedSourceMessage: null,
  analyzing: false,
  pastedPromptId: null,
  showWindowPicker: false,
  micState: 'idle',
  micError: null,
  lastAnswer: null,

  setAvatarState: (avatarState) => set({ avatarState }),
  setLatestAnalysis: (latestAnalysis) => set({ latestAnalysis, showPromptCard: true }),
  setMuted: (isMuted) => set({ isMuted }),
  setWatchStatus: (s) => set({
    watchedWindowName: s.windowName,
    watchedSourceMessage: s.message,
    isPaused: !!s.windowName && !s.auto,
    analyzing: s.analyzing,
  }),
  setPastedPromptId: (pastedPromptId) => set({ pastedPromptId }),
  setQuietMode: (isQuietMode) => set({ isQuietMode }),
  setLastSpokenText: (lastSpokenText) => set({ lastSpokenText }),
  setShowPromptCard: (showPromptCard) => set({ showPromptCard }),
  setShowWindowPicker: (showWindowPicker) => set({ showWindowPicker }),
  setMicState: (micState) => set({ micState }),
  setMicError: (micError) => set({ micError }),
  setLastAnswer: (lastAnswer) => set({ lastAnswer, showPromptCard: !!lastAnswer }),
  clearAnalysis: () => set({ latestAnalysis: null, showPromptCard: false, lastSpokenText: '', lastAnswer: null, pastedPromptId: null }),
}))
