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
  /**
   * The updater, or a function returning it. Pass a function for the real
   * electron-updater autoUpdater: merely reading that export constructs an
   * updater, which throws on some dev / Linux runs (e.g. app version "0.0"),
   * so it must only be touched when the check is enabled.
   */
  updater: UpdaterLike | (() => UpdaterLike)
  currentVersion: string
  /** Dev / unpackaged runs and test runs never check. */
  enabled: boolean
  /** Push the notice (or null) to the robot. */
  notify: (notice: UpdateNotice | null) => void
  log: (message: string) => void
  /**
   * Runs just before quitAndInstall. Must ONLY set flags (so close / quit
   * handlers let the updater's own quit through) — never close windows or quit:
   * the updater closes them itself, after its handoff (Squirrel.Mac on macOS).
   */
  prepareForInstall?: () => void
}

export interface UpdateCheck {
  checkOnce(): Promise<void>
  download(): Promise<void>
  install(): void
  dismiss(): void
  current(): UpdateNotice | null
}

const MAX_NOTES = 1200

/** The same for every install, so it identifies nobody (see createUpdateCheck). */
export const SHARED_STAGING_ID = '00000000-0000-0000-0000-000000000000'

/**
 * 'window-all-closed' normally quits the app. While the updater is quitting to
 * install, it owns the quit (macOS: Squirrel closes the windows, then quits and
 * relaunches), so the app must not quit underneath it.
 */
export function quitOnAllWindowsClosed(quittingForUpdate: boolean): boolean {
  return !quittingForUpdate
}

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
  const { notify, log } = deps
  // Resolved only when enabled: disabled runs never construct the updater.
  const updater: UpdaterLike | null = !deps.enabled ? null
    : typeof deps.updater === 'function' ? deps.updater() : deps.updater
  let checked = false
  let notice: UpdateNotice | null = null
  let dismissed = false

  const set = (next: UpdateNotice | null): void => {
    notice = next
    if (!dismissed || next === null) notify(next)
  }

  if (updater) {
    // No install ID: electron-updater 6.x would otherwise create
    // userData/.updaterId (a random UUID, kept forever) and send it with every
    // update request as "x-user-staging-id" (only used for staged rollouts,
    // which MyBuildy does not use). Every install sends this same all-zero value.
    ;(updater as unknown as { stagingUserIdPromise: { value: Promise<string> } }).stagingUserIdPromise = { value: Promise.resolve(SHARED_STAGING_ID) }

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
      if (!updater || checked) return
      checked = true
      try { await updater.checkForUpdates() } catch (e) { log(`[Update] check failed: ${e instanceof Error ? e.message : String(e)}`) }
    },
    async download() {
      if (!updater || !notice || notice.phase !== 'available') return
      set({ ...notice, phase: 'downloading', percent: 0 })
      try { await updater.downloadUpdate() } catch (e) {
        log(`[Update] download failed: ${e instanceof Error ? e.message : String(e)}`)
        set(null)
      }
    },
    install() {
      if (!updater || notice?.phase !== 'ready') return
      log(`[Update] restarting to install ${notice.version}`)
      deps.prepareForInstall?.()
      updater.quitAndInstall(false, true)
    },
    dismiss() {
      dismissed = true
      notify(null)
    },
    current: () => (dismissed ? null : notice),
  }
}
