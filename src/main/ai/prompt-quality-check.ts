// prompt-quality-check.ts — main process
// Part C, Intelligence Fix 2: a fast, cheap SECOND-PASS grader for the
// suggestedPrompt (nextPrompt) field of an analysis.
//
// It asks Haiku 4.5 — fast + cheap — to grade the prompt against the user's goal
// and project memory. If the prompt is weak and Haiku can improve it, we swap in
// the improved version; if it's weak with no fix, we blank it and explain.
//
// CRITICAL: this NEVER blocks the main analysis flow. The caller fires it AFTER
// the analysis is already on screen, then patches the prompt if the grade comes
// back. If the grader call fails or the provider isn't usable, we return
// { valid: true } so the original prompt is kept untouched.

import type { AnalysisResult, AppSettings, Goal } from '../../renderer/src/types'
import { readJson } from './provider-errors'
import { userFacingHandoff } from '../display-consistency'
import { fetchWithTimeout } from './fetch-with-timeout'
import { debugLog } from '../debug-log'
import { recordProviderCall } from '../cost-guard'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface PromptQualityResult {
  valid: boolean
  reason?: string
  improvedPrompt?: string
  // Phase 3B: true when the prompt contains a question/request directed at the
  // HUMAN instead of an instruction for the coding agent. A human-directed
  // prompt is always dropped and converted to a hand-off — never "improved".
  humanDirected?: boolean
  // The hand-off card's text for a humanDirected verdict: a short question or
  // decision for the user. Generated separately from `reason`, which is the
  // grader's own reasoning and is only ever written to the debug log.
  userQuestion?: string
}

/**
 * Grade (and optionally improve) an analysis's suggested prompt.
 * Returns { valid: true } unchanged on any error so the caller keeps the original.
 */
export async function checkPromptQuality(
  analysis: AnalysisResult,
  memoryContext: string,
  goal: Goal | null,
  settings: AppSettings
): Promise<PromptQualityResult> {
  const prompt = (analysis.nextPrompt || '').trim()
  if (!prompt) {
    // Nothing to grade — the model already decided no prompt was appropriate.
    return { valid: true }
  }

  const graderSystem =
    'You are a prompt quality grader. Respond with JSON only, no markdown, no prose.'
  const graderUser = buildGraderPrompt(prompt, memoryContext, goal)

  try {
    const text = await callGrader(graderSystem, graderUser, settings)
    if (!text) return { valid: true }

    const json = extractJson(text)
    if (!json) {
      console.warn('[PromptQuality] Grader returned unparseable output — keeping original')
      return { valid: true }
    }

    const humanDirected = json.humanDirected === true
    // A human-directed prompt is NEVER valid, whatever the grader's overall verdict.
    const valid = json.valid !== false && !humanDirected
    const improved = typeof json.improvedPrompt === 'string' ? json.improvedPrompt.trim() : ''
    const userQuestion = typeof json.userQuestion === 'string' ? json.userQuestion.trim() : ''
    debugLog(`[PromptQuality] valid=${valid} humanDirected=${humanDirected} reason="${json.reason || ''}" improved=${improved ? 'yes' : 'no'}`)
    return {
      valid,
      reason: typeof json.reason === 'string' ? json.reason : undefined,
      improvedPrompt: improved || undefined,
      humanDirected: humanDirected || undefined,
      userQuestion: userQuestion || undefined,
    }
  } catch (error) {
    console.warn('[PromptQuality] Grader error — keeping original prompt:', error)
    return { valid: true }
  }
}

/**
 * Pure policy: turn a grader verdict into the display patch (Phase 3B).
 *
 *   - humanDirected → the analysis also becomes a hand-off (Block 6):
 *     needsHumanJudgment is set, and the prompt is KEPT (never blank a prompt
 *     already on screen; deferring the decision must leave it usable). The card shows only the grader's userQuestion (cleaned by
 *     userFacingHandoff) — never its reasoning, which stays in the debug log. An improvedPrompt is deliberately IGNORED here — a prompt that
 *     asked the human a question must not be silently rewritten into an
 *     instruction the user never approved.
 *   - invalid with an improvedPrompt → swap in the improved prompt.
 *   - invalid with no improvement → blank the prompt and explain.
 *   - valid → null (nothing to patch).
 */
export function buildQualityPatch(
  analysis: AnalysisResult,
  result: PromptQualityResult
): Partial<AnalysisResult> | null {
  if (result.humanDirected) {
    // The prompt is KEPT: it may already be on screen, and deferring the
    // decision ("I'll decide" / "Skip for now") must never take it away.
    // The decision card is shown alongside it.
    return {
      needsHumanJudgment: true,
      humanJudgmentReason: userFacingHandoff(
        (result.userQuestion || '').trim() || (analysis.humanJudgmentReason || '').trim()
      ),
    }
  }
  if (result.valid) return null
  if (result.improvedPrompt) return { nextPrompt: result.improvedPrompt }
  // The grader's reason is its own reasoning — debug log only, never shown.
  return {
    nextPrompt: '',
    alignmentNote: analysis.alignmentNote || 'No high-quality next prompt right now.',
  }
}

/**
 * Pure: does this quality patch DROP the displayed prompt (empty it) rather than
 * improve it? When true, the caller must also retract the pending verifier
 * outcome recorded for the original suggestion — otherwise the next cycle would
 * "verify" a prompt that was never kept on screen or sent.
 */
export function patchDropsPrompt(patch: Partial<AnalysisResult> | null): boolean {
  return !!patch && 'nextPrompt' in patch && !(patch.nextPrompt || '').trim()
}

function buildGraderPrompt(prompt: string, memoryContext: string, goal: Goal | null): string {
  return `You are a prompt quality grader. Grade this suggested next prompt for a non-technical builder using Claude Code:

1. Is it specific to the user's project? (not generic)
2. Is it ONE concrete action?
3. Does it align with the user's goal?
4. Does it reference things from project memory correctly?
5. Is it non-redundant (does not suggest already-completed work)?
6. Is it addressed to the CODING AGENT only? It must be a direct instruction the agent can execute. It FAILS this criterion if it contains ANY question or request directed at the human user — e.g. "please clarify", "do you want", "are you building", "confirm whether", or any question addressed to "you". Set "humanDirected" to true when it fails this criterion.

User's goal: ${goal?.purpose || '(not set)'}
Project memory:
${memoryContext || '(none yet)'}

Suggested prompt: ${prompt}

Respond JSON only:
{
  "valid": true/false,
  "humanDirected": true/false — true when the prompt asks the human a question or requests a decision/clarification from the human (criterion 6),
  "reason": "<why if not valid>",
  "improvedPrompt": "<rewritten prompt if you can improve it, otherwise empty string>",
  "userQuestion": "<ONLY when humanDirected is true: the question or decision for the user, in plain English, at most two short sentences, spoken directly to them (e.g. 'Tests pass. Want to open the app in your browser and check the Invoices screen before saving your work?'). Never mention criteria, grading, the prompt or project memory, and never quote anything. Otherwise empty string>"
}`
}

/**
 * Call the grader. Prefers Haiku via the Anthropic API (incl. proxy mode). If the
 * configured provider is not Anthropic we fall back to the user's analysis model
 * via the same Anthropic-style call ONLY when an Anthropic key exists; otherwise
 * we skip (return '') so the original prompt is kept.
 */
async function callGrader(
  system: string,
  user: string,
  settings: AppSettings
): Promise<string> {
  // The grader uses the Anthropic Messages shape (Haiku). Only run it when the
  // configured provider is Anthropic and a key is present; otherwise skip and keep
  // the original prompt. (Worker proxy mode removed in v1.)
  if (settings.provider !== 'anthropic') {
    console.log('[PromptQuality] Non-Anthropic provider — skipping grader')
    return ''
  }
  if (!settings.apiKey) {
    console.log('[PromptQuality] No Anthropic API key — skipping grader')
    return ''
  }

  const model = HAIKU_MODEL
  const url = 'https://api.anthropic.com/v1/messages'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
  }

  const body = {
    model,
    max_tokens: 500,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  }

  recordProviderCall() // cost guard: grader call
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (response.status === 404) {
    // Grader model not available on this account — skip grading entirely so
    // the analysis proceeds ungraded (never fail the analysis over the grader).
    console.warn('[PromptQuality] Grader model not found (404) — skipping grading')
    return ''
  }
  if (!response.ok) {
    console.warn(`[PromptQuality] Grader HTTP ${response.status} — skipping`)
    return ''
  }
  const json = await readJson<{ content?: Array<{ type: string; text?: string }> }>(response, 'Anthropic')
  return json.content?.find((b) => b.type === 'text')?.text || ''
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return null
  }
}
