// listen-worker.ts — MyBuildy's on-device listening (a small English
// speech-to-text model, 8-bit, bundled with the app), in its own utility
// process like Buildy's voice (kokoro-worker.ts). Audio arrives here as 16 kHz
// mono samples from the robot and is turned into text right here: it is never
// sent anywhere, and the model is never downloaded at run time.
//
// Messages from main (listen-engine.ts):
//   { type: 'load', modelDir }               → { type: 'ready', loadMs } | { type: 'load-failed', message }
//   { type: 'transcribe', id, samples }      → { type: 'text', id, text, ms } | { type: 'transcribe-failed', id, message }

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

const MODEL = 'onnx-community/whisper-tiny.en'

type FromMain =
  | { type: 'load'; modelDir: string }
  | { type: 'transcribe'; id: string; samples: Float32Array }

let asr: AutomaticSpeechRecognitionPipeline | null = null
let chain: Promise<void> = Promise.resolve()

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
      post({ type: 'ready', loadMs: Date.now() - started })
    } catch (error) {
      post({ type: 'load-failed', message: String(error).slice(0, 300) })
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
  if (message.type === 'transcribe' && !(message.samples instanceof Float32Array)) {
    message.samples = new Float32Array(message.samples as unknown as ArrayLike<number>)
  }
  chain = chain.then(() => handle(message))
})
