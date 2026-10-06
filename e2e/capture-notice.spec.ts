// capture-notice.spec.ts — the one-time capture disclosure is enforced in MAIN.
// On a fresh profile (notice never accepted) every capture/upload channel is
// refused, even when a renderer calls it directly and skips the notice UI.

import { test, expect } from '@playwright/test'
import { launchMyBuildy, type MyBuildyApp } from './helpers'
import { CAPTURE_NOTICE_REQUIRED_MESSAGE } from '../src/renderer/src/types'

let mybuildy: MyBuildyApp

test.beforeAll(async () => {
  mybuildy = await launchMyBuildy()
})

test.afterAll(async () => {
  await mybuildy?.close()
})

type Api = {
  mybuildy: {
    captureWindow?: unknown
    analyze?: unknown
    analyzeNow(): Promise<string>
    transcribeAudio(audio: ArrayBuffer): Promise<{ success: boolean; error?: string }>
  }
}

test('no renderer can capture or upload a screen on its own: only the watch does, after the notice', async () => {
  const result = await mybuildy.main.evaluate(async () => {
    const api = (window as unknown as Api).mybuildy
    // The Guidance tab's old capture + analysis channels are gone; Analyze Now
    // runs the watch's own cycle, and with nothing watched captures nothing.
    return { capture: typeof api.captureWindow, analyze: typeof api.analyze, analyzeNow: await api.analyzeNow() }
  })
  expect(result).toEqual({ capture: 'undefined', analyze: 'undefined', analyzeNow: 'no-window' })
})

test('spoken-question audio is not uploaded until the notice is accepted', async () => {
  const result = await mybuildy.companion.evaluate(async () => {
    const api = (window as unknown as Api).mybuildy
    return api.transcribeAudio(new Uint8Array(2048).buffer)
  })
  expect(result.success).toBe(false)
  expect(result.error).toBe(CAPTURE_NOTICE_REQUIRED_MESSAGE)
})
