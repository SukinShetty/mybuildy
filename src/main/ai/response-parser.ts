// response-parser.ts
// Shared response parsing for all AI providers.
// Handles JSON extraction from noisy model output, field-level type coercion,
// and brainstorm project data extraction.
//
// Models — especially smaller/local ones — often return:
//   - JSON wrapped in markdown fences (```json ... ```)
//   - Explanation text before or after the JSON
//   - Partial or missing fields
//   - String values where arrays are expected
//   - Trailing commas in JSON
//
// This parser handles all of those cases gracefully.

import type { AgentName, AnalysisResult, ExtractedProjectData, GoalAlignment, TerminalState } from '../../renderer/src/types'
import { userFacingHandoff } from '../display-consistency'

/**
 * Parse raw model output text into a structured AnalysisResult.
 * Tries multiple strategies in order: direct parse → fence-stripped parse →
 * regex JSON extraction. Falls back to a user-friendly result if everything fails.
 */
export function parseAnalysisResponse(
  rawResponseText: string,
  startTime: number
): AnalysisResult {
  const parsed = extractJSON(rawResponseText)

  if (!parsed) {
    return buildFallbackAnalysisResult(rawResponseText, startTime)
  }

  // Phase 3B backstop: ALL providers flow through here, so a nextPrompt that
  // asks the HUMAN a question is converted to a hand-off before anyone sees it.
  return routeHumanQuestionToHandoff(normalizeAnalysisResult(parsed, startTime))
}

// ─── Human-question backstop (Phase 3B) ──────────────────────────────────────
// The nextPrompt is pasted verbatim into a coding agent, so it must be an
// instruction to the AGENT — never a question for the human. These functions are
// pure (electron-free) and run as the final backstop for every provider.

/** Phrases that always mean the prompt is talking to the human, not the agent. */
const HUMAN_QUESTION_PHRASES = [
  'please clarify',
  'are you building',
  'confirm whether',
  'do you want',
]

/**
 * Heuristic: does this prompt contain a question or request directed at the
 * human user (rather than an instruction for the coding agent)?
 *
 * Flags (case-insensitive):
 *   1. Any of the trigger phrases: "please clarify", "are you building",
 *      "confirm whether", "do you want" — anywhere in the text.
 *   2. The "you…?" heuristic: the text is split into sentences at `.`, `!`, `?`
 *      (each sentence keeps its terminator; trailing quotes/brackets after the
 *      terminator are ignored). A sentence that ENDS in "?" AND contains "you",
 *      "your", or "yours" as a whole word is treated as a question to the human.
 *      A sentence mentioning "you"/"your" WITHOUT ending in "?" does not trigger
 *      (e.g. "The form validates your input server-side." is fine).
 *
 * Known limits (documented on purpose — this is a backstop, not a classifier):
 * questions that avoid both the trigger phrases and the word "you" are not
 * caught here; the strengthened system prompt and the quality grader handle
 * those upstream.
 */
export function containsHumanDirectedQuestion(prompt: string): boolean {
  const text = (prompt || '').toLowerCase()
  if (!text.trim()) return false

  if (HUMAN_QUESTION_PHRASES.some((phrase) => text.includes(phrase))) return true

  // "you…?" heuristic — sentence-level check.
  const sentences = text.match(/[^.!?]+[.!?]?/g) || []
  return sentences.some((sentence) => {
    const trimmed = sentence.trim().replace(/["')\]]+$/, '')
    return trimmed.endsWith('?') && /\b(you|your|yours)\b/.test(trimmed)
  })
}

/**
 * If the analysis's nextPrompt is directed at the human, convert the analysis to
 * a hand-off (existing Block 6 structure: needsHumanJudgment + reason) and DROP
 * the prompt entirely — the question belongs in the hand-off card, never in the
 * paste-prompt. Returns the analysis unchanged otherwise.
 */
export function routeHumanQuestionToHandoff(analysis: AnalysisResult): AnalysisResult {
  if (!containsHumanDirectedQuestion(analysis.nextPrompt || '')) return analysis

  console.log('[Prompt] routed human question to hand-off')
  return {
    ...analysis,
    nextPrompt: '',
    expectedOutcome: '',
    needsHumanJudgment: true,
    // The question itself is addressed to the user, so it can be the card text —
    // userFacingHandoff falls back when it is not a clean, short question.
    humanJudgmentReason: userFacingHandoff(
      (analysis.humanJudgmentReason || '').trim() || (analysis.nextPrompt || '').trim()
    ),
  }
}

/**
 * After a brainstorm conversation, the model may include a structured summary block.
 * This function tries to extract it.
 */
export function tryExtractProjectData(
  fullResponseText: string
): ExtractedProjectData | null {
  const summaryBlockMatch = fullResponseText.match(
    /---MYBUILDY_PROJECT_SUMMARY---([\s\S]+?)---END_MYBUILDY_PROJECT_SUMMARY---/
  )
  if (!summaryBlockMatch) return null

  const summaryBlock = summaryBlockMatch[1]

  function extractField(fieldName: string): string {
    const match = summaryBlock.match(new RegExp(`${fieldName}:\\s*(.+)`))
    return match ? match[1].trim() : ''
  }

  // FIRST_PROMPT is the last field in the block and may run long; capture
  // everything after its label to the end of the block (tolerates wrapping).
  function extractFirstPrompt(): string {
    const match = summaryBlock.match(/FIRST_PROMPT:\s*([\s\S]+?)\s*$/)
    return match ? match[1].trim() : ''
  }

  return {
    projectName: extractField('PROJECT_NAME'),
    productSummary: extractField('PRODUCT_SUMMARY'),
    targetUser: extractField('TARGET_USER'),
    coreProblem: extractField('CORE_PROBLEM'),
    brainstormSummary: extractField('MVP_FOCUS'),
    firstPrompt: extractFirstPrompt(),
  }
}

// ─── JSON extraction ─────────────────────────────────────────────────────────

/**
 * Try to extract a JSON object from noisy model output.
 * Handles markdown fences, surrounding text, and trailing commas.
 */
function extractJSON(text: string): Record<string, unknown> | null {
  // Strategy 1: direct parse (model followed instructions perfectly)
  const trimmed = text.trim()
  const directResult = tryParse(trimmed)
  if (directResult) return directResult

  // Strategy 2: strip markdown fences and try again
  const stripped = stripMarkdownFences(trimmed)
  const strippedResult = tryParse(stripped)
  if (strippedResult) return strippedResult

  // Strategy 3: find the outermost { ... } in the text
  const braceMatch = findOutermostBraces(trimmed)
  if (braceMatch) {
    const braceResult = tryParse(braceMatch)
    if (braceResult) return braceResult
  }

  return null
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Try fixing trailing commas — common in weaker model output
    const fixed = text.replace(/,\s*([\]}])/g, '$1')
    try {
      const parsed = JSON.parse(fixed)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // genuinely unparseable
    }
  }
  return null
}

/**
 * Strip markdown code fences in all common variants:
 *   ```json\n...\n```
 *   ```JSON\n...\n```
 *   ```\n...\n```
 *   ~~~json\n...\n~~~
 */
function stripMarkdownFences(text: string): string {
  // Match fenced code blocks and extract their content
  const fenceMatch = text.match(/^[`~]{3,}(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*[`~]{3,}\s*$/m)
  if (fenceMatch) return fenceMatch[1].trim()

  // If fences aren't at the boundaries, try to find them inline
  const inlineMatch = text.match(/[`~]{3,}(?:json|JSON)?\s*\n([\s\S]*?)\n\s*[`~]{3,}/)
  if (inlineMatch) return inlineMatch[1].trim()

  return text
}

/**
 * Find the outermost matched { ... } in the text.
 * Uses brace counting rather than greedy regex to handle nested objects correctly.
 */
function findOutermostBraces(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (char === '\\' && inString) {
      escapeNext = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

// ─── Field normalization ─────────────────────────────────────────────────────

/**
 * Normalize a parsed JSON object into a valid AnalysisResult.
 * Coerces types: strings become single-element arrays where arrays are expected,
 * missing fields get safe defaults.
 */
function normalizeAnalysisResult(
  parsed: Record<string, unknown>,
  startTime: number
): AnalysisResult {
  return {
    screenContentVisible: toBool(parsed.screenContentVisible, false),
    whatIsHappening: toStr(parsed.whatIsHappening, ''),
    whatItMeans: toStr(parsed.whatItMeans, ''),
    whatIsBuilt: toStrArray(parsed.whatIsBuilt),
    whatIsMissing: toStrArray(parsed.whatIsMissing),
    whatIsBroken: toStrArray(parsed.whatIsBroken),
    whereUserIsStuck: parsed.whereUserIsStuck != null ? toStr(parsed.whereUserIsStuck, null) : null,
    bestNextMove: toStr(parsed.bestNextMove, ''),
    nextPrompt: toStr(parsed.nextPrompt, ''),
    expectedOutcome: parsed.expectedOutcome != null ? toStr(parsed.expectedOutcome, '') : undefined,
    builderNote: toStr(parsed.builderNote, ''),
    goalAlignment: toGoalAlignment(parsed.goalAlignment),
    alignmentNote: parsed.alignmentNote != null ? toStr(parsed.alignmentNote, '') : undefined,
    projectUnderstandingNote: parsed.projectUnderstandingNote != null ? toStr(parsed.projectUnderstandingNote, '') : undefined,
    isCriticalOverride: toBool(parsed.isCriticalOverride, false),
    needsHumanJudgment: toBool(parsed.needsHumanJudgment, false),
    humanJudgmentReason: parsed.humanJudgmentReason != null ? toStr(parsed.humanJudgmentReason, '') : undefined,
    terminalState: toTerminalState(parsed.terminalState),
    agentName: toAgentName(parsed.agentName),
    analyzedAt: new Date().toISOString(),
    analysisDurationMs: Date.now() - startTime,
  }
}

/**
 * Coerce a value to a valid AgentName; 'other' when absent/unrecognized.
 * Tolerates minor model variations like "Claude Code", "claude-code", or
 * "Codex CLI".
 */
export function toAgentName(value: unknown): AgentName {
  if (typeof value !== 'string') return 'other'
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'claude_code' || normalized === 'claudecode' || normalized === 'claude') {
    return 'claude_code'
  }
  if (normalized === 'codex' || normalized === 'codex_cli' || normalized === 'codexcli') {
    return 'codex'
  }
  return 'other'
}

/**
 * Coerce a value to a valid TerminalState; 'unknown' when absent/unrecognized.
 * Tolerates minor model variations like "awaiting-prompt" or "Awaiting Prompt".
 */
function toTerminalState(value: unknown): TerminalState {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'awaiting_prompt') return 'awaiting_prompt'
  if (normalized === 'working') return 'working'
  if (normalized === 'permission_prompt') return 'permission_prompt'
  if (normalized === 'not_a_coding_agent') return 'not_a_coding_agent'
  return 'unknown'
}

/**
 * Coerce a value to a valid GoalAlignment, or null if absent/unrecognized.
 * Tolerates minor model variations like "on track" or "ontrack".
 */
function toGoalAlignment(value: unknown): GoalAlignment | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (normalized === 'on-track' || normalized === 'ontrack') return 'on-track'
  if (normalized === 'drift' || normalized === 'drifting') return 'drift'
  if (normalized === 'blocked') return 'blocked'
  return null
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function toStr(value: unknown, fallback: string | null): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback ?? ''
  return String(value)
}

/**
 * Coerce a value to a string array.
 * Handles: actual arrays, single strings, null/undefined, numbers.
 */
function toStrArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

// ─── Fallback ────────────────────────────────────────────────────────────────

function buildFallbackAnalysisResult(rawText: string, startTime: number): AnalysisResult {
  return {
    screenContentVisible: false,
    // Never the raw answer (it can be half a JSON object): plain words only.
    whatIsHappening: "MyBuildy couldn't read the AI's answer this time.",
    whatItMeans: 'Nothing is wrong with your project — the answer came back incomplete.',
    whatIsBuilt: [],
    whatIsMissing: [],
    whatIsBroken: [],
    whereUserIsStuck: null,
    bestNextMove: 'Look again: click Analyze Now in the Guidance tab, or wait — while watching, MyBuildy looks again by itself.',
    nextPrompt: '',
    builderNote: 'No worries — sometimes it takes a second try!',
    terminalState: 'unknown',
    agentName: 'other',
    analyzedAt: new Date().toISOString(),
    analysisDurationMs: Date.now() - startTime,
  }
}
