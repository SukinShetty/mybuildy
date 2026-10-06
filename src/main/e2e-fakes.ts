// e2e-fakes.ts — main process, e2e ONLY. Stand-ins that let the Playwright
// suite walk the whole setup wizard on any OS without an AI provider or real
// macOS permissions:
//
//   platform     MYBUILDY_E2E_FAKE_PLATFORM=darwin|win32 — which platform's
//                steps the wizard shows (so the Mac steps run on Windows CI
//                and the Windows steps on macOS CI)
//   permissions  the Mac permission states, changed by the test through
//                __mybuildyE2E.setFakePermissions (e2e-hooks.ts); screen
//                starts granted with MYBUILDY_E2E_FAKE_SCREEN=granted, to
//                model a restart that applied the permission
//   provider     model list / model check / screen analysis answer locally
//                with canned data — no provider is ever called
//
// Active ONLY when MYBUILDY_E2E=1 AND MYBUILDY_E2E_FAKES=1 AND the app is not
// packaged. A packaged build or a normal run never has any of this.

import { app } from 'electron'
import type { SetupPermissions } from './setup-permissions'
import type { AnalysisResult, ModelChoice } from '../renderer/src/types'

export interface E2eFakes {
  platform: NodeJS.Platform
  permissions: SetupPermissions
  openedPanes: string[]
  pastePermissionRequests: number
}

let fakes: E2eFakes | null | undefined

export function isE2eDevRun(): boolean {
  return process.env['MYBUILDY_E2E'] === '1' && !app.isPackaged
}

export function e2eFakes(): E2eFakes | null {
  if (fakes !== undefined) return fakes
  if (!isE2eDevRun() || process.env['MYBUILDY_E2E_FAKES'] !== '1') {
    fakes = null
    return fakes
  }
  const p = process.env['MYBUILDY_E2E_FAKE_PLATFORM']
  fakes = {
    platform: p === 'darwin' || p === 'win32' ? p : process.platform,
    permissions: {
      screen: process.env['MYBUILDY_E2E_FAKE_SCREEN'] === 'granted' ? 'granted' : 'not-granted',
      accessibility: false,
      automation: 'unknown',
    },
    openedPanes: [],
    pastePermissionRequests: 0,
  }
  console.log('[E2E] setup fakes active (platform, permissions, provider)')
  return fakes
}

export const FAKE_MODELS: ModelChoice[] = [
  { id: 'fake-large', label: 'Fake Large' },
  { id: 'fake-mini', label: 'Fake Mini', suggested: true, curated: true },
]

/**
 * The fake provider's screen analysis: the canned answer, after
 * MYBUILDY_E2E_FAKE_ANALYSIS_MS (default 0) so a test can see the app while an
 * analysis is running. Counts calls, so a test can check one analysis ran.
 */
export let fakeAnalysisCalls = 0
export async function fakeAnalyzeScreen(): Promise<AnalysisResult> {
  fakeAnalysisCalls++
  const delay = Number(process.env['MYBUILDY_E2E_FAKE_ANALYSIS_MS'] ?? 0)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  return fakeAnalysis()
}

/** A canned analysis for a watch started during the e2e wizard run. */
export function fakeAnalysis(): AnalysisResult {
  return {
    screenContentVisible: true,
    whatIsHappening: 'The coding agent is waiting for your first instruction.',
    whatItMeans: 'Everything is ready to start building.',
    whatIsBuilt: [],
    whatIsMissing: [],
    whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'Give the agent its first instruction.',
    nextPrompt: 'Create a simple page with the title "My habits".',
    expectedOutcome: 'A page with the title appears.',
    builderNote: 'Nice start.',
    goalAlignment: 'on-track',
    terminalState: 'awaiting_prompt',
    agentName: 'claude_code',
    analyzedAt: new Date().toISOString(),
    analysisDurationMs: 1,
  }
}
