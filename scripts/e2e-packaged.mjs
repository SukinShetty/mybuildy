// e2e-packaged.mjs — run the Playwright Electron suite against the PACKAGED app.
//   Windows: dist/win-unpacked/MyBuildy.exe (npm run package)
//   macOS:   dist/mac*/MyBuildy.app/Contents/MacOS/MyBuildy
//            (npx electron-builder --mac dmg; electron-builder names the folder
//            "mac" for x64 and "mac-arm64" for Apple Silicon — the one that
//            matches this machine's CPU is preferred)
// Dev-only tests (screenshots + fixture hook) self-skip via MYBUILDY_E2E_EXE.

import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

function packagedExecutable() {
  if (process.platform === 'win32') return resolve('dist', 'win-unpacked', 'MyBuildy.exe')
  if (process.platform === 'darwin') {
    const dirs = existsSync('dist') ? readdirSync('dist').filter((d) => d.startsWith('mac')) : []
    const preferred = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
    dirs.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)))
    const candidates = dirs.map((d) => resolve('dist', d, 'MyBuildy.app', 'Contents', 'MacOS', 'MyBuildy'))
    return candidates.find((p) => existsSync(p)) ?? join(resolve('dist'), 'mac*', 'MyBuildy.app', 'Contents', 'MacOS', 'MyBuildy')
  }
  console.error(`[test:e2e:packaged] No packaged build is produced for ${process.platform}.`)
  process.exit(1)
}

const exe = packagedExecutable()

if (!existsSync(exe)) {
  console.error(
    `[test:e2e:packaged] Packaged app not found: ${exe}\n` +
    'Build it first (Windows: `npm run package`; macOS: `npm run build && npx electron-builder --mac dmg`), ' +
    'then re-run npm run test:e2e:packaged.'
  )
  process.exit(1)
}

const result = spawnSync('npx', ['playwright', 'test'], {
  stdio: 'inherit',
  env: { ...process.env, MYBUILDY_E2E_EXE: exe, MYBUILDY_DISABLE_UPDATE_CHECK: '1' },
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
