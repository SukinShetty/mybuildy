// log-mel.ts — the log-mel features Google's speech_embedding expects, in our own code
// (same maths as scripts/wake-model/logmel.py): 25 ms periodic-Hann frames every 10 ms,
// |FFT 512|, 32 HTK-mel bands 60–3800 Hz, log(x + 0.001). 16 kHz input, -1..1 floats.

export const SR = 16000, WIN = 400, HOP = 160, NFFT = 512, BANDS = 32
const LO = 60, HI = 3800
const BINS = NFFT / 2 + 1

function melMatrix(): Float32Array {
  const hz2mel = (f: number) => 1127 * Math.log(1 + f / 700)
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => hz2mel(LO) + ((hz2mel(HI) - hz2mel(LO)) * i) / (BANDS + 1))
  const m = new Float32Array(BINS * BANDS) // row 0 (DC) stays zero
  for (let k = 1; k < BINS; k++) {
    const mel = hz2mel((k * (SR / 2)) / (BINS - 1))
    for (let b = 0; b < BANDS; b++) {
      const [lo, c, hi] = [edges[b], edges[b + 1], edges[b + 2]]
      m[k * BANDS + b] = Math.max(0, Math.min((mel - lo) / (c - lo), (hi - mel) / (hi - c)))
    }
  }
  return m
}
const MEL = melMatrix()
const HANN = Float32Array.from({ length: WIN }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WIN))
const REV = Uint16Array.from({ length: NFFT }, (_, i) => { let r = 0; for (let b = 0, v = i; b < 9; b++, v >>= 1) r = (r << 1) | (v & 1); return r })
const COS = Float64Array.from({ length: NFFT / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / NFFT))
const SIN = Float64Array.from({ length: NFFT / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / NFFT))
const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mag = new Float64Array(BINS)

/** one frame (WIN samples starting at `at`) → BANDS log-mel values written into out[o..] */
export function logMelFrame(x: Float32Array, at: number, out: Float32Array, o: number): void {
  re.fill(0); im.fill(0)
  for (let n = 0; n < WIN; n++) re[REV[n]] = x[at + n] * HANN[n]
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size
    for (let s = 0; s < NFFT; s += size) for (let j = 0; j < half; j++) {
      const wr = COS[j * step], wi = SIN[j * step], a = s + j, b = a + half
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
    }
  }
  for (let k = 0; k < BINS; k++) mag[k] = Math.hypot(re[k], im[k])
  for (let b = 0; b < BANDS; b++) {
    let s = 0
    for (let k = 1; k < BINS; k++) s += mag[k] * MEL[k * BANDS + b]
    out[o + b] = Math.log(s + 0.001)
  }
}

/** all frames of x → frames × BANDS */
export function logMel(x: Float32Array): Float32Array {
  const n = Math.max(0, 1 + Math.floor((x.length - WIN) / HOP))
  const out = new Float32Array(n * BANDS)
  for (let f = 0; f < n; f++) logMelFrame(x, f * HOP, out, f * BANDS)
  return out
}
