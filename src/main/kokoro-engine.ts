// kokoro-engine.ts — main process. Starts Buildy's own voice (kokoro-worker.ts,
// a utility process) when MyBuildy starts, keeps the model loaded, and turns a
// sentence into WAV audio for the voice queue (voice-player.ts).
//
// The model ships inside the installer (package.json build.extraResources,
// fetched and checked by scripts/fetch-kokoro-model.mjs). If it is missing or
// the engine can't start, kokoroStatus() says why, in plain words, and speech
// falls back to the computer's voice — with a notice, never silently.

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { logWatchEvent } from './watch-log'

export const BUILDY_VOICE = 'af_bella' // Bella
const MODEL_FILE = join('onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_fp16.onnx')
const SPEAK_TIMEOUT_MS = 30_000

export type KokoroStatus =
  | { state: 'off' }                        // e2e runs: not started (tests never wait for a model)
  | { state: 'loading' }
  | { state: 'ready'; loadMs: number }
  | { state: 'failed'; code: 'kokoro-missing' | 'kokoro-failed'; detail: string }

type FromWorker =
  | { type: 'ready'; loadMs: number }
  | { type: 'load-failed'; message: string }
  | { type: 'audio'; id: string; wavBase64: string; ms: number }
  | { type: 'speak-failed'; id: string; message: string }

let worker: UtilityProcess | null = null
let status: KokoroStatus = { state: 'off' }
let readyWaiters: Array<() => void> = []
let nextId = 0
const pending = new Map<string, { resolve: (wav: string | null) => void; timer: ReturnType<typeof setTimeout> }>()
// Sentences asked for ahead of time (the next ones while one plays), by text.
const prefetched = new Map<string, Promise<string | null>>()
const PREFETCH_LIMIT = 12

/** Where the bundled model is: next to the app when installed, resources/ in a dev run. */
export function kokoroModelDir(): string {
  // Dev / test runs: resources/kokoro in the repo (this file runs from out/main).
  return app.isPackaged ? join(process.resourcesPath, 'kokoro') : join(__dirname, '..', '..', 'resources', 'kokoro')
}

export function kokoroStatus(): KokoroStatus {
  return status
}

function settle(next: KokoroStatus): void {
  status = next
  const waiters = readyWaiters
  readyWaiters = []
  for (const wake of waiters) wake()
}

/** Start the engine and load the model (once, at startup). */
export function startKokoro(): void {
  if (worker || status.state === 'loading' || status.state === 'ready') return
  // e2e runs don't load a 160 MB model per launch, unless a test asks for it.
  if (process.env['MYBUILDY_E2E'] === '1' && process.env['MYBUILDY_E2E_KOKORO'] !== '1') return
  const modelDir = kokoroModelDir()
  if (!existsSync(join(modelDir, MODEL_FILE))) {
    settle({ state: 'failed', code: 'kokoro-missing', detail: 'model file not found' })
    logWatchEvent('voice-engine', { kokoro: 'missing' })
    return
  }
  status = { state: 'loading' }
  const started = Date.now()
  worker = utilityProcess.fork(join(__dirname, 'kokoro-worker.js'), [], { serviceName: 'MyBuildy voice' })
  worker.on('message', (message: FromWorker) => {
    if (message.type === 'ready') {
      settle({ state: 'ready', loadMs: message.loadMs })
      console.log(`[Kokoro] Buildy's voice ready in ${Date.now() - started} ms`)
      logWatchEvent('voice-engine', { kokoro: 'ready', loadMs: message.loadMs })
    } else if (message.type === 'load-failed') {
      console.warn('[Kokoro] could not load:', message.message)
      settle({ state: 'failed', code: 'kokoro-failed', detail: message.message })
      logWatchEvent('voice-engine', { kokoro: 'failed' })
    } else {
      const job = pending.get(message.id)
      if (!job) return
      pending.delete(message.id)
      clearTimeout(job.timer)
      if (message.type === 'audio') job.resolve(message.wavBase64)
      else { console.warn('[Kokoro] speech failed:', message.message); job.resolve(null) }
    }
  })
  worker.on('exit', (code) => {
    worker = null
    for (const [, job] of pending) { clearTimeout(job.timer); job.resolve(null) }
    pending.clear()
    prefetched.clear()
    if (status.state !== 'failed') {
      console.warn(`[Kokoro] engine stopped (exit ${code})`)
      settle({ state: 'failed', code: 'kokoro-failed', detail: `engine stopped (exit ${code})` })
      logWatchEvent('voice-engine', { kokoro: 'stopped' })
    }
  })
  worker.postMessage({ type: 'load', modelDir, voice: BUILDY_VOICE })
}

/** Resolves once the engine is ready or has failed (the first line may arrive while it loads). */
function whenSettled(): Promise<void> {
  if (status.state !== 'loading') return Promise.resolve()
  return new Promise((resolve) => readyWaiters.push(resolve))
}

function request(text: string): Promise<string | null> {
  return whenSettled().then(() => {
    if (status.state !== 'ready' || !worker) return null
    const id = `k${++nextId}`
    const w = worker
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(null) }, SPEAK_TIMEOUT_MS)
      pending.set(id, { resolve, timer })
      w.postMessage({ type: 'speak', id, text })
    })
  })
}

/** Start making these sentences now (in order), so each is ready when its turn comes. */
export function prefetchKokoro(sentences: string[]): void {
  for (const sentence of sentences) {
    if (prefetched.has(sentence)) continue
    if (prefetched.size >= PREFETCH_LIMIT) prefetched.delete(prefetched.keys().next().value as string)
    prefetched.set(sentence, request(sentence))
  }
}

/** WAV audio (base64) for one sentence, or null if Buildy's voice can't speak it. */
export function speakWithKokoro(sentence: string): Promise<string | null> {
  const ready = prefetched.get(sentence)
  if (ready) {
    prefetched.delete(sentence)
    return ready
  }
  return request(sentence)
}

/** Stop pressed: drop sentences made ahead of time (the engine stays loaded). */
export function clearKokoroPrefetch(): void {
  prefetched.clear()
}

export function stopKokoro(): void {
  worker?.kill()
  worker = null
}
