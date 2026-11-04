import os, json, sys
d = sys.argv[1]; man = []
for f in sorted(os.listdir(d)):
    if not f.endswith('.f32') or os.path.getsize(os.path.join(d, f)) < 3200: continue
    kind, rest = f.split('_', 1); voice = rest.split('_')[0]
    man.append({'kind': kind, 'voice': voice, 'text': '', 'file': f})
json.dump(man, open(os.path.join(d, 'manifest.json'), 'w')); print({k: sum(m['kind'] == k for m in man) for k in ('pos', 'near', 'gen')}, len({m['voice'] for m in man}))
