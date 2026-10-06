// buildy-voice.spec.ts — Buildy's own voice (Kokoro, Bella) loads from the
// model bundled with the app and speaks through the real voice queue.
// e2e runs normally skip loading the model; MYBUILDY_E2E_KOKORO=1 turns it on
// here. Needs the model: npm run fetch:voice (CI does it).
//   - dev build: the engine loads, a line is spoken by Kokoro in WAV clips
//     (one sentence each), and the diagnostic log names the engine
//   - packaged build (also the signed, notarized Mac app in
//     mac-signed-build.yml): the engine loads inside the installed app

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

test.setTimeout(180_000)

const LINE = 'Claude Code just finished building your invoice page. Two tests passed. Your next prompt is ready to paste.'

let m: MyBuildyApp
let watchLog = (): string => ''

test.beforeAll(async () => {
  m = await launchMyBuildy({ env: { MYBUILDY_E2E_KOKORO: '1' } })
  const file = path.join(await m.app.evaluate(({ app }) => app.getPath('userData')), 'logs', 'watch.log')
  watchLog = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
})
test.afterAll(async () => { await m?.close() })

test("Buildy's voice engine loads the bundled model", async () => {
  await expect.poll(watchLog, { timeout: 120_000 }).toMatch(/voice-engine kokoro=(ready|failed|missing|stopped)/)
  const line = watchLog().split('\n').find((l) => l.includes('voice-engine'))
  console.log(`[buildy-voice] ${line}`)
  expect(line).toMatch(/kokoro=ready loadMs=\d+/)
})

test('Bella speaks a line, one sentence per clip, and the log says Kokoro spoke it', async () => {
  test.skip(IS_PACKAGED_RUN, 'Speaking on demand uses the dev-build test hook')
  await m.voice.evaluate(() => {
    const w = window as unknown as { __clips: Array<{ src: string; duration: number }> }
    w.__clips = []
    const Original = window.Audio
    ;(window as unknown as { Audio: unknown }).Audio = function (src?: string) {
      const audio = new Original(src)
      audio.addEventListener('canplaythrough', () => w.__clips.push({ src: (src ?? '').slice(0, 40), duration: audio.duration }))
      return audio
    } as unknown as typeof Audio
  })
  await m.app.evaluate((_e, text) => (globalThis as unknown as Record<string, { speak(t: string): void }>)['__mybuildyE2E'].speak(text), LINE)

  await expect.poll(watchLog, { timeout: 60_000 }).toMatch(/voice-line engine=kokoro firstWordMs=\d+/)
  const spoken = watchLog().split('\n').find((l) => l.includes('voice-line'))
  console.log(`[buildy-voice] ${spoken}`)
  // Two clips: "Claude Code just finished…" and "Two tests passed. Your next prompt…"
  await expect.poll(() => m.voice.evaluate(() => (window as unknown as { __clips: unknown[] }).__clips.length), { timeout: 30_000 }).toBe(2)
  const clips = await m.voice.evaluate(() => (window as unknown as { __clips: Array<{ src: string; duration: number }> }).__clips)
  for (const clip of clips) {
    expect(Buffer.from(clip.src.split(',')[1] ?? '', 'base64').subarray(0, 4).toString('latin1')).toBe('RIFF') // WAV at Kokoro's own rate
    expect(clip.duration).toBeGreaterThan(1)
  }
})
