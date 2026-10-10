// fake-provider-server.ts — TESTS ONLY. A real local HTTP server that answers
// like an AI provider and can misbehave on purpose: send the headers and then
// never the body, send part of a stream and then stall, or send slowly. Used to
// prove that a provider request's timeout covers the WHOLE response.

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeBehavior =
  | { kind: 'normal'; status?: number; body: string; contentType?: string }
  /** Status line and headers, then nothing: the body never arrives. */
  | { kind: 'stall-after-headers'; status?: number; contentType?: string }
  /** Headers and the first chunk(s) of a stream, then nothing. */
  | { kind: 'partial-then-stall'; chunks: string[]; contentType?: string }
  /** Every chunk arrives, `gapMs` apart, then the response ends. */
  | { kind: 'slow'; chunks: string[]; gapMs: number; contentType?: string }

export interface FakeProviderServer {
  url: string
  /** What the next requests get. */
  behave(behavior: FakeBehavior): void
  /** Resolves once a request's headers have been written (status line sent). */
  headersSent(): Promise<void>
  requests: Array<{ method: string; path: string }>
  close(): Promise<void>
}

export async function startFakeProviderServer(): Promise<FakeProviderServer> {
  let behavior: FakeBehavior = { kind: 'normal', body: '{}' }
  const open = new Set<ServerResponse>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const requests: Array<{ method: string; path: string }> = []
  let headersWaiters: Array<() => void> = []
  const headersDone = (): void => { const w = headersWaiters; headersWaiters = []; w.forEach((f) => f()) }

  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method || '', path: req.url || '' })
    req.resume() // drain the request body
    req.on('end', () => {
      open.add(res)
      res.on('close', () => open.delete(res))
      const b = behavior
      const type = ('contentType' in b && b.contentType) || 'application/json'
      if (b.kind === 'normal') {
        res.writeHead(b.status ?? 200, { 'content-type': type })
        res.end(b.body)
        headersDone()
        return
      }
      if (b.kind === 'stall-after-headers') {
        res.writeHead(b.status ?? 200, { 'content-type': type })
        res.flushHeaders()
        headersDone()
        return // never writes the body
      }
      res.writeHead(200, { 'content-type': type })
      res.flushHeaders()
      headersDone()
      if (b.kind === 'partial-then-stall') {
        for (const c of b.chunks) res.write(c)
        return // never ends
      }
      let i = 0
      const timer = setInterval(() => {
        if (i < b.chunks.length) { res.write(b.chunks[i++]); return }
        clearInterval(timer)
        timers.delete(timer)
        res.end()
      }, b.gapMs)
      timers.add(timer)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    behave: (b) => { behavior = b },
    headersSent: () => new Promise<void>((resolve) => headersWaiters.push(resolve)),
    requests,
    close: async () => {
      for (const t of timers) clearInterval(t)
      for (const r of open) r.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
