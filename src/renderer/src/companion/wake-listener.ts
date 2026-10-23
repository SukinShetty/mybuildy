// wake-listener.ts — "MyBuildy, …" hands-free. Runs ONLY while the user has
// turned the wake word on in Settings > Voice (off by default), MyBuildy is
// watching their coding agent, and the robot is on screen.
//
// Microphone → speech-segmenter (loudness only) → on-device listening model
// (main/listen-engine.ts) → wake-phrase.ts. Nothing is sent anywhere until the
// wake word is heard: then the words after it go through the same ask flow as
// the mic button ("give me the prompt" → the next prompt).
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
  | 'starting'  // opening the microphone / loading the listening model
  | 'listening' // waiting for "MyBuildy"
  | 'heard'     // "MyBuildy" heard: waiting for the question
  | 'working'   // a command is being answered
  | 'error'     // stopped; the message says why and what to do

export interface WakeListenerDeps {
  openMic(): Promise<MicHandle>
  /** On-device speech-to-text only. */
  transcribe(samples: Float32Array): Promise<{ success: boolean; text: string; error?: string }>
  onCommand(command: VoiceCommand): Promise<void>
  onIndicator(state: ListenIndicator, message?: string): void
  /** Plain words for a microphone error (voice-mic.ts). */
  explainMicError(error: unknown): string
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
}): boolean {
  return input.wakeWordEnabled === true && input.watching && input.captureNoticeAccepted && input.robotVisible &&
    input.listenModel !== 'missing' && input.listenModel !== 'failed' && !input.micButtonRecording
}

/** After "MyBuildy" alone, how long the next thing said counts as the question. */
export const FOLLOW_UP_MS = 6000
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 1500

export class WakeListener {
  private mic: MicHandle | null = null
  private segmenter: SpeechSegmenter | null = null
  private wanted = false
  private busy = false
  private awaitingCommandUntil = 0
  private restarts = 0
  private restartTimer: unknown = null
  private generation = 0
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
    this.closeMic()
    this.busy = false
    this.awaitingCommandUntil = 0
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
    this.segmenter = new SpeechSegmenter((segment) => { void this.onSegment(segment, gen) })
    mic.onSamples((samples) => { if (gen === this.generation) this.segmenter?.push(samples) })
    mic.onEnded(() => { if (gen === this.generation) this.micLost() })
    this.deps.onIndicator('listening')
  }

  private micLost(): void {
    this.closeMic()
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
  }

  private async onSegment(segment: Float32Array, gen: number): Promise<void> {
    // One stretch at a time: while one is being read or answered, others are dropped.
    if (this.busy) return
    this.busy = true
    try {
      const result = await this.deps.transcribe(segment)
      if (gen !== this.generation) return
      if (!result.success) {
        // The listening model itself failed (not just "couldn't make it out").
        if (result.error && /isn't available/.test(result.error)) {
          this.wanted = false
          this.closeMic()
          this.deps.onIndicator('error', result.error)
        }
        return
      }
      const now = Date.now()
      let commandText: string | null = null
      if (this.awaitingCommandUntil > now) {
        commandText = result.text
        this.awaitingCommandUntil = 0
      } else {
        const match = findWakePhrase(result.text)
        if (!match.heard) return
        if (!match.command) {
          this.awaitingCommandUntil = now + FOLLOW_UP_MS
          this.deps.onIndicator('heard')
          return
        }
        commandText = match.command
      }
      const command = routeCommand(commandText)
      if (command.kind === 'none') { this.deps.onIndicator('listening'); return }
      this.deps.onIndicator('working')
      await this.deps.onCommand(command)
      if (gen === this.generation && this.wanted) this.deps.onIndicator('listening')
    } catch (error) {
      console.warn('[Wake] segment failed:', String(error).slice(0, 120))
      if (gen === this.generation && this.wanted) this.deps.onIndicator('listening')
    } finally {
      if (gen === this.generation) this.busy = false
    }
  }
}
