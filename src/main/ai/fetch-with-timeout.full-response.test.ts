// A provider request's timeout must cover the WHOLE response — headers AND
// body/stream — not stop when the headers arrive. Real HTTP against a local
// fake provider (testing/fake-provider-server.ts) that misbehaves on purpose.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setTimeout as realDelay } from 'node:timers/promises'
import { providerFetch, withCancellation, CancelledError } from './fetch-with-timeout'
import { readJson, providerHttpError, mapProviderError } from './provider-errors'
import { startFakeProviderServer, type FakeProviderServer } from './testing/fake-provider-server'

let server: FakeProviderServer
beforeAll(async () => { server = await startFakeProviderServer() })
afterAll(async () => { await server.close() })

type Outcome = { state: 'resolved'; value: unknown; ms: number } | { state: 'rejected'; error: unknown; ms: number } | { state: 'hung'; ms: number }

/** Settle `work` or report it hung after `guardMs` of REAL time. */
async function settleWithin(guardMs: number, work: () => Promise<unknown>): Promise<Outcome> {
  const started = Date.now()
  const run = work().then(
    (value) => ({ state: 'resolved' as const, value, ms: Date.now() - started }),
    (error) => ({ state: 'rejected' as const, error, ms: Date.now() - started }),
  )
  return Promise.race([run, realDelay(guardMs).then(() => ({ state: 'hung' as const, ms: Date.now() - started }))])
}

/** Read a body chunk by chunk, like the brainstorm stream readers do. */
async function readStream(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
}

describe('providerFetch — the timeout covers the whole response', () => {
  it('normal response: read in full, nothing aborted', async () => {
    server.behave({ kind: 'normal', body: '{"ok":true}' })
    const out = await settleWithin(3000, async () => readJson(await providerFetch(server.url, {}, { timeoutMs: 500 }), 'Test'))
    expect(out).toMatchObject({ state: 'resolved', value: { ok: true } })
  })

  it('headers arrive, then the body stalls: the request is aborted at the timeout with a clear timeout error', async () => {
    server.behave({ kind: 'stall-after-headers' })
    const out = await settleWithin(3000, async () => readJson(await providerFetch(server.url, {}, { timeoutMs: 400 }), 'Test'))
    expect(out.state).toBe('rejected')
    if (out.state !== 'rejected') return
    expect(String(out.error)).toMatch(/timed out after/i)
    expect(out.ms).toBeGreaterThanOrEqual(350)
    expect(out.ms).toBeLessThan(1500)
    expect(mapProviderError(String(out.error)).kind).toBe('timeout')
  })

  it('the timeout counts from the request, not from the headers: headers at 300 ms, body never → aborted at ~500 ms', async () => {
    server.behave({ kind: 'slow', chunks: ['{"partial":'], gapMs: 300 })
    // The one chunk comes after 300 ms and the body never completes in time (it
    // ends at 600 ms): a 500 ms deadline must cut it off.
    const out = await settleWithin(3000, async () => readJson(await providerFetch(server.url, {}, { timeoutMs: 500 }), 'Test'))
    expect(out.state).toBe('rejected')
    if (out.state !== 'rejected') return
    expect(String(out.error)).toMatch(/timed out after/i)
    expect(out.ms).toBeLessThan(1000)
  })

  it('slow but complete within the limit: never aborted early', async () => {
    server.behave({ kind: 'slow', chunks: ['{"a":', '1,', '"b":', '2}'], gapMs: 100 })
    const out = await settleWithin(3000, async () => readJson(await providerFetch(server.url, {}, { timeoutMs: 1500 }), 'Test'))
    expect(out).toMatchObject({ state: 'resolved', value: { a: 1, b: 2 } })
  })

  it('an error response whose body stalls is still classified, by its status, in time', async () => {
    server.behave({ kind: 'stall-after-headers', status: 503 })
    const out = await settleWithin(3000, async () => {
      const response = await providerFetch(server.url, {}, { timeoutMs: 400 })
      return providerHttpError('Test', response)
    })
    expect(out.state).toBe('resolved')
    if (out.state === 'resolved') expect((out.value as { kind: string }).kind).toBe('server')
  })

  it('Stop during a stalled body cancels it (CancelledError, not a timeout)', async () => {
    server.behave({ kind: 'stall-after-headers' })
    const stop = new AbortController()
    const out = await settleWithin(3000, () => withCancellation(stop.signal, async () => {
      const response = await providerFetch(server.url, {}, { timeoutMs: 10_000 })
      setTimeout(() => stop.abort(), 100)
      return readJson(response, 'Test')
    }))
    expect(out.state).toBe('rejected')
    if (out.state === 'rejected') expect(out.error).toBeInstanceOf(CancelledError)
  })
})

describe('providerFetch — streams: a stalled stream is aborted, a slow one is not', () => {
  it('partial stream, then nothing: aborted after the timeout with no new data', async () => {
    server.behave({ kind: 'partial-then-stall', chunks: ['data: {"t":"Hel"}\n\n'], contentType: 'text/event-stream' })
    const out = await settleWithin(3000, async () => readStream(await providerFetch(server.url, {}, { timeoutMs: 400, stream: true })))
    expect(out.state).toBe('rejected')
    if (out.state !== 'rejected') return
    expect(String(out.error)).toMatch(/timed out|stopped sending/i)
    expect(out.ms).toBeLessThan(1500)
    expect(mapProviderError(String(out.error)).kind).toBe('timeout')
  })

  it('slow stream that keeps sending: read to the end even though it takes longer than the timeout in total', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => `data: {"n":${i}}\n\n`)
    server.behave({ kind: 'slow', chunks, gapMs: 150, contentType: 'text/event-stream' })
    // 8 chunks 150 ms apart ≈ 1.35 s in total, with a 500 ms timeout: each gap
    // is well inside it, so the stream must not be cut off.
    const out = await settleWithin(5000, async () => readStream(await providerFetch(server.url, {}, { timeoutMs: 500, stream: true })))
    expect(out.state).toBe('resolved')
    if (out.state === 'resolved') expect(out.value).toBe(chunks.join(''))
  })

  it('a stream is still bounded overall (maxTotalMs), even if it keeps trickling', async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => `data: {"n":${i}}\n\n`)
    server.behave({ kind: 'slow', chunks, gapMs: 100, contentType: 'text/event-stream' })
    const out = await settleWithin(5000, async () => readStream(await providerFetch(server.url, {}, { timeoutMs: 500, stream: true, maxTotalMs: 800 })))
    expect(out.state).toBe('rejected')
    if (out.state === 'rejected') expect(out.ms).toBeLessThan(1500)
  })
})
