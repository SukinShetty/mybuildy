// model-fetch.ts — main process ONLY
// Fetches live model lists from each provider with the STORED key (the
// renderer never sees keys — it only asks "list models for provider X").
// Results are cached for 10 minutes per provider+baseUrl+key; the pure
// filtering lives in model-list.ts and the Suggested tag in model-suggestions.ts.

import type { AppSettings, ModelChoice, ModelListResult } from '../../renderer/src/types'
import { redactKnownSecrets } from '../secure-store'
import { providerHttpError, readJson } from './provider-errors'
import { fetchWithTimeout } from './fetch-with-timeout'
import {
  filterOpenAIModels, filterGeminiModels, filterOpenRouterModels,
  parseAnthropicModels, parseOllamaTags, parseOpenAICompatibleList,
} from './model-list'
import { applySuggestedTag } from './model-suggestions'
import { mapProviderError } from './provider-errors'
import { modelListDiagnostic } from './model-list-diagnostic'
import { keyFingerprint } from '../vision-approvals'
import { getProviderInfo } from './provider-registry'

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface CacheEntry {
  at: number
  models: ModelChoice[]
}

const cache = new Map<string, CacheEntry>()

function baseUrlFor(settings: AppSettings): string {
  const url = settings.baseUrl?.trim() || getProviderInfo(settings.provider).defaultBaseUrl
  return url.replace(/\/$/, '')
}

async function fetchJson(url: string, headers: Record<string, string>, isLocal: boolean): Promise<unknown> {
  const response = await fetchWithTimeout(url, { method: 'GET', headers }, isLocal)
  if (!response.ok) {
    throw await providerHttpError('Model list', response)
  }
  return readJson(response, 'Model list')
}

async function fetchRawModels(settings: AppSettings): Promise<ModelChoice[]> {
  const provider = settings.provider
  switch (provider) {
    case 'anthropic': {
      const json = await fetchJson('https://api.anthropic.com/v1/models?limit=1000', {
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      }, false)
      return parseAnthropicModels(json)
    }
    case 'openai': {
      const json = await fetchJson('https://api.openai.com/v1/models', {
        Authorization: `Bearer ${settings.apiKey}`,
      }, false)
      return filterOpenAIModels(json)
    }
    case 'gemini': {
      const json = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
        'x-goog-api-key': settings.apiKey,
      }, false)
      return filterGeminiModels(json)
    }
    case 'openrouter': {
      const headers: Record<string, string> = {}
      if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`
      const json = await fetchJson('https://openrouter.ai/api/v1/models', headers, false)
      return filterOpenRouterModels(json)
    }
    case 'ollama': {
      const json = await fetchJson(`${baseUrlFor(settings)}/api/tags`, {}, true)
      return parseOllamaTags(json)
    }
    case 'lmstudio':
    case 'custom': {
      const headers: Record<string, string> = {}
      if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`
      const json = await fetchJson(`${baseUrlFor(settings)}/models`, headers, true)
      return parseOpenAICompatibleList(json)
    }
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

/**
 * Live model list for the configured provider (10-minute cache). Errors come
 * back as the same plain-English strings used everywhere else.
 */
export async function fetchModelsForProvider(settings: AppSettings): Promise<ModelListResult> {
  const cacheKey = `${settings.provider}|${baseUrlFor(settings)}|${keyFingerprint(settings.apiKey)}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { models: hit.models, error: null }
  }
  try {
    const models = applySuggestedTag(settings.provider, await fetchRawModels(settings))
    cache.set(cacheKey, { at: Date.now(), models })
    return { models, error: null }
  } catch (error) {
    const diagnostic = modelListDiagnostic(error)
    console.warn('[Models] list fetch failed:', diagnostic)
    return { models: [], error: redactKnownSecrets(mapProviderError(String(error)).message), diagnostic }
  }
}
