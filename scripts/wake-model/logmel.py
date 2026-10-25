# The log-mel features Google's speech_embedding expects (same maths as its TF graph):
# 25 ms periodic-Hann frames every 10 ms, |FFT 512|, 32 mel bands 60-3800 Hz (HTK mel), log(x + 0.001).
import numpy as np
SR, WIN, HOP, NFFT, BANDS, LO, HI = 16000, 400, 160, 512, 32, 60.0, 3800.0
def mel_matrix():
    hz2mel = lambda f: 1127.0 * np.log(1.0 + f / 700.0)
    bins = hz2mel(np.linspace(0.0, SR / 2, NFFT // 2 + 1)[1:])[:, None]
    edges = np.linspace(hz2mel(LO), hz2mel(HI), BANDS + 2)
    lower, center, upper = edges[:-2][None], edges[1:-1][None], edges[2:][None]
    w = np.maximum(0.0, np.minimum((bins - lower) / (center - lower), (upper - bins) / (upper - center)))
    return np.pad(w, [[1, 0], [0, 0]]).astype(np.float32)  # (257, 32)
MEL = mel_matrix()
HANN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)).astype(np.float32)
def logmel(x):
    n = 1 + (len(x) - WIN) // HOP
    if n <= 0: return np.zeros((0, BANDS), np.float32)
    idx = np.arange(WIN)[None] + HOP * np.arange(n)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * HANN, NFFT)).astype(np.float32)
    return np.log(mag @ MEL + 0.001).astype(np.float32)
