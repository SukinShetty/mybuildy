// fetch-kokoro-model.mjs — puts Buildy's voice model (Kokoro 82M, fp16) in
// resources/kokoro/, where electron-builder bundles it into the installer
// (package.json build.extraResources) and a dev run reads it.
//
// Downloads ONLY over HTTPS from Hugging Face, at a pinned revision, and checks
// every file's SHA-256 before it is used; a file already present with the right
// hash is kept. Run: node scripts/fetch-kokoro-model.mjs  (npm run fetch:voice)

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const FILES = {
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  'onnx/model_fp16.onnx': 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
}
const OUT = join(process.cwd(), 'resources', 'kokoro', REPO)

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
  // Hugging Face serves large files from its own CDN; anything else is refused.
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
console.log(`Buildy's voice model is ready in ${OUT}`)
