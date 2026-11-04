// listen-worker.ts — MyBuildy's on-device listening (a small English
// speech-to-text model, 8-bit, bundled with the app), in its own utility
// process like Buildy's voice (kokoro-worker.ts). Audio arrives here as 16 kHz
// mono samples from the robot and is turned into text right here: it is never
// sent anywhere, and the model is never downloaded at run time.
//
// Messages from main (listen-engine.ts):
//   { type: 'load', modelDir }               → { type: 'ready', loadMs } | { type: 'load-failed', message }
//   { type: 'transcribe', id, samples }      → { type: 'text', id, text, ms } | { type: 'transcribe-failed', id, message }
//   { type: 'spot', id, samples }            → { type: 'scores', id, scores }   ("Hey Buildy" keyword model, wakeDir)
//   { type: 'spot-reset' }                   (new microphone stream)

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import * as ort from 'onnxruntime-node'
import { readFileSync } from 'fs'
import { join } from 'path'
import { KeywordSpotter, type Classifier } from './keyword-spotter'

const MODEL = 'onnx-community/whisper-tiny.en'

type FromMain =
  | { type: 'load'; modelDir: string; wakeDir?: string }
  | { type: 'transcribe'; id: string; samples: Float32Array }
  | { type: 'spot'; id: string; samples: Float32Array }
  | { type: 'spot-reset' }

let asr: AutomaticSpeechRecognitionPipeline | null = null
let chain: Promise<void> = Promise.resolve()
let spotChain: Promise<void> = Promise.resolve()
let spotter: KeywordSpotter | null = null

/** The keyword model: Google's speech embedding (ONNX) + our small classifier. One thread: it runs all the time. */
async function loadSpotter(dir: string): Promise<KeywordSpotter> {
  const session = await ort.InferenceSession.create(join(dir, 'speech-embedding.onnx'), { intraOpNumThreads: 1, interOpNumThreads: 1 })
  const classifier = JSON.parse(readFileSync(join(dir, 'hey-buildy.json'), 'utf8')) as Classifier
  return new KeywordSpotter({
    embed: async (mel76) => (await session.run({ logmel: new ort.Tensor('float32', mel76, [1, 76, 32, 1]) }))[session.outputNames[0]].data as Float32Array,
  }, classifier)
}

function post(message: unknown): void {
  process.parentPort.postMessage(message)
}

async function handle(message: FromMain): Promise<void> {
  if (message.type === 'load') {
    try {
      const started = Date.now()
      env.allowRemoteModels = false // the bundled model only, never a download
      env.localModelPath = message.modelDir
      // (pipeline is called through a loose type: its full overloads are too big for TypeScript.)
      const make = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<AutomaticSpeechRecognitionPipeline>
      asr = (await make('automatic-speech-recognition', MODEL, {
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        device: 'cpu',
        // One thread: on multi-core CPUs the 8-bit model's threaded maths gave
        // DIFFERENT text for the same audio from run to run (measured: 3 of 6
        // runs garbled); one thread is stable, as fast for a few seconds of
        // speech, and leaves the other cores to the user.
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
      }))
      await asr(new Float32Array(16000)) // warm up
      if (message.wakeDir) spotter = await loadSpotter(message.wakeDir)
      post({ type: 'ready', loadMs: Date.now() - started })
    } catch (error) {
      post({ type: 'load-failed', message: String(error).slice(0, 300) })
    }
    return
  }
  if (message.type === 'spot-reset') { spotter?.reset(); return }
  if (message.type === 'spot') {
    try {
      post({ type: 'scores', id: message.id, scores: spotter ? await spotter.push(message.samples) : [] })
    } catch (error) {
      post({ type: 'scores', id: message.id, scores: [], error: String(error).slice(0, 200) })
    }
    return
  }
  if (!asr) {
    post({ type: 'transcribe-failed', id: message.id, message: 'not loaded' })
    return
  }
  try {
    const started = Date.now()
    // A short cap: a command is a sentence, and it stops the small model's rare runaway repeats.
    const out = (await asr(message.samples, { max_new_tokens: 64 } as never)) as { text: string }
    post({ type: 'text', id: message.id, text: cleanTranscript(out.text), ms: Date.now() - started })
  } catch (error) {
    post({ type: 'transcribe-failed', id: message.id, message: String(error).slice(0, 300) })
  }
}

/** Drop the model's non-speech tags ("[BLANK_AUDIO]", "(music)", "♪"). */
function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim()
}

process.parentPort.on('message', (event: { data: FromMain }) => {
  const message = event.data
  if ((message.type === 'transcribe' || message.type === 'spot') && !(message.samples instanceof Float32Array)) {
    message.samples = new Float32Array(message.samples as unknown as ArrayLike<number>)
  }
  // Keyword scores run on their own queue so a transcription in progress never backs up the live audio.
  if (message.type === 'spot' || message.type === 'spot-reset') spotChain = spotChain.then(() => handle(message))
  else chain = chain.then(() => handle(message))
})
