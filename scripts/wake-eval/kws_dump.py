# Two-stage check, step 1: run the keyword model; at every trigger (score > THR, 2 s apart) cut
# 2 s before .. 3 s after and save it, for verify.mjs to transcribe with the listening model.
#   python kws_dump.py SET_DIR MODEL.json THR OUT_DIR [shard/n]
import json, os, sys, zlib, itertools, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
setdir, modelp, thr, outd = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
sh, n = map(int, (sys.argv[5] if len(sys.argv) > 5 else '0/1').split('/'))
import kws, wake_audio as wa
wa.init(setdir); os.makedirs(outd, exist_ok=True)
model = [(np.array(W, np.float32), np.array(b, np.float32)) for W, b in json.load(open(modelp))['layers']]
SR = 16000
def cuts(x):
    s = kws.scores(model, x); out = []; last = -99
    for j, v in enumerate(s):
        if v > thr and j - last > 25:
            end = ((j + 15) * 8 + 76) * 160; out.append(x[max(0, end - 2 * SR): end + 3 * SR]); last = j
    return out
idx = open(os.path.join(outd, f'index-{sh}.jsonl'), 'a')
done = set()
for f in os.listdir(outd):
    if f.startswith('index-'): done |= {json.loads(l)['id'] for l in open(os.path.join(outd, f))}
def save(i, meta, cs):
    files = []
    for c, a in enumerate(cs):
        fn = f'{zlib.crc32(i.encode()):08x}-{c}.f32'; a.astype(np.float32).tofile(os.path.join(outd, fn)); files.append(fn)
    idx.write(json.dumps({'id': i, **meta, 'cuts': files}) + '\n'); idx.flush()
for m in wa.man:
    if m['kind'] == 'chat': continue
    for cond in (['clean', 'hiss', 'babble', 'far'] if m['kind'] == 'wake' else ['clean', 'babble']):
        i = m['file'] + '|' + cond
        if i in done or zlib.crc32(i.encode()) % n != sh: continue
        save(i, {'kind': m['kind'], 'cond': cond, 'said': m['text']}, cuts(wa.render(wa.load(m), cond, np.random.default_rng(zlib.crc32(i.encode())))))
for i, x in itertools.chain(((f'stream{k}', x) for k, x in wa.stream_chunks()), kws.libri_chunks() if os.environ.get('LIBRI') else []):
    if i in done or zlib.crc32(i.encode()) % n != sh: continue
    save(i, {'kind': 'stream', 'seconds': len(x) / SR}, cuts(x))
