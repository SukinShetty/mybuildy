// prompt-quality-check.test.ts
// Phase 3B: the grader gains an "addressed to the coding agent" criterion.
// When the grader flags a prompt as human-directed, the analysis is converted to
// a hand-off (Block 6) and the prompt is DROPPED — never patched/improved.
// The AI call is mocked (global fetch); neutral sample data only.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkPromptQuality, buildQualityPatch, patchDropsPrompt } from './prompt-quality-check'
import type { PromptQualityResult } from './prompt-quality-check'
import type { AnalysisResult, AppSettings } from '../../renderer/src/types'
import { defaultSettings } from '../../renderer/src/types'
import {
  recordPendingOutcome, removePendingOutcome, getMostRecentPending, setVerifierProject,
} from '../verifier'

function makeAnalysis(nextPrompt: string): AnalysisResult {
  return {
    screenContentVisible: true,
    whatIsHappening: 'The editor shows the form component.',
    whatItMeans: 'The form is mid-build.',
    whatIsBuilt: ['form layout'],
    whatIsMissing: ['save button'],
    whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'Wire up saving next.',
    nextPrompt,
    expectedOutcome: 'The form has a working save button.',
    builderNote: 'Keep going!',
    needsHumanJudgment: false,
    humanJudgmentReason: '',
    terminalState: 'awaiting_prompt',
    analyzedAt: new Date().toISOString(),
    analysisDurationMs: 100,
  }
}

function makeSettings(): AppSettings {
  return { ...defaultSettings(), provider: 'anthropic', apiKey: 'test-key' }
}

/** Stub global fetch to return an Anthropic-style grader response. */
function stubGraderResponse(graderJson: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(graderJson) }] }), { status: 200 })
    )
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('checkPromptQuality — human-directed criterion (Phase 3B)', () => {
  it('fails a prompt the grader flags as directed at the human', async () => {
    stubGraderResponse({
      valid: true, // even if the grader forgets to fail it overall…
      humanDirected: true, // …the human-directed flag must force invalid
      reason: 'The prompt asks the user a question instead of instructing the agent.',
      improvedPrompt: '',
    })
    const analysis = makeAnalysis('Do you want the list page or the detail page first?')
    const result = await checkPromptQuality(analysis, '', null, makeSettings())
    expect(result.humanDirected).toBe(true)
    expect(result.valid).toBe(false)
  })

  it('does not mark a passing agent-directed prompt as human-directed', async () => {
    stubGraderResponse({ valid: true, humanDirected: false, reason: '', improvedPrompt: '' })
    const analysis = makeAnalysis(
      'Add a save button to the form component and wire it to the existing submit handler'
    )
    const result = await checkPromptQuality(analysis, '', null, makeSettings())
    expect(result.humanDirected).toBeFalsy()
    expect(result.valid).toBe(true)
  })
})

describe('buildQualityPatch — converts human-directed prompts to a hand-off', () => {
  it('KEEPS the prompt on screen and adds the hand-off, IGNORING any improvedPrompt', () => {
    const analysis = makeAnalysis('Are you building a planner or a checklist?')
    const result: PromptQualityResult = {
      valid: false,
      humanDirected: true,
      reason: 'Asks the user which product they are building.',
      improvedPrompt: 'Build the planner page with a weekly grid layout.',
    }
    const patch = buildQualityPatch(analysis, result)
    expect(patch).not.toBeNull()
    // Deferring the decision must leave the prompt usable: never blank it.
    expect('nextPrompt' in patch!).toBe(false)
    expect('expectedOutcome' in patch!).toBe(false)
    expect({ ...analysis, ...patch }.nextPrompt).toBe('Are you building a planner or a checklist?')
    expect(patch!.needsHumanJudgment).toBe(true)
    expect(patch!.humanJudgmentReason).toBeTruthy()
  })

  it('returns null for a valid prompt (nothing to patch)', () => {
    const result: PromptQualityResult = { valid: true }
    expect(buildQualityPatch(makeAnalysis('Add the save button.'), result)).toBeNull()
  })

  it('still swaps in an improved prompt for ordinary quality failures', () => {
    const analysis = makeAnalysis('Continue building.')
    const result: PromptQualityResult = {
      valid: false,
      reason: 'Too generic.',
      improvedPrompt: 'Add a save button to the form component and wire it to the submit handler.',
    }
    const patch = buildQualityPatch(analysis, result)
    expect(patch!.nextPrompt).toBe(
      'Add a save button to the form component and wire it to the submit handler.'
    )
    expect(patch!.needsHumanJudgment).toBeUndefined()
  })

  it('blanks the prompt when invalid with no improvement — the grader reason is never shown', () => {
    const analysis = makeAnalysis('Continue building.')
    const result: PromptQualityResult = { valid: false, reason: 'Too generic.' }
    const patch = buildQualityPatch(analysis, result)
    expect(patch!.nextPrompt).toBe('')
    expect(patch!.alignmentNote).not.toContain('Too generic.')
    expect(patch!.alignmentNote).toBeTruthy()
    expect(patch!.needsHumanJudgment).toBeUndefined()
  })
})

describe('patchDropsPrompt — detects patches that empty the prompt', () => {
  it('is true for the ordinary blank path, false for a hand-off (prompt kept)', () => {
    const analysis = makeAnalysis('Are you building a planner or a checklist?')
    expect(patchDropsPrompt(buildQualityPatch(analysis, { valid: false, humanDirected: true }))).toBe(false)
    expect(patchDropsPrompt(buildQualityPatch(analysis, { valid: false, reason: 'Too generic.' }))).toBe(true)
  })

  it('is false for an improved prompt, a valid result, and patches without nextPrompt', () => {
    const analysis = makeAnalysis('Continue building.')
    expect(
      patchDropsPrompt(buildQualityPatch(analysis, { valid: false, improvedPrompt: 'Add the save button to the form component.' }))
    ).toBe(false)
    expect(patchDropsPrompt(buildQualityPatch(analysis, { valid: true }))).toBe(false)
    expect(patchDropsPrompt({ alignmentNote: 'note only' })).toBe(false)
  })
})

describe('dropped prompt → pending verifier outcome removed (stale-outcome fix)', () => {
  // Mirrors the analysis-loop wiring: the suggestion is recorded as a pending
  // outcome BEFORE grading; when the grade drops the prompt, the recorded
  // outcome must be removed so the next cycle never verifies a prompt that was
  // never shown or sent. Uses the verifier's real in-memory API.
  it('grader blanks the prompt (no improvement) → no pending outcome remains', () => {
    setVerifierProject('quality-drop-test')
    const analysis = makeAnalysis('Continue building.')
    const recorded = recordPendingOutcome(analysis.nextPrompt, analysis.expectedOutcome || '')
    expect(getMostRecentPending()).not.toBeNull()

    const patch = buildQualityPatch(analysis, { valid: false, reason: 'Too generic.' })
    if (patchDropsPrompt(patch)) removePendingOutcome(recorded?.id ?? null)

    expect(getMostRecentPending()).toBeNull()
    setVerifierProject('default')
  })

  it('an improved (not dropped) prompt keeps the pending outcome', () => {
    setVerifierProject('quality-improve-test')
    const analysis = makeAnalysis('Continue building.')
    const recorded = recordPendingOutcome(analysis.nextPrompt, analysis.expectedOutcome || '')

    const patch = buildQualityPatch(analysis, {
      valid: false,
      improvedPrompt: 'Add the save button to the form component.',
    })
    if (patchDropsPrompt(patch)) removePendingOutcome(recorded?.id ?? null)

    expect(getMostRecentPending()?.id).toBe(recorded!.id)
    setVerifierProject('default')
  })
})
