# Eval conditions shared by the Python eval scripts (same definitions as run.mjs).
import json, os, numpy as np
man = None; setdir = None; chats = None
def init(d):
    global man, setdir, chats
    setdir = d; man = json.load(open(os.path.join(d, 'manifest.json'))); chats = [m for m in man if m['kind'] == 'chat']
load = lambda m: np.fromfile(os.path.join(setdir, 'clips', m['file']), dtype=np.float32)
rms = lambda x: float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
def babble(rng, n):
    o = np.zeros(n, np.float32)
    for _ in range(2):
        at = 0
        while at < n:
            c = load(chats[rng.integers(len(chats))]); k = min(len(c), n - at); o[at:at + k] += c[:k]; at += len(c) + 2000
    return o
def render(s, cond, rng):
    pad = 16000; o = np.zeros(pad + len(s) + 19200, np.float32); sp = rms(s)
    if cond == 'far':
        y = np.zeros_like(s); lp = 0.0
        for i in range(len(s)): lp = lp * 0.6 + s[i] * 0.4; y[i] = lp
        z = y.copy(); z[800:] += 0.35 * y[:-800]; z[1900:] += 0.2 * y[:-1900]
        o[pad:pad + len(s)] = z * 0.12; sp *= 0.12
    else: o[pad:pad + len(s)] = s
    if cond in ('hiss', 'far'): o += (rng.uniform(-1, 1, len(o)) * sp / 10 ** 0.5 * np.sqrt(3)).astype(np.float32)
    if cond == 'babble': b = babble(rng, len(o)); o += b * (sp / 10 ** 0.5 / (rms(b) or 1))
    return o
def stream_chunks():
    """all non-wake eval clips (near-miss sentences + everyday talk) joined, 5-minute chunks; every 3rd chunk with background talk"""
    import zlib
    neg = [m for m in man if m['kind'] != 'wake']; chunk = []; n = 0; idx = 0
    def make(chunk, idx):
        x = np.concatenate(chunk); rng = np.random.default_rng(idx); x = x + rng.uniform(-0.004, 0.004, len(x)).astype(np.float32)
        if idx % 3 == 2: x = x + babble(rng, len(x)) * 0.15
        return x
    for m in neg:
        c = load(m); g = np.zeros(int(16000 * (0.5 + (zlib.crc32(m['file'].encode()) % 300) / 100)), np.float32)
        chunk += [c, g]; n += len(c) + len(g)
        if n >= 16000 * 300: yield idx, make(chunk, idx); chunk = []; n = 0; idx += 1
    if chunk: yield idx, make(chunk, idx)
