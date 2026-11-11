// licence-check-lib.mjs — pure helpers for scripts/check-licences.mjs (unit-tested).

/** Licences that are fine to ship inside MyBuildy (SPDX ids). */
export const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0',
  'CC0-1.0', 'Unlicense', 'Zlib', 'Python-2.0', 'CC-BY-4.0', 'BSD-3-Clause-Clear', 'PolyForm-Shield-1.0.0',
])

/** Packages whose licence field hides GPL code inside them. */
export const KNOWN_GPL_INSIDE = {
  phonemizer: 'eSpeak NG (GPL-3.0-or-later) compiled to WebAssembly, although package.json says Apache-2.0',
  'espeak-ng': 'eSpeak NG (GPL-3.0-or-later)',
}

/** Text that only GPL'd eSpeak NG code or data contains. */
export const GPL_SIGNATURES = [
  /espeak[-_ ]?ng/i,
  /espeak_(?:Initialize|TextToPhonemes|SetVoiceByName|Synth)/,
  /\bphontab\b|\bphonindex\b/,
  /GNU AFFERO GENERAL PUBLIC LICENSE/i,
]

/**
 * Classify an SPDX expression: 'ok', 'copyleft' (GPL/AGPL/LGPL/…), 'noncommercial' or 'unknown'.
 * "A OR B": fine if either side is fine. "A AND B": every part must be fine.
 */
export function classifyLicence(expr) {
  if (!expr || typeof expr !== 'string') return 'unknown'
  const clean = expr.trim().replace(/^\((.*)\)$/, '$1').trim()
  if (/\s+OR\s+/i.test(clean)) {
    const parts = splitTop(clean, 'OR').map(classifyLicence)
    if (parts.includes('ok')) return 'ok'
    return parts.find((p) => p !== 'unknown') ?? 'unknown'
  }
  if (/\s+AND\s+/i.test(clean)) {
    const parts = splitTop(clean, 'AND').map(classifyLicence)
    for (const worst of ['copyleft', 'noncommercial', 'unknown']) if (parts.includes(worst)) return worst
    return 'ok'
  }
  const id = clean.replace(/\s+WITH\s+.*$/i, '')
  if (/\b(A|L)?GPL\b|GPL-|AGPL|LGPL|SSPL|EUPL|OSL-|CC-BY-SA|CC-BY-NC-SA/i.test(id)) return 'copyleft'
  if (/NC|Non-?Commercial|PolyForm-Noncommercial|Commons-Clause/i.test(id) && id !== 'PolyForm-Shield-1.0.0') return 'noncommercial'
  return ALLOWED.has(id) ? 'ok' : 'unknown'
}

function splitTop(expr, op) {
  const out = []
  let depth = 0, cur = ''
  const tokens = expr.split(/(\(|\)|\s+)/).filter((t) => t !== '' && !/^\s+$/.test(t))
  for (const t of tokens) {
    if (t === '(') depth++
    if (t === ')') depth--
    if (depth === 0 && t.toUpperCase() === op) { out.push(cur.trim()); cur = ''; continue }
    cur += (cur && t !== ')' && !cur.endsWith('(') ? ' ' : '') + t
  }
  out.push(cur.trim())
  return out
}

/** The licence a package.json declares (old `licenses` arrays too). */
export function declaredLicence(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')
  return null
}

/** Signatures of GPL code found in a piece of text (file contents). */
export function gplSignaturesIn(text) {
  return GPL_SIGNATURES.filter((re) => re.test(text)).map((re) => re.source)
}

/**
 * Packages a bundle can reach from `roots`, resolved like Node through
 * package-lock.json's `packages` map; `replaced` packages (build aliases to a
 * stub) are not followed. Returns lock keys (node_modules/... paths).
 */
export function reachable(lockPackages, roots, replaced = new Set()) {
  const seen = new Set()
  const resolve = (name, from) => {
    let base = from
    for (;;) {
      const key = `${base ? base + '/' : ''}node_modules/${name}`
      if (lockPackages[key]) return key
      if (!base) return null
      const i = base.lastIndexOf('/node_modules/')
      base = i < 0 ? '' : base.slice(0, i)
    }
  }
  const walk = (name, from) => {
    if (replaced.has(name)) return
    const key = resolve(name, from)
    if (!key || seen.has(key)) return
    seen.add(key)
    const p = lockPackages[key]
    for (const dep of Object.keys({ ...(p.dependencies || {}), ...(p.optionalDependencies || {}) })) walk(dep, key)
  }
  for (const r of roots) walk(r, '')
  return seen
}
