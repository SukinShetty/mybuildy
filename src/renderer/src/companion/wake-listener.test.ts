// Behaviour of the "Hey Buildy" wake word, with a fake microphone (through the real
// openMicrophone), the real segmenter and request matcher, a MOCKED keyword model
// (spot) and a fake listening model.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WakeListener, shouldListenForWakeWord, type ListenIndicator } from './wake-listener'
import { openMicrophone, micButtonState, micErrorMessage } from './voice-mic'
import { defaultNonSecretSettings } from '../types'

// ── a fake Web Audio + getUserMedia ──
let pushAudio: ((s: Float32Array) => void) | null = null
let endTrack: (() => void) | null = null
class FakeAudioContext {
  state = 'running'
  destination = {}
  onstatechange: (() => void) | null = null
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor() {
    const p: { onaudioprocess: ((e: unknown) => void) | null; connect(): void; disconnect(): void } = { onaudioprocess: null, connect() {}, disconnect() {} }
    pushAudio = (s) => p.onaudioprocess?.({ inputBuffer: { getChannelData: () => s } })
    return p
  }
  addEventListener() {}
  close() { this.state = 'closed'; return Promise.resolve() }
}
function fakeMedia() {
  return {
    getUserMedia: vi.fn(async () => {
      const listeners: Record<string, () => void> = {}
      const track = { stop: vi.fn(), addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn }, removeEventListener() {}, set onended(fn: () => void) { listeners.ended = fn } }
      endTrack = () => listeners.ended?.()
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
    }),
  }
}

const sec = (s: number, loud: boolean): Float32Array => {
  const a = new Float32Array(Math.round(16000 * s))
  if (loud) for (let i = 0; i < a.length; i++) a[i] = 0.2 * Math.sin(i / 3)
  return a
}
const flush = () => new Promise((r) => setTimeout(r, 0))
async function say(seconds = 1.2) {
  // quiet lead-in, speech, then enough quiet to end the segment; real time lets the keyword model keep up
  for (const part of [sec(0.6, false), sec(seconds, true), sec(1.2, false)]) {
    for (let i = 0; i < part.length; i += 4096) { pushAudio!(part.subarray(i, i + 4096)); await flush() }
  }
}

let media: ReturnType<typeof fakeMedia>
let indicator: ListenIndicator[]
let messages: (string | undefined)[]
let onCommand: ReturnType<typeof vi.fn>
let heardText: string[]
let fetchSpy: ReturnType<typeof vi.fn>
let wakeNext: boolean // the mocked keyword model says "Hey Buildy" on its next call

function makeListener(opts: { openMic?: () => Promise<never> } = {}) {
  const transcribe = vi.fn(async () => ({ success: true, text: heardText.shift() ?? '' }))
  const spot = vi.fn(async (samples: Float32Array) => {
    const n = Math.floor(samples.length / 1280)
    if (wakeNext && n > 0) { wakeNext = false; return [...new Array(n - 1).fill(0.1), 0.9999] }
    return new Array(n).fill(0.1)
  })
  const timers: (() => void)[] = []
  const listener = new WakeListener({
    openMic: opts.openMic ?? (() => openMicrophone(media)),
    spot,
    transcribe,
    onCommand: (c) => (onCommand as unknown as (c: unknown) => Promise<void>)(c),
    onIndicator: (s, m) => { indicator.push(s); messages.push(m) },
    explainMicError: (e) => micErrorMessage(e, 'win32'),
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })
  return { listener, transcribe, timers, spot }
}

beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  fetchSpy = vi.fn(async () => { throw new Error('no network expected') })
  vi.stubGlobal('fetch', fetchSpy)
  media = fakeMedia()
  indicator = []
  messages = []
  heardText = []
  onCommand = vi.fn(async () => {})
  pushAudio = null
  wakeNext = false
})
afterEach(() => vi.unstubAllGlobals())

const gate = { watching: true, captureNoticeAccepted: true, robotVisible: true, listenModel: 'ready' as const, micButtonRecording: false }

describe('wake word', () => {
  it('is off by default: nothing opens the microphone', async () => {
    const settings = defaultNonSecretSettings()
    expect(settings.wakeWordEnabled).toBe(false)
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: settings.wakeWordEnabled })).toBe(false)
    makeListener() // created, never started (CompanionApp starts it only through the gate)
    await flush()
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops when turned off, the robot is hidden, or the mic button is recording', () => {
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true })).toBe(true)
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true, robotVisible: false })).toBe(false)
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true, watching: false })).toBe(false)
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true, captureNoticeAccepted: false })).toBe(false)
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true, micButtonRecording: true })).toBe(false)
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true, listenModel: 'missing' })).toBe(false)
  })

  it('turning it on opens the microphone and shows the listening indicator; off closes it', async () => {
    const { listener } = makeListener()
    await listener.start()
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)
    expect(indicator.at(-1)).toBe('listening')
    const track = (await media.getUserMedia.mock.results[0].value).getTracks()[0]
    listener.stop()
    expect(track.stop).toHaveBeenCalled()
    expect(indicator.at(-1)).toBe('off')
  })

  it('"Hey Buildy, give me the prompt" (mocked detector) runs the next-prompt action', async () => {
    const { listener } = makeListener()
    await listener.start()
    heardText = ['Hey Buildy, give me the prompt.']
    wakeNext = true
    await say()
    await flush(); await flush(); await flush()
    expect(indicator).toContain('heard')
    expect(onCommand).toHaveBeenCalledWith({ kind: 'suggest-prompt' })
    expect(indicator).toContain('working')
    expect(indicator.at(-1)).toBe('listening')
  })

  it('"Hey Buildy" then a question asks it', async () => {
    const { listener } = makeListener()
    await listener.start()
    heardText = ['Hey Buildy.', 'why did the tests fail?']
    wakeNext = true
    await say(0.6); await flush(); await flush()
    expect(indicator.at(-1)).toBe('heard')
    await say(); await flush(); await flush()
    expect(onCommand).toHaveBeenCalledWith({ kind: 'ask', question: 'why did the tests fail?' })
  })

  it('a false wake with no request goes quietly back to listening: nothing sent anywhere', async () => {
    const { listener, timers } = makeListener()
    await listener.start()
    heardText = ['Okay.']
    wakeNext = true
    await say(); await flush(); await flush()
    expect(indicator).toContain('heard')
    timers.shift()!() // the request window ends
    expect(indicator.at(-1)).toBe('listening')
    expect(onCommand).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('before the wake word nothing is transcribed and nothing goes on the network', async () => {
    const { listener, transcribe, spot } = makeListener()
    await listener.start()
    heardText = ['give me the prompt']
    await say(); await flush(); await flush()
    await say(); await flush(); await flush()
    expect(spot).toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(onCommand).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('pauses while the computer sleeps or the screen is locked', () => {
    expect(shouldListenForWakeWord({ ...gate, wakeWordEnabled: true, systemPaused: true })).toBe(false)
  })

  it('silence never reaches the listening model', async () => {
    const { listener, transcribe } = makeListener()
    await listener.start()
    const quiet = sec(30, false)
    for (let i = 0; i < quiet.length; i += 4096) pushAudio!(quiet.subarray(i, i + 4096))
    await flush()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('a lost microphone (unplugged / sleep) restarts listening, then gives up with a message', async () => {
    const { listener, timers } = makeListener()
    await listener.start()
    for (let i = 0; i < 3; i++) {
      endTrack!()
      expect(indicator.at(-1)).toBe('starting')
      timers.shift()!(); await flush()
      expect(indicator.at(-1)).toBe('listening')
    }
    expect(media.getUserMedia).toHaveBeenCalledTimes(4)
    endTrack!()
    expect(indicator.at(-1)).toBe('error')
    expect(messages.at(-1)).toMatch(/lost the microphone/)
  })

  it('a microphone switch reopens on the new one', async () => {
    const { listener } = makeListener()
    await listener.start()
    await listener.microphoneChanged()
    expect(media.getUserMedia).toHaveBeenCalledTimes(2)
    expect(indicator.at(-1)).toBe('listening')
  })

  it('a blocked microphone on Windows explains the privacy setting, and does not retry', async () => {
    const blocked = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const openMic = vi.fn(async () => { throw blocked })
    const { listener, timers } = makeListener({ openMic })
    await listener.start()
    expect(indicator.at(-1)).toBe('error')
    expect(messages.at(-1)).toMatch(/Privacy & security > Microphone/)
    expect(messages.at(-1)).toMatch(/Let desktop apps access your microphone/)
    expect(timers).toHaveLength(0)
    expect(openMic).toHaveBeenCalledTimes(1)
  })
})

describe('mic button', () => {
  it('is shown without an ElevenLabs key and records on this computer', () => {
    const b = micButtonState({ listenModel: 'ready', hasElevenKey: false, watching: true })
    expect(b).toMatchObject({ visible: true, canRecord: true, via: 'on-device' })
  })
  it('with no listening model and no key it is still shown and explains how to get voice working', () => {
    const b = micButtonState({ listenModel: 'missing', hasElevenKey: false, watching: true })
    expect(b.visible).toBe(true)
    expect(b.canRecord).toBe(false)
    expect(b.explain).toMatch(/ElevenLabs key in Settings > Voice/)
  })
  it('falls back to ElevenLabs when a key is saved and the model is missing', () => {
    expect(micButtonState({ listenModel: 'missing', hasElevenKey: true, watching: true }).via).toBe('elevenlabs')
  })
  it('error words name the right place on each system', () => {
    const e = { name: 'NotAllowedError' }
    expect(micErrorMessage(e, 'win32')).toMatch(/Windows Settings > Privacy & security > Microphone/)
    expect(micErrorMessage(e, 'darwin')).toMatch(/System Settings > Privacy & Security > Microphone/)
    expect(micErrorMessage({ name: 'NotFoundError' }, 'win32')).toMatch(/No microphone found/)
  })
})

// Review findings on 26c14e19: each of these failed there.
describe('wake word: state stays true to the detector (regressions)', () => {
  it('stop + start while a keyword check is still running: detection resumes, the indicator is not lying', async () => {
    const { listener, spot } = makeListener()
    let release!: (v: number[]) => void
    spot.mockImplementationOnce(() => new Promise<number[]>((r) => { release = r }))
    await listener.start()
    await say(0.4) // first check is now stuck in flight
    listener.stop()
    await listener.start()
    release([0.1]); await flush()
    expect(indicator.at(-1)).toBe('listening')
    const before = spot.mock.calls.length
    heardText = ['Hey Buildy, give me the prompt.']
    wakeNext = true
    await say(); await flush(); await flush(); await flush()
    expect(spot.mock.calls.length).toBeGreaterThan(before) // the detector really runs again
    expect(onCommand).toHaveBeenCalledWith({ kind: 'suggest-prompt' })
  })

  it('a slow empty transcription that outlives the 6 s window does not leave it armed: later speech needs a new wake', async () => {
    const { listener, transcribe, timers } = makeListener()
    let release!: (v: { success: boolean; text: string }) => void
    transcribe.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await listener.start()
    wakeNext = true
    await say(0.6); await flush() // wake + a segment whose transcription hangs
    expect(transcribe).toHaveBeenCalledTimes(1)
    timers.at(-1)!() // window deadline passes while transcribing
    release({ success: true, text: '' }); await flush(); await flush()
    expect(indicator.at(-1)).toBe('listening')
    heardText = ['why did the tests fail?']
    await say(); await flush(); await flush()
    expect(onCommand).not.toHaveBeenCalled()
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('a late transcription of a real request after the window closed is discarded', async () => {
    let t = 0
    const { listener, transcribe } = makeListener()
    ;(listener as unknown as { deps: { now: () => number } }).deps.now = () => t
    let release!: (v: { success: boolean; text: string }) => void
    transcribe.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await listener.start()
    wakeNext = true
    await say(0.6); await flush()
    t += 7000 // the window timer is late (busy event loop), but the deadline has passed
    release({ success: true, text: 'why did the tests fail?' }); await flush(); await flush()
    expect(onCommand).not.toHaveBeenCalled()
    expect(indicator.at(-1)).toBe('listening')
  })
})
