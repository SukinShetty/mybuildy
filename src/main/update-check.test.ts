import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUpdateCheck, updateCheckEnabled, plainReleaseNotes, type UpdaterLike } from './update-check'
import type { UpdateNotice } from '../renderer/src/types'

// A fake electron-updater autoUpdater: records calls, lets the test fire events.
function fakeUpdater() {
  const listeners = new Map<string, ((...a: any[]) => void)[]>()
  const u = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null as unknown,
    on: vi.fn((e: string, fn: (...a: any[]) => void) => { listeners.set(e, [...(listeners.get(e) ?? []), fn]) }),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    emit: (e: string, ...a: any[]) => (listeners.get(e) ?? []).forEach((fn) => fn(...a)),
  }
  return u satisfies UpdaterLike & { emit: unknown }
}

function setup(enabled = true) {
  const updater = fakeUpdater()
  const shown: (UpdateNotice | null)[] = []
  const log = vi.fn()
  const beforeInstall = vi.fn()
  const check = createUpdateCheck({ updater, currentVersion: '0.1.0', enabled, notify: (n) => shown.push(n), log, beforeInstall })
  const last = () => shown[shown.length - 1]
  return { updater, shown, last, log, beforeInstall, check }
}

describe('update check on open', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks exactly once, never on a timer, and never downloads or installs on its own', async () => {
    const { updater, check } = setup()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    await check.checkOnce()
    await check.checkOnce()
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('index.ts asks once after the windows are up, and nothing schedules it again', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(index.match(/updateCheck\.checkOnce\(\)/g)).toHaveLength(1)
    const ready = index.slice(index.indexOf('app.whenReady()'))
    expect(ready).toContain('updateCheck.checkOnce()')
    const mod = readFileSync(join(__dirname, 'update-check.ts'), 'utf8')
    expect(mod).not.toMatch(/setInterval|setTimeout/)
    expect(index).not.toMatch(/setInterval\([^)]*checkOnce|checkForUpdatesAndNotify/)
  })

  it('a newer version shows "New update available" with its release notes', async () => {
    const { updater, check, last } = setup()
    await check.checkOnce()
    updater.emit('update-available', { version: '0.1.1', releaseNotes: '<h2>Fixes</h2><ul><li>Paste works in &quot;iTerm&quot;</li></ul>' })
    expect(last()).toEqual({ phase: 'available', version: '0.1.1', notes: expect.stringContaining('• Paste works in "iTerm"') })
    expect(check.current()?.phase).toBe('available')
  })

  it('Update downloads; the download finishing offers Restart, which installs', async () => {
    const { updater, check, last, beforeInstall } = setup()
    updater.emit('update-available', { version: '0.1.1', releaseNotes: 'Notes' })
    check.install() // not downloaded yet: nothing
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await check.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(last()?.phase).toBe('downloading')
    updater.emit('download-progress', { percent: 42.4 })
    expect(last()).toMatchObject({ phase: 'downloading', percent: 42 })
    updater.emit('update-downloaded', { version: '0.1.1' })
    expect(last()).toEqual({ phase: 'ready', version: '0.1.1', notes: 'Notes' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    check.install()
    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('offline or any error shows nothing (logged only)', async () => {
    const { updater, check, shown, log } = setup()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await check.checkOnce()
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(shown).toEqual([])
    expect(check.current()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ERR_INTERNET_DISCONNECTED'))
  })

  it('a failed download hides the notice instead of showing an error', async () => {
    const { updater, check, last } = setup()
    updater.emit('update-available', { version: '0.1.1' })
    updater.downloadUpdate.mockRejectedValueOnce(new Error('HTTP 404'))
    await check.download()
    expect(last()).toBeNull()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('Later hides it for this session and nothing installs', async () => {
    const { updater, check, last } = setup()
    updater.emit('update-available', { version: '0.1.1' })
    check.dismiss()
    expect(last()).toBeNull()
    expect(check.current()).toBeNull()
    updater.emit('update-available', { version: '0.1.1' })
    expect(last()).toBeNull()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('dev / unpackaged builds never check', async () => {
    const { updater, check } = setup(false)
    await check.checkOnce()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.on).not.toHaveBeenCalled()
  })
})

describe('updateCheckEnabled', () => {
  const on = { isPackaged: true, platform: 'win32', env: {} }
  it('installed Windows and Mac apps check', () => {
    expect(updateCheckEnabled(on)).toBe(true)
    expect(updateCheckEnabled({ ...on, platform: 'darwin' })).toBe(true)
  })
  it('dev runs, Linux, e2e and the opt-out never check', () => {
    expect(updateCheckEnabled({ ...on, isPackaged: false })).toBe(false)
    expect(updateCheckEnabled({ ...on, platform: 'linux' })).toBe(false)
    expect(updateCheckEnabled({ ...on, env: { MYBUILDY_E2E: '1' } })).toBe(false)
    expect(updateCheckEnabled({ ...on, env: { MYBUILDY_DISABLE_UPDATE_CHECK: '1' } })).toBe(false)
  })
})

describe('plainReleaseNotes', () => {
  it('never passes HTML through, and stays short', () => {
    expect(plainReleaseNotes('<script>x</script><p>Hi</p>')).not.toMatch(/[<>]/)
    expect(plainReleaseNotes([{ version: '0.1.1', note: '<p>A</p>' }])).toBe('A')
    expect(plainReleaseNotes(undefined)).toBe('')
    expect(plainReleaseNotes('x'.repeat(5000)).length).toBeLessThanOrEqual(1201)
  })
})
