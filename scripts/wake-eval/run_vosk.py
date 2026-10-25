# Wake-word eval for a grammar-constrained Vosk (Kaldi) recognizer — eval only (the app would use the
# WASM build of the same decoder). Same clips/conditions definitions as run.mjs (SNR 10 dB hiss/babble,
# far = quieter + duller + echo + hiss), its own noise seed. Resumable JSONL.
# python run_vosk.py SET_DIR MODEL_DIR OUT.jsonl utter|stream [shard/n]
import json, os, sys, zlib, numpy as np
from vosk import Model, KaldiRecognizer, SetLogLevel
SetLogLevel(-1)
setdir, modeldir, out, part = sys.argv[1:5]
shard, shards = map(int, (sys.argv[5] if len(sys.argv) > 5 else '0/1').split('/'))
man = json.load(open(os.path.join(setdir, 'manifest.json')))
load = lambda m: np.fromfile(os.path.join(setdir, 'clips', m['file']), dtype=np.float32)
done = set(json.loads(l)['id'] for l in open(out)) if os.path.exists(out) else set()
mine = lambda i: zlib.crc32(i.encode()) % shards == shard
chats = [m for m in man if m['kind'] == 'chat']
model = Model(modeldir)
PHRASES = ['my buildy', 'hey my buildy', 'my building', 'my build he', 'my billy']
GRAMMAR = json.dumps(PHRASES + ['[unk]'])
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

def heard(x):
    rec = KaldiRecognizer(model, 16000, GRAMMAR); hits = []
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()
    for i in range(0, len(pcm), 8000):
        if rec.AcceptWaveform(pcm[i:i + 8000]): hits.append(json.loads(rec.Result())['text'])
    hits.append(json.loads(rec.FinalResult())['text'])
    return [h for h in hits if h]

woke = lambda hs: any(h.replace('[unk]', '').strip() and any(p in h for p in PHRASES) for h in hs)
f = open(out, 'a')
if part == 'utter':
    for m in man:
        if m['kind'] == 'chat': continue
        for cond in (['clean', 'hiss', 'babble', 'far'] if m['kind'] == 'wake' else ['clean', 'babble']):
            i = m['file'] + '|' + cond
            if i in done or not mine(i): continue
            hs = heard(render(load(m), cond, np.random.default_rng(zlib.crc32(i.encode()))))
            f.write(json.dumps({'id': i, 'kind': m['kind'], 'source': m['source'], 'cond': cond, 'said': m['text'], 'woke': woke(hs), 'heard': hs}) + '\n'); f.flush()
else:
    neg = [m for m in man if m['kind'] != 'wake']; chunk = []; n = 0; idx = 0
    def flush():
        global chunk, n, idx
        i = f'stream{idx}'; idx += 1
        if chunk and i not in done and mine(i):
            x = np.concatenate(chunk); rng = np.random.default_rng(idx); x = x + rng.uniform(-0.004, 0.004, len(x)).astype(np.float32)
            if idx % 3 == 0: x = x + babble(rng, len(x)) * 0.15
            hs = heard(x)
            f.write(json.dumps({'id': i, 'seconds': len(x) / 16000, 'babble': idx % 3 == 0, 'triggers': [h for h in hs if woke([h])]}) + '\n'); f.flush()
        chunk = []; n = 0
    for m in neg:
        c = load(m); g = np.zeros(int(16000 * (0.5 + (zlib.crc32(m['file'].encode()) % 300) / 100)), np.float32)
        chunk += [c, g]; n += len(c) + len(g)
        if n >= 16000 * 300: flush()
    flush()
