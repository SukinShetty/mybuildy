// Two-stage check, step 2: transcribe every cut saved by kws_dump.py with the bundled listening
// model (fp32 encoder) and record the text, plus whether the app's wake-phrase rule accepts it.
//   node verify.mjs DUMP_DIR OUT.jsonl [shard/n]
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { pipeline, env } from '@huggingface/transformers'
import { findWakePhrase } from '../../src/renderer/src/companion/wake-phrase.ts'
const [dir, out, sh = '0/1'] = process.argv.slice(2)
const [shard, shards] = sh.split('/').map(Number)
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).cut) : [])
env.allowRemoteModels = false
env.localModelPath = join(import.meta.dirname, '..', '..', 'resources', 'whisper')
const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } })
const agc = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); const k = Math.min(30, 0.5 / (p || 1)); return x.map((v) => v * k) }
const clean = (t) => t.replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim()
let i = 0
for (const f of readdirSync(dir).filter((f) => f.startsWith('index-'))) for (const l of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(l)
  for (const cut of row.cuts) {
    if (done.has(cut) || i++ % shards !== shard) continue
    const b = readFileSync(join(dir, cut)); const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
    const t0 = performance.now(); const text = clean((await asr(agc(x), { max_new_tokens: 48 })).text)
    appendFileSync(out, JSON.stringify({ id: row.id, cut, text, app: findWakePhrase(text).heard, ms: Math.round(performance.now() - t0) }) + '\n')
  }
}
