// Resumable wake-word eval runner. Appends one JSON line per item to OUT (skips done ids).
//   --set DIR --out FILE --asr tiny|base --vad energy|silero --part utter|stream [--limit N]
// utter: every clip in clean + hiss + babble + far (deterministic noise per clip).
// stream: all non-wake clips joined into 5-minute chunks (with gaps + room noise, some with babble) = long non-wake audio.
import { readFileSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { pipeline, env } from '@huggingface/transformers'
import * as ort from 'onnxruntime-node'
import { SpeechSegmenter } from '../../src/renderer/src/companion/speech-segmenter.ts'
import { findWakePhrase } from '../../src/renderer/src/companion/wake-phrase.ts'

const root = join(import.meta.dirname, '..', '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const setDir = arg('--set'), outFile = arg('--out'), asrName = arg('--asr', 'tiny'), vadName = arg('--vad', 'energy'), part = arg('--part', 'utter')
const limit = Number(arg('--limit', '1e9'))
const [shard, shards] = arg('--shard', '0/1').split('/').map(Number)
const mine = (id) => hash(id) % shards === shard
const manifest = JSON.parse(readFileSync(join(setDir, 'manifest.json'), 'utf8'))
const load = (m) => { const b = readFileSync(join(setDir, 'clips', m.file)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) }
const done = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [])

// ── conditions ──
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1 }
const hash = (str) => { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)) }
const chats = manifest.filter((m) => m.kind === 'chat')
function babbleFor(id, n) {
  const r = rng(hash(id + 'b')), o = new Float32Array(n)
  for (let k = 0; k < 2; k++) { let at = 0; while (at < n) { const c = load(chats[Math.floor(((r() + 1) / 2) * chats.length)]); for (let i = 0; i < c.length && at + i < n; i++) o[at + i] += c[i]; at += c.length + 2000 } }
  return o
}
function render(speech, cond, id) {
  const pad = 16000, out = new Float32Array(pad + speech.length + 19200), r = rng(hash(id + cond))
  const sp = rms(speech)
  if (cond === 'far') {
    // 3 m away: quieter, duller, echoey
    let lp = 0; const y = new Float32Array(speech.length)
    for (let i = 0; i < speech.length; i++) { lp = lp * 0.6 + speech[i] * 0.4; y[i] = lp }
    for (let i = 0; i < y.length; i++) { const v = y[i] + 0.35 * (y[i - 800] ?? 0) + 0.2 * (y[i - 1900] ?? 0); out[pad + i] = v * 0.12 }
  } else for (let i = 0; i < speech.length; i++) out[pad + i] = speech[i]
  const speechRms = cond === 'far' ? sp * 0.12 : sp
  if (cond === 'hiss' || cond === 'far') { const k = (speechRms / Math.pow(10, 10 / 20)) * Math.sqrt(3); for (let i = 0; i < out.length; i++) out[i] += r() * k } // 10 dB SNR white noise
  if (cond === 'babble') { const b = babbleFor(id, out.length), k = speechRms / Math.pow(10, 10 / 20) / (rms(b) || 1); for (let i = 0; i < out.length; i++) out[i] += b[i] * k } // 10 dB SNR other talk
  return out
}

// ── VAD → segments ──
let silero = null
async function sileroSegments(x) {
  silero ??= await ort.InferenceSession.create(process.env.SILERO_VAD ?? '/workspace/evals/silero_vad.onnx', { intraOpNumThreads: 1, interOpNumThreads: 1 })
  let state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]); const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [])
  let ctx = new Float32Array(64); const segs = []; let cur = null, quiet = 0, voiced = 0; const pre = []
  for (let i = 0; i + 512 <= x.length; i += 512) {
    const frame = x.subarray(i, i + 512), inp = new Float32Array(576); inp.set(ctx); inp.set(frame, 64); ctx = frame.slice(448)
    const o = await silero.run({ input: new ort.Tensor('float32', inp, [1, 576]), state, sr }); state = o.stateN; const p = o.output.data[0]
    if (!cur) { pre.push(frame); if (pre.length > 10) pre.shift(); if (p > 0.5) { cur = [...pre]; pre.length = 0; quiet = 0; voiced = 1 } continue }
    cur.push(frame); if (p > 0.35) { quiet = 0; voiced++ } else quiet++
    if (quiet >= 19 || cur.length >= 250) { if (voiced >= 8) segs.push(concat(cur)); cur = null }
  }
  if (cur && voiced >= 8) segs.push(concat(cur))
  return segs
}
const concat = (fs) => { const o = new Float32Array(fs.reduce((a, f) => a + f.length, 0)); let k = 0; for (const f of fs) { o.set(f, k); k += f.length } return o }
function energySegments(x) { const segs = [], s = new SpeechSegmenter((g) => segs.push(g)); for (let i = 0; i < x.length; i += 1600) s.push(x.subarray(i, i + 1600)); s.push(new Float32Array(16000)); return segs }
const segmentsOf = (x) => vadName === 'silero' ? sileroSegments(x) : energySegments(x)

// ── ASR ──
env.allowRemoteModels = false
env.localModelPath = join(root, 'resources', 'whisper')
const model = asrName === 'base' ? 'onnx-community/whisper-base.en' : 'onnx-community/whisper-tiny.en'
const asr = await pipeline('automatic-speech-recognition', model, { dtype: { encoder_model: arg('--enc', 'fp32'), decoder_model_merged: 'q8' }, device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } })
const agc = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); const k = Math.min(30, 0.5 / (p || 1)); return x.map((v) => v * k) }
const clean = (t) => t.replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim()
async function transcribe(seg) { const t0 = performance.now(), c0 = process.cpuUsage(); const o = await asr(agc(seg), { max_new_tokens: 64 }); const c = process.cpuUsage(c0); return { text: clean(o.text), ms: performance.now() - t0, cpuMs: (c.user + c.system) / 1000 } }

const write = (row) => appendFileSync(outFile, JSON.stringify(row) + '\n')
let n = 0
if (part === 'utter') {
  for (const m of manifest.filter((m) => m.kind !== 'chat')) for (const cond of m.kind === 'wake' ? ['clean', 'hiss', 'babble', 'far'] : ['clean', 'babble']) {
    const id = `${m.file}|${cond}`; if (done.has(id) || !mine(id)) continue; if (n++ >= limit) process.exit(0)
    const x = render(load(m), cond, id), segs = await segmentsOf(x);  let woke = false, heard = [], ms = 0, cpuMs = 0, command = ''
    for (let k = 0; k < segs.length && !woke; k++) { const t = await transcribe(segs[k]); heard.push(t.text); ms = t.ms; cpuMs += t.cpuMs; const w = findWakePhrase(t.text); if (w.heard) { woke = true; command = w.command } }
    write({ id, kind: m.kind, source: m.source, voice: m.voice, speed: m.speed, cond, said: m.text, expect: m.command, woke, command, heard, segs: segs.length, lastAsrMs: Math.round(ms), cpuMs: Math.round(cpuMs) })
  }
} else {
  // long non-wake audio: 5-minute chunks
  const neg = manifest.filter((m) => m.kind !== 'wake'); const CH = 16000 * 300; let chunk = [], len = 0, idx = 0
  const flush = async () => {
    const id = `stream${idx++}`; if (done.has(id) || !len || !mine(id)) { chunk = []; len = 0; return }
    if (n++ >= limit) process.exit(0)
    const x = concat(chunk), r = rng(hash(id)), withBabble = idx % 3 === 0
    for (let i = 0; i < x.length; i++) x[i] += r() * 0.004
    if (withBabble) { const b = babbleFor(id, x.length); for (let i = 0; i < x.length; i++) x[i] += b[i] * 0.15 }
    const segs = await segmentsOf(x); const triggers = []; let cpuMs = 0
    for (const s of segs) { const t = await transcribe(s); cpuMs += t.cpuMs; if (findWakePhrase(t.text).heard) triggers.push(t.text) }
    write({ id, seconds: x.length / 16000, babble: withBabble, segs: segs.length, triggers, cpuMs: Math.round(cpuMs) }); chunk = []; len = 0
  }
  for (const m of neg) { const c = load(m), r = rng(hash(m.file)); const gap = new Float32Array(Math.round(16000 * (0.5 + (r() + 1) * 1.5))); chunk.push(c, gap); len += c.length + gap.length; if (len >= CH) await flush() }
  await flush()
}
