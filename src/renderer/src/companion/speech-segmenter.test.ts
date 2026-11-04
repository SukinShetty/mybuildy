import { describe, it, expect } from 'vitest'
import { SpeechSegmenter } from './speech-segmenter'

const tone = (s: number, amp: number) => { const a = new Float32Array(16000 * s); for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(i / 3); return a }
const noise = (s: number, amp: number) => { const a = new Float32Array(16000 * s); for (let i = 0; i < a.length; i++) a[i] = amp * (Math.random() * 2 - 1); return a }

describe('SpeechSegmenter', () => {
  it('silence and steady low noise give nothing', () => {
    const out: Float32Array[] = []
    const s = new SpeechSegmenter((x) => out.push(x))
    s.push(new Float32Array(16000 * 60)); s.push(noise(60, 0.002))
    expect(out).toHaveLength(0)
  })
  it('one stretch of speech gives one segment, including a little before it', () => {
    const out: Float32Array[] = []
    const s = new SpeechSegmenter((x) => out.push(x))
    s.push(new Float32Array(16000)); s.push(tone(1, 0.2)); s.push(new Float32Array(16000 * 1.5))
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeGreaterThan(16000)
    expect(out[0].length).toBeLessThan(16000 * 2.2)
  })
  it('a click is too short to count', () => {
    const out: Float32Array[] = []
    const s = new SpeechSegmenter((x) => out.push(x))
    s.push(new Float32Array(16000)); s.push(tone(0.1, 0.5)); s.push(new Float32Array(16000 * 1.5))
    expect(out).toHaveLength(0)
  })
  it('very long talk is cut at 8 s', () => {
    const out: Float32Array[] = []
    const s = new SpeechSegmenter((x) => out.push(x))
    s.push(new Float32Array(16000)); s.push(tone(12, 0.2)); s.push(new Float32Array(16000 * 1.5))
    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const seg of out) expect(seg.length).toBeLessThanOrEqual(16000 * 8.5)
  })
})
