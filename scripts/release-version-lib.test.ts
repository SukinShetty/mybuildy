import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs module shared with the release script (no type declarations)
import { artifactProblems, expectedArtifactNames, releaseFileNames } from './release-version-lib.mjs'

describe('release check: artifact names must match the version exactly', () => {
  it('lists the exact names for a version', () => {
    expect(expectedArtifactNames('0.1.0')).toEqual([
      'MyBuildy-Setup-0.1.0.exe',
      'MyBuildy-0.1.0-arm64.dmg',
      'MyBuildy-0.1.0-x64.dmg',
      'MyBuildy-0.1.0-arm64-mac.zip',
      'MyBuildy-0.1.0-x64-mac.zip',
    ])
  })

  it('the release also carries the update feeds and blockmaps the in-app update check reads', () => {
    expect(releaseFileNames('0.1.1')).toEqual(expect.arrayContaining([
      'MyBuildy-Setup-0.1.1.exe', 'latest.yml', 'MyBuildy-Setup-0.1.1.exe.blockmap',
      'latest-mac.yml', 'MyBuildy-0.1.1-arm64-mac.zip', 'MyBuildy-0.1.1-x64-mac.zip',
      'MyBuildy-0.1.1-arm64-mac.zip.blockmap', 'MyBuildy-0.1.1-x64-mac.zip.blockmap',
    ]))
  })

  it('accepts the exact names', () => {
    expect(artifactProblems('0.1.0', ['MyBuildy-Setup-0.1.0.exe'])).toEqual([])
    expect(artifactProblems('0.1.0', ['MyBuildy-0.1.0-arm64.dmg', 'MyBuildy-0.1.0-x64.dmg'])).toEqual([])
  })

  it('rejects MyBuildy-Setup-0.1.01.exe for v0.1.0 (a prefix match is not enough)', () => {
    expect(artifactProblems('0.1.0', ['MyBuildy-Setup-0.1.01.exe'])).not.toEqual([])
  })

  it('rejects other near misses and an empty build', () => {
    for (const name of ['MyBuildy-Setup-0.1.0.1.exe', 'MyBuildy-Setup-10.1.0.exe', 'MyBuildy-0.1.0-arm64-extra.dmg', 'MyBuildy-0.1.1-x64.dmg']) {
      expect(artifactProblems('0.1.0', [name]), name).not.toEqual([])
    }
    expect(artifactProblems('0.1.0', [])).not.toEqual([])
  })
})
