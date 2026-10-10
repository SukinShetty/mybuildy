// Every provider adapter (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, LM
// Studio) against a REAL local HTTP server that sends the headers and then
// stalls: the request must end at the provider's advertised timeout (60 s
// cloud, 120 s local) with a timeout error, never hang. Provider URLs are
// pointed at the fake server; only setTimeout/clearTimeout are faked, so time
// can be jumped past the timeout while the sockets stay real.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { setTimeout as realDelay } from 'node:timers/promises'
import type { AppSettings, CaptureResult, ProviderType } from '../../../renderer/src/types'
import { defaultSettings, IPC } from '../../../renderer/src/types'
import { startFakeProviderServer, type FakeProviderServer, type FakeBehavior } from '../testing/fake-provider-server'

vi.mock('electron', () => ({ app: { getPath: () => '.' } }))
vi.mock('../../secure-store', () => ({ redactKnownSecrets: (s: string) => s }))
vi.mock('../../e2e-fakes', () => ({ e2eFakes: () => null, fakeAnalyzeScreen: vi.fn() }))

import { getProvider } from '../provider-registry'
import { callTextCompletion } from '../text-completion'
import { mapProviderError } from '../provider-errors'

let server: FakeProviderServer
const realFetch = globalThis.fetch

beforeAll(async () => { server = await startFakeProviderServer() })
afterAll(async () => { await server.close() })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Send every provider request to the fake server, keeping its path. */
function routeToFakeServer(): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const u = new URL(url)
    return realFetch(`${server.url}${u.pathname}${u.search}`, init)
  })
}

const capture: CaptureResult = { imageBase64: 'AAAA', windowTitle: 'Terminal', sourceId: 'window:1:0', capturedAt: '2026-01-01T00:00:00Z' } as CaptureResult
const PROJECT = { goal: null, memoryContext: '' } as never

const PROVIDERS: Array<{ type: ProviderType; local: boolean; ok: string; streamChunk: string }> = [
  { type: 'anthropic', local: false, ok: JSON.stringify({ content: [{ type: 'text', text: 'Waiting for a prompt.' }] }), streamChunk: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n' },
  { type: 'openai', local: false, ok: JSON.stringify({ choices: [{ message: { content: 'Waiting for a prompt.' } }] }), streamChunk: 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' },
  { type: 'gemini', local: false, ok: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Waiting for a prompt.' }] } }] }), streamChunk: 'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n' },
  { type: 'openrouter', local: false, ok: JSON.stringify({ choices: [{ message: { content: 'Waiting for a prompt.' } }] }), streamChunk: 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' },
  { type: 'ollama', local: true, ok: JSON.stringify({ message: { content: 'Waiting for a prompt.' } }), streamChunk: '{"message":{"content":"Hi"},"done":false}\n' },
  { type: 'lmstudio', local: true, ok: JSON.stringify({ choices: [{ message: { content: 'Waiting for a prompt.' } }] }), streamChunk: 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' },
]

function settingsFor(type: ProviderType): AppSettings {
  return { ...defaultSettings(), provider: type, modelId: 'test-model', apiKey: 'sk-test-0000000000000000', baseUrl: type === 'ollama' || type === 'lmstudio' ? 'http://localhost:9' : '' }
}

/**
 * Start `work` with the server misbehaving as told, wait (real time) until the
 * headers have gone out, jump fake time past the timeout, then report how
 * `work` ended within 3 s of real time.
 */
async function afterTimeout(behavior: FakeBehavior, jumpMs: number, work: () => Promise<unknown>): Promise<{ state: 'resolved' | 'rejected' | 'hung'; error?: unknown }> {
  server.behave(behavior)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  routeToFakeServer()
  const headers = server.headersSent()
  const run = work().then(() => ({ state: 'resolved' as const }), (error) => ({ state: 'rejected' as const, error }))
  await headers
  await realDelay(150) // the headers reach the client: the old timer would be cleared by now
  await vi.advanceTimersByTimeAsync(jumpMs)
  return Promise.race([run, realDelay(3000).then(() => ({ state: 'hung' as const }))])
}

describe.each(PROVIDERS)('$type — analysis request', ({ type, local, ok }) => {
  const limit = local ? 120_000 : 60_000

  it('normal response: the analysis comes back', async () => {
    server.behave({ kind: 'normal', body: ok })
    routeToFakeServer()
    const result = await getProvider(type).analyzeScreen(capture, PROJECT, settingsFor(type))
    expect(result.whatIsHappening).toBeTruthy()
  })

  it(`headers, then the body stalls: ends at the ${limit / 1000} s timeout with a timeout error`, async () => {
    const out = await afterTimeout({ kind: 'stall-after-headers' }, limit + 1000, () => getProvider(type).analyzeScreen(capture, PROJECT, settingsFor(type)))
    expect(out.state).toBe('rejected')
    expect(String(out.error)).toMatch(/timed out after/i)
    expect(mapProviderError(String(out.error)).kind).toBe('timeout')
  })

  it('not aborted before its timeout', async () => {
    const out = await afterTimeout({ kind: 'stall-after-headers' }, limit - 5000, () => getProvider(type).analyzeScreen(capture, PROJECT, settingsFor(type)))
    expect(out.state).toBe('hung') // still waiting, as it should be, 5 s before the limit
  })

  it('text completions (verifier, prompt check, questions): a stalled body ends at the timeout', async () => {
    const out = await afterTimeout({ kind: 'stall-after-headers' }, limit + 1000, () => callTextCompletion({ system: 's', user: 'u', settings: settingsFor(type), imageBase64: 'AAAA' }))
    expect(out.state).toBe('rejected')
    expect(String(out.error)).toMatch(/timed out after/i)
  })
})

describe.each(PROVIDERS)('$type — brainstorm stream', ({ type, local, streamChunk }) => {
  const limit = local ? 120_000 : 60_000

  function sender() {
    const sent: Array<[string, unknown]> = []
    return { sent, webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push([channel, payload]) } } }
  }

  it('part of the stream, then nothing: the user gets an error after the timeout, not an endless spinner', async () => {
    const s = sender()
    const out = await afterTimeout({ kind: 'partial-then-stall', chunks: [streamChunk], contentType: 'text/event-stream' }, limit + 1000,
      () => getProvider(type).streamBrainstorm(s.webContents as never, 'Hello', [], settingsFor(type)))
    expect(out.state).toBe('resolved') // streamBrainstorm reports errors over IPC, it never throws
    expect(s.sent.map(([c]) => c)).toContain(IPC.BRAINSTORM_CHUNK)
    expect(s.sent.map(([c]) => c)).toContain(IPC.BRAINSTORM_ERROR)
  })

  it('a slow stream that keeps sending is read to the end', async () => {
    const s = sender()
    server.behave({ kind: 'slow', chunks: [streamChunk, streamChunk, streamChunk], gapMs: 100, contentType: 'text/event-stream' })
    routeToFakeServer()
    await getProvider(type).streamBrainstorm(s.webContents as never, 'Hello', [], settingsFor(type))
    expect(s.sent.filter(([c]) => c === IPC.BRAINSTORM_CHUNK)).toHaveLength(3)
    expect(s.sent.map(([c]) => c)).toContain(IPC.BRAINSTORM_DONE)
  })
})
