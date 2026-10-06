// setup-permissions.ts — main process. The macOS permissions the setup wizard
// walks through, checked live and requested at the step that explains them —
// never by surprise later:
//
//   screen        Screen Recording (Screen & System Audio Recording). macOS
//                 lists MyBuildy in System Settings once it has tried to
//                 capture, and applies a new grant only after a restart.
//   accessibility Pressing Cmd+V for "Paste into terminal".
//   automation    Asking System Events to bring the terminal forward and press
//                 Cmd+V. macOS shows its "MyBuildy wants to control System
//                 Events" prompt the first time; the wizard triggers it on
//                 purpose. There is no API to read this permission without
//                 asking, so the result of that request is what is reported.
//
// Microphone is deliberately NOT here: it is asked for only the first time the
// user clicks the mic button.
//
// e2e: with MYBUILDY_E2E=1 in a dev build, e2e-fakes.ts can stand in for the
// platform and these permissions, so both platforms' steps are testable.

import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { execFile } from 'child_process'
import { permissionSettingsUrl } from './mac-permissions-core'
import { e2eFakes, isE2eDevRun } from './e2e-fakes'

export type ScreenStatus = 'granted' | 'not-granted' | 'unknown'
export type AutomationStatus = 'granted' | 'denied' | 'unknown'

export interface SetupPermissions {
  screen: ScreenStatus
  accessibility: boolean
  automation: AutomationStatus
}

let automationResult: AutomationStatus = 'unknown'

/** The platform the setup wizard is for (process.platform, or the e2e fake). */
export function setupPlatform(): NodeJS.Platform {
  return e2eFakes()?.platform ?? process.platform
}

export function getSetupPermissions(): SetupPermissions {
  const fake = e2eFakes()
  if (fake) return { ...fake.permissions }
  if (process.platform !== 'darwin') return { screen: 'granted', accessibility: true, automation: 'granted' }
  const status = systemPreferences.getMediaAccessStatus('screen')
  return {
    screen: status === 'granted' ? 'granted' : status === 'unknown' ? 'unknown' : 'not-granted',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    automation: automationResult,
  }
}

/**
 * Make macOS list MyBuildy under Screen Recording (and show its own prompt the
 * first time): a 1×1 screen capture attempt, never stored or sent anywhere.
 */
export async function registerForScreenRecording(): Promise<void> {
  if (e2eFakes() || process.platform !== 'darwin') return
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  } catch {
    // The prompt, not the capture, is the point.
  }
}

export async function openPermissionPane(permission: 'screen' | 'accessibility' | 'automation'): Promise<void> {
  const fake = e2eFakes()
  if (fake) { fake.openedPanes.push(permission); return }
  if (process.platform !== 'darwin') return
  await shell.openExternal(permissionSettingsUrl(permission))
}

/** Ask System Events for its name: triggers macOS's Automation prompt the first time. */
function probeAutomation(): Promise<AutomationStatus> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', "Application('System Events').name()"],
      { timeout: 120_000 }, // the prompt waits for the user
      (error, _stdout, stderr) => {
        if (!error) return resolve('granted')
        resolve(/-1743/.test(String(stderr)) ? 'denied' : 'unknown')
      }
    )
  })
}

/**
 * "Let MyBuildy paste for you": show both macOS prompts now, where the wizard
 * explains them — Accessibility (with its System Settings button) and the
 * System Events Automation prompt.
 */
export async function requestPastePermissions(): Promise<SetupPermissions> {
  const fake = e2eFakes()
  if (fake) {
    fake.pastePermissionRequests++
    return getSetupPermissions()
  }
  if (process.platform !== 'darwin') return getSetupPermissions()
  systemPreferences.isTrustedAccessibilityClient(true) // shows macOS's prompt if not yet trusted
  automationResult = await probeAutomation()
  return getSetupPermissions()
}

/** Quit and reopen MyBuildy (macOS applies Screen Recording only after a restart). */
export function restartApp(): void {
  if (isE2eDevRun()) {
    // e2e: Playwright relaunches the app itself with the same profile.
    app.quit()
    return
  }
  app.relaunch()
  app.quit()
}
