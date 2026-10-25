// wake-listener.ts — "Hey Buildy, …" hands-free. Runs ONLY while the user has
// turned the wake word on in Settings > Voice (off by default), MyBuildy is
// watching their coding agent, the robot is on screen and the computer is awake.
//
// Microphone → keyword model ("Hey Buildy" score every 80 ms, computed on this
// computer: main/keyword-spotter.ts in the listening process). Nothing else
// happens until the score passes WAKE_THRESHOLD. Then, for COMMAND_WINDOW_MS,
// the next stretch of speech (speech-segmenter.ts) is turned into text on this
// computer and, if it is a real request, goes through the same ask flow as the
// mic button ("give me the prompt" → the next prompt). If no request is heard
// (a false wake), it quietly goes back to listening: nothing is sent anywhere.
//
// Recovery: if the microphone goes away (unplugged, switched, the computer
// slept) listening restarts on its own a few times, then says so. A blocked
// microphone stops listening and explains how to allow it; it never retries
// in a loop. Pure: everything outside is passed in (unit-tested with fakes).

import { SpeechSegmenter } from './speech-segmenter'
import { findWakePhrase, routeCommand, type VoiceCommand } from './wake-phrase'

export interface MicHandle {
  /** 16 kHz mono samples, as they arrive. */
  onSamples(handler: (samples: Float32Array) => void): void
  /** The microphone stopped (unplugged, switched, sleep). */
  onEnded(handler: () => void): void
  close(): void
}

export type ListenIndicator =
  | 'off'       // not listening
  | 'starting'  // opening the microphone / loading the models
  | 'listening' // waiting for "Hey Buildy"
  | 'heard'     // "Hey Buildy" heard: waiting for the request
  | 'working'   // a request is being answered
  | 'error'     // stopped; the message says why and what to do

export interface WakeListenerDeps {
  openMic(): Promise<MicHandle>
  /** On-device keyword scores (one per 80 ms) for these samples; reset = new stream. */
  spot(samples: Float32Array, reset: boolean): Promise<number[]>
  /** On-device speech-to-text only. */
  transcribe(samples: Float32Array): Promise<{ success: boolean; text: string; error?: string }>
  onCommand(command: VoiceCommand): Promise<void>
  onIndicator(state: ListenIndicator, message?: string): void
  /** Plain words for a microphone error (voice-mic.ts). */
  explainMicError(error: unknown): string
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

/** Listen for the wake word only when ALL of these hold. */
export function shouldListenForWakeWord(input: {
  wakeWordEnabled: boolean
  watching: boolean
  captureNoticeAccepted: boolean
  robotVisible: boolean
  listenModel: 'missing' | 'off' | 'loading' | 'ready' | 'failed'
  micButtonRecording: boolean
  /** The computer is asleep or the screen is locked. */
  systemPaused?: boolean
}): boolean {
  return input.wakeWordEnabled === true && input.watching && input.captureNoticeAccepted && input.robotVisible &&
    input.listenModel !== 'missing' && input.listenModel !== 'failed' && !input.micButtonRecording && input.systemPaused !== true
}

/** Keyword score that counts as "Hey Buildy" (eval, synthetic voices: 91.8% quiet, 76.5% noisy, 1.5 false/h on read speech). */
export const WAKE_THRESHOLD = 0.9995
/** After the wake word, how long a request is waited for before quietly listening again. */
export const COMMAND_WINDOW_MS = 6000
/** Audio sent to the keyword model at a time (160 ms). */
const SPOT_CHUNK = 2560
/** If the keyword model falls this far behind (slow computer), old audio is dropped. */
const MAX_BACKLOG = 16000
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 1500

/** A request worth acting on: at least two words, or "the prompt"-style requests. */
export function realRequest(text: string): VoiceCommand {
  const match = findWakePhrase(text)
  const said = (match.heard ? match.command : text).trim()
  const command = routeCommand(said)
  if (command.kind === 'ask' && said.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length < 2) return { kind: 'none' }
  return command
}

export class WakeListener {
  private mic: MicHandle | null = null
  private segmenter: SpeechSegmenter | null = null
  private wanted = false
  private busy = false
  private woke = false
  private windowTimer: unknown = null
  private restarts = 0
  private restartTimer: unknown = null
  private generation = 0
  private spotQueue: Float32Array[] = []
  private spotQueued = 0
  private spotting = false
  private spotReset = true
  private readonly deps: WakeListenerDeps

  constructor(deps: WakeListenerDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.mic !== null
  }

  async start(): Promise<void> {
    if (this.wanted) return
    this.wanted = true
    this.restarts = 0
    await this.open()
  }

  stop(): void {
    this.wanted = false
    this.generation++
    this.cancelRestart()
    this.endWindow()
    this.closeMic()
    this.busy = false
    this.deps.onIndicator('off')
  }

  private async open(): Promise<void> {
    const gen = ++this.generation
    this.deps.onIndicator('starting')
    let mic: MicHandle
    try {
      mic = await this.deps.openMic()
    } catch (error) {
      if (gen !== this.generation) return
      this.wanted = false
      this.deps.onIndicator('error', this.deps.explainMicError(error))
      return
    }
    if (gen !== this.generation || !this.wanted) { mic.close(); return }
    this.mic = mic
    this.spotQueue = []; this.spotQueued = 0; this.spotReset = true
    this.segmenter = new SpeechSegmenter((segment) => { void this.onSegment(segment, gen) })
    mic.onSamples((samples) => {
      if (gen !== this.generation) return
      this.segmenter?.push(samples)
      if (!this.woke && !this.busy) this.queueSpot(samples, gen)
    })
    mic.onEnded(() => { if (gen === this.generation) this.micLost() })
    this.deps.onIndicator('listening')
  }

  private queueSpot(samples: Float32Array, gen: number): void {
    this.spotQueue.push(samples); this.spotQueued += samples.length
    if (this.spotQueued > MAX_BACKLOG) { this.spotQueue = [samples]; this.spotQueued = samples.length; this.spotReset = true }
    if (!this.spotting && this.spotQueued >= SPOT_CHUNK) void this.runSpot(gen)
  }

  private async runSpot(gen: number): Promise<void> {
    this.spotting = true
    try {
      while (this.spotQueued >= SPOT_CHUNK && gen === this.generation && !this.woke && !this.busy) {
        const chunk = new Float32Array(this.spotQueued)
        let at = 0
        for (const part of this.spotQueue) { chunk.set(part, at); at += part.length }
        this.spotQueue = []; this.spotQueued = 0
        const reset = this.spotReset; this.spotReset = false
        const scores = await this.deps.spot(chunk, reset)
        if (gen !== this.generation) return
        if (scores.some((s) => s >= WAKE_THRESHOLD)) this.wake()
      }
    } catch (error) {
      console.warn('[Wake] keyword model failed:', String(error).slice(0, 120))
    } finally {
      if (gen === this.generation) this.spotting = false
    }
  }

  private wake(): void {
    this.woke = true
    this.spotQueue = []; this.spotQueued = 0; this.spotReset = true
    this.deps.onIndicator('heard')
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    // No request in time (often a false wake): back to listening, nothing sent anywhere.
    this.windowTimer = set(() => { this.windowTimer = null; if (this.woke && !this.busy) this.backToListening() }, COMMAND_WINDOW_MS)
  }

  private endWindow(): void {
    this.woke = false
    if (this.windowTimer === null) return
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    clear(this.windowTimer)
    this.windowTimer = null
  }

  private backToListening(): void {
    this.endWindow()
    if (this.wanted && this.mic) this.deps.onIndicator('listening')
  }

  private micLost(): void {
    this.closeMic()
    this.endWindow()
    if (!this.wanted) return
    if (this.restarts >= MAX_RESTARTS) {
      this.wanted = false
      this.deps.onIndicator('error', "MyBuildy lost the microphone. Check it's plugged in, then turn listening on again.")
      return
    }
    this.restarts++
    this.deps.onIndicator('starting')
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.restartTimer = set(() => { this.restartTimer = null; if (this.wanted) void this.open() }, RESTART_DELAY_MS)
  }

  /** The microphone list changed (plugged/unplugged): reopen on the current default. */
  async microphoneChanged(): Promise<void> {
    if (!this.wanted) return
    this.closeMic()
    this.endWindow()
    this.restarts = 0
    await this.open()
  }

  private cancelRestart(): void {
    if (this.restartTimer === null) return
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    clear(this.restartTimer)
    this.restartTimer = null
  }

  private closeMic(): void {
    this.mic?.close()
    this.mic = null
    this.segmenter = null
    this.spotQueue = []; this.spotQueued = 0
  }

  /** A stretch of speech ended. Only used in the few seconds after "Hey Buildy". */
  private async onSegment(segment: Float32Array, gen: number): Promise<void> {
    if (!this.woke || this.busy) return
    this.busy = true
    try {
      const result = await this.deps.transcribe(segment)
      if (gen !== this.generation) return
      if (!result.success) {
        if (result.error && /isn't available/.test(result.error)) {
          this.wanted = false
          this.closeMic()
          this.endWindow()
          this.deps.onIndicator('error', result.error)
        }
        return
      }
      const command = realRequest(result.text)
      // Just the name ("Hey Buildy.") or nothing useful: keep waiting until the window ends.
      if (command.kind === 'none') return
      this.endWindow()
      this.deps.onIndicator('working')
      await this.deps.onCommand(command)
      if (gen === this.generation && this.wanted) this.deps.onIndicator('listening')
    } catch (error) {
      console.warn('[Wake] request failed:', String(error).slice(0, 120))
      if (gen === this.generation && this.wanted) this.backToListening()
    } finally {
      if (gen === this.generation) this.busy = false
      if (gen === this.generation && !this.woke && this.wanted && this.mic) this.spotReset = true
    }
  }
}
