// launch.spec.ts — smoke: every window loads, no renderer console errors,
// no uncaught main-process errors, and the throwaway profile actually receives
// the app's files (proving the MYBUILDY_USER_DATA_DIR override took effect).

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { launchMyBuildy, IS_PACKAGED_RUN, type MyBuildyApp } from './helpers'

let mybuildy: MyBuildyApp

test.beforeAll(async () => {
  mybuildy = await launchMyBuildy()
})

test.afterAll(async () => {
  await mybuildy?.close()
})

test('all four windows load their routed renderer', async () => {
  expect(mybuildy.main.url()).not.toContain('companion=true')
  expect(mybuildy.companion.url()).toContain('companion=true')
  expect(mybuildy.guidance.url()).toContain('guidance=true')
  expect(mybuildy.voice.url()).toContain('voice=true')

  for (const page of [mybuildy.main, mybuildy.companion, mybuildy.guidance, mybuildy.voice]) {
    expect(await page.evaluate(() => document.readyState)).toBe('complete')
    expect(await page.evaluate(() => !!document.getElementById('root'))).toBe(true)
  }

  // The two visible UIs actually rendered content.
  expect(await mybuildy.main.evaluate(() => document.getElementById('root')!.childElementCount)).toBeGreaterThan(0)
  expect(await mybuildy.companion.evaluate(() => document.getElementById('root')!.childElementCount)).toBeGreaterThan(0)
})

test('app runs in the expected packaging mode with the overridden profile', async () => {
  const info = await mybuildy.app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    name: app.getName(),
    userData: app.getPath('userData'),
  }))
  expect(info.isPackaged).toBe(IS_PACKAGED_RUN)
  // The app name decides the REAL userData folder (…/MyBuildy) that the
  // isolation check in helpers.ts snapshots — if it drifted, that check would
  // watch a folder the app never uses and prove nothing.
  expect(info.name).toBe('MyBuildy')
  expect(path.resolve(info.userData)).toBe(path.resolve(mybuildy.profileDir))

  // The override provably took effect: the app wrote its first-run files into
  // the throwaway profile (settings/projects are created by startup).
  expect(fs.existsSync(path.join(mybuildy.profileDir, 'projects.json'))).toBe(true)
})

test('the running Electron runtime has the GHSA-jr5w-w6x2-84p9 TLS fix (>= 44.9.1)', async () => {
  // The packaged run checks the runtime actually inside the installer, not just the lockfile.
  const version = await mybuildy.app.evaluate(() => process.versions.electron)
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  expect(major).toBe(44)
  expect(minor > 9 || (minor === 9 && patch >= 1)).toBe(true)
})

test('no renderer console errors in any window', async () => {
  // Small settle so late async renderer work (settings/memory loads) surfaces.
  await mybuildy.main.waitForTimeout(1500)
  expect(mybuildy.rendererErrors).toEqual([])
})

test('no uncaught main-process errors', async () => {
  expect(await mybuildy.mainErrors()).toEqual([])
})
