import { describe, it, expect } from 'vitest'
import { isAllowedBaseUrl } from './ipc-schemas'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOUD_ORIGINS, originOf, customKeyAllowed, customKeyActionOnSave } from './provider-origins'

describe('cloud providers: only their own HTTPS origin', () => {
  it('rejects the three reported cases', () => {
    expect(isAllowedBaseUrl('openai', 'http://api.openai.com/v1')).toBe(false)
    expect(isAllowedBaseUrl('openai', 'https://api.elevenlabs.io/v1')).toBe(false)
    expect(isAllowedBaseUrl('gemini', 'http://generativelanguage.googleapis.com/v1beta')).toBe(false)
  })

  it('accepts each provider on its own HTTPS origin (and empty = default)', () => {
    expect(isAllowedBaseUrl('anthropic', 'https://api.anthropic.com')).toBe(true)
    expect(isAllowedBaseUrl('openai', 'https://api.openai.com/v1')).toBe(true)
    expect(isAllowedBaseUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta')).toBe(true)
    expect(isAllowedBaseUrl('openrouter', 'https://openrouter.ai/api/v1')).toBe(true)
    for (const p of ['anthropic', 'openai', 'gemini', 'openrouter']) expect(isAllowedBaseUrl(p, '')).toBe(true)
  })

  it('rejects another provider\'s host, look-alike hosts, ports, credentials in the URL and plain http', () => {
    expect(isAllowedBaseUrl('anthropic', 'https://api.openai.com')).toBe(false)
    expect(isAllowedBaseUrl('openrouter', 'https://generativelanguage.googleapis.com')).toBe(false)
    expect(isAllowedBaseUrl('openai', 'https://api.openai.com.evil.example/v1')).toBe(false)
    expect(isAllowedBaseUrl('openai', 'https://api.openai.com:8443/v1')).toBe(false)
    expect(isAllowedBaseUrl('openai', 'https://user:pass@api.openai.com/v1')).toBe(false)
    expect(isAllowedBaseUrl('anthropic', 'http://api.anthropic.com')).toBe(false)
    expect(isAllowedBaseUrl('openrouter', 'http://openrouter.ai/api/v1')).toBe(false)
  })

  it('pins ElevenLabs to its HTTPS origin', () => {
    expect(CLOUD_ORIGINS.elevenlabs).toBe('https://api.elevenlabs.io')
  })
})

describe('local and custom providers', () => {
  it('local providers stay on this computer', () => {
    expect(isAllowedBaseUrl('ollama', 'http://localhost:11434')).toBe(true)
    expect(isAllowedBaseUrl('lmstudio', 'http://127.0.0.1:1234/v1')).toBe(true)
    expect(isAllowedBaseUrl('ollama', 'http://example.com:11434')).toBe(false)
  })

  it('custom requires HTTPS except for loopback HTTP', () => {
    expect(isAllowedBaseUrl('custom', 'https://llm.example.com/v1')).toBe(true)
    expect(isAllowedBaseUrl('custom', 'http://localhost:8080/v1')).toBe(true)
    expect(isAllowedBaseUrl('custom', 'file:///etc/passwd')).toBe(false)
    for (const endpoint of ['http://llm.example.com/v1', 'http://192.168.1.2:8080/v1', 'http://localhost.evil.example/v1']) {
      expect(isAllowedBaseUrl('custom', endpoint)).toBe(false)
      expect(customKeyAllowed(new URL(endpoint).origin, endpoint)).toBe(false)
    }
    for (const endpoint of ['http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://localhost:8080/v1']) {
      expect(isAllowedBaseUrl('custom', endpoint)).toBe(true)
      expect(customKeyAllowed(new URL(endpoint).origin, endpoint)).toBe(true)
    }
  })
})

describe('custom keys saved before origin binding existed (legacy keys)', () => {
  it('are never sent anywhere until the user confirms the endpoint', () => {
    // No bound origin → the key is not usable for ANY endpoint.
    for (const url of ['https://llm.example.com/v1', 'http://localhost:8080/v1', 'https://attacker.example.net']) {
      expect(customKeyAllowed(null, url)).toBe(false)
    }
  })

  it('are kept (never silently deleted) when Settings are saved', () => {
    expect(customKeyActionOnSave(null, 'https://llm.example.com')).toBe('keep')
    expect(customKeyActionOnSave(null, null)).toBe('keep')
  })

  it('a bound key is cleared only when its endpoint actually changes', () => {
    expect(customKeyActionOnSave('https://llm.example.com', 'https://llm.example.com')).toBe('keep')
    expect(customKeyActionOnSave('https://llm.example.com', 'https://other.example.com')).toBe('clear')
  })

  it('the app no longer binds legacy keys automatically at startup', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(source).not.toMatch(/bindCustomKeyOrigin|legacyCustomKeyOrigin/)
  })
})

describe('custom provider key is bound to the origin it was entered for', () => {
  it('computes origins', () => {
    expect(originOf('https://llm.example.com/v1/')).toBe('https://llm.example.com')
    expect(originOf('http://localhost:8080/v1')).toBe('http://localhost:8080')
    expect(originOf('not a url')).toBeNull()
  })

  it('the key is usable only on the same origin', () => {
    expect(customKeyAllowed('https://llm.example.com', 'https://llm.example.com/v2')).toBe(true)
    expect(customKeyAllowed('https://llm.example.com', 'https://other.example.com/v1')).toBe(false)
    expect(customKeyAllowed('https://llm.example.com', 'http://llm.example.com/v1')).toBe(false)
    expect(customKeyAllowed(null, 'https://llm.example.com/v1')).toBe(false)
  })
})
