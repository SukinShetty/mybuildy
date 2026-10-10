// fake-local-server.ts — TESTS ONLY (unit tests and e2e). A real local HTTP
// server that answers like Ollama or LM Studio's local server, so model
// detection is tested against real HTTP on this computer. It can list any set
// of models (with or without the "can read images" information), answer like
// an older server, or accept connections and never answer. Its chat endpoint
// answers MyBuildy's vision check ("what colour is this image?") with "Red" for
// a model that can read images and "I can't see images" for one that can't.

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeLocalModel {
  name: string
  /** Ollama: reported in /api/show capabilities. LM Studio: type 'vlm' vs 'llm'. */
  vision?: boolean
  /** Ollama: details.families (older servers report vision models with 'clip' or 'mllama'). */
  families?: string[]
  /** LM Studio: an embeddings model (never a chat model). */
  embeddings?: boolean
}

export interface FakeLocalOptions {
  kind: 'ollama' | 'lmstudio'
  models?: FakeLocalModel[]
  /** Ollama: /api/show reports capabilities (newer servers). Default true. */
  capabilities?: boolean
  /** LM Studio: the /api/v0/models endpoint exists (with model types). Default true. */
  v0?: boolean
  /** Accept connections, never answer. */
  hang?: boolean
}

export interface FakeLocalServer {
  /** The address to use as the provider's base URL (LM Studio: …/v1). */
  url: string
  port: number
  setModels(models: FakeLocalModel[]): void
  requests: string[]
  close(): Promise<void>
}

export async function startFakeLocalServer(opts: FakeLocalOptions, port = 0): Promise<FakeLocalServer> {
  let models = opts.models ?? []
  const requests: string[] = []
  const open = new Set<ServerResponse>()
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const modelIn = (raw: string): string => {
    try { const b = JSON.parse(raw) as { model?: string; name?: string }; return b.model || b.name || '' } catch { return '' }
  }
  const answerFor = (name: string): string => (models.find((m) => m.name === name)?.vision ? 'Red' : "I can't see images.")

  const server: Server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0]
    requests.push(`${req.method} ${path}`)
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => {
      if (opts.hang) { open.add(res); return }
      if (opts.kind === 'ollama') {
        if (req.method === 'GET' && path === '/api/tags') {
          return json(res, 200, { models: models.map((m) => ({ name: m.name, model: m.name, details: { families: m.families ?? ['llama'] } })) })
        }
        if (req.method === 'POST' && path === '/api/show') {
          let name = ''
          try { const b = JSON.parse(raw) as { model?: string; name?: string }; name = b.model || b.name || '' } catch { /* bad body */ }
          const m = models.find((x) => x.name === name)
          if (!m) return json(res, 404, { error: `model '${name}' not found` })
          const body: Record<string, unknown> = { details: { families: m.families ?? ['llama'] } }
          if (opts.capabilities !== false) body['capabilities'] = m.vision ? ['completion', 'vision'] : ['completion']
          return json(res, 200, body)
        }
        if (req.method === 'POST' && path === '/api/chat') {
          return json(res, 200, { model: modelIn(raw), message: { role: 'assistant', content: answerFor(modelIn(raw)) }, done: true })
        }
        if (path === '/') { res.writeHead(200); res.end('Ollama is running'); return }
      } else {
        if (req.method === 'GET' && path === '/api/v0/models' && opts.v0 !== false) {
          return json(res, 200, { object: 'list', data: models.map((m) => ({ id: m.name, object: 'model', type: m.embeddings ? 'embeddings' : m.vision ? 'vlm' : 'llm', state: 'not-loaded' })) })
        }
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: answerFor(modelIn(raw)) }, finish_reason: 'stop' }] })
        }
        if (req.method === 'GET' && path === '/v1/models') {
          return json(res, 200, { object: 'list', data: models.map((m) => ({ id: m.name, object: 'model' })) })
        }
      }
      json(res, 404, { error: 'Unexpected endpoint or method.' })
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const actual = (server.address() as AddressInfo).port
  return {
    url: opts.kind === 'ollama' ? `http://127.0.0.1:${actual}` : `http://127.0.0.1:${actual}/v1`,
    port: actual,
    setModels: (m) => { models = m },
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const r of open) r.destroy()
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** A local port with nothing listening (for "the server isn't running"). */
export async function closedLocalPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}
