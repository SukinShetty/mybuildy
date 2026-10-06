import { describe, it, expect } from 'vitest'
import { chatCompletionLimits, isOpenAIReasoningModel, REASONING_HEADROOM_TOKENS } from './request-shape'

describe('isOpenAIReasoningModel', () => {
  it('recognises o-series, GPT-5 and GPT-6 families', () => {
    for (const id of ['o1', 'o3', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'openai/gpt-6-luna']) {
      expect(isOpenAIReasoningModel(id), id).toBe(true)
    }
  })

  it('leaves older and chat variants alone', () => {
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-chat-latest', 'gpt-5.2-chat-latest', 'claude-sonnet-5-5']) {
      expect(isOpenAIReasoningModel(id), id).toBe(false)
    }
  })
})

describe('chatCompletionLimits', () => {
  it('openai never sends max_tokens (GPT-5 family rejects it with HTTP 400)', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-6-luna', 'gpt-4.1-mini', 'gpt-4o-mini']) {
      expect(chatCompletionLimits('openai', id, 10)).not.toHaveProperty('max_tokens')
    }
  })

  it('openai reasoning models get headroom and low effort, so a 10-token check is not starved', () => {
    expect(chatCompletionLimits('openai', 'gpt-5-mini', 10)).toEqual({
      max_completion_tokens: 10 + REASONING_HEADROOM_TOKENS,
      reasoning_effort: 'low',
    })
  })

  it('openai non-reasoning models get exactly the visible budget', () => {
    expect(chatCompletionLimits('openai', 'gpt-4.1-mini', 1500)).toEqual({ max_completion_tokens: 1500 })
  })

  it('openrouter gives thinking models headroom and low effort, but never turns thinking on for Claude', () => {
    expect(chatCompletionLimits('openrouter', 'openai/gpt-6-luna', 800)).toEqual({
      max_tokens: 800 + REASONING_HEADROOM_TOKENS,
      reasoning: { effort: 'low' },
    })
    expect(chatCompletionLimits('openrouter', 'google/gemini-3.8-flash', 800)).toHaveProperty('reasoning')
    expect(chatCompletionLimits('openrouter', 'qwen/qwen3.8-flash', 10)).toHaveProperty('reasoning')
    expect(chatCompletionLimits('openrouter', 'openai/gpt-4o-mini', 800)).toEqual({ max_tokens: 800 })
    expect(chatCompletionLimits('openrouter', 'anthropic/claude-haiku-4.5', 800)).toEqual({ max_tokens: 800 })
  })

  it('local servers keep max_tokens unless the name is an OpenAI reasoning model', () => {
    expect(chatCompletionLimits('lmstudio', 'qwen2.5-vl-7b', 500)).toEqual({ max_tokens: 500 })
    expect(chatCompletionLimits('custom', 'gpt-5-mini', 500)).toEqual({ max_completion_tokens: 500 + REASONING_HEADROOM_TOKENS })
  })
})
