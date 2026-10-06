// voice.live.test.ts — a REAL ElevenLabs speech test (npm run test:live). Not
// part of `npm test` or CI: it uses a real key and a few credits.
//
// Speaks one short line with the default voice (Rachel) through the app's own
// code path (elevenlabs-tts.ts) and checks real MP3 audio comes back. On a
// failure it prints the same plain-English reason the app would show.
//
// The key is ELEVENLABS_API_KEY in MYBUILDY_TEST_KEYS (default
// C:\Users\User\mybuildy-test-keys.env) and is never printed.

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('no userData in live tests') }, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { synthesizeSpeech } from '../src/main/ai/elevenlabs-tts'
import { DEFAULT_VOICE_ID } from '../src/renderer/src/voice-options'

const KEY_FILE = process.env.MYBUILDY_TEST_KEYS || 'C:\\Users\\User\\mybuildy-test-keys.env'
const LINE = 'Claude Code just finished building your invoice page. Your next prompt is ready to paste.'

function elevenLabsKey(): string {
  for (const line of fs.readFileSync(KEY_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"]*)"?\s*$/)
    if (m) return m[1].trim()
  }
  return ''
}

describe('ElevenLabs (live)', () => {
  it('speaks a line with the default voice (Rachel) and returns real MP3 audio', async () => {
    const key = elevenLabsKey()
    expect(key, `add ELEVENLABS_API_KEY to ${KEY_FILE}`).not.toBe('')

    const started = Date.now()
    const result = await synthesizeSpeech(LINE, key, DEFAULT_VOICE_ID)
    const ms = Date.now() - started
    console.log(`[live] ElevenLabs: ${result.success ? `OK, ${Math.round((result.audioBase64?.length ?? 0) * 0.75 / 1024)} KB of audio in ${ms} ms` : `FAILED (${result.failure}): ${result.error}`}`)

    expect(result.failure, result.error ?? '').toBeNull()
    expect(result.success).toBe(true)
    const audio = Buffer.from(result.audioBase64 ?? '', 'base64')
    expect(audio.length).toBeGreaterThan(5_000)
    // An MP3: an ID3 tag or an MPEG frame sync at the start.
    expect(audio.subarray(0, 3).toString('latin1') === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)).toBe(true)
  })
})
