import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]; thrs = [float(t) for t in sys.argv[2].split(',')]
clips = [r for r in rows if 'cond' in r]; st = [r for r in rows if 'peaks' in r]
for t in thrs:
    d = collections.defaultdict(list)
    for r in clips: d[(r['kind'], r['cond'])].append(r['max'] > t)
    out = ''
    for pre in ('stream', 'libri'):
        ss = [r for r in st if r['id'].startswith(pre)]; hrs = sum(r['seconds'] for r in ss) / 3600; ft = sum(sum(p > t for p in r['peaks']) for r in ss)
        if hrs: out += f'  {pre} {ft} in {hrs:.2f}h = {ft/hrs:.1f}/h'
    w = [r for r in clips if r['kind'] == 'wake']; cl = [r['max'] > t for r in w if r['cond'] == 'clean']; no = [r['max'] > t for r in w if r['cond'] != 'clean']
    print(f'thr {t}: CLEAN {100*sum(cl)/max(1,len(cl)):.1f}% NOISY {100*sum(no)/max(1,len(no)):.1f}% | ' + '  '.join(f'{k[0]}/{k[1]} {100*sum(v)/len(v):.1f}%' for k, v in sorted(d.items())) + out)
