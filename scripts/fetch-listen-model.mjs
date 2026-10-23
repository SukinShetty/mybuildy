// fetch-listen-model.mjs — puts MyBuildy's on-device listening model (a small
// English speech-to-text model, ~64 MB) in resources/whisper/, where
// electron-builder bundles it into the installer (package.json
// build.extraResources) and a dev run reads it. Used only for the optional
// "MyBuildy" wake word and the mic button; audio never leaves the computer.
//
// Same rules as fetch-kokoro-model.mjs: HTTPS from Hugging Face only, a pinned
// revision, and every file's SHA-256 checked before it is used.
// Run: npm run fetch:voice (fetches both models).

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'onnx-community/whisper-tiny.en'
const REVISION = '2575352d61be1bf7225cf8f8b268a4678025fc58'
const FILES = {
  'config.json': '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233',
  'generation_config.json': '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9',
  'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  'tokenizer.json': '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0',
  'tokenizer_config.json': '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c',
  // full-precision encoder: the 8-bit one gave different (often wrong) text for the same audio
  'onnx/encoder_model.onnx': '8c361b9430a5ef6619ee64b7fe06c725df19f36d508cc8b847064b34a888a3fe',
  'onnx/decoder_model_merged_quantized.onnx': 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52',
}
const OUT = join(process.cwd(), 'resources', 'whisper', REPO)

async function sha256(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

for (const [name, expected] of Object.entries(FILES)) {
  const target = join(OUT, name)
  if (existsSync(target) && (await sha256(target)) === expected) {
    console.log(`ok (already here)  ${name}`)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed: ${name} (HTTP ${response.status})`)
  const host = new URL(response.url).hostname
  if (!/(^|\.)huggingface\.co$|(^|\.)hf\.co$/.test(host)) throw new Error(`${name} came from an unexpected host: ${host}`)
  const partial = `${target}.partial`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  const actual = await sha256(partial)
  if (actual !== expected) {
    rmSync(partial, { force: true })
    throw new Error(`${name}: SHA-256 mismatch (got ${actual})`)
  }
  renameSync(partial, target)
  console.log(`downloaded + verified  ${name}`)
}
console.log(`The listening model is ready in ${OUT}`)
