# "MyBuildy" keyword model on openWakeWord's frozen front end (melspectrogram + speech embedding,
# both small ONNX models), with our own small classifier on 16 x 96 embedding frames (1.28 s).
#   python kws.py train TRAIN_DIR MODEL_OUT.json
#   python kws.py eval SET_DIR MODEL.json OUT_PREFIX [shard/n]   (eval set: held-out voices + sentences)
import json, os, sys, zlib, numpy as np
from openwakeword.utils import AudioFeatures
F = AudioFeatures(ncpu=1)
SR = 16000
rms = lambda x: float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0

def emb(x):
    """embedding frames for audio x (int16 range); frame k sees audio up to ~ (k*8+76)*10 ms"""
    return F._get_embeddings((np.clip(x, -1, 1) * 32767).astype(np.int16))

def speech_bounds(x):
    a = np.abs(x); thr = 0.05 * a.max(); idx = np.where(a > thr)[0]
    return (idx[0], idx[-1]) if len(idx) else (0, len(x))

def pink(rng, n):
    w = rng.standard_normal(n); f = np.fft.rfft(w); f /= np.sqrt(np.arange(1, len(f) + 1)); y = np.fft.irfft(f, n); return (y / (rms(y) or 1)).astype(np.float32)

def far(rng, s):
    y = np.convolve(s, np.ones(rng.integers(2, 5)) / 3, 'same')
    for _ in range(3): d = rng.integers(300, 3000); y[d:] += rng.uniform(0.1, 0.4) * y[:-d]
    return (y * rng.uniform(0.08, 0.3)).astype(np.float32)

def augment(rng, x, others):
    kind = rng.choice(['clean', 'white', 'pink', 'babble', 'far', 'far'])
    sp = rms(x[x != 0]) if np.any(x) else 0.05
    if kind == 'far': x = far(rng, x); sp = rms(x[x != 0])
    if kind in ('white', 'far'): x = x + rng.uniform(-1, 1, len(x)).astype(np.float32) * np.sqrt(3) * sp / 10 ** (rng.uniform(5, 25) / 20)
    if kind == 'pink': x = x + pink(rng, len(x)) * sp / 10 ** (rng.uniform(5, 25) / 20)
    if kind == 'babble':
        b = np.zeros(len(x), np.float32)
        for _ in range(2):
            at = 0
            while at < len(x): c = others[rng.integers(len(others))]; k = min(len(c), len(x) - at); b[at:at + k] += c[:k]; at += len(c) + 1500
        x = x + b * sp / 10 ** (rng.uniform(5, 20) / 20) / (rms(b) or 1)
    return (x * rng.uniform(0.3, 1.5)).astype(np.float32)

def train(tdir, outp):
    from sklearn.neural_network import MLPClassifier
    man = json.load(open(os.path.join(tdir, 'manifest.json')))
    load = lambda m: np.fromfile(os.path.join(tdir, m['file']), dtype=np.float32)
    voices = sorted({m['voice'] for m in man}); val_voices = set(voices[::6])  # 1 in 6 voices held out for the threshold
    gens = [load(m) for m in man if m['kind'] == 'gen' and m['voice'] not in val_voices]
    X = {'tr': [], 'va': []}; Y = {'tr': [], 'va': []}
    rng = np.random.default_rng(1)
    for n, m in enumerate(man):
        x = load(m); x = x / (np.abs(x).max() or 1) * 0.5; split = 'va' if m['voice'] in val_voices else 'tr'
        reps = (6 if '-IN-' in m['voice'] or 'mINm' in m['voice'] else 3) if m['kind'] == 'pos' else 1
        for r in range(reps):
            lead = np.zeros(int(SR * rng.uniform(0.3, 1.2)), np.float32)
            if rng.random() < 0.5: g = gens[rng.integers(len(gens))]; lead = np.concatenate([g / (np.abs(g).max() or 1) * 0.5, np.zeros(int(SR * rng.uniform(0.05, 0.4)), np.float32)])
            tail = np.zeros(int(SR * 0.6), np.float32)
            if m['kind'] == 'pos' and r > 0:  # the request usually follows the name with little or no pause
                g = gens[rng.integers(len(gens))]; g = g[np.argmax(np.abs(g) > 0.02 * np.abs(g).max()):]
                tail = np.concatenate([np.zeros(int(SR * rng.uniform(0, 0.25)), np.float32), g / (np.abs(g).max() or 1) * 0.5])
            a = np.concatenate([lead, x, tail])
            a = augment(rng, a, gens)
            E = emb(a)
            if len(E) < 16: continue
            if m['kind'] == 'pos':
                s0, s1 = speech_bounds(np.concatenate([np.zeros(len(lead), np.float32), x]))
                end_frame = int((s1 / SR * 100 - 76) / 8)  # embedding frame whose window ends at the end of the name
                for off in (0, 1, 2, 3):
                    k = end_frame + off
                    if 16 <= k + 1 <= len(E): X[split].append(E[k - 15:k + 1].ravel()); Y[split].append(1)
                # the same audio well before the name ended: negative (only the lead-in)
                for k in range(15, max(15, end_frame - 12), 3): X[split].append(E[k - 15:k + 1].ravel()); Y[split].append(0)
            else:
                for k in range(15, len(E), 2): X[split].append(E[k - 15:k + 1].ravel()); Y[split].append(0)
        if n % 500 == 0: print('features', n, len(man), flush=True)
    # real human speech (LibriSpeech dev-clean, even-numbered speakers only; odd ones are the test stream)
    lib = os.environ.get('LIBRI')
    if lib:
        import soundfile as sf, glob
        files = sorted(f for f in glob.glob(lib + '/*/*/*.flac') if int(f.split('/')[-3]) % 2 == 0)
        for j, fp in enumerate(files[::2]):
            a, _ = sf.read(fp, dtype='float32'); a = augment(rng, a[:SR * 12], gens); E = emb(a)
            split = 'va' if j % 6 == 0 else 'tr'
            for k in range(15, len(E), 3): X[split].append(E[k - 15:k + 1].ravel()); Y[split].append(0)
            if j % 100 == 0: print('libri', j, flush=True)
    Xtr, Ytr = np.array(X['tr'], np.float32), np.array(Y['tr']); Xva, Yva = np.array(X['va'], np.float32), np.array(Y['va'])
    print('train', Xtr.shape, Ytr.mean(), 'val', Xva.shape, Yva.mean(), flush=True)
    w = np.where(Ytr == 1, 1.0, 1.0)
    clf = MLPClassifier(hidden_layer_sizes=(64, 32), alpha=1e-3, max_iter=60, early_stopping=True, random_state=0)
    # balance by oversampling positives
    pos = np.where(Ytr == 1)[0]; rep = max(1, int((Ytr == 0).sum() / max(1, len(pos)) / 4))
    idx = np.concatenate([np.arange(len(Ytr))] + [pos] * rep)
    clf.fit(Xtr[idx], Ytr[idx])
    p = clf.predict_proba(Xva)[:, 1]
    for t in (0.5, 0.7, 0.8, 0.9, 0.95, 0.98):
        print(f'val thr {t}: recall(window) {np.mean(p[Yva == 1] > t):.3f}  fp(window) {np.mean(p[Yva == 0] > t):.5f}', flush=True)
    json.dump({'layers': [[c.tolist(), b.tolist()] for c, b in zip(clf.coefs_, clf.intercepts_)], 'frames': 16}, open(outp, 'w'))

def scores(model, x):
    E = emb(x); out = []
    for k in range(15, len(E)):
        h = E[k - 15:k + 1].ravel()
        for i, (W, b) in enumerate(model):
            h = h @ W + b
            h = np.maximum(h, 0) if i < len(model) - 1 else 1 / (1 + np.exp(-h))
        out.append(float(h[0]))
    return np.array(out)

if __name__ == '__main__':
    if sys.argv[1] == 'train': train(sys.argv[2], sys.argv[3])

def libri_chunks():  # real human read speech, speakers never used in training, ~2 h
    import soundfile as sf, glob
    files = sorted(f for f in glob.glob(os.environ['LIBRI'] + '/*/*/*.flac') if int(f.split('/')[-3]) % 2 == 1)
    buf = []; tot = 0; idx = 0
    for fp in files:
        a, _ = sf.read(fp, dtype='float32'); buf += [a, np.zeros(SR // 2, np.float32)]; tot += len(a) + SR // 2
        if tot >= SR * 300:
            yield f'libri{idx}', np.concatenate(buf); buf = []; tot = 0; idx += 1
            if idx >= 24: return

def evaluate(setdir, modelp, outp, shard='0/1'):
    """max score per eval clip x condition (same conditions as run_vosk.py), and triggers on long non-wake audio"""
    sys.argv = [sys.argv[0], setdir, '', '', '']  # reuse run_vosk.py's render without running it
    import importlib.util
    spec = importlib.util.spec_from_file_location('rv', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wake_audio.py'))
    wa = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa); wa.init(setdir)
    model = [(np.array(W, np.float32), np.array(b, np.float32)) for W, b in json.load(open(modelp))['layers']]
    sh, n = map(int, shard.split('/'))
    done = set(json.loads(l)['id'] for l in open(outp)) if os.path.exists(outp) else set()
    f = open(outp, 'a')
    for m in wa.man:
        if m['kind'] == 'chat': continue
        for cond in (['clean', 'hiss', 'babble', 'far'] if m['kind'] == 'wake' else ['clean', 'babble']):
            i = m['file'] + '|' + cond
            if i in done or zlib.crc32(i.encode()) % n != sh: continue
            x = wa.render(wa.load(m), cond, np.random.default_rng(zlib.crc32(i.encode())))
            s = scores(model, x)
            f.write(json.dumps({'id': i, 'kind': m['kind'], 'source': m['source'], 'voice': m.get('voice'), 'cond': cond, 'said': m['text'], 'max': round(float(s.max()), 4) if len(s) else 0}) + '\n'); f.flush()
    # long non-wake audio in 5-minute chunks: every score peak above 0.3 (thresholding later), 2 s refractory
    chunks = [(f'stream{i}', x) for i, x in wa.stream_chunks()]
    import itertools
    for i, x in itertools.chain(((a, b) for a, b in chunks), libri_chunks() if os.environ.get('LIBRI') else []):
        idx = i
        if i in done or zlib.crc32(i.encode()) % n != sh: continue
        s = scores(model, x); peaks = []; last = -99
        for k, v in enumerate(s):
            if v > 0.3 and k - last > 25: peaks.append(round(float(v), 4)); last = k
            elif v > 0.3 and peaks and v > peaks[-1]: peaks[-1] = round(float(v), 4)
        f.write(json.dumps({'id': i, 'seconds': len(x) / SR, 'peaks': peaks}) + '\n'); f.flush()

if __name__ == '__main__' and sys.argv[1] == 'eval': evaluate(*sys.argv[2:])
