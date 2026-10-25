// release-assets.mjs — put this build's files on the release for a tag,
// replacing existing files IN PLACE (release-assets-lib.mjs). Run by the final
// job of release.yml:
//
//   node scripts/release-assets.mjs <tag> <dir>        (GITHUB_TOKEN, GITHUB_REPOSITORY)
//
// - An existing release for the tag (draft or published) is updated file by
//   file; its draft/published state, title and notes are never touched.
// - No release yet → a new DRAFT is created (nothing is ever published here).
// - Afterwards every file is downloaded again and its SHA256 compared with the
//   build: through the API always, and through the public download URL too when
//   the release is published. Any mismatch fails the job.

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { releaseFileNames } from './release-version-lib.mjs'
import { replaceAssetInPlace, uploadOrder, findReleaseForTag } from './release-assets-lib.mjs'

const [tag, dir] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
if (!tag || !dir || !token || !repo) {
  console.error('usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/release-assets.mjs <tag> <dir>')
  process.exit(2)
}

const API = `https://api.github.com/repos/${repo}`
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mybuildy-release' }

async function gh(method, url, body, extra = {}) {
  const res = await fetch(url, { method, headers: { ...headers, ...extra }, body })
  if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*/, '')} → HTTP ${res.status}`)
  return res.status === 204 ? null : res.json()
}

const api = {
  listAssets: (id) => gh('GET', `${API}/releases/${id}/assets?per_page=100`),
  upload: (id, name, data) =>
    gh('POST', `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, data, {
      'Content-Type': 'application/octet-stream',
    }),
  rename: (assetId, name) => gh('PATCH', `${API}/releases/assets/${assetId}`, JSON.stringify({ name })),
  remove: (assetId) => gh('DELETE', `${API}/releases/assets/${assetId}`),
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const version = tag.replace(/^v/, '')
const names = uploadOrder([...releaseFileNames(version), 'SHA256SUMS.txt'])
for (const n of names) if (!existsSync(join(dir, n))) throw new Error(`missing build file ${n}`)

let release = findReleaseForTag(await gh('GET', `${API}/releases?per_page=100`), tag)
if (!release) {
  release = await gh('POST', `${API}/releases`, JSON.stringify({ tag_name: tag, name: tag, draft: true }))
  console.log(`No release for ${tag} yet — created a DRAFT (id ${release.id}).`)
} else {
  console.log(`Updating the existing ${release.draft ? 'DRAFT' : 'PUBLISHED'} release for ${tag} (id ${release.id}) in place.`)
}
const draftBefore = release.draft

for (const name of names) {
  await replaceAssetInPlace(api, release.id, name, readFileSync(join(dir, name)), (m) => console.log(`  ${m}`))
}

// Verify: every name now serves exactly this build's bytes.
const after = await gh('GET', `${API}/releases/${release.id}`)
if (after.draft !== draftBefore) throw new Error('release draft/published state changed — this must never happen')
let failed = false
for (const name of names) {
  const expected = sha256(readFileSync(join(dir, name)))
  const matches = after.assets.filter((a) => a.name === name)
  if (matches.length !== 1) { console.error(`✗ ${name}: ${matches.length} assets with this name`); failed = true; continue }
  const viaApi = await fetch(matches[0].url, { headers: { ...headers, Accept: 'application/octet-stream' } })
  const apiOk = viaApi.ok && sha256(Buffer.from(await viaApi.arrayBuffer())) === expected
  let line = `${apiOk ? '✓' : '✗'} ${name} (API)`
  if (!after.draft) {
    const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`
    const pub = await fetch(url)
    const pubOk = pub.ok && sha256(Buffer.from(await pub.arrayBuffer())) === expected
    line += ` · ${pubOk ? '✓' : '✗'} ${url}`
    if (!pubOk) failed = true
  }
  if (!apiOk) failed = true
  console.log(line)
}
const leftovers = after.assets.filter((a) => !names.includes(a.name)).map((a) => a.name)
if (leftovers.length) console.log(`Other files left untouched on the release: ${leftovers.join(', ')}`)
console.log(`Release state unchanged: ${after.draft ? 'draft' : 'published'} — ${after.html_url}`)
if (failed) process.exit(1)
