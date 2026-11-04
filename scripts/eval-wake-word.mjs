// eval-wake-word.mjs — how well the on-device wake word and command
// transcription work, through the SAME code the app runs (speech-segmenter.ts
// → listening model → wake-phrase.ts). All audio is SYNTHETIC: made with the
// bundled voice engine (8 US/UK voices) and, optionally, extra clips from any
// other text-to-speech (e.g. Indian, Australian, Nigerian, South African,
// Singaporean English) given as 16 kHz mono float32 files + manifest.json.
// It is not a substitute for real people on real microphones.
//
// Needs both models: npm run fetch:voice. Run:
//   node --experimental-strip-types scripts/eval-wake-word.mjs [--extra DIR] [--out FILE] [--quick]
//
// Conditions per clip: clean, plus one of: fan hiss (~-30 dB), someone else
// talking underneath (-10 dB), far from the mic (-20 dB, plus hiss).
// False triggers per hour: ~continuous everyday talk (incl. near-miss words)
// with gaps and hiss, cut by the segmenter exactly as the app does.

import { env, pipeline } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { findWakePhrase, routeCommand } from '../src/renderer/src/companion/wake-phrase.ts'
import { SpeechSegmenter } from '../src/renderer/src/companion/speech-segmenter.ts'

const root = process.cwd()
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
const quick = process.argv.includes('--quick')
const data = JSON.parse(readFileSync(join(root, 'scripts', 'eval-wake-word-data.json'), 'utf8'))
const noBundled = process.argv.includes('--no-bundled')
const KOKORO_VOICES = noBundled ? [] : quick ? ['af_bella', 'am_puck'] : ['af_bella', 'af_heart', 'af_nicole', 'am_puck', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george']
const SPEEDS = quick ? [1.0] : [0.85, 1.0, 1.2]

function resample(x, from, to) {
  const n = Math.floor((x.length * to) / from), out = new Float32Array(n)
  for (let i = 0; i < n; i++) { const p = (i * from) / to, j = Math.floor(p), f = p - j; out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f }
  return out
}
let seed = 1
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
const peakOf = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p || 1 }
function normalize(x, peak = 0.5) { const k = peak / peakOf(x); return x.map((v) => v * k) }
/** Speech with 1 s of lead-in and 1.2 s of tail, through a condition. */
function render(speech, condition, babble) {
  const pad = 16000, tail = 19200, out = new Float32Array(pad + speech.length + tail)
  const gain = condition === 'far' ? 0.1 : 1
  for (let i = 0; i < speech.length; i++) out[pad + i] = speech[i] * gain
  if (condition !== 'clean') for (let i = 0; i < out.length; i++) out[i] += rnd() * 0.5 * 0.03 * (condition === 'far' ? 0.5 : 1)
  if (condition === 'babble') for (let i = 0; i < out.length; i++) out[i] += (babble[i % babble.length] ?? 0) * 0.3
  return out
}
function segmentsOf(samples) {
  const segs = []
  const seg = new SpeechSegmenter((s) => segs.push(s))
  for (let i = 0; i < samples.length; i += 1600) seg.push(samples.subarray(i, i + 1600))
  return segs
}
const wordsOf = (t) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
function wordAccuracy(heard, expected) {
  const h = wordsOf(heard), e = wordsOf(expected)
  const d = Array.from({ length: e.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 1; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= e.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (e[i - 1] === h[j - 1] ? 0 : 1))
  return Math.max(0, 1 - d[e.length][h.length] / e.length)
}

// ── 1. Clips ──
const clips = []
let nanRetries = 0, skipped = 0
env.allowRemoteModels = false
env.localModelPath = `${root}/resources/kokoro`
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp16', device: 'cpu' })
for (const voice of KOKORO_VOICES) for (const speed of SPEEDS) {
  // The voice engine now and then returns NaN samples (seen with the Male voice): retry, else skip and count it.
  const say = async (text) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const a = await tts.generate(text, { voice, speed })
      if (!a.audio.some(Number.isNaN)) return normalize(resample(a.audio, a.sampling_rate, 16000))
      nanRetries++
    }
    skipped++
    return null
  }
  for (const [text, command] of data.wake) clips.push({ kind: 'wake', text, command, source: `bundled:${voice}`, speed, samples: await say(text) })
  for (let k = clips.length - 1; k >= 0; k--) if (!clips[k].samples) clips.splice(k, 1)
  for (const text of data.other) clips.push({ kind: 'other', text, source: `bundled:${voice}`, speed, samples: await say(text) })
  if (speed === 1.0) for (const text of data.chat) clips.push({ kind: 'chat', text, source: `bundled:${voice}`, speed, samples: await say(text) })
  for (let k = clips.length - 1; k >= 0; k--) if (!clips[k].samples) clips.splice(k, 1)
}
const extra = arg('--extra')
if (extra && existsSync(join(extra, 'manifest.json'))) {
  for (const m of JSON.parse(readFileSync(join(extra, 'manifest.json'), 'utf8'))) {
    const f = join(extra, m.file)
    if (!existsSync(f)) continue
    const b = readFileSync(f)
    if (b.length < 3200) continue
    clips.push({ kind: m.kind, text: m.text, command: m.command, source: `extra:${m.voice}`, speed: m.rate, samples: normalize(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))) })
  }
}
console.error(`clips: ${clips.length}`)

// ── 2. Listening model ──
env.localModelPath = `${root}/resources/whisper`
const loadStart = Date.now()
const asr = await pipeline('automatic-speech-recognition', arg('--model') ?? 'onnx-community/whisper-tiny.en', { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } })
await asr(new Float32Array(16000))
const loadMs = Date.now() - loadStart
const clean = (t) => t.replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim()
const timings = []
async function transcribe(samples) {
  const cpu0 = process.cpuUsage(), t0 = performance.now()
  const out = await asr(samples, { max_new_tokens: 64 })
  const cpu = process.cpuUsage(cpu0)
  timings.push({ ms: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000, sec: samples.length / 16000 })
  return clean(out.text)
}
/** The app's flow for one utterance: segments in order; the wake segment's own words, else the next segment, are the command. */
async function runUtterance(audio) {
  const segs = segmentsOf(audio)
  const heard = []
  for (let k = 0; k < segs.length; k++) {
    const text = await transcribe(segs[k]); heard.push(text)
    const m = findWakePhrase(text)
    if (m.heard) {
      let command = m.command
      if (!command && k + 1 < segs.length) { command = await transcribe(segs[k + 1]); heard.push(command) }
      return { woke: true, command, heard: heard.join(' | '), segments: segs.length }
    }
  }
  return { woke: false, command: '', heard: heard.join(' | '), segments: segs.length }
}

// ── 3. Single utterances ──
const babbleSrc = clips.filter((c) => c.kind === 'chat')
const NOISY = ['hiss', 'babble', 'far']
const results = []
let n = 0
for (const c of clips.filter((c) => c.kind !== 'chat')) {
  if (n % 50 === 0) console.error(`utterance ${n}/${clips.length} ${new Date().toISOString()}`)
  const conds = ['clean', NOISY[n++ % 3]]
  for (const condition of conds) {
    const babble = babbleSrc.length ? babbleSrc[n % babbleSrc.length].samples : new Float32Array(1)
    const t0 = performance.now()
    const r = await runUtterance(render(c.samples, condition, babble))
    results.push({ kind: c.kind, source: c.source, speed: c.speed, condition, said: c.text, ...r,
      route: r.woke ? routeCommand(r.command).kind : null,
      commandAccuracy: c.kind === 'wake' && r.woke ? wordAccuracy(r.command, c.command) : null,
      expectedRoute: c.kind === 'wake' ? (/prompt|type next/.test(c.text) ? 'suggest-prompt' : 'ask') : null,
      totalMs: Math.round(performance.now() - t0) })
  }
}

// ── 4. False triggers per hour: continuous everyday talk ──
const stream = []
let streamSec = 0
for (const c of clips.filter((c) => c.kind !== 'wake')) {
  const gap = new Float32Array(Math.round(16000 * (0.4 + Math.abs(rnd()) * 1.6)))
  stream.push(c.samples, gap)
  streamSec += (c.samples.length + gap.length) / 16000
}
const all = new Float32Array(stream.reduce((a, s) => a + s.length, 0))
let off = 0; for (const s of stream) { all.set(s, off); off += s.length }
for (let i = 0; i < all.length; i++) all[i] += rnd() * 0.5 * 0.02
const streamSegs = segmentsOf(all)
const streamTriggers = []
for (const s of streamSegs) { const t = await transcribe(s); if (findWakePhrase(t).heard) streamTriggers.push(t) }

// ── 5. Idle: an hour of room noise only (no speech): how much reaches the model ──
const quiet = new SpeechSegmenter(() => idleSegments++)
let idleSegments = 0
const idleCpu0 = process.cpuUsage(), idleT0 = performance.now()
const chunk = new Float32Array(1600)
for (let k = 0; k < 36000; k++) { for (let i = 0; i < chunk.length; i++) chunk[i] = rnd() * 0.004 * (1 + 0.5 * Math.sin(k / 50)); quiet.push(chunk) }
const idleCpuMs = (process.cpuUsage(idleCpu0).user + process.cpuUsage(idleCpu0).system) / 1000

// ── Report ──
const pct = (a, b) => `${a}/${b} (${b ? ((100 * a) / b).toFixed(1) : 0}%)`
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const pq = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
const by = (rows, key) => Object.fromEntries([...new Set(rows.map((r) => key(r)))].map((k) => { const rs = rows.filter((r) => key(r) === k); return [k, pct(rs.filter((r) => r.woke).length, rs.length)] }))
const wake = results.filter((r) => r.kind === 'wake'), other = results.filter((r) => r.kind === 'other')
const woke = wake.filter((r) => r.woke)
const summary = {
  clips: clips.length, voiceEngineNaNRetries: nanRetries, clipsSkippedNaN: skipped, utterancesRun: results.length, cpu: `${cpus().length} × ${cpus()[0]?.model}`, modelLoadMs: loadMs,
  detection: pct(woke.length, wake.length),
  detectionByCondition: by(wake, (r) => r.condition),
  detectionBySource: by(wake, (r) => r.source),
  detectionBySpeed: by(wake, (r) => String(r.speed)),
  falseTriggersOnNearMissSentences: pct(other.filter((r) => r.woke).length, other.length),
  falseTriggersBySentence: Object.fromEntries(Object.entries(by(other, (r) => r.said)).filter(([, v]) => !v.startsWith('0/'))),
  routedCorrectly: pct(woke.filter((r) => r.route === r.expectedRoute).length, woke.length),
  commandWordAccuracy: `${(100 * avg(woke.map((r) => r.commandAccuracy))).toFixed(1)}% (detected clips)`,
  continuousTalk: { minutes: +(streamSec / 60).toFixed(1), segments: streamSegs.length, triggers: streamTriggers.length, perHour: +((streamTriggers.length * 3600) / streamSec).toFixed(1), heardAs: streamTriggers },
  idleHourOfNoise: { segmentsSentToModel: idleSegments, cpuMsForTheHour: Math.round(idleCpuMs), wallMs: Math.round(performance.now() - idleT0) },
  perSegmentLatencyMs: { mean: Math.round(avg(timings.map((t) => t.ms))), p50: Math.round(pq(timings.map((t) => t.ms), 0.5)), p95: Math.round(pq(timings.map((t) => t.ms), 0.95)), max: Math.round(Math.max(...timings.map((t) => t.ms))) },
  wakeToCommandMs: { p50: pq(woke.map((r) => r.totalMs), 0.5), p95: pq(woke.map((r) => r.totalMs), 0.95) },
  cpuMsPerSegmentMean: Math.round(avg(timings.map((t) => t.cpuMs))),
}
console.log(JSON.stringify(summary, null, 2))
const out = arg('--out')
if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 1))
