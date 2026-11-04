// Kokoro (Apache-2.0) TRAINING clips for "Hey Buildy". Voices are disjoint from the 8 Kokoro eval voices.
// Usage: node --experimental-strip-types scripts/wake-model/gen-kokoro-train.mjs OUT_DIR   (resumable; 16 kHz f32)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
const root = join(import.meta.dirname, '..', '..')
const out = process.argv[2]; mkdirSync(out, { recursive: true })
const ph = JSON.parse(readFileSync(join(import.meta.dirname, 'train-phrases.json'), 'utf8'))
const EVAL = new Set(['af_bella', 'af_heart', 'af_nicole', 'am_puck', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'])
const VOICES = ['af_alloy', 'af_aoede', 'af_jessica', 'af_kore', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_liam', 'am_onyx', 'am_santa', 'bf_alice', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_lewis'].filter((v) => !EVAL.has(v))
  .filter((v, i) => { const [k, n] = (process.env.SHARD ?? '0/1').split('/').map(Number); return i % n === k })
function resample(x, from, to) {
  const n = Math.floor((x.length * to) / from), o = new Float32Array(n)
  for (let i = 0; i < n; i++) { const p = (i * from) / to, j = Math.floor(p), f = p - j; o[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f }
  return o
}
function normalize(x) { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); const k = 0.5 / (p || 1); return x.map((v) => v * k) }
env.allowRemoteModels = false
env.localModelPath = join(root, 'resources', 'kokoro')
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp16', device: 'cpu' })
const jobs = []
for (const v of VOICES) {
  ph.pos.forEach((t, i) => [0.85, 1.0, 1.2].forEach((s) => jobs.push(['pos', v, t, s, `pos_k${v}_${i}_${s}`])))
  ph.near.forEach((t, i) => [0.9, 1.15].forEach((s) => jobs.push(['near', v, t, s, `near_k${v}_${i}_${s}`])))
  ph.gen.forEach((t, i) => jobs.push(['gen', v, t, 1.0, `gen_k${v}_${i}`]))
}
const man = []
for (const [n, [kind, voice, text, speed, name]] of jobs.entries()) {
  const file = name + '.f32'
  if (!existsSync(join(out, file))) {
    let audio = null
    for (let a = 0; a < 4 && !audio; a++) { const r = await tts.generate(text, { voice, speed }); if (!r.audio.some(Number.isNaN)) audio = normalize(resample(r.audio, r.sampling_rate, 16000)) }
    if (!audio) continue
    writeFileSync(join(out, file), Buffer.from(audio.buffer))
  }
  man.push({ file, kind, text, voice: 'kokoro_' + voice, source: 'kokoro' })
  if (n % 200 === 0) { writeFileSync(join(out, `manifest-kokoro-${(process.env.SHARD ?? '0/1').replace('/', 'of')}.json`), JSON.stringify(man)); console.error(n, '/', jobs.length) }
}
writeFileSync(join(out, `manifest-kokoro-${(process.env.SHARD ?? '0/1').replace('/', 'of')}.json`), JSON.stringify(man)); console.error('done', man.length)
