// listen-engine.spec.ts — the mic button's on-device speech-to-text works in the
// real app (dev build and the PACKAGED app): the bundled listening model loads in
// its own process and turns a recorded question into text. No microphone and no
// network: the test hands the app 16 kHz samples, as the mic button does.
// Fixture: e2e/fixtures/give-me-the-prompt.wav, "Give me the prompt." spoken by
// Buildy's own Male voice (Kokoro, Apache-2.0), 16 kHz mono 16-bit.

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, type MyBuildyApp } from './helpers'

type Api = {
  mybuildy: {
    listenStatus(): Promise<string>
    transcribeLocally(samples: Float32Array): Promise<{ success: boolean; text: string; error?: string }>
  }
}

function wavSamples(file: string): number[] {
  const buf = fs.readFileSync(file)
  const dataAt = buf.indexOf('data') + 8
  const out: number[] = []
  for (let i = dataAt; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i) / 32768)
  return out
}

let m: MyBuildyApp
test.beforeAll(async () => { m = await launchMyBuildy() })
test.afterAll(async () => { await m?.close() })

test('mic button speech-to-text: the bundled listening model turns "Give me the prompt." into text on this computer', async () => {
  test.setTimeout(180_000)
  const samples = wavSamples(path.join(__dirname, 'fixtures', 'give-me-the-prompt.wav'))
  expect(samples.length).toBeGreaterThan(16_000)
  const before = await m.companion.evaluate(() => (window as unknown as Api).mybuildy.listenStatus())
  expect(before, 'the listening model is bundled with the app').not.toBe('missing')
  const result = await m.companion.evaluate(
    (s) => (window as unknown as Api).mybuildy.transcribeLocally(new Float32Array(s)),
    samples,
  )
  expect(result.error ?? null).toBeNull()
  expect(result.success).toBe(true)
  expect(result.text.toLowerCase()).toMatch(/give me the prompt/)
  const after = await m.companion.evaluate(() => (window as unknown as Api).mybuildy.listenStatus())
  expect(after).toBe('ready')
})
