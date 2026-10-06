// Buildy's voice engine: the load time limit. A fake utility process stands in
// for kokoro-worker.ts (Electron mocked). A line held while the voice loads gets
// null when the limit passes (the computer's voice then speaks it, with the
// notice — voice-order.test.ts), and a load that finishes late takes over again.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => ({ workers: [] as Array<{ posted: unknown[]; emit: (e: string, m: unknown) => void }>, log: [] as Array<{ event: string; details: unknown }> }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '.' },
  utilityProcess: {
    fork: () => {
      const w = Object.assign(new EventEmitter(), { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m) }, kill() {} })
      h.workers.push(w)
      return w
    },
  },
}))
vi.mock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), existsSync: () => true }))
vi.mock('./watch-log', () => ({ logWatchEvent: (event: string, details: unknown) => h.log.push({ event, details }) }))
vi.mock('./e2e-fakes', () => ({ isE2eDevRun: () => false }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  h.workers.length = 0
  h.log.length = 0
})
afterEach(() => { vi.useRealTimers() })

describe("Buildy's voice: the load time limit", () => {
  it('is 45 s', async () => {
    const { KOKORO_LOAD_TIMEOUT_MS } = await import('./kokoro-engine')
    expect(KOKORO_LOAD_TIMEOUT_MS).toBe(45_000)
  })

  it('a load that never finishes: after 45 s the held line is let go (null) and the status says why', async () => {
    const engine = await import('./kokoro-engine')
    engine.startKokoro()
    expect(engine.kokoroIsLoading()).toBe(true)
    const held = engine.speakWithKokoro('Claude Code just finished building your invoice page.', 'bella')

    await vi.advanceTimersByTimeAsync(44_000)
    expect(engine.kokoroIsLoading()).toBe(true) // still waiting: a slow computer gets its chance
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await held).toBeNull()
    expect(engine.kokoroStatus()).toMatchObject({ state: 'failed', code: 'kokoro-slow' })
    expect(h.log).toContainEqual({ event: 'voice-engine', details: { kokoro: 'slow', limitMs: 45_000 } })
  })

  it('a load that finishes after the limit: Buildy’s voice takes over again from the next line', async () => {
    const engine = await import('./kokoro-engine')
    engine.startKokoro()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(engine.kokoroStatus().state).toBe('failed')

    h.workers[0].emit('message', { type: 'ready', loadMs: 52_000 })
    expect(engine.kokoroStatus()).toMatchObject({ state: 'ready' })
    expect(h.log.at(-1)).toEqual({ event: 'voice-engine', details: { kokoro: 'ready-late', loadMs: 52_000 } })

    const next = engine.speakWithKokoro('Two tests passed.', 'puck')
    await vi.advanceTimersByTimeAsync(0)
    const request = h.workers[0].posted.at(-1) as { id: string; voice: string }
    expect(request.voice).toBe('am_puck')
    h.workers[0].emit('message', { type: 'audio', id: request.id, wavBase64: 'UklGRg==', ms: 400 })
    expect(await next).toBe('UklGRg==')
  })

  it('a normal load inside the limit: the held line is spoken by Buildy’s voice', async () => {
    const engine = await import('./kokoro-engine')
    engine.startKokoro()
    const held = engine.speakWithKokoro('Hello.', 'bella')
    await vi.advanceTimersByTimeAsync(7_700) // a cold Apple Silicon Mac
    h.workers[0].emit('message', { type: 'ready', loadMs: 7_700 })
    await vi.advanceTimersByTimeAsync(0)
    const request = h.workers[0].posted.at(-1) as { id: string; voice: string }
    expect(request.voice).toBe('af_bella')
    h.workers[0].emit('message', { type: 'audio', id: request.id, wavBase64: 'UklGRg==', ms: 500 })
    expect(await held).toBe('UklGRg==')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(engine.kokoroStatus().state).toBe('ready') // the limit never fires after a load
  })
})
