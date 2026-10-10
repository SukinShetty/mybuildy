// provider-origins.ts — main process (ELECTRON-FREE, unit-tested)
// Where each provider's API key may be sent. Cloud providers: exactly their own
// HTTPS origin (scheme + host + default port, no credentials in the URL).
// Local providers: this computer only. Custom: HTTPS remotely; HTTP only on loopback, but its
// key is bound to the origin it was entered for (see customKeyAllowed).

export const CLOUD_ORIGINS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai',
  elevenlabs: 'https://api.elevenlabs.io',
} as const

type CloudProvider = Exclude<keyof typeof CLOUD_ORIGINS, 'elevenlabs'>

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** scheme://host[:port] of a URL, or null if it is not an http(s) URL. */
export function originOf(url: string): string | null {
  const u = parse((url || '').trim())
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null
  return u.origin
}

export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

/** Is `baseUrl` an acceptable endpoint for `provider`? Empty means "use the default". */
export function isAllowedProviderUrl(provider: string, baseUrl: string): boolean {
  const b = (baseUrl || '').trim()
  if (!b) return true
  const u = parse(b)
  if (!u || u.username || u.password) return false
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  if (provider in CLOUD_ORIGINS && provider !== 'elevenlabs') {
    return u.protocol === 'https:' && u.origin === CLOUD_ORIGINS[provider as CloudProvider]
  }
  switch (provider) {
    case 'ollama':
    case 'lmstudio':
      return isLocalHostname(u.hostname)
    case 'custom':
      return u.protocol === 'https:' || isLocalHostname(u.hostname)
    default:
      return false
  }
}

/** A stored custom key may be sent only to the exact origin it was entered for. */
export function customKeyAllowed(boundOrigin: string | null, baseUrl: string): boolean {
  const current = originOf(baseUrl)
  return isAllowedProviderUrl('custom', baseUrl) && !!boundOrigin && !!current && boundOrigin === current
}

/**
 * What a Settings save does to the stored custom key. A key bound to an origin
 * is cleared only when the endpoint moves to a different origin. A legacy key
 * (saved before binding existed, so unbound) is always KEPT: it stays unused
 * until the user confirms its endpoint in Settings, and is never deleted silently.
 */
export function customKeyActionOnSave(boundOrigin: string | null, newOrigin: string | null): 'keep' | 'clear' {
  return boundOrigin && boundOrigin !== newOrigin ? 'clear' : 'keep'
}
