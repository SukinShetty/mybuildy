// First-run setup, "Use a local model instead": finding Ollama / LM Studio on
// this computer and listing its models, preferring ones that can read images.
// Every test talks real HTTP to a fake local server (testing/fake-local-server.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { detectLocalServer, LOCAL_DEFAULT_ADDRESSES } from './local-detect'
import { startFakeLocalServer, closedLocalPort, type FakeLocalServer } from './testing/fake-local-server'

const servers: FakeLocalServer[] = []
async function serve(...args: Parameters<typeof startFakeLocalServer>): Promise<FakeLocalServer> {
  const s = await startFakeLocalServer(...args)
  servers.push(s)
  return s
}
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())) })

describe('the default addresses', () => {
  it('are the ones Ollama and LM Studio use out of the box, as in Settings', () => {
    expect(LOCAL_DEFAULT_ADDRESSES.ollama[0]).toBe('http://localhost:11434')
    expect(LOCAL_DEFAULT_ADDRESSES.lmstudio[0]).toBe('http://localhost:1234/v1')
    // 127.0.0.1 too, for a computer where "localhost" doesn't reach the server.
    expect(LOCAL_DEFAULT_ADDRESSES.ollama).toContain('http://127.0.0.1:11434')
    expect(LOCAL_DEFAULT_ADDRESSES.lmstudio).toContain('http://127.0.0.1:1234/v1')
  })
})

describe('Ollama', () => {
  it('running: lists its models, the ones that can read images first and marked', async () => {
    const s = await serve({ kind: 'ollama', models: [
      { name: 'text-only:7b' },
      { name: 'sees-images:7b', vision: true },
      { name: 'another-text:3b' },
    ] })
    const r = await detectLocalServer('ollama', [s.url])
    expect(r.running).toBe(true)
    expect(r.provider).toBe('ollama')
    expect(r.models.map((m) => [m.id, m.vision])).toEqual([
      ['sees-images:7b', 'yes'],
      ['another-text:3b', 'no'],
      ['text-only:7b', 'no'],
    ])
  })

  it('an older Ollama without capabilities: vision models are recognised by their family, others are "unknown"', async () => {
    const s = await serve({ kind: 'ollama', capabilities: false, models: [
      { name: 'plain:7b' },
      { name: 'clip-based:7b', families: ['llama', 'clip'] },
      { name: 'mllama-based:11b', families: ['mllama'] },
    ] })
    const r = await detectLocalServer('ollama', [s.url])
    const byId = Object.fromEntries(r.models.map((m) => [m.id, m.vision]))
    expect(byId).toEqual({ 'clip-based:7b': 'yes', 'mllama-based:11b': 'yes', 'plain:7b': 'unknown' })
    expect(r.models[r.models.length - 1].id).toBe('plain:7b')
  })

  it('running with no models: running, empty list', async () => {
    const s = await serve({ kind: 'ollama', models: [] })
    expect(await detectLocalServer('ollama', [s.url])).toMatchObject({ running: true, models: [] })
  })

  it('not running (nothing on the port): not running, quickly', async () => {
    const port = await closedLocalPort()
    const t0 = Date.now()
    const r = await detectLocalServer('ollama', [`http://127.0.0.1:${port}`])
    expect(r).toMatchObject({ running: false, models: [] })
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('a server that accepts the connection but never answers: not running, after the short detection timeout', async () => {
    const s = await serve({ kind: 'ollama', hang: true })
    const t0 = Date.now()
    const r = await detectLocalServer('ollama', [s.url], { timeoutMs: 400 })
    expect(r.running).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2500)
  })

  it('found at the default address: no address is saved (Settings shows the default)', async () => {
    const s = await serve({ kind: 'ollama', models: [{ name: 'm', vision: true }] })
    // The first candidate is "the default" for this check.
    expect((await detectLocalServer('ollama', [s.url], { defaultAddress: s.url })).baseUrl).toBe('')
  })

  it('the first address does not answer, the second does: that address is used and saved', async () => {
    const port = await closedLocalPort()
    const s = await serve({ kind: 'ollama', models: [{ name: 'm', vision: true }] })
    const r = await detectLocalServer('ollama', [`http://127.0.0.1:${port}`, s.url], { defaultAddress: `http://127.0.0.1:${port}` })
    expect(r).toMatchObject({ running: true, baseUrl: s.url })
  })
})

describe('LM Studio', () => {
  it('running: lists chat models (never embeddings), the ones that can read images first and marked', async () => {
    const s = await serve({ kind: 'lmstudio', models: [
      { name: 'text-model' },
      { name: 'embedding-model', embeddings: true },
      { name: 'vision-model', vision: true },
    ] })
    const r = await detectLocalServer('lmstudio', [s.url])
    expect(r.running).toBe(true)
    expect(r.models.map((m) => [m.id, m.vision])).toEqual([
      ['vision-model', 'yes'],
      ['text-model', 'no'],
    ])
  })

  it('an LM Studio without the model-type endpoint: falls back to the plain list, "unknown" unless the name says so, embeddings left out', async () => {
    const s = await serve({ kind: 'lmstudio', v0: false, models: [
      { name: 'some-model' },
      { name: 'text-embedding-small', embeddings: true },
      { name: 'qwen2-vl-7b' },
    ] })
    const r = await detectLocalServer('lmstudio', [s.url])
    expect(r.running).toBe(true)
    expect(r.models.map((m) => [m.id, m.vision])).toEqual([
      ['qwen2-vl-7b', 'yes'],
      ['some-model', 'unknown'],
    ])
  })

  it('not running: not running', async () => {
    const port = await closedLocalPort()
    expect(await detectLocalServer('lmstudio', [`http://127.0.0.1:${port}/v1`])).toMatchObject({ running: false, models: [] })
  })

  it('running with no models loaded or downloaded: running, empty list', async () => {
    const s = await serve({ kind: 'lmstudio', models: [] })
    expect(await detectLocalServer('lmstudio', [s.url])).toMatchObject({ running: true, models: [] })
  })
})

it('never sends anything but model-list requests (no model is loaded or run by detection)', async () => {
  const s = await serve({ kind: 'ollama', models: [{ name: 'a', vision: true }, { name: 'b' }] })
  await detectLocalServer('ollama', [s.url])
  expect(s.requests.every((r) => r === 'GET /api/tags' || r === 'POST /api/show')).toBe(true)
})
