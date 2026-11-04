# Clean-licence synthetic clips from Piper voices whose model cards state permissive data licences
# (libritts_r: CC BY 4.0, vctk: CC BY 4.0, ljspeech + cori: public domain). Dev machine only; nothing shipped.
#   python gen_piper.py train OUT_DIR   |   python gen_piper.py eval OUT_DIR   (resumable; 16 kHz f32 clips)
# Speakers are split so eval speakers never appear in training.
import json, os, random, sys, numpy as np
from piper import PiperVoice, SynthesisConfig
mode, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
P = os.environ.get('PIPER_DIR', '/workspace/evals/piper')
here = os.path.dirname(os.path.abspath(__file__))
INDIAN = {'p248', 'p251', 'p376'}            # VCTK speakers with Indian English accent
VCTK_EVAL = {'p248', 'p251', 'p234', 'p245', 'p261', 'p294', 'p311', 'p335'}  # 2 Indian + Scottish/Irish/US/English mix
def res(x, fr):  # linear resample to 16 kHz
    n = int(len(x) * 16000 / fr); p = np.arange(n) * fr / 16000; return np.interp(p, np.arange(len(x)), x).astype(np.float32)
def norm(x): return (x / (np.abs(x).max() or 1) * 0.5).astype(np.float32)
voices = {}
def voice(name):
    if name not in voices: voices[name] = PiperVoice.load(f'{P}/{name}.onnx')
    return voices[name]
jobs = []
if mode == 'train':
    ph = json.load(open(os.path.join(here, 'train-phrases.json')))
    lib = voice('en_US-libritts_r-medium').config.speaker_id_map; vc = voice('en_GB-vctk-medium').config.speaker_id_map
    spk = [('en_US-libritts_r-medium', s) for s in random.Random(0).sample(sorted(lib), 120)]
    spk += [('en_GB-vctk-medium', s) for s in sorted(vc) if s not in VCTK_EVAL]
    for model, s in spk:
        r = random.Random(model + s); tag = f'{model.split("-")[1]}_{s}' + ('_IN' if s in INDIAN else '')
        for i, t in enumerate(ph['pos']):
            for k in range(4 if s in INDIAN else 2): jobs.append(('pos', model, s, t, r.uniform(0.85, 1.25), f'pos_{tag}_{i}_{k}', tag))
        for i, t in enumerate(ph['near']): jobs.append(('near', model, s, t, r.uniform(0.85, 1.2), f'near_{tag}_{i}', tag))
        for i in r.sample(range(len(ph['gen'])), 16): jobs.append(('gen', model, s, ph['gen'][i], 1.0, f'gen_{tag}_{i}', tag))
else:
    d = json.load(open(os.path.join(here, '..', 'eval-wake-word-data-hey.json')))
    items = [('wake', t, c) for t, c in d['wake']] + [('other', t, None) for t in d['other']] + [('chat', t, None) for t in d['chat']]
    spk = [('en_GB-vctk-medium', s) for s in sorted(VCTK_EVAL)] + [('en_US-ljspeech-medium', None), ('en_GB-cori-medium', None)]
    for model, s in spk:
        tag = f'{model.split("-")[1]}' + (f'_{s}' for _ in [0]).__next__() if s else model.split('-')[1]
        for ls in (0.9, 1.15):
            for i, (k, t, c) in enumerate(items): jobs.append((k, model, s, t, ls, f'piper_{tag}_{ls}_{i}', tag, c))
man = []
for j in jobs:
    kind, model, s, text, ls, name, tag = j[:7]
    f = name + '.f32'; path = os.path.join(out, 'clips' if mode == 'eval' else '', f)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        v = voice(model); cfg = SynthesisConfig(speaker_id=v.config.speaker_id_map[s] if s else None, length_scale=ls)
        a = np.concatenate([c.audio_float_array for c in v.synthesize(text, syn_config=cfg)])
        norm(res(a, v.config.sample_rate)).tofile(path)
    m = {'file': f, 'kind': kind, 'text': text, 'voice': tag, 'source': 'piper'}
    if mode == 'eval': m.update(command=j[7], speed=ls)
    man.append(m)
    if len(man) % 2000 == 0: print(len(man), '/', len(jobs), flush=True)
json.dump(man, open(os.path.join(out, 'manifest.json' if mode == 'train' else 'manifest-piper.json'), 'w'))
print('done', len(man))
