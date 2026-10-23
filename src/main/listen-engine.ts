// listen-engine.ts — main process. Starts MyBuildy's on-device listening
// (listen-worker.ts, a utility process) the first time it is needed (the wake
// word is turned on, or the mic button is used) and turns 16 kHz mono samples
// into text on this computer. Nothing here touches the network.
//
// The model ships inside the installer (package.json build.extraResources,
// fetched and checked by scripts/fetch-listen-model.mjs).

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { logWatchEvent } from './watch-log'

const MODEL_FILE = join('onnx-community', 'whisper-tiny.en', 'onnx', 'decoder_model_merged_quantized.onnx')
const TRANSCRIBE_TIMEOUT_MS = 20_000
const LOAD_TIMEOUT_MS = 60_000
/** The longest stretch of speech accepted (30 s at 16 kHz). */
export const MAX_LISTEN_SAMPLES = 16_000 * 30

type FromWorker =
  | { type: 'ready'; loadMs: number }
  | { type: 'load-failed'; message: string }
  | { type: 'text'; id: string; text: string; ms: number }
  | { type: 'transcribe-failed'; id: string; message: string }

export type ListenStatus = 'missing' | 'off' | 'loading' | 'ready' | 'failed'

let worker: UtilityProcess | null = null
let status: ListenStatus = 'off'
let ready: Promise<boolean> | null = null
let nextId = 0
const pending = new Map<string, { resolve: (r: LocalTranscript) => void; timer: ReturnType<typeof setTimeout> }>()

export interface LocalTranscript { success: boolean; text: string; error?: string; ms?: number }

export function listenModelDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'whisper') : join(__dirname, '..', '..', 'resources', 'whisper')
}

/** Is the on-device listening model on this computer? */
export function listenModelAvailable(): boolean {
  return existsSync(join(listenModelDir(), MODEL_FILE))
}

export function listenStatus(): ListenStatus {
  if (status === 'off' && !listenModelAvailable()) return 'missing'
  return status
}

/** Start the engine (once); resolves true when it can transcribe. */
export function startListenEngine(): Promise<boolean> {
  if (ready) return ready
  if (!listenModelAvailable()) {
    status = 'missing'
    return Promise.resolve(false)
  }
  status = 'loading'
  ready = new Promise<boolean>((resolve) => {
    const limit = setTimeout(() => { status = 'failed'; resolve(false) }, LOAD_TIMEOUT_MS)
    worker = utilityProcess.fork(join(__dirname, 'listen-worker.js'), [], { serviceName: 'MyBuildy listening' })
    worker.on('message', (message: FromWorker) => {
      if (message.type === 'ready') {
        clearTimeout(limit)
        status = 'ready'
        logWatchEvent('listen-engine', { state: 'ready', loadMs: message.loadMs })
        resolve(true)
      } else if (message.type === 'load-failed') {
        clearTimeout(limit)
        status = 'failed'
        console.warn('[Listen] could not load:', message.message)
        logWatchEvent('listen-engine', { state: 'failed' })
        resolve(false)
      } else {
        const job = pending.get(message.id)
        if (!job) return
        pending.delete(message.id)
        clearTimeout(job.timer)
        // NOTE: never log the text itself (user speech content).
        if (message.type === 'text') job.resolve({ success: true, text: message.text, ms: message.ms })
        else job.resolve({ success: false, text: '', error: "Couldn't make out what you said. Try again." })
      }
    })
    worker.on('exit', () => {
      clearTimeout(limit)
      worker = null
      ready = null
      if (status !== 'failed') status = 'off'
      for (const [, job] of pending) { clearTimeout(job.timer); job.resolve({ success: false, text: '', error: 'Listening stopped.' }) }
      pending.clear()
      resolve(false)
    })
    worker.postMessage({ type: 'load', modelDir: listenModelDir() })
  })
  return ready
}

/** Speech (16 kHz mono samples) → text, on this computer. */
export async function transcribeLocally(samples: Float32Array): Promise<LocalTranscript> {
  if (samples.length === 0 || samples.length > MAX_LISTEN_SAMPLES) {
    return { success: false, text: '', error: 'That was too long. Try a shorter question.' }
  }
  if (!(await startListenEngine()) || !worker) {
    return { success: false, text: '', error: "MyBuildy's listening isn't available on this computer right now." }
  }
  const id = `l${++nextId}`
  const w = worker
  return new Promise<LocalTranscript>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ success: false, text: '', error: 'Listening took too long. Try again.' }) }, TRANSCRIBE_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    w.postMessage({ type: 'transcribe', id, samples })
  })
}

export function stopListenEngine(): void {
  worker?.kill()
  worker = null
  ready = null
  if (status !== 'missing') status = 'off'
}
