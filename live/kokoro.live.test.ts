// kokoro.live.test.ts — Buildy's own voice for real (npm run test:live). Not in
// `npm test` or CI: it loads the 160 MB model and runs it on this computer's CPU.
//
// Loads the model the installer bundles (resources/kokoro, from
// npm run fetch:voice) at the same quality the app uses (fp16), speaks with
// Bella, and reports the load time and the time to the first sentence — the
// app speaks one sentence at a time (kokoro-chunks.ts). No network, no key.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
import { splitIntoSentences } from '../src/main/kokoro-chunks'

const MODEL_DIR = join(__dirname, '..', 'resources', 'kokoro')
const LINE = 'Claude Code just finished building your invoice page. Two tests passed. Your next prompt is ready to paste.'

describe("Buildy's voice (live, on this computer)", () => {
  it('loads the bundled fp16 model and speaks the first sentence with Bella', async () => {
    expect(existsSync(join(MODEL_DIR, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_fp16.onnx')), 'run npm run fetch:voice first').toBe(true)
    env.allowRemoteModels = false
    env.localModelPath = MODEL_DIR

    let started = Date.now()
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp16', device: 'cpu' })
    const loadMs = Date.now() - started
    await tts.generate('Hi.', { voice: 'af_bella' }) // the app warms up the same way

    const [first] = splitIntoSentences(LINE)
    started = Date.now()
    const audio = await tts.generate(first, { voice: 'af_bella' })
    const firstSentenceMs = Date.now() - started
    console.log(`[live] Kokoro fp16 / Bella: model load ${loadMs} ms, first sentence made in ${firstSentenceMs} ms, ${(audio.audio.length / audio.sampling_rate).toFixed(1)} s of audio at ${audio.sampling_rate} Hz`)

    expect(audio.sampling_rate).toBe(24000)
    expect(audio.audio.length / audio.sampling_rate).toBeGreaterThan(1.5)
    expect(Math.max(...Array.from(audio.audio.slice(0, 48000), Math.abs))).toBeGreaterThan(0.05) // real sound, not silence
    expect(firstSentenceMs).toBeLessThan(1500)
  })
})
