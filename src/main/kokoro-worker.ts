// kokoro-worker.ts — Buildy's own voice (Kokoro 82M, fp16), in its own utility
// process: speech is CPU work, and running it here keeps the app responsive and
// keeps the model out of every renderer (their CSP and sandbox are unchanged).
//
// Loaded once at startup from the model bundled with the app (never from the
// network here) and kept loaded. Messages from main (kokoro-engine.ts):
//   { type: 'load', modelDir, voices, testLoad? } → { type: 'ready', loadMs } | { type: 'load-failed', message }
//   { type: 'speak', id, text, voice }            → { type: 'audio', id, wavBase64, ms } | { type: 'speak-failed', id, message }
// Requests are handled one at a time, in order. Only Buildy's voices (Bella,
// Puck) are accepted. testLoad (e2e dev runs only) simulates a slow or hung load.

import { env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'

type Voice = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice']

type FromMain =
  | { type: 'load'; modelDir: string; voices: Voice[]; testLoad?: { delayMs?: number; hang?: boolean } }
  | { type: 'speak'; id: string; text: string; voice: Voice }

let tts: KokoroTTS | null = null
let voices: Voice[] = []
let chain: Promise<void> = Promise.resolve()

function post(message: unknown): void {
  process.parentPort.postMessage(message)
}

/** Kokoro's float samples as a 16-bit mono WAV at its own rate (24 kHz) — no resampling. */
function toWav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function handle(message: FromMain): Promise<void> {
  if (message.type === 'load') {
    try {
      const started = Date.now()
      if (message.testLoad?.hang) return // e2e: a load that never finishes
      if (message.testLoad?.delayMs) await new Promise((resolve) => setTimeout(resolve, message.testLoad?.delayMs))
      env.allowRemoteModels = false // the bundled model only — never a download here
      env.localModelPath = message.modelDir
      voices = message.voices
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp16', device: 'cpu' })
      for (const voice of voices) await tts.generate('Hi.', { voice }) // warm up, so the first real line is fast
      post({ type: 'ready', loadMs: Date.now() - started })
    } catch (error) {
      post({ type: 'load-failed', message: String(error).slice(0, 300) })
    }
    return
  }
  if (!tts || !voices.includes(message.voice)) {
    post({ type: 'speak-failed', id: message.id, message: tts ? 'not one of Buildy\'s voices' : 'not loaded' })
    return
  }
  try {
    const started = Date.now()
    const audio = await tts.generate(message.text, { voice: message.voice })
    post({ type: 'audio', id: message.id, wavBase64: toWav(audio.audio, audio.sampling_rate).toString('base64'), ms: Date.now() - started })
  } catch (error) {
    post({ type: 'speak-failed', id: message.id, message: String(error).slice(0, 300) })
  }
}

process.parentPort.on('message', (event: { data: FromMain }) => {
  chain = chain.then(() => handle(event.data))
})
