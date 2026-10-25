// Runs the SHIPPED wake path over render_ts_set.py's audio: the app's real WakeListener
// (threshold WAKE_THRESHOLD, 6 s request window, backlog/reset rules) driving the app's
// real KeywordSpotter on resources/wake (the files packaged into the installer), exactly
// as listen-worker.ts loads them. Only the microphone, clock and speech-to-text are fakes
// (speech-to-text returns nothing, so every wake is followed by the window timing out).
//   node --experimental-strip-types kws-ts-eval.mjs SET_DIR OUT.jsonl [shard/n]
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import * as ort from 'onnxruntime-node'
const root = new URL('../../', import.meta.url).pathname
const tmp = mkdtempSync(tmpdir() + '/kwsts-')
const fix = (s) => s.replace(/from '\.\/([\w-]+)'/g, "from './$1.ts'")
for (const f of ['main/log-mel', 'main/keyword-spotter', 'renderer/src/companion/wake-listener', 'renderer/src/companion/speech-segmenter', 'renderer/src/companion/wake-phrase'])
  writeFileSync(`${tmp}/${f.split('/').pop()}.ts`, fix(readFileSync(`${root}src/${f}.ts`, 'utf8')))
const { KeywordSpotter } = await import(`${tmp}/keyword-spotter.ts`)
const { WakeListener, WAKE_THRESHOLD, COMMAND_WINDOW_MS } = await import(`${tmp}/wake-listener.ts`)
const wakeDir = root + 'resources/wake/'
const session = await ort.InferenceSession.create(wakeDir + 'speech-embedding.onnx', { intraOpNumThreads: 1, interOpNumThreads: 1 })
const classifier = JSON.parse(readFileSync(wakeDir + 'hey-buildy.json', 'utf8'))
const spotter = new KeywordSpotter({ embed: async (m) => (await session.run({ logmel: new ort.Tensor('float32', m, [1, 76, 32, 1]) }))[session.outputNames[0]].data }, classifier)

const [setDir, outp, shard = '0/1'] = process.argv.slice(2)
const [sh, n] = shard.split('/').map(Number)
const done = new Set(existsSync(outp) ? readFileSync(outp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [])
const items = readFileSync(setDir + '/manifest.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const MIC_CHUNK = 1365 // ~85 ms, like the app's microphone callback at 16 kHz

async function run(x) {
  let clock = 0, pending = Promise.resolve(), onSamples = null
  const timers = []
  const wakes = []
  const listener = new WakeListener({
    openMic: async () => ({ onSamples: (h) => { onSamples = h }, onEnded() {}, close() {} }),
    spot: (s, reset) => { if (reset) spotter.reset(); const p = spotter.push(s); pending = p; return p }, // listen-worker: spot-reset then spot
    transcribe: async () => ({ success: true, text: '' }),
    onCommand: async () => {},
    onIndicator: (s) => { if (s === 'heard') wakes.push(+(clock / 16000).toFixed(2)) },
    explainMicError: String,
    now: () => clock / 16 ,
    setTimer: (fn, ms) => { const t = { fn, due: clock / 16 + ms }; timers.push(t); return t },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
  })
  await listener.start()
  for (let i = 0; i < x.length; i += MIC_CHUNK) {
    onSamples(x.subarray(i, i + MIC_CHUNK)); clock = Math.min(x.length, i + MIC_CHUNK)
    await pending; await new Promise((r) => setImmediate(r)) // a computer fast enough to keep up (as measured: ~2% of a core)
    for (const t of timers.filter((t) => t.due <= clock / 16)) { timers.splice(timers.indexOf(t), 1); t.fn() }
  }
  listener.stop()
  return wakes
}

const t0 = performance.now(); let audio = 0
for (const it of items) {
  if (done.has(it.id) || (parseInt(it.file, 16) % n) !== sh) continue
  const b = readFileSync(setDir + '/' + it.file); const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
  const wakes = await run(x); audio += it.seconds
  const { file, ...meta } = it
  appendFileSync(outp, JSON.stringify({ ...meta, wakes }) + '\n')
}
console.log(`threshold ${WAKE_THRESHOLD}, window ${COMMAND_WINDOW_MS} ms; ${audio.toFixed(0)} s of audio in ${((performance.now() - t0) / 1000).toFixed(0)} s`)
