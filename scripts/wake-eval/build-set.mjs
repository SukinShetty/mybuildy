// Build the fixed wake-word test set on disk (resumable): every clip as 16 kHz f32.
//   positives: Kokoro (8 voices x 3 speeds) + extra accent clips (edge dir), "wake" kind
//   near-miss + chat: same sources
// Conditions are applied later by the runner (deterministic per clip), so this only stores clean speech.
// Usage: node --experimental-strip-types scripts/wake-eval/build-set.mjs OUT_DIR [EDGE_DIR]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'

const root = join(import.meta.dirname, '..', '..')
const [out, edge] = process.argv.slice(2)
mkdirSync(join(out, 'clips'), { recursive: true })
const data = JSON.parse(readFileSync(join(root, 'scripts', process.env.WAKE_DATA ?? 'eval-wake-word-data.json'), 'utf8'))
const manifestPath = join(out, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : []
const have = new Set(manifest.map((m) => m.file))
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest))

function resample(x, from, to) {
  const n = Math.floor((x.length * to) / from), o = new Float32Array(n)
  for (let i = 0; i < n; i++) { const p = (i * from) / to, j = Math.floor(p), f = p - j; o[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f }
  return o
}
function normalize(x) { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); const k = 0.5 / (p || 1); return x.map((v) => v * k) }

if (edge) for (const m of JSON.parse(readFileSync(join(edge, 'manifest.json'), 'utf8'))) {
  const file = 'edge_' + m.file
  if (have.has(file) || !existsSync(join(edge, m.file))) continue
  const b = readFileSync(join(edge, m.file)); if (b.length < 3200) continue
  writeFileSync(join(out, 'clips', file), Buffer.from(normalize(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))).buffer))
  manifest.push({ file, kind: m.kind, text: m.text, command: m.command, voice: m.voice, speed: m.rate, source: 'accent' }); have.add(file)
}
save()

env.allowRemoteModels = false
env.localModelPath = join(root, 'resources', 'kokoro')
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp16', device: 'cpu' })
let skipped = 0
const items = [...data.wake.map(([t, c]) => ['wake', t, c]), ...data.other.map((t) => ['other', t, null]), ...data.chat.map((t) => ['chat', t, null])]
for (const voice of ['af_bella', 'af_heart', 'af_nicole', 'am_puck', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george']) for (const speed of [0.85, 1.0, 1.2]) {
  for (const [i, [kind, text, command]] of items.entries()) {
    const file = `kokoro_${voice}_${speed}_${i}.f32`
    if (have.has(file)) continue
    let audio = null
    for (let a = 0; a < 4 && !audio; a++) { const r = await tts.generate(text, { voice, speed }); if (!r.audio.some(Number.isNaN)) audio = normalize(resample(r.audio, r.sampling_rate, 16000)) }
    if (!audio) { skipped++; continue }
    writeFileSync(join(out, 'clips', file), Buffer.from(audio.buffer))
    manifest.push({ file, kind, text, command, voice, speed, source: 'kokoro' }); have.add(file)
  }
  save(); console.error(`${voice} ${speed} done; clips ${manifest.length}, skipped(NaN) ${skipped}`)
}
writeFileSync(join(out, 'skipped.txt'), String(skipped))
