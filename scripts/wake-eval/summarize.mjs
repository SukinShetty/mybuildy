// node scripts/wake-eval/summarize.mjs RES_DIR → table per result file
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
const dir = process.argv[2]
const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}% (${a}/${b})` : '-'
const out = {}
for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
  const rows = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  if (f.startsWith('stream')) {
    const sec = rows.reduce((a, r) => a + r.seconds, 0), trig = rows.reduce((a, r) => a + r.triggers.length, 0)
    out[f] = { hours: +(sec / 3600).toFixed(2), triggers: trig, perHour: +(trig / (sec / 3600 || 1)).toFixed(2), heardAs: rows.flatMap((r) => r.triggers).slice(0, 8) }
    continue
  }
  const wake = rows.filter((r) => r.kind === 'wake'), other = rows.filter((r) => r.kind === 'other')
  const by = (rs, k) => Object.fromEntries([...new Set(rs.map(k))].sort().map((v) => { const x = rs.filter((r) => k(r) === v); return [v, pct(x.filter((r) => r.woke).length, x.length)] }))
  const noisy = wake.filter((r) => r.cond !== 'clean')
  out[f] = {
    clean: pct(wake.filter((r) => r.cond === 'clean' && r.woke).length, wake.filter((r) => r.cond === 'clean').length),
    noisyAll: pct(noisy.filter((r) => r.woke).length, noisy.length),
    byCond: by(wake, (r) => r.cond), bySource: by(wake, (r) => r.source),
    nearMissFalse: pct(other.filter((r) => r.woke).length, other.length),
    nearMissHeard: other.filter((r) => r.woke).slice(0, 6).map((r) => r.said),
  }
}
console.log(JSON.stringify(out, null, 1))
