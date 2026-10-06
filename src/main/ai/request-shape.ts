// request-shape.ts — PURE token/reasoning parameters for OpenAI-style
// chat/completions requests (OpenAI, OpenRouter, LM Studio, custom endpoints).
//
// Why this exists: OpenAI's reasoning models (o-series, GPT-5 and later)
// reject `max_tokens` with HTTP 400 — they take `max_completion_tokens`, which
// covers reasoning tokens AND the visible answer. With a small budget (the
// setup check asks for ~10 tokens) the model can spend it all on reasoning and
// return an empty answer, so reasoning models get a fixed headroom on top of
// the visible budget and are asked for low reasoning effort. Every request
// path builds its limits here so no path can drift.

import type { ProviderType } from '../../renderer/src/types'

/** Extra tokens reasoning models may spend thinking before the visible answer. */
export const REASONING_HEADROOM_TOKENS = 2048

function baseModelId(modelId: string): string {
  const lower = modelId.toLowerCase()
  return lower.includes('/') ? lower.split('/').pop() ?? lower : lower
}

/** OpenAI reasoning families: o1/o3/o4…, gpt-5*, gpt-6*… — but not the non-reasoning "chat" variants. */
export function isOpenAIReasoningModel(modelId: string): boolean {
  const id = baseModelId(modelId)
  if (id.includes('chat')) return false
  return /^o\d/.test(id) || /^gpt-([5-9]|\d{2,})/.test(id)
}

/**
 * Token-limit (and reasoning) fields to spread into a chat/completions body.
 * `visibleTokens` is the budget for the answer the user sees.
 */
export function chatCompletionLimits(
  provider: ProviderType,
  modelId: string,
  visibleTokens: number
): Record<string, unknown> {
  if (provider === 'openai') {
    // max_completion_tokens is accepted by every current OpenAI chat model;
    // max_tokens is deprecated and refused by reasoning models.
    return isOpenAIReasoningModel(modelId)
      ? { max_completion_tokens: visibleTokens + REASONING_HEADROOM_TOKENS, reasoning_effort: 'low' }
      : { max_completion_tokens: visibleTokens }
  }
  if (provider === 'openrouter') {
    // OpenRouter takes max_tokens for every model and a unified `reasoning`
    // object that non-reasoning models ignore. Many of its models think by
    // default (GPT-5+, Gemini 2.5+, Qwen 3.x…), so all get headroom and low
    // effort — except Claude, where `reasoning` would TURN ON extended thinking.
    const lower = modelId.toLowerCase()
    const reasoning = !lower.startsWith('anthropic/') &&
      (!lower.startsWith('openai/') || isOpenAIReasoningModel(modelId))
    return reasoning
      ? { max_tokens: visibleTokens + REASONING_HEADROOM_TOKENS, reasoning: { effort: 'low' } }
      : { max_tokens: visibleTokens }
  }
  // Local / custom OpenAI-compatible servers: keep the widely supported field,
  // switching only for model names that are known OpenAI reasoning models.
  return isOpenAIReasoningModel(modelId)
    ? { max_completion_tokens: visibleTokens + REASONING_HEADROOM_TOKENS }
    : { max_tokens: visibleTokens }
}
