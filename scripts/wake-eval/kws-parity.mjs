// Checks the app's streaming KeywordSpotter (TS log-mel + ONNX embedding) gives the same scores as the Python trainer.
//   node --experimental-strip-types kws-parity.mjs EMBEDDING.onnx MODEL.json CLIP.f32 PY_SCORES.json [chunk]
import { readFileSync } from 'fs'
import * as ort from 'onnxruntime-node'
import { mkdtempSync, writeFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
// node's type stripping needs explicit .ts extensions; the app's bundler doesn't, so copy with them added
const src = new URL('../../src/main/', import.meta.url).pathname, tmp = mkdtempSync(tmpdir() + '/kws-')
copyFileSync(src + 'log-mel.ts', tmp + '/log-mel.ts')
writeFileSync(tmp + '/keyword-spotter.ts', readFileSync(src + 'keyword-spotter.ts', 'utf8').replace("'./log-mel'", "'./log-mel.ts'"))
const { KeywordSpotter } = await import(tmp + '/keyword-spotter.ts')
const [onnx, modelp, clip, pyp, chunk = '1000'] = process.argv.slice(2)
const emb = await ort.InferenceSession.create(onnx, { intraOpNumThreads: 1, interOpNumThreads: 1 })
const models = { embed: async (m) => (await emb.run({ logmel: new ort.Tensor('float32', m, [1, 76, 32, 1]) }))[emb.outputNames[0]].data }
const s = new KeywordSpotter(models, JSON.parse(readFileSync(modelp, 'utf8')))
const b = readFileSync(clip); const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
const t0 = performance.now(); const js = []
for (let i = 0; i < x.length; i += +chunk) js.push(...(await s.push(x.subarray(i, i + +chunk))))
const ms = performance.now() - t0
const py = JSON.parse(readFileSync(pyp, 'utf8'))
console.log('js', js.length, 'py', py.length, 'audio s', (x.length / 16000).toFixed(1), 'ms', ms.toFixed(0))
console.log('max abs diff', Math.max(...js.map((v, i) => Math.abs(v - py[i]))).toExponential(2))
