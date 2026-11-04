import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs helper without type declarations
import { replaceAssetInPlace, uploadOrder, findReleaseForTag } from './release-assets-lib.mjs'

/**
 * A fake release that behaves like GitHub's: asset names are unique (uploading
 * a taken name fails with 422), and a download URL serves whichever asset holds
 * that name. After EVERY call it records what each public name serves.
 */
function fakeRelease(initial: Record<string, string>, draft: boolean) {
  let nextId = 1
  const assets = new Map<number, { name: string; data: string }>()
  for (const [name, data] of Object.entries(initial)) assets.set(nextId++, { name, data })
  const release = { id: 99, draft }
  const timeline: Array<Record<string, string | null>> = []
  const serves = (name: string) => [...assets.values()].find((a) => a.name === name)?.data ?? null
  const snapshot = () => timeline.push(Object.fromEntries(Object.keys(initial).map((n) => [n, serves(n)])))
  const taken = (name: string) => [...assets.values()].some((a) => a.name === name)
  let failRenameTo: string | null = null
  const api = {
    listAssets: async () => [...assets.entries()].map(([id, a]) => ({ id, name: a.name })),
    upload: async (_rid: number, name: string, data: string) => {
      if (taken(name)) throw new Error('HTTP 422 already_exists')
      const id = nextId++
      assets.set(id, { name, data })
      snapshot()
      return { id }
    },
    rename: async (id: number, name: string) => {
      if (name === failRenameTo) { failRenameTo = null; throw new Error('HTTP 502') }
      if (taken(name)) throw new Error('HTTP 422 already_exists')
      assets.get(id)!.name = name
      snapshot()
    },
    remove: async (id: number) => { assets.delete(id); snapshot() },
  }
  return { api, release, assets, timeline, serves, failNextRenameTo: (n: string) => { failRenameTo = n } }
}

const NAMES = ['MyBuildy-Setup-0.1.0.exe', 'MyBuildy-0.1.0-arm64.dmg', 'MyBuildy-0.1.0-x64.dmg', 'SHA256SUMS.txt']

describe('replacing release files in place', () => {
  it('every link serves a file throughout, except between two back-to-back renames; ends on the new file', async () => {
    const fake = fakeRelease(Object.fromEntries(NAMES.map((n) => [n, `old ${n}`])), false)
    for (const name of uploadOrder(NAMES)) {
      const before = fake.timeline.length
      await replaceAssetInPlace(fake.api, fake.release.id, name, `new ${name}`)
      const steps = fake.timeline.slice(before).map((t) => t[name])
      // upload (old served) → old renamed aside (gap) → new renamed in (new served) → old deleted
      expect(steps).toEqual([`old ${name}`, null, `new ${name}`, `new ${name}`])
      // No other file's link is affected meanwhile.
      for (const other of NAMES.filter((n) => n !== name)) {
        expect(fake.timeline.slice(before).every((t) => t[other] !== null)).toBe(true)
      }
    }
    for (const n of NAMES) expect(fake.serves(n)).toBe(`new ${n}`)
    expect(fake.assets.size).toBe(NAMES.length) // no leftovers
    expect(fake.release.draft).toBe(false) // the API has no way to change it; state untouched
  })

  it('SHA256SUMS.txt is replaced last', () => {
    expect(uploadOrder(NAMES).at(-1)).toBe('SHA256SUMS.txt')
  })

  it('update feeds go up after every installer and zip, so a feed never points at a missing file', () => {
    const order = uploadOrder(['SHA256SUMS.txt', 'latest.yml', 'MyBuildy-Setup-0.1.1.exe', 'latest-mac.yml', 'MyBuildy-0.1.1-x64-mac.zip', 'MyBuildy-Setup-0.1.1.exe.blockmap'])
    expect(order).toEqual(['MyBuildy-0.1.1-x64-mac.zip', 'MyBuildy-Setup-0.1.1.exe', 'MyBuildy-Setup-0.1.1.exe.blockmap', 'latest-mac.yml', 'latest.yml', 'SHA256SUMS.txt'])
  })

  it('if the final rename fails, the old file is put back under its name', async () => {
    const name = 'MyBuildy-Setup-0.1.0.exe'
    const fake = fakeRelease({ [name]: 'old' }, false)
    fake.failNextRenameTo(name)
    await expect(replaceAssetInPlace(fake.api, fake.release.id, name, 'new')).rejects.toThrow()
    expect(fake.serves(name)).toBe('old')
    expect(fake.assets.size).toBe(1)
  })

  it('cleans up leftovers from an interrupted run, and adds files a release does not have yet', async () => {
    const name = 'MyBuildy-0.1.0-x64.dmg'
    const fake = fakeRelease({ [name]: 'old', [`${name}.uploading`]: 'half', [`${name}.old`]: 'older' }, true)
    await replaceAssetInPlace(fake.api, fake.release.id, name, 'new')
    expect(fake.serves(name)).toBe('new')
    expect([...fake.assets.values()].map((a) => a.name)).toEqual([name])

    const empty = fakeRelease({}, true)
    await replaceAssetInPlace(empty.api, empty.release.id, 'SHA256SUMS.txt', 'sums')
    expect(empty.serves('SHA256SUMS.txt')).toBe('sums')
  })

  it('finds the release for a tag whether it is a draft or published', () => {
    const releases = [{ id: 1, tag_name: 'v0.0.9', draft: false }, { id: 2, tag_name: 'v0.1.0', draft: true }]
    expect(findReleaseForTag(releases, 'v0.1.0')).toEqual(releases[1])
    expect(findReleaseForTag(releases, 'v9.9.9')).toBeNull()
  })
})

describe('the release script never deletes a release', () => {
  it('only ever deletes release ASSETS, and never changes draft/published state', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = ['release-assets.mjs', 'release-assets-lib.mjs'].map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n')
    // Every DELETE goes to /releases/assets/<id>; nothing deletes /releases/<id> or a tag.
    const deletes = [...src.matchAll(/gh\('DELETE',\s*`([^`]+)`/g)].map((m) => m[1])
    expect(deletes).toEqual(['${API}/releases/assets/${assetId}'])
    expect(src).not.toMatch(/git\/refs\/tags/)
    // The release object is only ever created as a draft, never patched.
    expect(src).not.toMatch(/gh\('PATCH',\s*`\$\{API\}\/releases\/\$\{/)
    expect(src).toMatch(/draft: true/)
    expect(src).not.toMatch(/draft: false/)
  })
})
