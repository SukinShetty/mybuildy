// release-assets-lib.mjs — replace a release's files IN PLACE, so its download
// links keep working throughout, and never change whether it is published.
//
// GitHub allows only one asset per name on a release, so "upload the new file
// and then remove the old one with the same name" is done as:
//   1. upload the new file as "<name>.uploading"     (old file still served)
//   2. rename the old file to "<name>.old"
//   3. rename the new file to "<name>"               (new file served)
//   4. delete "<name>.old"
// The link is unavailable only between 2 and 3 — two back-to-back API calls.
// If 3 fails, the old file is renamed back, so the link keeps the old file.
//
// The GitHub calls are injected (see release-assets.mjs), so the order is
// unit-tested (release-assets-lib.test.ts).

const UPLOADING = '.uploading'
const OLD = '.old'

/**
 * Installers and zips first; then the update feeds (latest*.yml), so an app
 * checking for updates never sees a feed pointing at a file not yet replaced;
 * SHA256SUMS.txt last, so its checksums never describe files not yet replaced.
 */
export function uploadOrder(names) {
  const isFeed = (n) => /^latest(-mac)?\.yml$/.test(n)
  const sums = names.filter((n) => n === 'SHA256SUMS.txt')
  const feeds = names.filter(isFeed).sort()
  return [...names.filter((n) => n !== 'SHA256SUMS.txt' && !isFeed(n)).sort(), ...feeds, ...sums]
}

/**
 * Replace (or add) one asset. `api`:
 *   listAssets(releaseId) → [{ id, name }]
 *   upload(releaseId, name, data) → { id }
 *   rename(assetId, name)
 *   remove(assetId)
 */
export async function replaceAssetInPlace(api, releaseId, name, data, log = () => {}) {
  const before = await api.listAssets(releaseId)
  // Leftovers from an interrupted earlier run.
  for (const a of before) {
    if (a.name === name + UPLOADING || a.name === name + OLD) {
      log(`removing leftover ${a.name}`)
      await api.remove(a.id)
    }
  }
  const old = before.find((a) => a.name === name) || null

  const fresh = await api.upload(releaseId, name + UPLOADING, data)
  if (!old) {
    await api.rename(fresh.id, name)
    log(`added ${name}`)
    return { replaced: false, id: fresh.id }
  }

  await api.rename(old.id, name + OLD)
  try {
    await api.rename(fresh.id, name)
  } catch (error) {
    // Put the old file back under its name so the link keeps working.
    await api.rename(old.id, name)
    await api.remove(fresh.id)
    throw error
  }
  await api.remove(old.id)
  log(`replaced ${name}`)
  return { replaced: true, id: fresh.id }
}

/** Find the release for a tag, draft or published (drafts are not returned by /releases/tags/). */
export function findReleaseForTag(releases, tag) {
  return releases.find((r) => r.tag_name === tag) || null
}
