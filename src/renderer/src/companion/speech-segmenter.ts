// speech-segmenter.ts — finds stretches of speech in the microphone stream
// (16 kHz mono), so only those go to the on-device listening model. Silence is
// dropped here and costs nothing but this loudness check.
//
// A simple loudness gate that adapts to the room: the background level is
// tracked continuously (follows quiet quickly, noise slowly), and speech is
// sound clearly above it. A stretch ends after 0.7 s of quiet, or at 8 s.
// Pure and unit-tested; the same code runs in the audio eval.

export const SAMPLE_RATE = 16_000
const FRAME = 480 // 30 ms
const START_FRAMES = 3 // 90 ms of speech starts a stretch
const END_FRAMES = 24 // 0.72 s of quiet ends it
const PREROLL_FRAMES = 10 // keep 0.3 s before the start (the first syllable)
const MAX_FRAMES = Math.round((8 * SAMPLE_RATE) / FRAME)
const MIN_FRAMES = 12 // shorter than 0.36 s: a click or a cough, dropped
const MIN_LEVEL = 0.003 // below this it is quiet, whatever the room

export class SpeechSegmenter {
  private floor = 0.002
  private pending = new Float32Array(0)
  private preroll: Float32Array[] = []
  private speech: Float32Array[] | null = null
  private loudRun = 0
  private quietRun = 0
  private voicedFrames = 0

  private readonly onSegment: (samples: Float32Array) => void

  constructor(onSegment: (samples: Float32Array) => void) {
    this.onSegment = onSegment
  }

  /** Current background level (for tests). */
  get noiseFloor(): number {
    return this.floor
  }

  push(samples: Float32Array): void {
    let buf = samples
    if (this.pending.length) {
      buf = new Float32Array(this.pending.length + samples.length)
      buf.set(this.pending)
      buf.set(samples, this.pending.length)
    }
    let i = 0
    for (; i + FRAME <= buf.length; i += FRAME) this.frame(buf.slice(i, i + FRAME))
    this.pending = buf.slice(i)
  }

  /** Forget everything (e.g. the microphone changed). */
  reset(): void {
    this.pending = new Float32Array(0)
    this.preroll = []
    this.speech = null
    this.loudRun = 0
    this.quietRun = 0
  }

  private frame(f: Float32Array): void {
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    const level = Math.sqrt(sum / f.length)
    const loud = level > Math.max(MIN_LEVEL, this.floor * 3)
    // Background: falls fast to quieter sound, rises slowly (so speech doesn't become "background").
    this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * 0.998 + level * 0.002
    this.floor = Math.max(this.floor, 0.0005)

    if (!this.speech) {
      this.preroll.push(f)
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift()
      this.loudRun = loud ? this.loudRun + 1 : 0
      if (this.loudRun >= START_FRAMES) {
        this.speech = [...this.preroll]
        this.preroll = []
        this.quietRun = 0
        this.voicedFrames = this.loudRun
      }
      return
    }
    this.speech.push(f)
    if (loud) { this.quietRun = 0; this.voicedFrames++ } else this.quietRun++
    if (this.quietRun >= END_FRAMES || this.speech.length >= MAX_FRAMES) this.finish()
  }

  private finish(): void {
    const frames = this.speech ?? []
    this.speech = null
    this.loudRun = 0
    this.quietRun = 0
    if (this.voicedFrames < MIN_FRAMES) return
    const out = new Float32Array(frames.length * FRAME)
    frames.forEach((fr, k) => out.set(fr, k * FRAME))
    this.onSegment(out)
  }
}
