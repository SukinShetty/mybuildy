import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]; thrs = [float(t) for t in sys.argv[2].split(',')]
clips = [r for r in rows if 'cond' in r]; st = [r for r in rows if 'peaks' in r]
for t in thrs:
    d = collections.defaultdict(list)
    for r in clips: d[(r['kind'], r['cond'])].append(r['max'] > t)
    hrs = sum(r['seconds'] for r in st) / 3600; ft = sum(sum(p > t for p in r['peaks']) for r in st)
    print(f'thr {t}: ' + '  '.join(f'{k[0]}/{k[1]} {100*sum(v)/len(v):.1f}% (n={len(v)})' for k, v in sorted(d.items())) + (f'  stream {ft} in {hrs:.2f}h = {ft/hrs:.1f}/h' if hrs else ''))
