#!/usr/bin/env node
// check-licences.mjs — fails the build if GPL / AGPL (or LGPL, non-commercial or
// unknown-licence) code would ship in MyBuildy.
//
//   node scripts/check-licences.mjs                      # dependencies (package-lock.json)
//   node scripts/check-licences.mjs --out out            # + the built bundles in out/
//   node scripts/check-licences.mjs --app dist/win-unpacked/resources   # + a packaged app
//   ... --report licence-report.md                       # write the full inventory
//   node scripts/check-licences.mjs --write-notices      # refresh the package list in THIRD_PARTY_NOTICES.md
//
// What ships: the production dependencies (packed into app.asar by
// electron-builder) and the packages bundled into out/ by electron-vite
// (BUNDLED_VOICE_DEPS + the renderer's React). Packages the build replaces with a
// stub (vite `alias` to src/main/*-stub.ts: sharp, phonemizer) don't ship.
// A licence field can lie: `phonemizer` says Apache-2.0 but is eSpeak NG
// (GPL-3.0), so files are also scanned for eSpeak NG's own names.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { createRequire } from 'module'
import { classifyLicence, declaredLicence, gplSignaturesIn, KNOWN_GPL_INSIDE, reachable } from './licence-check-lib.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const args = process.argv.slice(2)
const opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const problems = []
const rows = []

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const viteConfig = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')

// Packages the build replaces with a stub, read from the vite config itself.
const replaced = new Set([...viteConfig.matchAll(/([\w@/-]+):\s*resolve\(__dirname, 'src\/main\/[\w-]+-stub\.ts'\)/g)].map((m) => m[1]))
for (const must of ['phonemizer', 'sharp']) {
  if (!replaced.has(must)) problems.push(`electron.vite.config.ts no longer replaces "${must}" with a stub`)
}
const bundledRoots = (/BUNDLED_VOICE_DEPS = \[([^\]]*)\]/.exec(viteConfig)?.[1] ?? '').match(/'[^']+'/g)?.map((s) => s.slice(1, -1)) ?? []
const rendererRoots = ['react', 'react-dom', 'zustand', 'zod']
const prodRoots = Object.keys(pkg.dependencies ?? {})

const shippedKeys = reachable(lock, [...prodRoots, ...bundledRoots, ...rendererRoots], replaced)

function licenceOf(key) {
  const file = join(root, key, 'package.json')
  if (existsSync(file)) return declaredLicence(JSON.parse(readFileSync(file, 'utf8')))
  return lock[key]?.license ?? null
}

function judge(name, version, licence, where) {
  let verdict = classifyLicence(licence)
  let note = ''
  if (KNOWN_GPL_INSIDE[name]) { verdict = 'copyleft'; note = KNOWN_GPL_INSIDE[name] }
  rows.push({ name, version, licence: licence ?? '(none)', verdict, where, note })
  if (verdict !== 'ok') problems.push(`${name}@${version} (${where}): ${verdict} — ${licence ?? 'no licence'}${note ? ` — ${note}` : ''}`)
}

for (const key of [...shippedKeys].sort()) {
  const name = key.replace(/^.*node_modules\//, '')
  const where = lock[key]?.dev ? 'bundled in out/' : 'app.asar node_modules'
  judge(name, lock[key]?.version ?? '?', licenceOf(key), where)
}

// Built files: no eSpeak NG code or data.
function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* files(p)
    else yield { path: p, size: s.size }
  }
}
const SCANNED = /\.(c?js|mjs|json|wasm|html|txt|md|node|dll|dylib|so)$/i
const MAX_SCAN = 64 * 1024 * 1024
function scanText(label, text) {
  // The notices file names eSpeak NG on purpose (as not shipped).
  if (/THIRD_PARTY_NOTICES\.md$/.test(label)) return
  // Electron's and Chromium's own licence listings quote licence texts
  // (Chromium's credits include the AGPL text); they are notices, not code.
  if (/(^|[\\/])(LICENSES\.chromium\.html|LICENSE\.electron\.txt|LICENSE)$/.test(label)) { console.log(`[licences] ${label}: licence listing, not scanned for signatures`); return }
  const hits = gplSignaturesIn(text)
  if (hits.length) problems.push(`${label}: GPL code signature ${hits.join(', ')}`)
}
for (const dir of opt('--out')) {
  let n = 0
  for (const f of files(join(root, dir))) {
    if (!SCANNED.test(f.path) || f.size > MAX_SCAN) continue
    scanText(relative(root, f.path), readFileSync(f.path, 'latin1'))
    n++
  }
  console.log(`[licences] scanned ${n} built files in ${dir}`)
}

// A packaged app: what's really inside app.asar, app.asar.unpacked and resources/.
const require = createRequire(import.meta.url)
for (const resources of opt('--app')) {
  const asarFile = join(resources, 'app.asar')
  if (!existsSync(asarFile)) { problems.push(`${resources}: no app.asar`); continue }
  const asar = require('@electron/asar')
  const listed = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/').replace(/^\//, ''))
  let n = 0
  const shippedNames = new Set(rows.map((r) => r.name))
  for (const inner of listed) {
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(inner) ?? /^node_modules\/.+\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(inner)
    let content
    try { content = asar.extractFile(asarFile, inner) } catch { continue } // a directory
    if (m) {
      const p = JSON.parse(content.toString('utf8'))
      if (p.name === m[1] && !shippedNames.has(p.name)) judge(p.name, p.version, declaredLicence(p), `app.asar (${inner})`)
    }
    if (SCANNED.test(inner) && content.length <= MAX_SCAN) { scanText(`${asarFile}:${inner}`, content.toString('latin1')); n++ }
  }
  for (const f of files(resources)) {
    if (f.path === asarFile || !SCANNED.test(f.path) || f.size > MAX_SCAN) continue
    scanText(relative(resources, f.path), readFileSync(f.path, 'latin1'))
    n++
  }
  console.log(`[licences] scanned ${n} files in ${resources} (${listed.length} entries in app.asar)`)
}

// THIRD_PARTY_NOTICES.md lists every shipped package with its licence text.
const NOTICES = join(root, 'THIRD_PARTY_NOTICES.md')
const START = '<!-- npm-packages:start (generated by scripts/check-licences.mjs --write-notices) -->'
const END = '<!-- npm-packages:end -->'
const NO_TEXT = {
  'onnxruntime-node': 'MIT License. Copyright (c) Microsoft Corporation. (The npm package ships no licence file; text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE)',
  'onnxruntime-common': 'MIT License. Copyright (c) Microsoft Corporation. (The npm package ships no licence file; text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE)',
  'onnxruntime-web': 'MIT License. Copyright (c) Microsoft Corporation. (The npm package ships no licence file; text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE)',
}
function licenceText(key, name, licence) {
  const dir = join(root, key)
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort() : []
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).filter(Boolean)
  if (texts.length) return texts.join('\n\n')
  return NO_TEXT[name] ?? `${licence} (the package ships no licence file; standard text: https://spdx.org/licenses/${encodeURIComponent(licence ?? '')}.html)`
}
const packageSection = () => {
  const seen = new Set()
  const parts = []
  for (const key of [...shippedKeys].sort((a, b) => a.replace(/.*node_modules\//, '').localeCompare(b.replace(/.*node_modules\//, '')))) {
    const name = key.replace(/^.*node_modules\//, '')
    const version = lock[key]?.version ?? '?'
    if (seen.has(`${name}@${version}`)) continue
    seen.add(`${name}@${version}`)
    const licence = licenceOf(key)
    parts.push(`### ${name}@${version} — ${licence}\n\n\`\`\`text\n${licenceText(key, name, licence).replace(/\`\`\`/g, "'''")}\n\`\`\``)
  }
  return `${START}\n\n${parts.join('\n\n')}\n\n${END}`
}
if (args.includes('--write-notices')) {
  const current = readFileSync(NOTICES, 'utf8')
  const section = packageSection()
  const updated = current.includes(START) ? current.replace(new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*${END}`), section) : `${current.trimEnd()}\n\n## npm packages in the app\n\n${section}\n`
  writeFileSync(NOTICES, updated)
  console.log(`[licences] THIRD_PARTY_NOTICES.md: ${shippedKeys.size} package entries written`)
} else {
  const notices = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : ''
  for (const key of shippedKeys) {
    const name = key.replace(/^.*node_modules\//, '')
    if (!notices.includes(`### ${name}@${lock[key]?.version} `)) problems.push(`THIRD_PARTY_NOTICES.md has no entry for ${name}@${lock[key]?.version} (run: node scripts/check-licences.mjs --write-notices)`)
  }
}

const report = opt('--report')[0]
if (report) {
  const lines = ['| Package | Version | Licence | Verdict | Where |', '|---|---|---|---|---|']
  for (const r of rows) lines.push(`| ${r.name} | ${r.version} | ${r.licence} | ${r.verdict}${r.note ? ` (${r.note})` : ''} | ${r.where} |`)
  writeFileSync(report, `# Shipped npm packages\n\nNot shipped (replaced by a stub at build time): ${[...replaced].join(', ')}.\n\n${lines.join('\n')}\n`)
  console.log(`[licences] report: ${report}`)
}

console.log(`[licences] ${rows.length} shipped packages checked`)
if (problems.length) {
  console.error(`[licences] FAILED — ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('[licences] OK: no GPL, AGPL, LGPL, non-commercial or unknown-licence code ships')
