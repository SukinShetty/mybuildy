// navigation-guard.ts — main process (pure, electron-free)
// Predicates behind the global web-contents security guard installed in
// index.ts via app.on('web-contents-created'):
//   - window.open from any renderer is ALWAYS denied; safe external URLs
//     (https / mailto) are forwarded to the OS browser instead.
//   - will-navigate / will-redirect may only target the app's own renderer:
//     the packaged file:// bundle, or the electron-vite dev server origin.
//   - In packaged builds, reload/devtools keyboard shortcuts are blocked.

/** Only https: and mailto: may be opened in the user's browser. Deny file:,
 *  custom protocols, and malformed URLs (which could trigger unsafe handlers). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'https:' || p === 'mailto:'
  } catch {
    return false
  }
}

/**
 * May one of our windows navigate to `url`?
 *   - file:// must be the exact bundled renderer document (query/hash may vary)
 *   - when a dev server URL is configured (ELECTRON_RENDERER_URL), that exact
 *     origin is allowed too (http://localhost:<port> during `npm run dev`)
 *   - everything else (remote sites, javascript:, other local ports) is denied
 */
export function isAllowedAppNavigation(url: string, devServerUrl?: string | null, bundledRendererUrl?: string | null): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.protocol === 'file:') {
    if (!bundledRendererUrl) return false
    try {
      const bundled = new URL(bundledRendererUrl)
      if (bundled.protocol !== 'file:') return false
      // Different windows select their view with query parameters; those and
      // fragments do not change which document receives the privileged preload.
      target.search = ''; target.hash = ''
      bundled.search = ''; bundled.hash = ''
      return target.href === bundled.href
    } catch { return false }
  }
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl)
      return (dev.protocol === 'http:' || dev.protocol === 'https:') && target.origin === dev.origin
    } catch {
      return false // malformed dev server URL — deny anything non-file
    }
  }
  return false
}

/** Minimal shape of Electron's before-input-event Input we depend on. */
export interface KeyInput {
  type: string
  key: string
  code?: string   // physical key (e.g. 'KeyI') — stable when Option composes a character
  control: boolean
  meta: boolean
  shift: boolean
  alt?: boolean
}

/**
 * Reload/devtools shortcuts blocked in PACKAGED builds: Ctrl+R, F5, F12 and
 * Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C (plus macOS Cmd equivalents), and
 * the macOS DevTools chords Cmd+Option+I / J / C (matched by physical key,
 * because Option changes the reported character).
 */
export function isBlockedDevShortcut(input: KeyInput): boolean {
  if (input.type !== 'keyDown') return false
  const key = input.key.toLowerCase()
  const ctrlOrCmd = input.control || input.meta
  if (key === 'f5' || key === 'f12') return true
  if (ctrlOrCmd && key === 'r') return true
  if (ctrlOrCmd && input.shift && (key === 'i' || key === 'j' || key === 'c')) return true
  if (ctrlOrCmd && input.alt && (input.code === 'KeyI' || input.code === 'KeyJ' || input.code === 'KeyC')) return true
  return false
}
