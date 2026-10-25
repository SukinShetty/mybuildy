import { describe, it, expect } from 'vitest'
import type { AnalysisResult } from '../renderer/src/types'
import { isGoalReached,
  HANDOFF_FALLBACK, userFacingHandoff, claimsGoalReached, reconcileWithVerdict, prepareForDisplay,
} from './display-consistency'
import { buildQualityPatch } from './ai/prompt-quality-check'

// The checker output the installed-build smoke test showed on the hand-off card.
const CHECKER_OUTPUT =
  "The prompt contains implicit requests for human confirmation ('Should I proceed?'), violating criterion 6. " +
  "Additionally, it is redundant — the project memory states Claude Code is 'currently reading the existing code' and has already run the tests."

const GOOD_QUESTION =
  'Tests pass. Want to open Tally in your browser and check the Invoices screen before saving your work?'

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length
}

function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    screenContentVisible: true,
    whatIsHappening: 'The invoice tests finished.',
    whatItMeans: 'Invoices can be saved.',
    whatIsBuilt: [], whatIsMissing: [], whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'Check the Invoices screen.',
    nextPrompt: 'Run the invoice tests.',
    builderNote: 'Nice work.',
    goalAlignment: 'on-track',
    alignmentNote: '',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    analysisDurationMs: 1,
    ...over,
  }
}

describe('hand-off card text', () => {
  it('the exact checker output never reaches the card', () => {
    const patch = buildQualityPatch(analysis(), { valid: false, humanDirected: true, reason: CHECKER_OUTPUT })!
    const card = patch.humanJudgmentReason!
    expect(card).not.toMatch(/criterion/i)
    expect(card).not.toContain('currently reading the existing code')
    expect(card).not.toMatch(/['"“”‘’]/)
    expect(sentenceCount(card)).toBeLessThanOrEqual(2)
    expect(card).toBe(HANDOFF_FALLBACK)
  })

  it("shows the grader's separate user question when it is clean", () => {
    const patch = buildQualityPatch(analysis(), {
      valid: false, humanDirected: true, reason: CHECKER_OUTPUT, userQuestion: GOOD_QUESTION,
    })!
    expect(patch.humanJudgmentReason).toBe(GOOD_QUESTION)
  })

  it('falls back when the "question" is really reasoning, quotes memory, or runs long', () => {
    expect(userFacingHandoff(CHECKER_OUTPUT)).toBe(HANDOFF_FALLBACK)
    expect(userFacingHandoff("Memory says 'reading code'. Proceed?")).toBe(HANDOFF_FALLBACK)
    expect(userFacingHandoff('Should the grader prompt be rewritten?')).toBe(HANDOFF_FALLBACK)
    expect(userFacingHandoff('Tests pass. The build is green. Want to ship it?')).toBe(HANDOFF_FALLBACK)
    expect(userFacingHandoff('Want to ' + 'check the invoices and '.repeat(20) + 'ship?')).toBe(HANDOFF_FALLBACK)
    expect(userFacingHandoff('')).toBe(HANDOFF_FALLBACK)
    expect(userFacingHandoff('Everything compiled.')).toBe(HANDOFF_FALLBACK) // not addressed to the user
  })

  it('keeps a clean question, apostrophes included', () => {
    expect(userFacingHandoff(GOOD_QUESTION)).toBe(GOOD_QUESTION)
    expect(userFacingHandoff("Do you want monthly or yearly plans? It's your call.")).toBe(
      "Do you want monthly or yearly plans? It's your call."
    )
  })

  it("the analysis model's own hand-off text gets the same clean-up", () => {
    const shown = prepareForDisplay(analysis({ needsHumanJudgment: true, humanJudgmentReason: CHECKER_OUTPUT }))
    expect(shown.humanJudgmentReason).toBe(HANDOFF_FALLBACK)
  })
})

describe('one status: verdict, pill and headline agree', () => {
  const claiming = {
    whatIsHappening: 'You have reached your goal. The Invoices screen saves invoices.',
    bestNextMove: 'Goal reached — save your work.',
    builderNote: 'You hit your goal!',
    alignmentNote: 'The goal is complete.',
  }

  it('partial: every "goal reached" claim is removed, the rest is kept', () => {
    const out = reconcileWithVerdict(analysis({ ...claiming, verification: { status: 'partial', note: 'PDF export is missing.' } }))
    for (const f of ['whatIsHappening', 'whatItMeans', 'bestNextMove', 'builderNote', 'alignmentNote'] as const) {
      expect(claimsGoalReached(out[f]), `${f}: ${out[f]}`).toBe(false)
    }
    expect(out.whatIsHappening).toBe('The Invoices screen saves invoices.')
    expect(out.bestNextMove).toMatch(/not reached yet/)
    expect(out.verification?.status).toBe('partial')
    expect(out.goalAlignment).toBe('on-track')
  })

  it('failed: same rule', () => {
    const out = reconcileWithVerdict(analysis({ ...claiming, verification: { status: 'failed', note: 'Saving crashes.' } }))
    expect(claimsGoalReached(out.whatIsHappening)).toBe(false)
    expect(out.bestNextMove).toMatch(/didn't work/)
  })

  it('success (or no verdict) leaves the text alone', () => {
    const a = analysis({ ...claiming, verification: { status: 'success', note: 'Works.' } })
    expect(reconcileWithVerdict(a)).toBe(a)
    const b = analysis(claiming)
    expect(reconcileWithVerdict(b)).toBe(b)
  })

  it('recognises the common phrasings', () => {
    for (const t of ['You have reached your goal', 'goal achieved', 'Your goal is now complete', 'We met the project goal']) {
      expect(claimsGoalReached(t), t).toBe(true)
    }
    for (const t of ['Keep going toward your goal', 'This moves you closer to the goal']) {
      expect(claimsGoalReached(t), t).toBe(false)
    }
  })
})

describe('goal reached: the robot celebrates only a verified goal', () => {
  const verified = { status: 'success' as const, note: 'it worked' }

  it('is set when the Verifier passed and the analysis says the goal is reached', () => {
    const out = prepareForDisplay(analysis({ verification: verified, builderNote: 'You reached your goal — the habit tracker is done!' }))
    expect(out.goalReached).toBe(true)
    expect(isGoalReached(out)).toBe(true)
  })

  it('is not set from the model\'s claim alone', () => {
    expect(prepareForDisplay(analysis({ builderNote: 'Goal reached!' })).goalReached).toBeFalsy()
  })

  it('is not set when the Verifier passed but nobody says the goal is reached', () => {
    expect(prepareForDisplay(analysis({ verification: verified })).goalReached).toBeFalsy()
  })

  it('is not set on a partial or failed verdict, or while blocked', () => {
    expect(prepareForDisplay(analysis({ verification: { status: 'partial', note: 'x' }, builderNote: 'Goal reached!' })).goalReached).toBeFalsy()
    expect(prepareForDisplay(analysis({ verification: verified, goalAlignment: 'blocked', builderNote: 'Goal reached!' })).goalReached).toBeFalsy()
  })
})

describe('prepareForDisplay — never points at a prompt that is not there', () => {
  it('rewrites "Paste the prompt below" when there is no prompt (hand-off)', () => {
    const out = prepareForDisplay(analysis({
      nextPrompt: '',
      bestNextMove: 'Paste the prompt below into Claude Code and press Enter.',
      needsHumanJudgment: true,
      humanJudgmentReason: 'Photos or sharing next?',
    }))
    expect(out.bestNextMove).not.toMatch(/paste|below/i)
    expect(out.bestNextMove).toMatch(/answer the question/i)
  })

  it('rewrites it without a hand-off too', () => {
    const out = prepareForDisplay(analysis({ nextPrompt: '', bestNextMove: 'Paste the prompt below into Claude Code.' }))
    expect(out.bestNextMove).not.toMatch(/prompt below/i)
  })

  it('leaves it alone when the prompt is there', () => {
    const out = prepareForDisplay(analysis({ nextPrompt: 'Add the save button.', bestNextMove: 'Paste the prompt below into Claude Code.' }))
    expect(out.bestNextMove).toBe('Paste the prompt below into Claude Code.')
  })

  it('a grader hand-off keeps the prompt on screen next to the decision card', () => {
    const base = analysis({ nextPrompt: 'Add photo upload to the recipe form.', bestNextMove: 'Paste the prompt below into Claude Code.' })
    const out = prepareForDisplay({ ...base, ...buildQualityPatch(base, { valid: false, humanDirected: true, userQuestion: 'Photos or sharing next?' }) })
    expect(out.needsHumanJudgment).toBe(true)
    expect(out.nextPrompt).toBe('Add photo upload to the recipe form.')
    expect(out.bestNextMove).toBe('Paste the prompt below into Claude Code.')
  })
})

describe('prepareForDisplay — ordinary paste instructions are kept when there is no prompt', () => {
  it.each([
    'Copy the preview URL and paste it into your browser.',
    'Paste your Supabase URL into the .env file, then restart the dev server.',
    'Copy the error message and paste it into a search engine if it keeps happening.',
    'Paste the API key into Settings, then click Save.',
    'Open the link Claude Code printed and paste it into Chrome.',
    // Claude Code's own permission prompt (nothing to paste; this IS the next step)
    'Claude Code is asking to run a command. Read the prompt in the terminal and press 1 to allow it.',
    'Answer the prompt in your terminal: type y and press Enter.',
    'Claude is waiting at a yes/no prompt. Choose Yes if you trust the command.',
  ])('keeps: %s', (line) => {
    for (const needsHumanJudgment of [false, true]) {
      const out = prepareForDisplay(analysis({ nextPrompt: '', bestNextMove: line, needsHumanJudgment }))
      expect(out.bestNextMove).toBe(line)
    }
  })

  it.each([
    'Paste the prompt below into Claude Code.',
    'Paste the prompt into Claude Code and press Enter.',
    'Copy the suggested prompt and send it to the agent.',
    'Paste this into Claude Code.',
    'Paste it into the terminal where Claude Code is running.',
    'Use the text below to tell Claude what to do next.',
  ])('rewrites (no prompt to point at): %s', (line) => {
    const out = prepareForDisplay(analysis({ nextPrompt: '', bestNextMove: line }))
    expect(out.bestNextMove).not.toBe(line)
    // …but with a prompt on screen, the same line stays.
    expect(prepareForDisplay(analysis({ nextPrompt: 'Add the save button.', bestNextMove: line })).bestNextMove).toBe(line)
  })
})

