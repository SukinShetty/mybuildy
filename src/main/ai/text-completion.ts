// text-completion.ts — main process
// A provider-agnostic, single-shot TEXT completion. Used by loop-engineering
// helpers (e.g. the verifier) that need a small structured judgment from the
// SAME provider/model the user selected — NOT a hardcoded provider.
//
// SECURITY: the API key comes from `settings` (main-owned, injected from the
// encrypted secure-store by memory.ts). It is never read from the renderer.
// Keys always go in headers, never the URL.

import type { AppSettings } from '../../renderer/src/types'
import { providerHttpError, readJson } from './provider-errors'
import { getProviderInfo } from './provider-registry'
import { fetchWithTimeout } from './fetch-with-timeout'
import { chatCompletionLimits } from './request-shape'

export interface TextCompletionRequest {
  system: string
  user: string
  settings: AppSettings
  /** Override the model (e.g. use Haiku on Anthropic for a cheap grade). */
  modelOverride?: string
  maxTokens?: number
  /** Optional image to include (base64). */
  imageBase64?: string | null
  /** MIME type of imageBase64 (default image/jpeg; the vision check sends a PNG). */
  imageMime?: string
}

/**
 * Run one text completion against the user's configured provider/model.
 * Returns the raw text (possibly empty). Throws on HTTP / network errors so the
 * caller can decide how to degrade.
 */
export async function callTextCompletion(req: TextCompletionRequest): Promise<string> {
  const { system, user, settings } = req
  const provider = settings.provider
  const model = req.modelOverride || settings.modelId
  const maxTokens = req.maxTokens ?? 500
  const image = req.imageBase64 || null
  const imageMime = req.imageMime || 'image/jpeg'
  const isLocal = provider === 'ollama' || provider === 'lmstudio'

  if (provider === 'anthropic') {
    const content: Array<Record<string, unknown>> = []
    if (image) {
      content.push({ type: 'image', source: { type: 'base64', media_type: imageMime, data: image } })
    }
    content.push({ type: 'text', text: user })
    const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }, isLocal)
    if (!res.ok) throw await providerHttpError(`Anthropic`, res)
    const json = await readJson<{ content?: Array<{ type: string; text?: string }> }>(res, 'Provider')
    return json.content?.find((b) => b.type === 'text')?.text || ''
  }

  if (provider === 'gemini') {
    const baseUrl = settings.baseUrl || getProviderInfo('gemini').defaultBaseUrl
    const parts: Array<Record<string, unknown>> = []
    if (image) parts.push({ inline_data: { mime_type: imageMime, data: image } })
    parts.push({ text: user })
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }
    // Key in a header, never the URL.
    const res = await fetchWithTimeout(`${baseUrl}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify(body),
    }, isLocal)
    if (!res.ok) throw await providerHttpError(`Gemini`, res)
    const json = await readJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(res, 'Provider')
    return json.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }

  // OpenAI-compatible (openai, openrouter, ollama, lmstudio, custom)
  const baseUrl = (settings.baseUrl || getProviderInfo(provider).defaultBaseUrl).replace(/\/$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/SukinShetty/mybuildy'
    headers['X-Title'] = 'MyBuildy'
  }

  // Ollama's /v1 OpenAI-compatible endpoint has patchy image_url support, so
  // its native /api/chat is used for images instead (see below).
  if (provider === 'ollama' && image) {
    const res = await fetchWithTimeout(`${(settings.baseUrl || getProviderInfo('ollama').defaultBaseUrl).replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { num_predict: maxTokens },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user, images: [image] },
        ],
      }),
    }, true)
    if (!res.ok) throw await providerHttpError(`Ollama`, res)
    const json = await readJson<{ message?: { content?: string } }>(res, 'Provider')
    return json.message?.content || ''
  }

  const userContent: Array<Record<string, unknown>> = []
  if (image) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${image}`, detail: 'high' } })
  }
  userContent.push({ type: 'text', text: user })

  const body = {
    model,
    ...chatCompletionLimits(provider, model, maxTokens),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  }
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, isLocal)
  if (!res.ok) throw await providerHttpError(`${provider}`, res)
  const json = await readJson<{ choices?: Array<{ message?: { content?: string } }> }>(res, 'Provider')
  return json.choices?.[0]?.message?.content || ''
}
