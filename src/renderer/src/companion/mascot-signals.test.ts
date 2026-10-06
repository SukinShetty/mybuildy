// mascot-signals.test.ts
// Pure mapping from an incoming AnalysisResult (plus the previously seen one)
// to robot signals: alignment glow, one-off reactions, and the "!" alert badge.
//
// Event semantics under test:
//   - Reactions fire on TRANSITIONS, not on every analysis, so a persistent
//     blocked state doesn't replay "failed" every cycle.
//   - The main process re-sends the SAME analysis (same analyzedAt) when a
//     background pass patches it (e.g. the verifier verdict arrives) — a
//     re-send must not replay a verdict that already fired.
//   - Priority when several events land in one analysis: failed > goal complete > Verifier passed.
//   - Hand-offs raise the badge but are not a reaction (the robot waits instead).

import { describe, it, expect } from 'vitest'
import { deriveMascotSignals } from './mascot-signals'
import type { AnalysisResult } from '../types'

// Neutral sample analysis — only the fields the mapper reads are meaningful.
function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    screenContentVisible: true,
    whatIsHappening: 'sample activity',
    whatItMeans: 'sample meaning',
    whatIsBuilt: [],
    whatIsMissing: [],
    whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'sample move',
    nextPrompt: '',
    builderNote: 'sample note',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    analysisDurationMs: 100,
    ...overrides,
  }
}

const passed = { status: 'success' as const, note: 'it worked' }
const failedVerdict = { status: 'failed' as const, note: 'nope' }

describe('deriveMascotSignals — alignment glow', () => {
  it('passes goalAlignment through', () => {
    expect(deriveMascotSignals(makeAnalysis({ goalAlignment: 'on-track' }), null).alignment).toBe('on-track')
    expect(deriveMascotSignals(makeAnalysis({ goalAlignment: 'drift' }), null).alignment).toBe('drift')
    expect(deriveMascotSignals(makeAnalysis({ goalAlignment: 'blocked' }), null).alignment).toBe('blocked')
  })

  it('is null when the analysis has no goal alignment', () => {
    expect(deriveMascotSignals(makeAnalysis(), null).alignment).toBeNull()
    expect(deriveMascotSignals(makeAnalysis({ goalAlignment: null }), null).alignment).toBeNull()
  })
})

describe('deriveMascotSignals — no event', () => {
  it('a plain on-track analysis produces no reaction and no badge', () => {
    const s = deriveMascotSignals(makeAnalysis({ goalAlignment: 'on-track' }), null)
    expect(s.reaction).toBeNull()
    expect(s.raiseAlertBadge).toBe(false)
  })

  it('a partial verdict is not a reaction', () => {
    expect(deriveMascotSignals(makeAnalysis({ verification: { status: 'partial', note: 'kind of' } }), null).reaction).toBeNull()
  })

  it('a permission prompt is not a reaction (the robot waves instead)', () => {
    expect(deriveMascotSignals(makeAnalysis({ terminalState: 'permission_prompt' }), null).reaction).toBeNull()
  })
})

describe('deriveMascotSignals — Verifier passed → jump with sparkles', () => {
  it('fires when a success verdict arrives', () => {
    expect(deriveMascotSignals(makeAnalysis({ verification: passed }), null).reaction).toBe('verify-passed')
  })

  it('fires when the verdict is patched onto the SAME analysis (re-send)', () => {
    const prev = makeAnalysis({ analyzedAt: '2026-01-01T00:01:00.000Z' })
    const current = makeAnalysis({ analyzedAt: '2026-01-01T00:01:00.000Z', verification: passed })
    expect(deriveMascotSignals(current, prev).reaction).toBe('verify-passed')
  })

  it('does not replay on a second re-send of the same analysis', () => {
    const prev = makeAnalysis({ analyzedAt: '2026-01-01T00:01:00.000Z', verification: passed })
    const current = makeAnalysis({ analyzedAt: '2026-01-01T00:01:00.000Z', verification: passed, nextPrompt: 'patched' })
    expect(deriveMascotSignals(current, prev).reaction).toBeNull()
  })

  it('fires again for a NEW analysis with its own success verdict', () => {
    const prev = makeAnalysis({ analyzedAt: '2026-01-01T00:01:00.000Z', verification: passed })
    const current = makeAnalysis({ analyzedAt: '2026-01-01T00:02:00.000Z', verification: passed })
    expect(deriveMascotSignals(current, prev).reaction).toBe('verify-passed')
  })
})

describe('deriveMascotSignals — goal complete → three jumps with confetti', () => {
  it('fires when the goal is first reached', () => {
    expect(deriveMascotSignals(makeAnalysis({ goalReached: true, verification: passed }), null).reaction).toBe('goal-complete')
  })

  it('does not replay on a re-send of the same analysis', () => {
    const prev = makeAnalysis({ goalReached: true, verification: passed })
    expect(deriveMascotSignals(makeAnalysis({ goalReached: true, verification: passed }), prev).reaction).toBeNull()
  })
})

describe('deriveMascotSignals — failed: blocked, or the Verifier fails', () => {
  it('fires failed + badge when alignment turns blocked', () => {
    const s = deriveMascotSignals(makeAnalysis({ goalAlignment: 'blocked' }), makeAnalysis({ goalAlignment: 'on-track' }))
    expect(s.reaction).toBe('failed')
    expect(s.raiseAlertBadge).toBe(true)
  })

  it('fires failed when a failed verdict arrives, and not again on a re-send', () => {
    expect(deriveMascotSignals(makeAnalysis({ verification: failedVerdict }), null).reaction).toBe('failed')
    const prev = makeAnalysis({ verification: failedVerdict })
    expect(deriveMascotSignals(makeAnalysis({ verification: failedVerdict }), prev).reaction).toBeNull()
  })

  it('does not re-fire while the analysis stays blocked', () => {
    const s = deriveMascotSignals(
      makeAnalysis({ goalAlignment: 'blocked', analyzedAt: '2026-01-01T00:02:00.000Z' }),
      makeAnalysis({ goalAlignment: 'blocked', analyzedAt: '2026-01-01T00:01:00.000Z' })
    )
    expect(s.reaction).toBeNull()
    expect(s.raiseAlertBadge).toBe(false)
  })
})

describe('deriveMascotSignals — hand-off', () => {
  it('raises the badge but plays no reaction (the robot shows "waiting")', () => {
    const s = deriveMascotSignals(makeAnalysis({ needsHumanJudgment: true }), makeAnalysis())
    expect(s.reaction).toBeNull()
    expect(s.raiseAlertBadge).toBe(true)
  })

  it('a hand-off following a blocked alignment is still the same alert (no new badge)', () => {
    const s = deriveMascotSignals(makeAnalysis({ needsHumanJudgment: true }), makeAnalysis({ goalAlignment: 'blocked' }))
    expect(s.raiseAlertBadge).toBe(false)
  })

  it('a resolved hand-off raises nothing', () => {
    const s = deriveMascotSignals(makeAnalysis({ needsHumanJudgment: true }), makeAnalysis(), () => true)
    expect(s.raiseAlertBadge).toBe(false)
  })
})

describe('deriveMascotSignals — priority when events coincide', () => {
  it('failed wins over a Verifier pass', () => {
    const s = deriveMascotSignals(makeAnalysis({ goalAlignment: 'blocked', verification: passed }), makeAnalysis())
    expect(s.reaction).toBe('failed')
    expect(s.raiseAlertBadge).toBe(true)
  })

  it('goal complete wins over a plain Verifier pass', () => {
    expect(deriveMascotSignals(makeAnalysis({ goalReached: true, verification: passed }), makeAnalysis()).reaction).toBe('goal-complete')
  })
})
