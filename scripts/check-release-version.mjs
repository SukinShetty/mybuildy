// check-release-version.mjs — fail the release if the versions disagree.
// Compares: the git tag (vX.Y.Z), package.json, the version inside every
// packaged app found under dist/ (app.asar's package.json; on macOS also the
// bundle's CFBundleShortVersionString), and the version in the artifact names.
//
//   node scripts/check-release-version.mjs v0.1.0
//
// Run AFTER electron-builder in each release job.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { artifactProblems } from './release-version-lib.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const tag = (process.argv[2] || process.env.GITHUB_REF_NAME || '').trim()
const problems = []
const seen = []

if (!/^v\d+\.\d+\.\d+$/.test(tag)) problems.push(`tag "${tag}" is not of the form vX.Y.Z`)
const tagVersion = tag.replace(/^v/, '')
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
seen.push(`tag ${tagVersion}`, `package.json ${pkgVersion}`)
if (pkgVersion !== tagVersion) problems.push(`package.json is ${pkgVersion} but the tag is ${tag}`)

const dist = 'dist'
const asars = []
if (existsSync(join(dist, 'win-unpacked', 'resources', 'app.asar'))) asars.push(join(dist, 'win-unpacked', 'resources', 'app.asar'))
for (const d of existsSync(dist) ? readdirSync(dist) : []) {
  const p = join(dist, d, 'MyBuildy.app', 'Contents', 'Resources', 'app.asar')
  if (d.startsWith('mac') && existsSync(p)) asars.push(p)
}
if (asars.length === 0) problems.push('no packaged app found under dist/ (run electron-builder first)')

for (const file of asars) {
  const version = JSON.parse(asar.extractFile(file, 'package.json').toString('utf8')).version
  seen.push(`${file} ${version}`)
  if (version !== tagVersion) problems.push(`${file} contains version ${version}, expected ${tagVersion}`)
  if (file.includes('.app')) {
    const plist = readFileSync(join(file, '..', '..', 'Info.plist'), 'utf8')
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    const bundleVersion = m ? m[1] : '(missing)'
    seen.push(`${file} Info.plist ${bundleVersion}`)
    if (bundleVersion !== tagVersion) problems.push(`${file} bundle version is ${bundleVersion}, expected ${tagVersion}`)
  }
}

// Every installer file in dist/ must be EXACTLY one of this version's names.
const artifacts = existsSync(dist) ? readdirSync(dist).filter((f) => /\.(exe|dmg|zip)$/i.test(f) && !/__uninstaller/i.test(f)) : []
for (const a of artifacts) seen.push(`artifact ${a}`)
problems.push(...artifactProblems(tagVersion, artifacts))

console.log(`[version-check] ${seen.join(' | ')}`)
if (problems.length) {
  for (const p of problems) console.error(`[version-check] MISMATCH: ${p}`)
  process.exit(1)
}
console.log(`[version-check] OK — everything is ${tagVersion}`)
