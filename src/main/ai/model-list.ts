// model-list.ts — PURE model-list filtering per provider.
// Takes the raw JSON each provider's model-list endpoint returns and produces
// the ModelChoice[] the Settings UI renders. No fetching here (see
// model-fetch.ts) — these functions are unit-tested against recorded fixtures.

import type { ModelChoice } from '../../renderer/src/types'

// ─── OpenAI ──────────────────────────────────────────────────────────────────

// Ids containing any of these are not vision chat models usable through
// chat/completions (speech, image, embedding, audio, search, completion-only,
// Responses-only "pro"/codex/deep-research models) — drop them.
export const OPENAI_EXCLUDED_SUBSTRINGS = [
  'embedding', 'tts', 'whisper', 'transcribe', 'dall-e', 'image',
  'moderation', 'audio', 'realtime', 'live', 'translate', 'search',
  'instruct', 'babbage', 'davinci', 'codex', 'sora', 'deep-research',
  'computer-use',
] as const

// Responses-only "pro" models and text-only legacy models (no image input).
const OPENAI_EXCLUDED_PATTERNS = [/-pro(-|$)/, /^gpt-3\.5/, /^gpt-4(-\d{4})?$/, /^o3-mini/, /^o1-mini/]

/** GET https://api.openai.com/v1/models → chat-capable models only. */
export function filterOpenAIModels(json: unknown): ModelChoice[] {
  const data = (json as { data?: Array<{ id?: unknown }> } | null)?.data
  if (!Array.isArray(data)) return []
  const out: ModelChoice[] = []
  for (const entry of data) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (!id) continue
    const lower = id.toLowerCase()
    if (OPENAI_EXCLUDED_SUBSTRINGS.some((s) => lower.includes(s))) continue
    if (OPENAI_EXCLUDED_PATTERNS.some((p) => p.test(lower))) continue
    out.push({ id, label: id })
  }
  return out
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

/**
 * GET https://generativelanguage.googleapis.com/v1beta/models →
 * keep models whose supportedGenerationMethods includes generateContent;
 * drop embedding/aqa models. The "models/" name prefix is stripped.
 */
export function filterGeminiModels(json: unknown): ModelChoice[] {
  const models = (json as {
    models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }>
  } | null)?.models
  if (!Array.isArray(models)) return []
  const out: ModelChoice[] = []
  for (const entry of models) {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    if (!name) continue
    const id = name.replace(/^models\//, '')
    const lower = id.toLowerCase()
    if (lower.includes('embedding') || lower === 'aqa' || lower.includes('aqa-')) continue
    if (/(image|tts|audio|live|lyria|veo|imagen)/.test(lower)) continue
    const methods = Array.isArray(entry.supportedGenerationMethods)
      ? (entry.supportedGenerationMethods as unknown[])
      : []
    if (!methods.includes('generateContent')) continue
    const label = typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : id
    out.push({ id, label })
  }
  return out
}

// ─── OpenRouter ──────────────────────────────────────────────────────────────

export const OPEN_WEIGHT_GROUP = 'Open-weight models'
export const OTHER_GROUP = 'Other models'

// Id prefixes that mark an open-weight model (grouped FIRST in the picker).
export const OPEN_WEIGHT_PREFIXES = [
  'meta-llama/', 'qwen/', 'mistralai/', 'google/gemma', 'microsoft/phi',
  'nvidia/', 'z-ai/', 'moonshotai/', 'allenai/',
] as const

function isOpenWeightId(id: string): boolean {
  return OPEN_WEIGHT_PREFIXES.some((p) => id.startsWith(p))
}

function perMillion(raw: unknown): number | null {
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return null
  return n * 1_000_000
}

/**
 * GET https://openrouter.ai/api/v1/models → ONLY models whose
 * architecture.input_modalities includes "image" (the screenshot is always
 * sent, so text-only models are useless here). Open-weight models are grouped
 * first; prices are mapped to $ per million tokens.
 */
export function filterOpenRouterModels(json: unknown): ModelChoice[] {
  const data = (json as {
    data?: Array<{
      id?: unknown
      name?: unknown
      architecture?: { input_modalities?: unknown }
      pricing?: { prompt?: unknown; completion?: unknown }
    }>
  } | null)?.data
  if (!Array.isArray(data)) return []

  const openWeight: ModelChoice[] = []
  const other: ModelChoice[] = []
  for (const entry of data) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (!id) continue
    const modalities = Array.isArray(entry.architecture?.input_modalities)
      ? (entry.architecture!.input_modalities as unknown[])
      : []
    if (!modalities.includes('image')) continue
    // Batch-only variants, image/music generators and safety classifiers are
    // not chat models MyBuildy can use.
    if (id.includes(':batch') || /(image|lyria|guard)/.test(id.toLowerCase())) continue
    const choice: ModelChoice = {
      id,
      label: typeof entry.name === 'string' && entry.name ? entry.name : id,
      group: isOpenWeightId(id) ? OPEN_WEIGHT_GROUP : OTHER_GROUP,
      promptPricePerM: perMillion(entry.pricing?.prompt),
      completionPricePerM: perMillion(entry.pricing?.completion),
    }
    ;(isOpenWeightId(id) ? openWeight : other).push(choice)
  }
  return [...openWeight, ...other]
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

/** GET https://api.anthropic.com/v1/models → every listed model. */
export function parseAnthropicModels(json: unknown): ModelChoice[] {
  const data = (json as { data?: Array<{ id?: unknown; display_name?: unknown }> } | null)?.data
  if (!Array.isArray(data)) return []
  const out: ModelChoice[] = []
  for (const entry of data) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (!id) continue
    const label = typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : id
    out.push({ id, label })
  }
  return out
}

// ─── Ollama / OpenAI-compatible local servers ────────────────────────────────

/** GET {baseUrl}/api/tags → installed Ollama models. */
export function parseOllamaTags(json: unknown): ModelChoice[] {
  const models = (json as { models?: Array<{ name?: unknown }> } | null)?.models
  if (!Array.isArray(models)) return []
  const out: ModelChoice[] = []
  for (const entry of models) {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    if (name) out.push({ id: name, label: name })
  }
  return out
}

/** GET {baseUrl}/models (LM Studio / custom endpoints) → unfiltered id list. */
export function parseOpenAICompatibleList(json: unknown): ModelChoice[] {
  const data = (json as { data?: Array<{ id?: unknown }> } | null)?.data
  if (!Array.isArray(data)) return []
  const out: ModelChoice[] = []
  for (const entry of data) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (id) out.push({ id, label: id })
  }
  return out
}
