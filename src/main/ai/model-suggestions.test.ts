// model-suggestions.test.ts
// Curated "Recommended" models: only ever applied to models actually present
// in the live list; the Suggested model is always one of the curated ones.

import { describe, it, expect } from 'vitest'
import { CURATED_MODELS, pickSuggestedModelId, applySuggestedTag } from './model-suggestions'
import type { ModelChoice } from '../../renderer/src/types'

const NOT_CHAT = /(tts|whisper|transcribe|embedding|image|audio|realtime|search|instruct|moderation|dall-e|sora|codex|lyria)/

describe('CURATED_MODELS', () => {
  it('lists 3 to 6 models for each cloud provider', () => {
    for (const p of ['anthropic', 'openai', 'openrouter', 'gemini'] as const) {
      const list = CURATED_MODELS[p] ?? []
      expect(list.length, p).toBeGreaterThanOrEqual(3)
      expect(list.length, p).toBeLessThanOrEqual(6)
    }
  })

  it('never lists a speech, image, embedding, audio, search or completion-only model', () => {
    for (const list of Object.values(CURATED_MODELS)) {
      for (const id of list ?? []) expect(id, id).not.toMatch(NOT_CHAT)
    }
  })
})

describe('pickSuggestedModelId', () => {
  it('picks the best curated model present on the account', () => {
    expect(pickSuggestedModelId('openai', ['gpt-4o', 'gpt-5.4-mini', 'gpt-6-luna', 'gpt-4o-mini-tts'])).toBe('gpt-6-luna')
    expect(pickSuggestedModelId('openai', ['gpt-4o-mini', 'gpt-5.4-mini'])).toBe('gpt-5.4-mini')
  })

  it('never suggests a model the curated list does not contain', () => {
    expect(pickSuggestedModelId('openai', ['gpt-realtime-2.1-mini', 'gpt-4o-mini-tts', 'gpt-image-1-mini'])).toBeNull()
  })

  it('returns null when nothing curated is present, or the provider has no list', () => {
    expect(pickSuggestedModelId('anthropic', ['claude-instant-1'])).toBeNull()
    expect(pickSuggestedModelId('ollama', ['llava:latest'])).toBeNull()
  })
})

describe('applySuggestedTag', () => {
  it('puts curated models first in curated order, tags exactly one Suggested, keeps the rest behind', () => {
    const models: ModelChoice[] = [
      { id: 'gpt-4o-mini-tts', label: 'tts' },
      { id: 'gpt-5.4-mini', label: '5.4 mini' },
      { id: 'gpt-6-luna', label: '6 luna' },
      { id: 'gpt-5', label: '5' },
    ]
    const tagged = applySuggestedTag('openai', models)
    expect(tagged.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.4-mini', 'gpt-4o-mini-tts', 'gpt-5'])
    expect(tagged.filter((m) => m.suggested).map((m) => m.id)).toEqual(['gpt-6-luna'])
    expect(tagged.filter((m) => m.curated).map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.4-mini'])
  })

  it('leaves a list with nothing curated untouched', () => {
    const models: ModelChoice[] = [{ id: 'llava', label: 'llava' }]
    expect(applySuggestedTag('ollama', models)).toBe(models)
  })
})
