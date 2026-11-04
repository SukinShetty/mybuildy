import { describe, it, expect } from 'vitest'
import { KeywordSpotter, classify, type Classifier } from './keyword-spotter'
import { logMel } from './log-mel'

// A fake embedding (mean of the window per 3 bands) and a tiny classifier: tests the streaming, not the model.
const embed = async (m: Float32Array) => {
  const out = new Float32Array(96)
  for (let i = 0; i < m.length; i++) out[i % 96] += m[i] / 100
  return out
}
const clf: Classifier = { frames: 16, layers: [[Array.from({ length: 1536 }, (_, i) => [((i % 7) - 3) / 50]), [0.1]]] }
const audio = Float32Array.from({ length: 16000 * 4 }, (_, i) => 0.3 * Math.sin(i / 5) * Math.sin(i / 3000))

describe('KeywordSpotter', () => {
  it('first score after ~2 s, then one every 80 ms; the same however the audio is chunked', async () => {
    const whole = await new KeywordSpotter({ embed }, clf).push(audio)
    // first embedding needs 12 400 samples, then one per 1280; scores need 16 embeddings
    expect(whole.length).toBe(Math.floor((audio.length - 12400) / 1280) + 1 - 15)
    const s = new KeywordSpotter({ embed }, clf); const parts: number[] = []
    for (let i = 0; i < audio.length; i += 777) parts.push(...(await s.push(audio.subarray(i, i + 777))))
    expect(parts.length).toBe(whole.length)
    parts.forEach((v, i) => expect(v).toBeCloseTo(whole[i], 6))
  })
  it('classify is a small ReLU network with a sigmoid output', () => {
    expect(classify({ frames: 1, layers: [[[[1]], [0]], [[[2]], [-1]]] }, Float32Array.of(1))).toBeCloseTo(1 / (1 + Math.exp(-1)))
  })
  it('log-mel: 32 bands per 10 ms frame, finite', () => {
    const m = logMel(audio.subarray(0, 16000))
    expect(m.length).toBe((1 + Math.floor((16000 - 400) / 160)) * 32)
    expect(m.every(Number.isFinite)).toBe(true)
  })
})
