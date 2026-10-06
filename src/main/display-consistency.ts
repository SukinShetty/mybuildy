// display-consistency.ts — pure, last-step clean-up of an analysis before the
// guidance panel shows it. Applied by the analysis loop to every display (first
// show and every patch-and-resend), so both rules hold whichever pass produced
// the text.
//
//   1. Hand-off text is a short question or decision addressed to the user —
//      at most two sentences, never checker reasoning, criterion numbers or
//      quotes of memory / internal state. Anything else becomes HANDOFF_FALLBACK.
//   2. One status: when the Verifier says the last step was only partial or
//      failed, no headline or note may claim the goal is reached.

import type { AnalysisResult, VerificationStatus } from '../renderer/src/types'
import { HANDOFF_FALLBACK } from '../renderer/src/handoff'

export { HANDOFF_FALLBACK }

const MAX_HANDOFF_CHARS = 240

// Words that only appear when the checker (or the analysis model) is explaining
// itself rather than talking to the user.
const INTERNAL_WORDS =
  /criteri|grader|checker|\bprompt\b|\bmemory\b|redundan|violat|implicit|\bjson\b|nextPrompt|internal state|human[- ]directed|addressed to the/i

// A quoted phrase: straight or curly double quotes, or a single-quoted phrase
// (an apostrophe inside a word, as in "don't", is not a quote).
const QUOTED = /["“”„]|(^|[\s(])['‘][^'’]+['’](?=[\s.,;:!?)]|$)/

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * The text the hand-off card may show: the candidate if it is a clean, short
 * question or decision for the user, otherwise the fallback.
 */
export function userFacingHandoff(candidate: string | null | undefined): string {
  const text = (candidate || '').replace(/\s+/g, ' ').trim()
  if (!text) return HANDOFF_FALLBACK
  if (text.length > MAX_HANDOFF_CHARS) return HANDOFF_FALLBACK
  if (INTERNAL_WORDS.test(text) || QUOTED.test(text)) return HANDOFF_FALLBACK
  if (sentences(text).length > 2) return HANDOFF_FALLBACK
  // Addressed to the user: a question, or a sentence that speaks to "you".
  if (!/\?$/.test(text) && !/\byou(r|'re|'ll)?\b/i.test(text)) return HANDOFF_FALLBACK
  return text
}

// "reached/achieved/met your goal", "goal is reached", "goal complete", …
const GOAL_REACHED = [
  /\b(reached|achieved|met|hit|accomplished|completed|finished)\s+(your|the|our|this)\s+(\w+\s+)?goal\b/i,
  /\bgoal\s+(is|has been|was|now)\s+(now\s+)?(reached|achieved|met|complete|completed|done|accomplished)\b/i,
  /\bgoal\s+(reached|achieved|met|complete|completed|accomplished)\b/i,
]

export function claimsGoalReached(text: string | null | undefined): boolean {
  return !!text && GOAL_REACHED.some((re) => re.test(text))
}

const NOT_YET: Record<Exclude<VerificationStatus, 'success'>, string> = {
  partial: 'Part of the last step worked, but the goal is not reached yet.',
  failed: "The last step didn't work, so the goal is not reached yet.",
}

const TEXT_FIELDS = ['whatIsHappening', 'whatItMeans', 'bestNextMove', 'builderNote', 'alignmentNote'] as const

/** Drop the sentences that claim the goal is reached; fall back when nothing is left. */
function withoutGoalClaim(text: string, fallback: string): string {
  const kept = sentences(text).filter((s) => !claimsGoalReached(s)).join(' ')
  return kept || fallback
}

/**
 * Make the analysis agree with its Verifier verdict: on partial or failed, strip
 * every "goal reached" claim from the headline and notes. The badge shows the
 * verdict and the pill shows alignment (on track / drifting / blocked) — neither
 * can say "reached" — so after this the three always agree.
 */
export function reconcileWithVerdict(analysis: AnalysisResult): AnalysisResult {
  const status = analysis.verification?.status
  if (status !== 'partial' && status !== 'failed') return analysis
  const fallback = NOT_YET[status]
  let out = analysis
  for (const field of TEXT_FIELDS) {
    const value = analysis[field]
    if (typeof value === 'string' && claimsGoalReached(value)) {
      out = { ...out, [field]: withoutGoalClaim(value, field === 'alignmentNote' ? '' : fallback) }
    }
  }
  return out
}

/**
 * The goal counts as complete only when the Verifier passed AND the analysis
 * says so — a model's claim alone never sets it, and nothing set while blocked.
 */
export function isGoalReached(analysis: AnalysisResult): boolean {
  if (analysis.verification?.status !== 'success' || analysis.goalAlignment === 'blocked') return false
  return TEXT_FIELDS.some((field) => claimsGoalReached(analysis[field]))
}

/** Everything the panel shows goes through here (first display and every patch). */
export function prepareForDisplay(analysis: AnalysisResult): AnalysisResult {
  let out = reconcileWithVerdict(analysis)
  const goalReached = isGoalReached(out)
  if (!!out.goalReached !== goalReached) out = { ...out, goalReached }
  if (out.needsHumanJudgment) {
    const text = userFacingHandoff(out.humanJudgmentReason)
    if (text !== out.humanJudgmentReason) out = { ...out, humanJudgmentReason: text }
  }
  return out
}
