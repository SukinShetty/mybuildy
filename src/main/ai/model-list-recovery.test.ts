import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../renderer/src/types'
import { modelListDiagnostic } from './model-list-diagnostic'
import { ProviderHttpError } from './provider-errors'

vi.mock('../secure-store', () => ({ redactKnownSecrets: (s: string) => s }))
vi.mock('../vision-approvals', () => ({ keyFingerprint: (s: string) => s }))
vi.mock('./provider-registry', () => ({ getProviderInfo: () => ({ defaultBaseUrl: 'https://api.anthropic.com' }) }))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('model-list diagnostics', () => {
  it('contains only stage, validated status and classification', () => {
    const d = modelListDiagnostic(new ProviderHttpError('secret-in-label', 400, 'bad-request', 'secret-in-body'))
    expect(d).toEqual({ stage: 'model-list', status: 400, kind: 'bad-request' })
    expect(JSON.stringify(d)).not.toContain('secret')
  })
  it('does not infer diagnostic status from arbitrary error text', () => {
    expect(modelListDiagnostic(new Error('private 400 response'))).toEqual({ stage: 'model-list', status: null, kind: 'bad-request' })
  })
})

describe('Anthropic model-list failures and recovery', () => {
  it.each([
    [400, 'bad-request'], [401, 'key-rejected'], [403, 'key-rejected'],
    [402, 'billing'], [429, 'rate-limited'], [503, 'server'],
  ])('reports HTTP %s safely and retries instead of caching failure', async (status, kind) => {
    vi.resetModules()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"synthetic-private-body"}}', { status: Number(status) }))
      .mockResolvedValueOnce(new Response('{"data":[{"id":"synthetic-model","display_name":"Synthetic model"}]}'))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchModelsForProvider } = await import('./model-fetch')
    const settings = { provider: 'anthropic', baseUrl: '', apiKey: 'synthetic-no-network' } as AppSettings
    const failed = await fetchModelsForProvider(settings)
    expect(failed.models).toEqual([])
    expect(failed.diagnostic).toEqual({ stage: 'model-list', status, kind })
    expect(JSON.stringify(failed)).not.toContain('synthetic-private-body')
    const recovered = await fetchModelsForProvider(settings)
    expect(recovered.models[0].id).toBe('synthetic-model')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: {
      'x-api-key': 'synthetic-no-network', 'anthropic-version': '2023-06-01',
    } })
  })
  it.each([
    [new Error('fetch failed'), 'network'],
    [new Error('Request timed out after 60s.'), 'timeout'],
  ])('keeps transport failures recoverable: %s', async (error, kind) => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(error)
      .mockResolvedValueOnce(new Response('{"data":[]}')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchModelsForProvider } = await import('./model-fetch')
    const s = { provider: 'anthropic', baseUrl: '', apiKey: 'synthetic-no-network' } as AppSettings
    expect((await fetchModelsForProvider(s)).diagnostic).toEqual({ stage: 'model-list', status: null, kind })
    expect(await fetchModelsForProvider(s)).toEqual({ models: [], error: null })
  })
})
