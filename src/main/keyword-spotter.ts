// keyword-spotter.ts — the "Hey Buildy" detector, run on this computer.
// Audio (16 kHz) → a mel spectrogram and a general speech "embedding" (two small
// ONNX models from the open-source openWakeWord project) → our own small
// classifier, trained only for "Hey Buildy" (scripts/wake-eval/kws.py). Every
// 80 ms it gives a score 0–1; a score over the threshold means the name was said.
// Pure apart from the two model calls, which are passed in (tested with fakes).

export interface SpotterModels {
  /** mel model: audio as int16-range floats → frames × 32 values */
  mel(samples: Float32Array): Promise<Float32Array>
  /** embedding model: 76 × 32 mel values → 96 values */
  embed(mel76: Float32Array): Promise<Float32Array>
}
export interface Classifier { layers: [number[][], number[]][]; frames: number }

const CHUNK = 1280 // 80 ms
const MEL_CONTEXT = 480 // the mel model needs 3 extra hops of audio before each chunk
const MEL_BINS = 32
const MEL_WINDOW = 76

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
  private pending = new Float32Array(0)
  private tail = new Float32Array(MEL_CONTEXT)
  private mel: Float32Array[] = []
  private emb: Float32Array[] = []
  private models: SpotterModels
  private classifier: Classifier
  constructor(models: SpotterModels, classifier: Classifier) {
    this.models = models
    this.classifier = classifier
  }

  reset(): void {
    this.pending = new Float32Array(0); this.tail = new Float32Array(MEL_CONTEXT); this.mel = []; this.emb = []
  }

  /** Feed audio (-1..1 floats); returns one score per 80 ms step completed. */
  async push(samples: Float32Array): Promise<number[]> {
    const all = new Float32Array(this.pending.length + samples.length)
    all.set(this.pending); all.set(samples, this.pending.length)
    const scores: number[] = []
    let at = 0
    for (; at + CHUNK <= all.length; at += CHUNK) {
      const chunk = new Float32Array(MEL_CONTEXT + CHUNK)
      chunk.set(this.tail); chunk.set(all.subarray(at, at + CHUNK), MEL_CONTEXT)
      this.tail = chunk.slice(chunk.length - MEL_CONTEXT)
      const pcm = chunk.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))
      const m = await this.models.mel(pcm)
      for (let f = 0; f + MEL_BINS <= m.length; f += MEL_BINS) this.mel.push(m.slice(f, f + MEL_BINS).map((v) => v / 10 + 2))
      if (this.mel.length > MEL_WINDOW + 16) this.mel.splice(0, this.mel.length - MEL_WINDOW - 16)
      if (this.mel.length < MEL_WINDOW) continue
      const win = new Float32Array(MEL_WINDOW * MEL_BINS)
      this.mel.slice(-MEL_WINDOW).forEach((row, r) => win.set(row, r * MEL_BINS))
      this.emb.push(await this.models.embed(win))
      if (this.emb.length > this.classifier.frames) this.emb.shift()
      if (this.emb.length < this.classifier.frames) continue
      const x = new Float32Array(this.classifier.frames * 96)
      this.emb.forEach((e, r) => x.set(e, r * 96))
      scores.push(classify(this.classifier, x))
    }
    this.pending = all.slice(at)
    return scores
  }
}
