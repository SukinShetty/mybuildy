// voice-mic.ts — the ONE place MyBuildy opens the microphone, and what the mic
// button can do on this computer.
//
// The microphone is opened only (a) when the user clicks the mic button, or
// (b) while the user has turned on the "Hey Buildy" wake word in Settings > Voice.
// Setup never opens it (setup/microphone-rule.test.ts).

import type { MicHandle } from './wake-listener'

export type ListenModel = 'missing' | 'off' | 'loading' | 'ready' | 'failed'

export interface MicButton {
  /** The button is always on the robot's bar. */
  visible: true
  /** Clicking records (otherwise it explains). */
  canRecord: boolean
  /** How the question will be turned into text. */
  via: 'on-device' | 'elevenlabs' | null
  /** Said when clicked and it can't record (or as its tooltip). */
  explain: string | null
}

export const NO_SPEECH_TO_TEXT_MESSAGE =
  "MyBuildy can't turn speech into text on this computer yet: its listening model is missing. Reinstall MyBuildy, or add your ElevenLabs key in Settings > Voice."

/** What the mic button does, given what this computer has. */
export function micButtonState(input: { listenModel: ListenModel; hasElevenKey: boolean; watching: boolean }): MicButton {
  const local = input.listenModel !== 'missing' && input.listenModel !== 'failed'
  const via = local ? 'on-device' : input.hasElevenKey ? 'elevenlabs' : null
  if (!via) return { visible: true, canRecord: false, via, explain: NO_SPEECH_TO_TEXT_MESSAGE }
  if (!input.watching) return { visible: true, canRecord: false, via, explain: 'Ask out loud once MyBuildy is watching your coding agent' }
  return { visible: true, canRecord: true, via, explain: null }
}

/** Plain words for a microphone error, with where to fix it on this computer. */
export function micErrorMessage(error: unknown, platform: string): string {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    if (platform === 'win32') {
      return 'Windows is blocking the microphone. Open Windows Settings > Privacy & security > Microphone, turn on "Microphone access" and "Let desktop apps access your microphone", then try again.'
    }
    if (platform === 'darwin') {
      return 'Your Mac is blocking the microphone. Open System Settings > Privacy & Security > Microphone, turn on MyBuildy, then try again.'
    }
    return 'The microphone is blocked. Allow MyBuildy to use it in your system settings, then try again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found. Plug one in (or turn it on), then try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'Another app is using the microphone, or it stopped working. Close that app or reconnect the mic, then try again.'
  }
  return "MyBuildy couldn't open the microphone. Check it's connected and allowed, then try again."
}

export interface OpenedMic extends MicHandle {
  stream: MediaStream
}

/** Open the microphone: the stream, plus 16 kHz mono samples for on-device listening. */
export async function openMicrophone(media: Pick<MediaDevices, 'getUserMedia'> = navigator.mediaDevices): Promise<OpenedMic> {
  const stream = await media.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let context: AudioContext | null = null
  let sampleHandler: ((samples: Float32Array) => void) | null = null
  let endedHandler: (() => void) | null = null
  let closed = false
  try {
    context = new AudioContext({ sampleRate: 16_000 })
    const source = context.createMediaStreamSource(stream)
    // 4096 samples = 4 callbacks a second at 16 kHz: almost no work while quiet.
    const processor = context.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => { sampleHandler?.(new Float32Array(e.inputBuffer.getChannelData(0))) }
    source.connect(processor)
    processor.connect(context.destination) // needed for the callback to run; it outputs silence
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop())
    throw error
  }
  const ended = (): void => { if (!closed) endedHandler?.() }
  for (const track of stream.getAudioTracks()) track.addEventListener('ended', ended)
  // Sleep / resume: the audio may be suspended or the track ended underneath us.
  context.addEventListener('statechange', () => { if (context?.state === 'closed') ended() })
  return {
    stream,
    onSamples: (h) => { sampleHandler = h },
    onEnded: (h) => { endedHandler = h },
    close: () => {
      if (closed) return
      closed = true
      stream.getTracks().forEach((t) => t.stop())
      void context?.close().catch(() => {})
    },
  }
}

/** A recorded clip (any format the browser can decode) → 16 kHz mono samples. */
export async function decodeTo16k(audio: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 16_000, 16_000)
  const decoded = await ctx.decodeAudioData(audio.slice(0))
  const length = Math.ceil(decoded.duration * 16_000)
  const offline = new OfflineAudioContext(1, Math.max(1, length), 16_000)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}
