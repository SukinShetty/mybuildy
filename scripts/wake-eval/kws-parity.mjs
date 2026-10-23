// Checks the app's streaming KeywordSpotter gives the same scores as the Python trainer's batch code.
//   node --experimental-strip-types kws-parity.mjs MODELS_DIR MODEL.json CLIP.f32 PY_SCORES.json
import { readFileSync } from 'fs'
import * as ort from 'onnxruntime-node'
import { KeywordSpotter } from '../../src/main/keyword-spotter.ts'
const [dir, modelp, clip, pyp] = process.argv.slice(2)
const opt = { intraOpNumThreads: 1, interOpNumThreads: 1 }
const mel = await ort.InferenceSession.create(dir + '/melspectrogram.onnx', opt), emb = await ort.InferenceSession.create(dir + '/embedding_model.onnx', opt)
const models = {
  mel: async (x) => (await mel.run({ input: new ort.Tensor('float32', x, [1, x.length]) }))[mel.outputNames[0]].data,
  embed: async (m) => (await emb.run({ input_1: new ort.Tensor('float32', m, [1, 76, 32, 1]) }))[emb.outputNames[0]].data,
}
const s = new KeywordSpotter(models, JSON.parse(readFileSync(modelp, 'utf8')))
const b = readFileSync(clip); const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
const t0 = performance.now(); const js = await s.push(x); const ms = performance.now() - t0
const py = JSON.parse(readFileSync(pyp, 'utf8'))
console.log('js', js.length, 'py', py.length, 'audio s', (x.length / 16000).toFixed(1), 'ms', ms.toFixed(0))
console.log('max js', Math.max(...js).toFixed(3), 'max py', Math.max(...py).toFixed(3))
console.log('js tail', js.slice(-12).map((v) => v.toFixed(2)).join(' ')); console.log('py tail', py.slice(-12).map((v) => v.toFixed(2)).join(' '))
