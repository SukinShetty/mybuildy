// provider-errors.test.ts
// Error mapping: raw provider errors → exact plain-English strings shown on the
// mascot label, guidance panel and the Settings test result.

import { describe, it, expect } from 'vitest'
import { mapProviderError, PROVIDER_ERROR_MESSAGES } from './provider-errors'

describe('mapProviderError', () => {
  it('401 → key rejected', () => {
    const r = mapProviderError('Anthropic API error 401: {"type":"authentication_error"}')
    expect(r.kind).toBe('key-rejected')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.keyRejected)
  })

  it('403 → key rejected', () => {
    const r = mapProviderError('OpenAI API error 403: forbidden')
    expect(r.kind).toBe('key-rejected')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.keyRejected)
  })

  it('402 → billing problem', () => {
    const r = mapProviderError('OpenRouter API error 402: insufficient balance')
    expect(r.kind).toBe('billing')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.billing)
  })

  it('OpenAI insufficient_quota → billing problem (even on a 429 status)', () => {
    const r = mapProviderError('OpenAI API error 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')
    expect(r.kind).toBe('billing')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.billing)
  })

  it('Anthropic "credit balance is too low" → billing problem', () => {
    const r = mapProviderError('Anthropic API error 400: Your credit balance is too low to access the Anthropic API.')
    expect(r.kind).toBe('billing')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.billing)
  })

  it('429 → rate limited', () => {
    const r = mapProviderError('Anthropic API error 429: rate_limit_error')
    expect(r.kind).toBe('rate-limited')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.rateLimited)
  })

  it('404 → model not found', () => {
    const r = mapProviderError('OpenAI API error 404: The model `gpt-nonexistent` does not exist')
    expect(r.kind).toBe('model-not-found')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.modelNotFound)
  })

  it('timeout → its own plain timeout message (not "check your internet")', () => {
    const r = mapProviderError('ProviderTimeoutError: Request timed out after 60s. The API may be experiencing issues — try again.')
    expect(r.kind).toBe('timeout')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.timeout)
  })

  it('a local model that timed out gets the local wording', () => {
    const r = mapProviderError('ProviderTimeoutError: Request timed out after 120s. Check that your local model server is running and responsive.')
    expect(r.kind).toBe('timeout')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.localTimeout)
  })

  it('connection refused / fetch failure → network message', () => {
    expect(mapProviderError('TypeError: fetch failed').kind).toBe('network')
    expect(mapProviderError('Error: connect ECONNREFUSED 127.0.0.1:11434').kind).toBe('network')
  })

  it('image-unsupported errors → cannot read images', () => {
    const r = mapProviderError('Ollama error 400: this model does not support image input')
    expect(r.kind).toBe('cannot-read-images')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.cannotReadImages)
  })

  it('unknown errors get a plain message, never the raw provider text', () => {
    const r = mapProviderError('Something exotic happened')
    expect(r.kind).toBe('unknown')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.unknown)
    expect(r.message).not.toContain('exotic')
  })

  it('an HTTP 400 the model refuses (GPT-5 max_tokens) → plain "try the next recommended model"', () => {
    const r = mapProviderError('ProviderHttpError: OpenAI request failed (HTTP 400, bad-request): x')
    expect(r.kind).toBe('bad-request')
    expect(r.message).toBe(PROVIDER_ERROR_MESSAGES.badRequest)
    expect(mapProviderError("Unsupported parameter: 'max_tokens'", 400).kind).toBe('bad-request')
  })

  it('no user-facing message ever contains HTTP codes or error class names', () => {
    for (const message of Object.values(PROVIDER_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/HTTP|[45]\d\d|Error|ProviderHttpError/)
    }
  })

  it('5xx → provider trouble; empty answers and unreadable bodies → plain messages', () => {
    expect(mapProviderError('boom', 503).kind).toBe('server')
    expect(mapProviderError('Error: OpenAI returned no text content').kind).toBe('empty-answer')
    expect(mapProviderError('ProviderResponseError: Provider sent a response MyBuildy could not read (BAD_JSON).').kind).toBe('empty-answer')
  })

  it('an explicit status wins over text sniffing', () => {
    const r = mapProviderError('weird body', 401)
    expect(r.kind).toBe('key-rejected')
  })
})
