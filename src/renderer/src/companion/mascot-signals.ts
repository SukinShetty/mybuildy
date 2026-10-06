// mascot-signals.ts
// Pure mapping from an incoming AnalysisResult (plus the previously seen one)
// to robot signals: alignment glow, a one-off reaction, and whether to raise
// the "!" alert badge. Kept free of React/assets so it unit-tests cleanly.
// The ongoing animation (idle, review, waving, …) is chosen separately, from
// the current situation, by robot-animation.ts.
//
// Event semantics:
//   - Reactions fire on TRANSITIONS, not on every analysis, so a blocked state
//     that persists across cycles doesn't replay "failed" every 30 seconds.
//   - The main process re-sends the SAME analysis (same analyzedAt) when a
//     background pass patches it (verifier verdict, grader-improved prompt —
//     see patchDisplayAndResend in analysis-loop.ts). A verdict fires when it
//     first appears, and never again for that analysis.
//   - When several events coincide, one reaction plays:
//     failed > goal complete > Verifier passed.
//   - Hand-offs raise the badge but are not a reaction: the robot shows the
//     ongoing "waiting" state while the decision card is open.
//   - A hand-off the user already answered or dismissed (isResolved) no longer
//     counts: it raises no badge, however often it is re-sent.

import type { AnalysisResult, VerificationStatus } from '../types'
import type { RobotReaction } from './robot-animation'

/** Goal alignment drives the glow colour while watching. */
export type MascotAlignment = 'on-track' | 'drift' | 'blocked'

export interface MascotSignals {
  /** Glow colour while watching: on-track green, drift amber, blocked red. */
  alignment: MascotAlignment | null
  /** One-off reaction to play (the caller times it), or null. */
  reaction: RobotReaction | null
  /** True when a NEW blocked/hand-off alert should raise the "!" badge. */
  raiseAlertBadge: boolean
}

/** BLOCKED alignment and unresolved hand-off moments share one alert badge. */
function isAlert(a: AnalysisResult, isResolved: (a: AnalysisResult) => boolean): boolean {
  return a.goalAlignment === 'blocked' || (!!a.needsHumanJudgment && !isResolved(a))
}

/** A verdict counts once: on a new analysis, or when first patched onto the shown one. */
function newVerdict(current: AnalysisResult, previous: AnalysisResult | null, status: VerificationStatus): boolean {
  if (current.verification?.status !== status) return false
  const alreadySeen = previous !== null && previous.analyzedAt === current.analyzedAt &&
    previous.verification?.status === status
  return !alreadySeen
}

export function deriveMascotSignals(
  current: AnalysisResult,
  previous: AnalysisResult | null,
  isResolved: (a: AnalysisResult) => boolean = () => false
): MascotSignals {
  const newAlert = isAlert(current, isResolved) && (previous === null || !isAlert(previous, isResolved))
  const newBlocked = current.goalAlignment === 'blocked' && previous?.goalAlignment !== 'blocked'
  const newGoalReached = !!current.goalReached &&
    !(previous !== null && previous.analyzedAt === current.analyzedAt && previous.goalReached)

  const reaction: RobotReaction | null =
    newBlocked || newVerdict(current, previous, 'failed') ? 'failed'
    : newGoalReached ? 'goal-complete'
    : newVerdict(current, previous, 'success') ? 'verify-passed'
    : null

  return {
    alignment: current.goalAlignment ?? null,
    reaction,
    raiseAlertBadge: newAlert,
  }
}
