// update-check.ts — "is there a newer MyBuildy?" asked ONCE, when the app opens.
//
// Uses electron-updater against this repo's public GitHub Releases (no token,
// no MyBuildy server, no polling). If a newer version is published, the robot
// shows "New update available" with its release notes and an Update button.
// Nothing downloads until Update is clicked, nothing installs until "Restart to
// update" is clicked, and Later hides the notice for this session.
// Offline / GitHub errors are logged and never shown.
//
// The updater is injected so the behaviour is unit-tested (update-check.test.ts);
// index.ts wires the real electron-updater autoUpdater.

import type { UpdateNotice } from '../renderer/src/types'

/** The part of electron-updater's AppUpdater this module uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateCheckDeps {
  updater: UpdaterLike
  currentVersion: string
  /** Dev / unpackaged runs and test runs never check. */
  enabled: boolean
  /** Push the notice (or null) to the robot. */
  notify: (notice: UpdateNotice | null) => void
  log: (message: string) => void
  /** Runs just before quitAndInstall (lets the app mark itself as quitting). */
  beforeInstall?: () => void
}

export interface UpdateCheck {
  checkOnce(): Promise<void>
  download(): Promise<void>
  install(): void
  dismiss(): void
  current(): UpdateNotice | null
}

const MAX_NOTES = 1200

/**
 * Only installed (packaged) Windows and macOS builds check. Dev runs, Linux
 * (runs from source), e2e runs and MYBUILDY_DISABLE_UPDATE_CHECK=1 never do.
 */
export function updateCheckEnabled(o: { isPackaged: boolean; platform: string; env: Record<string, string | undefined> }): boolean {
  if (!o.isPackaged) return false
  if (o.platform !== 'win32' && o.platform !== 'darwin') return false
  if (o.env['MYBUILDY_DISABLE_UPDATE_CHECK'] === '1' || o.env['MYBUILDY_E2E'] === '1') return false
  return true
}

/** Release notes from GitHub arrive as HTML (or a list of them): show plain text. */
export function plainReleaseNotes(notes: unknown): string {
  const raw = Array.isArray(notes)
    ? notes.map((n) => (n && typeof n === 'object' ? String((n as { note?: unknown }).note ?? '') : String(n ?? ''))).join('\n')
    : typeof notes === 'string' ? notes : ''
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|li|h[1-6]|div)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > MAX_NOTES ? text.slice(0, MAX_NOTES).trimEnd() + '…' : text
}

export function createUpdateCheck(deps: UpdateCheckDeps): UpdateCheck {
  const { updater, notify, log } = deps
  let checked = false
  let notice: UpdateNotice | null = null
  let dismissed = false

  const set = (next: UpdateNotice | null): void => {
    notice = next
    if (!dismissed || next === null) notify(next)
  }

  if (deps.enabled) {
    // Never download or install on its own.
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.logger = { info: log, warn: log, error: log, debug: () => {} }

    updater.on('update-available', (info: { version?: string; releaseNotes?: unknown }) => {
      const version = String(info?.version ?? '')
      log(`[Update] ${version} available (running ${deps.currentVersion})`)
      set({ phase: 'available', version, notes: plainReleaseNotes(info?.releaseNotes) })
    })
    updater.on('update-not-available', () => log(`[Update] up to date (${deps.currentVersion})`))
    updater.on('download-progress', (p: { percent?: number }) => {
      if (notice && notice.phase !== 'ready') set({ ...notice, phase: 'downloading', percent: Math.round(p?.percent ?? 0) })
    })
    updater.on('update-downloaded', () => {
      if (notice) set({ phase: 'ready', version: notice.version, notes: notice.notes })
    })
    updater.on('error', (e: unknown) => {
      // Offline, GitHub down, rate limit, bad download: log only, show nothing.
      log(`[Update] ${e instanceof Error ? e.message : String(e)}`)
      if (notice) set(null)
    })
  }

  return {
    async checkOnce() {
      if (!deps.enabled || checked) return
      checked = true
      try { await updater.checkForUpdates() } catch (e) { log(`[Update] check failed: ${e instanceof Error ? e.message : String(e)}`) }
    },
    async download() {
      if (!notice || notice.phase !== 'available') return
      set({ ...notice, phase: 'downloading', percent: 0 })
      try { await updater.downloadUpdate() } catch (e) {
        log(`[Update] download failed: ${e instanceof Error ? e.message : String(e)}`)
        set(null)
      }
    },
    install() {
      if (notice?.phase !== 'ready') return
      log(`[Update] restarting to install ${notice.version}`)
      deps.beforeInstall?.()
      updater.quitAndInstall(false, true)
    },
    dismiss() {
      dismissed = true
      notify(null)
    },
    current: () => (dismissed ? null : notice),
  }
}
