# Summary of kws-ts-eval.mjs output (the shipped path, threshold and window as in the app).
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
w = [r for r in rows if r['kind'] == 'wake']; cl = [bool(r['wakes']) for r in w if r['cond'] == 'clean']; no = [bool(r['wakes']) for r in w if r['cond'] != 'clean']
oth = [r for r in rows if r['kind'] == 'other']
print(f"wake clips: clean {100*sum(cl)/len(cl):.1f}% ({len(cl)}), noisy {100*sum(no)/len(no):.1f}% ({len(no)})")
by = collections.defaultdict(list)
for r in w: by[r['cond']].append(bool(r['wakes']))
print('  by condition: ' + ', '.join(f'{k} {100*sum(v)/len(v):.1f}%' for k, v in sorted(by.items())))
if oth: print(f"near-miss/other clips that woke: {100*sum(bool(r['wakes']) for r in oth)/len(oth):.1f}% ({len(oth)})")
for k in ('stream', 'libri'):
    s = [r for r in rows if r['kind'] == k]; h = sum(r['seconds'] for r in s) / 3600; f = sum(len(r['wakes']) for r in s)
    if h: print(f"{k}: {f} false wakes in {h:.2f} h = {f/h:.1f}/h")
