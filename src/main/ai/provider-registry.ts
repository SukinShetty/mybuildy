// provider-registry.ts
// Factory that maps a ProviderType to the correct AIProvider instance.
// Also exports the full list of provider info for the Settings UI.

import type { ProviderType } from '../../renderer/src/types'
import type { AIProvider, ProviderInfo } from './provider-interface'
import { AnthropicProvider, anthropicProviderInfo } from './providers/anthropic'
import {
  OpenAICompatibleProvider,
  openaiProviderInfo,
  openrouterProviderInfo,
  lmstudioProviderInfo,
  customProviderInfo,
} from './providers/openai-compatible'
import { GeminiProvider, geminiProviderInfo } from './providers/gemini'
import { OllamaProvider, ollamaProviderInfo } from './providers/ollama'
import { e2eFakes, fakeAnalyzeScreen } from '../e2e-fakes'

/**
 * Get the AIProvider instance for a given provider type.
 */
export function getProvider(providerType: ProviderType): AIProvider {
  const provider = realProvider(providerType)
  // e2e only (e2e-fakes.ts): a watch started by the setup wizard test gets a
  // canned analysis — no provider is ever called.
  if (e2eFakes()) return Object.assign(Object.create(provider) as AIProvider, { analyzeScreen: fakeAnalyzeScreen })
  return provider
}

function realProvider(providerType: ProviderType): AIProvider {
  switch (providerType) {
    case 'anthropic':
      return new AnthropicProvider()
    case 'openai':
      return new OpenAICompatibleProvider(openaiProviderInfo)
    case 'gemini':
      return new GeminiProvider()
    case 'openrouter':
      return new OpenAICompatibleProvider(openrouterProviderInfo)
    case 'ollama':
      return new OllamaProvider()
    case 'lmstudio':
      return new OpenAICompatibleProvider(lmstudioProviderInfo)
    case 'custom':
      return new OpenAICompatibleProvider(customProviderInfo)
    default:
      throw new Error(`Unknown AI provider: ${providerType}`)
  }
}

/**
 * All available provider metadata — used by the Settings UI to render
 * provider cards, model pickers, and capability badges.
 */
export const allProviderInfos: ProviderInfo[] = [
  anthropicProviderInfo,
  openaiProviderInfo,
  geminiProviderInfo,
  openrouterProviderInfo,
  ollamaProviderInfo,
  lmstudioProviderInfo,
  customProviderInfo,
]

/**
 * Get provider info by type.
 */
export function getProviderInfo(providerType: ProviderType): ProviderInfo {
  const info = allProviderInfos.find((p) => p.type === providerType)
  if (!info) throw new Error(`Unknown AI provider: ${providerType}`)
  return info
}
