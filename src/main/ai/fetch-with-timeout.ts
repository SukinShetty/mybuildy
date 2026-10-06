// fetch-with-timeout.ts
// The ONE way main talks to AI / speech providers. Every request:
//   - never follows a redirect (redirect: 'error'): these requests carry API keys
//     in headers or query strings, and a redirect must not carry them elsewhere;
//   - has a timeout (cloud 60s, local models 120s; streaming callers may opt out);
//   - honours the current cancellation scope: work started under
//     withCancellation(signal, …) — a watch session's analysis, grading,
//     verification and spoken questions — is aborted when that signal fires
//     (the Stop button), and no new request is made once it has.

import { AsyncLocalStorage } from 'node:async_hooks'

const CLOUD_TIMEOUT_MS = 60_000
const LOCAL_TIMEOUT_MS = 120_000

/** Thrown when a request was cancelled because its scope was stopped. */
export class CancelledError extends Error {
  constructor() {
    super('Stopped.')
    this.name = 'CancelledError'
  }
}

const cancelScope = new AsyncLocalStorage<AbortSignal>()

/** Run `fn` so that every provider request it makes (even after awaits) is cancelled by `signal`. */
export function withCancellation<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return cancelScope.run(signal, fn)
}

/**
 * Run `fn` outside any cancellation scope. Speech uses this: it has its own Stop
 * (voice-player.ts), and must not be cut over to the computer's voice because
 * the watch that asked for it ended (a project switch mid-sentence).
 */
export function withoutCancellation<T>(fn: () => Promise<T>): Promise<T> {
  return cancelScope.exit(fn)
}

/** True when the current scope has been cancelled (lets loops bail out before a capture). */
export function isCancelled(): boolean {
  return cancelScope.getStore()?.aborted ?? false
}

export interface ProviderFetchOptions {
  isLocal?: boolean
  /** Override the timeout; null = no timeout (long streaming responses). */
  timeoutMs?: number | null
}

export async function providerFetch(
  url: string,
  init: RequestInit,
  opts: ProviderFetchOptions = {}
): Promise<Response> {
  const scope = cancelScope.getStore()
  if (scope?.aborted) throw new CancelledError()

  const timeoutMs = opts.timeoutMs === undefined ? (opts.isLocal ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS) : opts.timeoutMs
  const timeout = new AbortController()
  const timer = timeoutMs === null ? null : setTimeout(() => timeout.abort(), timeoutMs)
  const signals = [timeout.signal, scope, init.signal].filter((s): s is AbortSignal => !!s)
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

  try {
    return await fetch(url, { ...init, redirect: 'error', signal })
  } catch (error) {
    if (scope?.aborted) throw new CancelledError()
    if (timeout.signal.aborted && timeoutMs !== null) {
      const seconds = Math.round(timeoutMs / 1000)
      throw new Error(
        `Request timed out after ${seconds}s. ${opts.isLocal ? 'Check that your local model server is running and responsive.' : 'The API may be experiencing issues — try again.'}`
      )
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Kept for existing call sites: providerFetch with the default timeout. */
export function fetchWithTimeout(url: string, options: RequestInit, isLocal: boolean = false): Promise<Response> {
  return providerFetch(url, options, { isLocal })
}
