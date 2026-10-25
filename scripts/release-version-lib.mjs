// release-version-lib.mjs — pure checks used by check-release-version.mjs (and its tests).

/** The exact installer / app file names a release of `version` produces (checked in dist/). */
export function expectedArtifactNames(version) {
  return [
    `MyBuildy-Setup-${version}.exe`,
    `MyBuildy-${version}-arm64.dmg`,
    `MyBuildy-${version}-x64.dmg`,
    // Mac auto-update reads the app from these zips (Squirrel.Mac needs a zip).
    `MyBuildy-${version}-arm64-mac.zip`,
    `MyBuildy-${version}-x64-mac.zip`,
  ]
}

/**
 * The files the in-app update check (electron-updater, GitHub provider) reads:
 * latest.yml / latest-mac.yml say which version is newest and point at the
 * installer (Windows) or zip (Mac); the .blockmap files allow smaller, differential downloads.
 */
export function updateArtifactNames(version) {
  return [
    'latest.yml',
    `MyBuildy-Setup-${version}.exe.blockmap`,
    'latest-mac.yml',
    `MyBuildy-${version}-arm64-mac.zip.blockmap`,
    `MyBuildy-${version}-x64-mac.zip.blockmap`,
  ]
}

/** Every file release.yml puts on the release (SHA256SUMS.txt aside). */
export function releaseFileNames(version) {
  return [...expectedArtifactNames(version), ...updateArtifactNames(version)]
}

/**
 * Problems with the installer files found in dist/: each must be EXACTLY one of
 * the expected names (no prefix/substring matching), and there must be at least one.
 */
export function artifactProblems(version, names) {
  const expected = new Set(expectedArtifactNames(version))
  const problems = []
  if (names.length === 0) problems.push('no installer files found under dist/')
  for (const name of names) {
    if (!expected.has(name)) problems.push(`artifact ${name} is not an exact ${version} release file name`)
  }
  return problems
}
