// keyword-spotter.ts — the "Hey Buildy" detector, run on this computer.
// Audio (16 kHz) → our own log-mel (log-mel.ts) → Google's speech_embedding network
// (Apache-2.0, re-exported to ONNX by us; see THIRD_PARTY_NOTICES.md) → our own small
// classifier trained only for "Hey Buildy" (scripts/wake-eval/kws.py). Every 80 ms it
// gives a score 0–1; a score over the threshold means the name was said.
// Pure apart from the embedding model call, which is passed in (tested with fakes).
import { BANDS, HOP, WIN, logMelFrame } from './log-mel'

export interface SpotterModels {
  /** embedding network: 76 × 32 log-mel values → 96 values */
  embed(mel76: Float32Array): Promise<Float32Array>
}
export interface Classifier { layers: [number[][], number[]][]; frames: number }

const MEL_WINDOW = 76 // log-mel frames per embedding (~0.775 s)
const MEL_STEP = 8 // one embedding every 8 frames (80 ms)

export function classify(c: Classifier, input: Float32Array): number {
  let h: Float32Array = input
  c.layers.forEach(([W, b], i) => {
    const out = new Float32Array(b.length)
    for (let o = 0; o < b.length; o++) {
      let s = b[o]
      for (let k = 0; k < h.length; k++) s += h[k] * W[k][o]
      out[o] = i < c.layers.length - 1 ? Math.max(0, s) : 1 / (1 + Math.exp(-s))
    }
    h = out
  })
  return h[0]
}

export class KeywordSpotter {
  private audio = new Float32Array(0) // samples not yet fully used by a frame
  private mel: Float32Array[] = []
  private sinceEmbed = 0
  private emb: Float32Array[] = []
  private models: SpotterModels
  private classifier: Classifier
  constructor(models: SpotterModels, classifier: Classifier) {
    this.models = models
    this.classifier = classifier
  }

  reset(): void {
    this.audio = new Float32Array(0); this.mel = []; this.sinceEmbed = 0; this.emb = []
  }

  /** Feed audio (-1..1 floats); returns one score per 80 ms step completed. */
  async push(samples: Float32Array): Promise<number[]> {
    const all = new Float32Array(this.audio.length + samples.length)
    all.set(this.audio); all.set(samples.map((v) => Math.max(-1, Math.min(1, v))), this.audio.length)
    const scores: number[] = []
    let at = 0
    for (; at + WIN <= all.length; at += HOP) {
      const row = new Float32Array(BANDS); logMelFrame(all, at, row, 0)
      this.mel.push(row); if (this.mel.length > MEL_WINDOW) this.mel.shift()
      if (this.mel.length < MEL_WINDOW) continue
      // embedding k uses frames 8k .. 8k+75
      if (this.sinceEmbed-- > 0) continue
      this.sinceEmbed = MEL_STEP - 1
      const win = new Float32Array(MEL_WINDOW * BANDS)
      this.mel.forEach((r, i) => win.set(r, i * BANDS))
      this.emb.push(await this.models.embed(win))
      if (this.emb.length > this.classifier.frames) this.emb.shift()
      if (this.emb.length < this.classifier.frames) continue
      const x = new Float32Array(this.classifier.frames * 96)
      this.emb.forEach((e, r) => x.set(e, r * 96))
      scores.push(classify(this.classifier, x))
    }
    this.audio = all.slice(at)
    return scores
  }
}
