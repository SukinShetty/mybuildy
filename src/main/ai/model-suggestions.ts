// model-suggestions.ts — curated "Recommended" models and the "Suggested" tag.
// Each cloud provider has a short, hand-picked list of vision-capable CHAT
// models, best first. Only entries that are actually present in the account's
// LIVE list are marked (nothing is invented, nothing is pre-selected):
//   - curated:   shown by default in the model picker (3 to 6 models);
//   - suggested: the first curated model present — always one of the curated.
// Everything else stays behind "Show all". Providers without a list
// (local servers, custom endpoints) get no tags.
//
// Every curated entry is exercised against the real API by `npm run test:live`
// (setup check + one screen analysis). Update the list and re-run that suite
// when providers release or retire models.

import type { ModelChoice, ProviderType } from '../../renderer/src/types'

export const CURATED_MODELS: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: [
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-opus-5-5',
  ],
  openai: [
    'gpt-6-luna',
    'gpt-5.6-luna',
    'gpt-5.4-mini',
    'gpt-6-sol',
  ],
  openrouter: [
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-5.5',
    'openai/gpt-6-luna',
    'google/gemini-3.8-flash',
    'qwen/qwen3.8-flash',
  ],
  // Not yet tested live (Gemini sits under Advanced, labelled as such).
  gemini: [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash',
  ],
}

/** The curated ids that exist in this live list, in curated (best-first) order. */
export function curatedIdsPresent(provider: string, ids: readonly string[]): string[] {
  const curated = CURATED_MODELS[provider as ProviderType] ?? []
  const present = new Set(ids)
  return curated.filter((id) => present.has(id))
}

/** The model to tag "Suggested": the best curated model present, or null. */
export function pickSuggestedModelId(provider: string, ids: readonly string[]): string | null {
  return curatedIdsPresent(provider, ids)[0] ?? null
}

/**
 * Mark curated + Suggested models and put the curated ones first, in curated
 * order; the rest keep their original order behind them.
 */
export function applySuggestedTag(provider: string, models: ModelChoice[]): ModelChoice[] {
  const curated = curatedIdsPresent(provider, models.map((m) => m.id))
  if (curated.length === 0) return models
  const rank = new Map(curated.map((id, i) => [id, i]))
  const top = models
    .filter((m) => rank.has(m.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map((m) => ({ ...m, curated: true, ...(m.id === curated[0] ? { suggested: true } : {}) }))
  const rest = models.filter((m) => !rank.has(m.id))
  return [...top, ...rest]
}
