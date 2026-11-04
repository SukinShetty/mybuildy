# Renders exactly the audio kws.py eval scores (same clips, conditions, seeds, stream and LibriSpeech chunks)
# to raw f32 files, so kws-ts-eval.mjs can run the SHIPPED app path over it.
#   LIBRI=... python render_ts_set.py SET_DIR OUT_DIR
import json, os, sys, zlib, importlib.util, numpy as np
here = os.path.dirname(os.path.abspath(__file__))
setdir, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
spec = importlib.util.spec_from_file_location('wa', os.path.join(here, 'wake_audio.py'))
wa = importlib.util.module_from_spec(spec); sys.argv = [sys.argv[0], setdir, '', '', '']; spec.loader.exec_module(wa); wa.init(setdir)
spec = importlib.util.spec_from_file_location('kws', os.path.join(here, 'kws.py')); kws = importlib.util.module_from_spec(spec); spec.loader.exec_module(kws)
man = open(os.path.join(out, 'manifest.jsonl'), 'w')
def put(i, x, **meta):
    fn = '%08x.f32' % zlib.crc32(i.encode()); np.clip(x, -1, 1).astype(np.float32).tofile(os.path.join(out, fn))
    man.write(json.dumps({'id': i, 'file': fn, 'seconds': len(x) / 16000, **meta}) + '\n'); man.flush()
for m in wa.man:
    if m['kind'] == 'chat': continue
    for cond in (['clean', 'hiss', 'babble', 'far'] if m['kind'] == 'wake' else ['clean', 'babble']):
        i = m['file'] + '|' + cond
        put(i, wa.render(wa.load(m), cond, np.random.default_rng(zlib.crc32(i.encode()))), kind=m['kind'], cond=cond, voice=m.get('voice'), said=m['text'])
for i, x in wa.stream_chunks(): put(f'stream{i}', x, kind='stream')
if os.environ.get('LIBRI'):
    for i, x in kws.libri_chunks(): put(i, x, kind='libri')
