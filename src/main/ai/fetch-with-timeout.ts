// fetch-with-timeout.ts
// The ONE way main talks to AI / speech providers. Every request:
//   - never follows a redirect (redirect: 'error'): these requests carry API keys
//     in headers or query strings, and a redirect must not carry them elsewhere;
//   - has a timeout (cloud 60s, local models 120s) that covers the WHOLE
//     response: the headers AND the body. Reading the body (json(), text(), a
//     stream reader) is aborted at the deadline too, with a ProviderTimeoutError.
//     A streaming response (opts.stream) is instead allowed to take longer as
//     long as it keeps sending: the timeout then applies to the headers and to
//     every gap between chunks, with an overall cap (STREAM_MAX_MS);
//   - honours the current cancellation scope: work started under
//     withCancellation(signal, …) — a watch session's analysis, grading,
//     verification and spoken questions — is aborted when that signal fires
//     (the Stop button), and no new request is made once it has.

import { AsyncLocalStorage } from 'node:async_hooks'

const CLOUD_TIMEOUT_MS = 60_000
const LOCAL_TIMEOUT_MS = 120_000
/** A streaming response may keep going while it keeps sending, but never longer than this. */
const STREAM_MAX_MS = 10 * 60_000

/** Thrown when a request was cancelled because its scope was stopped. */
export class CancelledError extends Error {
  constructor() {
    super('Stopped.')
    this.name = 'CancelledError'
  }
}

/**
 * Thrown when a provider took too long: no complete response by the deadline
 * (headers + body), or a stream that stopped sending. The message keeps the
 * "Request timed out after Ns." wording that provider-errors.ts maps to plain
 * English.
 */
export class ProviderTimeoutError extends Error {
  constructor(seconds: number, isLocal: boolean, stalledStream = false) {
    super(
      `Request timed out after ${seconds}s${stalledStream ? ' (the response stopped arriving)' : ''}. ` +
      (isLocal ? 'Check that your local model server is running and responsive.' : 'The API may be experiencing issues — try again.')
    )
    this.name = 'ProviderTimeoutError'
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
  /** Override the timeout; null = no timeout. */
  timeoutMs?: number | null
  /**
   * A streaming response (SSE / NDJSON) read chunk by chunk: the timeout covers
   * the headers and then each gap between chunks, so a slow stream that keeps
   * sending is not cut off but a stalled one is. Never longer than maxTotalMs
   * (default STREAM_MAX_MS) in total.
   */
  stream?: boolean
  maxTotalMs?: number
}

// Responses that can never carry a body (new Response() refuses one for these).
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

export async function providerFetch(
  url: string,
  init: RequestInit,
  opts: ProviderFetchOptions = {}
): Promise<Response> {
  const scope = cancelScope.getStore()
  if (scope?.aborted) throw new CancelledError()

  const isLocal = !!opts.isLocal
  const timeoutMs = opts.timeoutMs === undefined ? (isLocal ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS) : opts.timeoutMs
  const timeout = new AbortController()
  let timedOut: { stalledStream: boolean } | null = null
  let gapTimer: ReturnType<typeof setTimeout> | null = null
  let totalTimer: ReturnType<typeof setTimeout> | null = null
  const fire = (stalledStream: boolean): void => {
    if (timedOut || timeout.signal.aborted) return
    timedOut = { stalledStream }
    timeout.abort()
  }
  const clearTimers = (): void => {
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null }
  }
  if (timeoutMs !== null) {
    if (opts.stream) {
      // The headers, then each gap between chunks, must come within timeoutMs.
      gapTimer = setTimeout(() => fire(false), timeoutMs)
      totalTimer = setTimeout(() => fire(false), Math.max(timeoutMs, opts.maxTotalMs ?? STREAM_MAX_MS))
    } else {
      // One deadline for the whole response: headers AND body.
      totalTimer = setTimeout(() => fire(false), timeoutMs)
    }
  }
  const signals = [timeout.signal, scope, init.signal].filter((s): s is AbortSignal => !!s)
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

  /** The error to surface for a failed request or body read. */
  const failure = (error: unknown): unknown => {
    if (scope?.aborted) return new CancelledError()
    if (timedOut && timeoutMs !== null) return new ProviderTimeoutError(Math.round(timeoutMs / 1000), isLocal, timedOut.stalledStream)
    return error
  }

  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch (error) {
    clearTimers()
    throw failure(error)
  }

  if (timeoutMs === null || !response.body || NULL_BODY_STATUSES.has(response.status)) {
    clearTimers()
    return response
  }

  // Keep the timeout running while the caller reads the body: hand back the
  // same response with its body passed through a guard that clears the timers
  // when the body ends (or is cancelled) and turns an abort into the timeout /
  // Stop error.
  const reader = response.body.getReader()
  let finished = false
  const finish = (): void => { finished = true; clearTimers() }
  if (opts.stream && gapTimer) {
    clearTimeout(gapTimer)
    gapTimer = setTimeout(() => fire(true), timeoutMs)
  }
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) { finish(); controller.close(); return }
        if (opts.stream && !finished) {
          if (gapTimer) clearTimeout(gapTimer)
          gapTimer = setTimeout(() => fire(true), timeoutMs)
        }
        controller.enqueue(value)
      } catch (error) {
        finish()
        controller.error(failure(error))
      }
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    },
  })
  return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** Kept for existing call sites: providerFetch with the default timeout. */
export function fetchWithTimeout(url: string, options: RequestInit, isLocal: boolean = false): Promise<Response> {
  return providerFetch(url, options, { isLocal })
}
