// after-pack.js — electron-builder afterPack hook (runs before signing and the DMG).
// Every platform: Buildy's voice engine (onnxruntime-node, unpacked from the
// asar) ships native builds for every OS and chip — keep only this build's.
// macOS:
//   - Release builds (CI) carry a Developer ID certificate in CSC_LINK (or a
//     keychain identity in CSC_NAME): electron-builder itself then signs the
//     .app with the hardened runtime and build/entitlements.mac.plist, and
//     notarizes it with the APPLE_* credentials. Nothing to do here.
//   - Local builds without a certificate: ad-hoc sign ("codesign --sign -") so
//     the app still launches on Apple Silicon, then verify the signature so a
//     broken bundle fails the build instead of reaching a tester.

const { execFileSync } = require('child_process')
const { existsSync, readdirSync, rmSync } = require('fs')
const { join } = require('path')
const { Arch } = require('builder-util')

/** Remove onnxruntime-node's native builds for other platforms and chips. */
function keepOnlyThisPlatformsVoiceEngine(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const bin = join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
  if (!existsSync(bin)) throw new Error(`[after-pack] voice engine missing: ${bin}`)
  const arch = Arch[context.arch]
  for (const os of readdirSync(bin)) {
    for (const cpu of readdirSync(join(bin, os))) {
      if (os === context.electronPlatformName && cpu === arch) continue
      rmSync(join(bin, os, cpu), { recursive: true, force: true })
    }
    if (readdirSync(join(bin, os)).length === 0) rmSync(join(bin, os), { recursive: true, force: true })
  }
  if (!existsSync(join(bin, context.electronPlatformName, arch))) {
    throw new Error(`[after-pack] no voice engine for ${context.electronPlatformName}-${arch}`)
  }
  console.log(`[after-pack] voice engine: kept ${context.electronPlatformName}-${arch} only`)
}

const ENTITLEMENTS = join(__dirname, '..', 'build', 'entitlements.mac.plist')

exports.default = async function afterPack(context) {
  keepOnlyThisPlatformsVoiceEngine(context)
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
