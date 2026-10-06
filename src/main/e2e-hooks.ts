// e2e-hooks.ts — main process, e2e/dev ONLY.
// A tiny test hook used by the Playwright suite (e2e/screenshots.spec.ts) to
// render the guidance panel from a canned fixture analysis WITHOUT calling any
// AI provider. Registered ONLY when MYBUILDY_E2E=1 AND the app is not packaged —
// packaged builds never expose it, and normal dev runs (no MYBUILDY_E2E) don't
// either.
//
// The hook is a main-process global invoked via Playwright's
// electronApp.evaluate(); it deliberately reuses the app's real display
// pathway (showGuidanceWindow -> GUIDANCE_DATA -> GuidancePanel), so the
// screenshot exercises the exact code a live analysis would.
//
// The fixture uses NEUTRAL sample data only (a generic recipe-box app).

import { app, type BrowserWindow } from 'electron'
import { showGuidanceWindow } from './guidance-window'
import { e2eFakes, fakeAnalysisCalls, type E2eFakes } from './e2e-fakes'
import { pressRobotShortcut } from './robot-shortcut'
import { enqueueSpeech } from './voice-player'
import type { SetupPermissions } from './setup-permissions'
import { IPC, type AnalysisResult } from '../renderer/src/types'

const FIXTURE_ANALYSIS: AnalysisResult = {
  screenContentVisible: true,
  whatIsHappening:
    'The terminal just finished adding the "save recipe" form — the dev server reloaded and all 12 checks passed.',
  whatItMeans: 'Visitors can now type in a recipe and keep it. The core loop of the app works end to end.',
  whatIsBuilt: ['Recipe list page', 'Save-recipe form', 'Search by ingredient'],
  whatIsMissing: ['Photo upload for each recipe', 'A way to share a recipe with a friend'],
  whatIsBroken: [],
  whereUserIsStuck: null,
  bestNextMove: 'Add photo upload next — recipes without pictures are much harder to browse.',
  nextPrompt:
    'Add a photo upload field to the save-recipe form. Store the image locally and show it at the top of the recipe page.',
  expectedOutcome: 'The save-recipe form shows a photo picker and a saved recipe displays its photo.',
  builderNote: "Nice progress — the app already does the one thing it promised. Photos will make it feel real.",
  goalAlignment: 'on-track',
  alignmentNote: 'Everything on screen moves the recipe box closer to something a friend could use.',
  projectUnderstandingNote: 'a simple recipe box where anyone can save and find home recipes',
  verification: { status: 'success', note: 'The save-recipe form from the last prompt now works.' },
  terminalState: 'awaiting_prompt',
  agentName: 'claude_code',
  sendGuard: null,
  callsThisHour: 3,
  promptId: 'e2e-fixture-prompt',
  analyzedAt: new Date().toISOString(),
  analysisDurationMs: 1234,
}

interface E2eHooks {
  showFixtureGuidance(): void
  /** Send a hand-off analysis to the companion exactly as the loop does; returns its analyzedAt. */
  sendFixtureHandoff(analyzedAt?: string): string
  /** Show a spoken-question answer with a suggested goal, through the real display path. */
  showFixtureAnswer(): void
  /** Press the bring-back shortcut (Ctrl/Cmd+Alt+B) — a test cannot send a system-wide key. */
  pressRobotShortcut(): void
  /** The setup-wizard fakes (e2e-fakes.ts), or null when not enabled. */
  setupFakes(): E2eFakes | null
  /** Change the fake macOS permissions (the wizard's live status picks it up). */
  setFakePermissions(p: Partial<SetupPermissions>): void
  /** How many screen analyses the fake provider has answered. */
  fakeAnalysisCalls(): number
  /** Speak a line through the real voice queue (the voice order picks the engine). */
  speak(text: string): void
}

/** Register the gated e2e test hooks. No-op outside MYBUILDY_E2E=1 dev runs. */
export function registerE2eTestHooks(getCompanionWindow: () => BrowserWindow | null): void {
  if (process.env['MYBUILDY_E2E'] !== '1' || app.isPackaged) return
  const hooks: E2eHooks = {
    showFixtureGuidance(): void {
      showGuidanceWindow({
        kind: 'analysis',
        analysis: { ...FIXTURE_ANALYSIS, analyzedAt: new Date().toISOString() },
      })
    },
    sendFixtureHandoff(analyzedAt = new Date().toISOString()): string {
      const analysis: AnalysisResult = {
        ...FIXTURE_ANALYSIS,
        nextPrompt: '',
        expectedOutcome: '',
        verification: null,
        needsHumanJudgment: true,
        humanJudgmentReason: 'Recipes save now. Want to add photos next, or sharing with friends?',
        analyzedAt,
      }
      getCompanionWindow()?.webContents.send(IPC.COMPANION_ANALYSIS, analysis)
      return analyzedAt
    },
    pressRobotShortcut: () => pressRobotShortcut(),
    setupFakes: () => e2eFakes(),
    fakeAnalysisCalls: () => fakeAnalysisCalls,
    speak: (text: string) => enqueueSpeech({ id: `e2e-${Date.now()}`, text }),
    setFakePermissions(p: Partial<SetupPermissions>): void {
      const fakes = e2eFakes()
      if (fakes) Object.assign(fakes.permissions, p)
    },
    showFixtureAnswer(): void {
      showGuidanceWindow({
        kind: 'answer',
        answer: {
          question: 'Give me a goal for the recipe photos',
          answer: "Here's a goal you can use for recipe photos.",
          suggestion: {
            kind: 'goal',
            text: 'Let people add a photo to each recipe and show it at the top of the recipe page.',
            doneWhen: 'a saved recipe with a photo shows that photo at the top of its page after a restart',
          },
        },
      })
    },
  }
  ;(globalThis as Record<string, unknown>)['__mybuildyE2E'] = hooks
  console.log('[E2E] test hooks registered (MYBUILDY_E2E dev run only)')
}
