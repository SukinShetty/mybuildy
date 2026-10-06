// The voice order, driven through the real voice player and queue (Electron,
// the engines and the diagnostic log mocked): ElevenLabs when a key is set,
// otherwise Buildy's own voice (Kokoro, Bella, one sentence per chunk), and the
// computer's voice only when Buildy's can't run — every fallback announced.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: { id: string; audioBase64?: string; text?: string } }>,
  settings: { elevenLabsApiKey: '', elevenLabsVoiceId: '' } as Record<string, string>,
  eleven: vi.fn(),
  kokoro: vi.fn(),
  kokoroState: { state: 'ready' } as { state: string; code?: string },
  prefetched: [] as string[][],
  log: [] as Array<{ event: string; details: Record<string, unknown> }>,
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: (channel: string, payload: never) => h.sent.push({ channel, payload }), on: () => {} }
    isDestroyed = () => false
    once = () => {}
    loadURL = () => {}
    loadFile = () => {}
    setIgnoreMouseEvents = () => {}
  },
}))
vi.mock('./memory', () => ({ loadSettings: async () => h.settings }))
vi.mock('./guidance-window', () => ({ sendSpeechProgress: () => {} }))
vi.mock('./watch-log', () => ({ logWatchEvent: (event: string, details: Record<string, unknown> = {}) => h.log.push({ event, details }) }))
vi.mock('./ai/elevenlabs-tts', () => ({ synthesizeSpeech: h.eleven }))
vi.mock('./kokoro-engine', () => ({
  kokoroStatus: () => h.kokoroState,
  speakWithKokoro: h.kokoro,
  prefetchKokoro: (s: string[]) => h.prefetched.push(s),
  clearKokoroPrefetch: () => {},
}))

import { createVoicePlayerWindow, enqueueSpeech, handleVoiceEnded, getVoiceFallback, setVoiceFallbackNotice, resetVoiceHealth, stopVoice, resetVoiceDedup } from './voice-player'
import { IPC } from '../renderer/src/types'

const notices: Array<{ headline: string; reason: string } | null> = []
setVoiceFallbackNotice((n) => notices.push(n))
createVoicePlayerWindow()

const LINE = 'Claude Code just finished building your invoice page. Two tests passed. Your next prompt is ready to paste.'
const plays = () => h.sent.filter((m) => m.channel === IPC.VOICE_PLAY_AUDIO || m.channel === IPC.VOICE_PLAY_TTS)

/** Speak a line and let every chunk "finish playing". */
async function speak(text: string): Promise<void> {
  enqueueSpeech({ id: `line-${Math.random()}`, text })
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0))
    const last = plays().at(-1)
    if (last) handleVoiceEnded(last.payload.id)
  }
}

beforeEach(async () => {
  stopVoice()
  resetVoiceDedup() // each test speaks the same line
  h.sent.length = 0
  h.log.length = 0
  h.prefetched.length = 0
  notices.length = 0
  h.settings.elevenLabsApiKey = ''
  h.kokoroState = { state: 'ready' }
  h.eleven.mockReset()
  h.kokoro.mockReset()
  h.kokoro.mockImplementation(async (sentence: string) => Buffer.from(`wav:${sentence}`).toString('base64'))
  resetVoiceHealth()
  await new Promise((r) => setTimeout(r, 0))
})

describe('the voice order', () => {
  it("no ElevenLabs key: Bella speaks, one sentence at a time, made ahead; logged as kokoro", async () => {
    await speak(LINE)
    expect(h.eleven).not.toHaveBeenCalled()
    expect(h.prefetched[0]).toEqual([
      'Claude Code just finished building your invoice page.',
      'Two tests passed. Your next prompt is ready to paste.', // a very short sentence joins the next
    ])
    const audio = plays().filter((p) => p.channel === IPC.VOICE_PLAY_AUDIO)
    expect(audio).toHaveLength(2)
    expect(h.log.find((l) => l.event === 'voice-line')?.details.engine).toBe('kokoro')
    expect(getVoiceFallback()).toBeNull()
  })

  it('ElevenLabs key set and working: ElevenLabs speaks with its own chunking; Kokoro is not used', async () => {
    h.settings.elevenLabsApiKey = 'sk_test'
    resetVoiceHealth()
    await new Promise((r) => setTimeout(r, 0)) // the player re-reads the key
    h.eleven.mockResolvedValue({ success: true, audioBase64: 'bXAz', error: null, failure: null })
    await speak(LINE)
    expect(h.eleven).toHaveBeenCalledTimes(1) // one chunk: the queue's own chunking
    expect(h.kokoro).not.toHaveBeenCalled()
    expect(h.log.find((l) => l.event === 'voice-line')?.details.engine).toBe('elevenlabs')
  })

  it('ElevenLabs fails: Bella speaks instead, and the notice says so with the reason', async () => {
    h.settings.elevenLabsApiKey = 'sk_test'
    resetVoiceHealth()
    await new Promise((r) => setTimeout(r, 0)) // the player re-reads the key
    h.eleven.mockResolvedValue({ success: false, audioBase64: null, error: 'x', failure: 'quota' })
    await speak(LINE)
    expect(h.kokoro).toHaveBeenCalled()
    expect(getVoiceFallback()).toMatchObject({
      headline: "Your voice key isn't working, so MyBuildy is using Buildy's own voice",
      reason: 'Your ElevenLabs credits for this month are used up.',
    })
    expect(h.log).toContainEqual({ event: 'voice-fallback', details: { reason: 'quota', speaking: 'kokoro' } })
  })

  it("Buildy's voice can't run: the computer's voice, announced with the reason", async () => {
    h.kokoroState = { state: 'failed', code: 'kokoro-missing' }
    h.kokoro.mockResolvedValue(null)
    await speak(LINE)
    expect(plays().every((p) => p.channel === IPC.VOICE_PLAY_TTS)).toBe(true)
    expect(getVoiceFallback()).toMatchObject({
      headline: "Buildy's voice couldn't start, so MyBuildy is using your computer's voice",
      reason: "Buildy's voice files are missing from this install. Reinstalling MyBuildy puts them back.",
    })
    expect(h.log.find((l) => l.event === 'voice-line')?.details.engine).toBe('system')
  })

  it('both fail: the computer’s voice, and the notice names the ElevenLabs reason', async () => {
    h.settings.elevenLabsApiKey = 'sk_test'
    resetVoiceHealth()
    await new Promise((r) => setTimeout(r, 0)) // the player re-reads the key
    h.eleven.mockResolvedValue({ success: false, audioBase64: null, error: 'x', failure: 'invalid-key' })
    h.kokoroState = { state: 'failed', code: 'kokoro-failed' }
    h.kokoro.mockResolvedValue(null)
    await speak(LINE)
    expect(getVoiceFallback()?.headline).toBe("Your voice key isn't working, so MyBuildy is using your computer's voice")
    expect(getVoiceFallback()?.reason).toMatch(/didn't accept the key/)
  })
})
