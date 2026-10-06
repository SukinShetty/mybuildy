// after-pack.js — electron-builder afterPack hook (runs before signing and the DMG).
// macOS only.
//   - Release builds (CI) carry a Developer ID certificate in CSC_LINK (or a
//     keychain identity in CSC_NAME): electron-builder itself then signs the
//     .app with the hardened runtime and build/entitlements.mac.plist, and
//     notarizes it with the APPLE_* credentials. Nothing to do here.
//   - Local builds without a certificate: ad-hoc sign ("codesign --sign -") so
//     the app still launches on Apple Silicon, then verify the signature so a
//     broken bundle fails the build instead of reaching a tester.
// Windows/Linux builds return immediately.

const { execFileSync } = require('child_process')
const { join } = require('path')

const ENTITLEMENTS = join(__dirname, '..', 'build', 'entitlements.mac.plist')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[after-pack] Developer ID certificate present — electron-builder signs and notarizes')
    return
  }
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`[after-pack] no certificate — ad-hoc signing ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', ENTITLEMENTS, appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
}
