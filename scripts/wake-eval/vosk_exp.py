# Quick Vosk grammar experiments on a fixed sample (same conditions as run_vosk.py).
# python vosk_exp.py SET MODEL OUT.json  CONFIGS.json   (list of {name, wake, decoys, conf})
import json, os, sys, zlib, numpy as np
from vosk import Model, KaldiRecognizer, SetLogLevel
SetLogLevel(-1)
setdir, modeldir, outp, cfgp = sys.argv[1:5]
man = json.load(open(os.path.join(setdir, 'manifest.json')))
load = lambda m: np.fromfile(os.path.join(setdir, 'clips', m['file']), dtype=np.float32)
chats = [m for m in man if m['kind'] == 'chat']
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
# fixed sample: every wake clip of the set (sampled), near-misses clean, and ~1 h of non-wake talk
rs = np.random.default_rng(7)
wake = [m for m in man if m['kind'] == 'wake']; other = [m for m in man if m['kind'] == 'other']
wake = [wake[i] for i in rs.choice(len(wake), min(int(os.environ.get('NW', 120)), len(wake)), replace=False)]
items = [(m, c) for m in wake for c in ('clean', 'hiss', 'babble', 'far')] + [(m, 'clean') for m in other]
audio = {}
for m, c in items: audio[(m['file'], c)] = (np.clip(render(load(m), c, np.random.default_rng(zlib.crc32((m['file'] + c).encode()))), -1, 1) * 32767).astype('<i2').tobytes()
neg = [m for m in man if m['kind'] != 'wake']; rs.shuffle(neg); parts = []; n = 0
for m in neg:
    c = load(m); parts += [c, np.zeros(int(16000 * (0.5 + rs.random() * 2)), np.float32)]; n += len(c)
    if n > 16000 * 3600 * float(os.environ.get('HOURS', 1)): break
stream = np.concatenate(parts); stream += rs.uniform(-0.004, 0.004, len(stream)).astype(np.float32)
third = len(stream) // 3; stream[:third] += babble(rs, third) * 0.15
streamb = (np.clip(stream, -1, 1) * 32767).astype('<i2').tobytes(); hours = len(stream) / 16000 / 3600
model = Model(modeldir)
def run(pcm, grammar, wakeset, conf):
    rec = KaldiRecognizer(model, 16000, grammar); rec.SetWords(True); hits = []
    def take(r):
        r = json.loads(r); ws = r.get('result', []); words = [w['word'] for w in ws]
        for p in wakeset:
            pw = p.split()
            for i in range(len(words) - len(pw) + 1):
                if words[i:i + len(pw)] == pw and min(w['conf'] for w in ws[i:i + len(pw)]) >= conf: hits.append(r.get('text', '')); return
    for i in range(0, len(pcm), 8000):
        if rec.AcceptWaveform(pcm[i:i + 8000]): take(rec.Result())
    take(rec.FinalResult())
    return hits
res = json.load(open(outp)) if os.path.exists(outp) else {}
import time
for cfg in json.load(open(cfgp)):
    if cfg['name'] in res: continue
    g = json.dumps(cfg['wake'] + cfg['decoys'] + ['[unk]'])
    by = {}
    for (f, c), pcm in audio.items():
        kind = 'other' if c == 'clean' and any(m['file'] == f for m in other) else 'wake'
        k = kind if kind == 'other' else c
        by.setdefault(k, []).append(bool(run(pcm, g, cfg['wake'], cfg['conf'])))
    t0 = time.process_time(); trig = run(streamb, g, cfg['wake'], cfg['conf']); cpu = time.process_time() - t0
    r = {k: round(100 * sum(v) / len(v), 1) for k, v in by.items()}
    r['noisy'] = round(100 * sum(sum(by[k]) for k in ('hiss', 'babble', 'far')) / sum(len(by[k]) for k in ('hiss', 'babble', 'far')), 1)
    r['stream_per_hour'] = round(len(trig) / hours, 2); r['stream_hours'] = round(hours, 2); r['cpu_sec_per_audio_hour'] = round(cpu / hours, 1); r['stream_heard'] = trig[:6]
    res[cfg['name']] = r; json.dump(res, open(outp, 'w'), indent=1); print(cfg['name'], r, flush=True)
