// verifier-check.ts — main process (loop engineering Block 4)
// Runs on the analysis AFTER a pending prompt-outcome exists, and judges whether
// the previously-suggested prompt achieved its expected outcome.
//
// PROVIDER: uses the SAME provider/model the user selected (via callTextCompletion).
// The one exception is a cost optimisation: on Anthropic we grade with Haiku. For
// every other provider we use the user's configured model — nothing is hardcoded
// to Anthropic. The API key is read from `settings` (main-owned), never the renderer.
//
// NON-BLOCKING: the caller fires this in parallel (like the prompt-quality grader)
// and respects the session token, so a stale-window verdict is discarded.

import type { AnalysisResult, AppSettings, Goal } from '../../renderer/src/types'
import type { PromptOutcome } from '../verifier'
import { callTextCompletion } from './text-completion'
import { debugLog } from '../debug-log'
import { reserveProviderCall } from '../cost-guard'

// Haiku is only used when the user's provider IS Anthropic (cheap grade).
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export type VerifierStatus = 'success' | 'failed' | 'partial' | 'still_pending'

export interface VerifierResult {
  status: VerifierStatus
  note: string
  correctivePrompt?: string
}

/**
 * Verify whether a pending prompt achieved its expected outcome, using the
 * current analysis as evidence. Returns 'still_pending' (keep waiting) on any
 * error or unparseable output so we never fabricate a verdict.
 */
export async function verifyPromptOutcome(
  pending: PromptOutcome,
  analysis: AnalysisResult,
  goal: Goal | null,
  memoryContext: string,
  settings: AppSettings
): Promise<VerifierResult> {
  const system =
    'You verify whether a coding prompt achieved its intended outcome, judging ONLY from the described current screen state. Respond with JSON only — no markdown, no prose.'
  const user = buildVerifierPrompt(pending, analysis, goal, memoryContext)

  try {
    // On Anthropic, grade cheaply with Haiku; otherwise use the user's own model.
    const modelOverride = settings.provider === 'anthropic' ? HAIKU_MODEL : undefined
    // Cost guard: at the hourly cap, no check is sent and the prompt stays pending.
    if (!reserveProviderCall(settings.hourlyCallCap)) {
      debugLog('[Verifier] hourly request limit reached — not checked, still pending')
      return { status: 'still_pending', note: '' }
    }
    const text = await callTextCompletion({ system, user, settings, modelOverride, maxTokens: 400 })
    const result = parseVerifierResponse(text)
    debugLog(`[Verifier] status=${result.status} note="${result.note.slice(0, 80)}"`)
    return result
  } catch (error) {
    console.warn('[Verifier] check failed — treating as still pending:', error)
    return { status: 'still_pending', note: '' }
  }
}

function buildVerifierPrompt(
  pending: PromptOutcome,
  analysis: AnalysisResult,
  goal: Goal | null,
  memoryContext: string
): string {
  return `A moment ago MyBuildy suggested this prompt for the user to paste into their coding tool:

SUGGESTED PROMPT:
${pending.promptText}

EXPECTED OUTCOME (what success looks like):
${pending.expectedOutcome}

Now, the CURRENT screen shows:
${analysis.whatIsHappening || '(nothing clearly visible)'}

${analysis.whatIsBroken?.length ? `Problems currently visible: ${analysis.whatIsBroken.join('; ')}\n` : ''}User's goal: ${goal?.purpose || '(not set)'}
Project memory:
${memoryContext || '(none yet)'}

Decide whether the expected outcome was achieved. Choose ONE status:
- "success": the expected outcome is clearly visible / achieved.
- "failed": it clearly did NOT work (errors, or the expected result is absent and something went wrong).
- "partial": some progress toward the outcome, but not fully done.
- "still_pending": you cannot yet tell from the current screen (e.g. it is still running, or the screen moved on to something unrelated).

Respond JSON only:
{
  "status": "success" | "failed" | "partial" | "still_pending",
  "note": "<one plain-English sentence for a non-technical user about what happened>",
  "correctivePrompt": "<ONLY if status is failed or partial: a concrete, paste-ready next prompt to fix or finish it; otherwise empty string>"
}`
}

/**
 * Parse the verifier model's JSON output into a VerifierResult.
 * Pure + exported for tests. Unknown/absent status → 'still_pending'.
 */
export function parseVerifierResponse(text: string): VerifierResult {
  const json = extractJson(text)
  if (!json) return { status: 'still_pending', note: '' }

  const status = normalizeStatus(json.status)
  const note = typeof json.note === 'string' ? json.note.trim() : ''
  const corrective =
    typeof json.correctivePrompt === 'string' ? json.correctivePrompt.trim() : ''

  return {
    status,
    note,
    // Corrective prompts only make sense for failed/partial.
    correctivePrompt: (status === 'failed' || status === 'partial') && corrective ? corrective : undefined,
  }
}

function normalizeStatus(value: unknown): VerifierStatus {
  if (typeof value !== 'string') return 'still_pending'
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (v === 'success' || v === 'succeeded' || v === 'done') return 'success'
  if (v === 'failed' || v === 'fail' || v === 'failure') return 'failed'
  if (v === 'partial' || v === 'partially') return 'partial'
  return 'still_pending'
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = (text || '').match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    // Tolerate trailing commas from weaker models.
    try {
      return JSON.parse(match[0].replace(/,\s*([\]}])/g, '$1')) as Record<string, unknown>
    } catch {
      return null
    }
  }
}
