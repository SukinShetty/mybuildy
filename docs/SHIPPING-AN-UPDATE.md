# How to ship an update

Installed MyBuildy apps (Windows and Mac, from 0.1.1 on) check GitHub **once when
they open**. If a newer **published** release exists, the robot shows
"New update available: MyBuildy x.y.z" with that release's notes, an **Update**
button and **Later**. Update downloads; **Restart to update** installs. Nothing
downloads or installs without a click. Offline or errors: nothing is shown
(logged only). Dev runs, Linux and e2e runs never check.

The app reads `latest.yml` (Windows) and `latest-mac.yml` (Mac) from the
**latest published, non-prerelease** GitHub Release of `SukinShetty/mybuildy`.

## Steps

1. **Bump the version.** `package.json` `"version"` (e.g. `0.1.0` → `0.1.1`), then
   `npm install --package-lock-only --legacy-peer-deps` so the lockfile agrees.
   Add the release to `CHANGELOG.md` and `docs/release-notes/vX.Y.Z.md`. Merge to `main`.
2. **Tag and push:** `git tag v0.1.1 && git push origin v0.1.1`.
3. **`release.yml` runs** (Windows NSIS + signed/notarized Mac). It uploads to a
   **draft** release: the installers, the Mac update zips, `latest.yml`,
   `latest-mac.yml`, the blockmaps and `SHA256SUMS.txt`.
   Feeds are uploaded after the files they point at.
4. **Write the release notes** in the draft's description — they are what the
   robot shows under "New update available" (plain text; HTML is stripped).
5. **Publish** the draft (not as a pre-release). From that moment, every
   installed app that is opened sees the update. mybuildy.com downloads switch
   to it at the same time.

## Things that will not work

- **Rebuilding the same version in place does not trigger updates.** Moving
  the `v0.1.0` tag and re-running the release replaces the files, but installed
  0.1.0 apps compare versions, see 0.1.0 = 0.1.0 and stay quiet. Always bump.
- **0.1.0 has no update check.** People on 0.1.0 must download 0.1.1 once from
  mybuildy.com; from 0.1.1 on they are told about each new version.
- **Drafts and pre-releases are invisible** to installed apps (no `allowPrerelease`).
- **Mac** updates need the signed, notarized app inside the zip (the release job
  signs and notarizes; never publish an unsigned Mac build — Squirrel.Mac
  refuses an update not signed by the same Developer ID).
- **Windows** is unsigned: electron-updater only verifies the publisher when the
  app is configured with a `publisherName`; we have none, so the update is
  checked against the SHA-512 in `latest.yml` only (downloaded over HTTPS from
  GitHub). If Windows code signing is added later, set `win.signtoolOptions.publisherName`
  (or `win.publisherName`) in the same release that starts signing, because from then on
  every update must carry that signature.

## Testing a real update without touching public users

Use a throwaway public repo so nothing appears on `SukinShetty/mybuildy` releases:

1. Create `SukinShetty/mybuildy-update-test` (public, empty).
2. On a throwaway branch, set `build.publish[0].repo` to `mybuildy-update-test`
   and build two versions, e.g. `0.9.0` and `0.9.1` (never tagged or published
   on the real repo).
3. Build and install `0.9.0` (Windows: `npx electron-builder --win nsis --publish never`;
   Mac: the signed build from `mac-signed-build.yml`, which also makes the zip).
4. Build `0.9.1`, create a **published** release `v0.9.1` on the test repo and
   upload its installer/zips, blockmaps and `latest*.yml`.
5. Open the installed 0.9.0: expect the notice, click Update, then Restart, and
   check the installed version is 0.9.1 (Windows: Settings → Apps; Mac: Finder → Get Info). On a Mac, run it from /Applications — Squirrel.Mac cannot replace an app running from the DMG or a quarantined Downloads folder. Also try: offline (nothing shown), Later (gone).
6. Delete the test repo and uninstall.

## Privacy notes for maintainers

- electron-updater normally writes `userData/.updaterId` and sends it as
  `x-user-staging-id` (for staged rollouts). `update-check.ts` replaces it with
  one all-zero value shared by every install, so no ID file is created. Don't
  use `stagingPercentage` in `latest*.yml` — with the shared value every install
  would get it at once.
- "Restart to update" only sets quit flags and calls `quitAndInstall()`; the
  updater closes the windows itself (on macOS after its Squirrel handoff).
  Don't add window-closing or `app.quit()` before it.
