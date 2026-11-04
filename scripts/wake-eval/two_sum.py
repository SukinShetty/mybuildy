import json, sys, re, glob, collections
idx = {}
for f in glob.glob(sys.argv[1] + '/index-*.jsonl'):
    for l in open(f): r = json.loads(l); idx[r['id']] = r
ver = {}
for f in glob.glob(sys.argv[2]):
    for l in open(f): r = json.loads(l); ver[r['cut']] = r
def lenient(t):
    t = re.sub(r'[^a-z ]', ' ', t.lower()); t = ' ' + re.sub(r'\s+', ' ', t) + ' '
    return bool(re.search(r' (my|mai|hi|hey) ?(buildy|buildie|buildi|build e|biddy|bilty|bildy|building|billy|beauty|buddy) ', t) or ' mybuildy' in t)
REQ = r'(what|whats|why|how|where|when|who|which|can|could|would|will|should|please|tell|explain|help|give|show|check|fix|did|does|do|is it|are|any|next)'
def hey(t, loose=False):
    t = re.sub(r'[^a-z ,.?!]', ' ', t.lower()); t = re.sub(r'\s+', ' ', t).strip()
    names = r'(buildy|buildie|bildy|billdy|baldy|bill d|bill b|building|billie' + (r'|billy|beauty|bud|buddy' if loose else '') + r')'
    m = re.match(r'^(hey|hay|a|hi|okay hey)[,.!]? ' + names + r'\b([,.?!]?)\s*(.*)$', t)
    if not m: return False
    rest = m.group(4)
    return m.group(3) != '' or rest == '' or bool(re.match(REQ + r'\b', rest))
rules = {'hey-strict': lambda v: hey(v['text']), 'hey-loose': lambda v: hey(v['text'], True),'app': lambda v: v['app'], 'lenient': lambda v: lenient(v['text'])}
for name, rule in rules.items():
    d = collections.defaultdict(list); fa = collections.Counter(); secs = collections.Counter(); pend = 0
    for i, r in idx.items():
        vs = [ver.get(c) for c in r['cuts']]
        if any(v is None for v in vs): pend += 1; continue
        hit = any(rule(v) for v in vs)
        if r['kind'] == 'stream':
            p = 'libri' if i.startswith('libri') else 'stream'; secs[p] += r['seconds']; fa[p] += sum(rule(v) for v in vs)
        else: d[(r['kind'], r['cond'])].append(hit)
    w = lambda c: [x for (k, cc), v in d.items() if k == 'wake' and c(cc) for x in v]
    cl, no = w(lambda c: c == 'clean'), w(lambda c: c != 'clean')
    print(f"{name}: CLEAN {100*sum(cl)/max(1,len(cl)):.1f}% (n={len(cl)}) NOISY {100*sum(no)/max(1,len(no)):.1f}% | " + ' '.join(f'{k[0]}/{k[1]} {100*sum(v)/len(v):.1f}%' for k, v in sorted(d.items())) + ''.join(f' | {p} {fa[p]} in {secs[p]/3600:.2f}h = {fa[p]/(secs[p]/3600):.1f}/h' for p in secs) + f' (pending {pend})')
