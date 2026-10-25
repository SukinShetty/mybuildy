// Adversarial races with a manual clock and hand-resolved keyword/transcription results.
import { it, expect, vi } from 'vitest'
import { WakeListener, COMMAND_WINDOW_MS, type MicHandle } from './wake-listener'

function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r }); return { p, resolve } }
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }
const loud = (s: number) => { const a = new Float32Array(16000 * s); for (let i = 0; i < a.length; i++) a[i] = 0.2 * Math.sin(i / 3); return a }
const quiet = (s: number) => new Float32Array(16000 * s)

function harness() {
  let push: (s: Float32Array) => void = () => {}
  let clock = 0
  const timers: { fn: () => void; at: number; h: number }[] = []
  let hid = 0
  const spots: { d: ReturnType<typeof deferred<number[]>>; n: number }[] = []
  const transcribes: ReturnType<typeof deferred<{ success: boolean; text: string }>>[] = []
  const states: string[] = []
  const onCommand = vi.fn(async () => {})
  const l = new WakeListener({
    openMic: async (): Promise<MicHandle> => ({ onSamples: (h) => { push = h }, onEnded: () => {}, close: () => { push = () => {} } }),
    spot: (s) => { const d = deferred<number[]>(); spots.push({ d, n: Math.floor(s.length / 1280) }); return d.p },
    transcribe: () => { const d = deferred<{ success: boolean; text: string }>(); transcribes.push(d); return d.p },
    onCommand, onIndicator: (s) => states.push(s), explainMicError: () => 'x',
    now: () => clock,
    setTimer: (fn, ms) => { const h = ++hid; timers.push({ fn, at: clock + ms, h }); return h },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.h === h); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = (ms: number) => { clock += ms; for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn() } }
  const feed = async (a: Float32Array) => { for (let i = 0; i < a.length; i += 4096) { push(a.subarray(i, i + 4096)); await flush() } }
  return { l, spots, transcribes, states, onCommand, advance, feed, push: (a: Float32Array) => push(a) }
}

it('A: stop/start while a keyword check is pending: stale result ignored, detection resumes', async () => {
  const h = harness()
  await h.l.start(); await h.feed(quiet(0.2))
  expect(h.spots.length).toBe(1)
  h.l.stop(); await h.l.start()
  h.spots[0].d.resolve([0.99999]); await flush()
  expect(h.l.state).toBe('listening') // stale wake ignored
  await h.feed(quiet(0.2))
  expect(h.spots.length).toBe(2) // detection resumed
  h.spots[1].d.resolve([0.99999]); await flush()
  expect(h.l.state).toBe('heard')
})

it('B: delayed empty transcription past the window: back to listening, later speech ignored without wake', async () => {
  const h = harness()
  await h.l.start(); await h.feed(quiet(0.2)); h.spots[0].d.resolve([0.99999]); await flush()
  expect(h.l.state).toBe('heard')
  await h.feed(loud(1)); await h.feed(quiet(1))
  expect(h.transcribes.length).toBe(1)
  // timer fires late? simulate clock past deadline without timer by resolving after deadline
  h.advance(COMMAND_WINDOW_MS + 1)
  h.transcribes[0].resolve({ success: true, text: '' }); await flush()
  expect(h.l.state).toBe('listening')
  await h.feed(loud(1)); await h.feed(quiet(1))
  expect(h.transcribes.length).toBe(1)
  expect(h.onCommand).not.toHaveBeenCalled()
})

it('C: a slow transcription from an expired window must not swallow the next window\'s request', async () => {
  const h = harness()
  await h.l.start(); await h.feed(quiet(0.2)); h.spots[0].d.resolve([0.99999]); await flush()
  await h.feed(loud(1)); await h.feed(quiet(1))            // transcription #1 starts, hangs
  h.advance(COMMAND_WINDOW_MS + 1)                          // window 1 expires
  expect(h.l.state).toBe('listening')
  await h.feed(quiet(0.2))
  const last = h.spots[h.spots.length - 1]; last.d.resolve([0.99999]); await flush()
  expect(h.l.state).toBe('heard')                           // window 2
  await h.feed(loud(1)); await h.feed(quiet(1))            // "give me the prompt"
  expect(h.transcribes.length).toBe(2)                     // should be transcribed
})
