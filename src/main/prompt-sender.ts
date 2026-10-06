// prompt-sender.ts — main process
// Executes an approved "Send to Claude Code": puts the sanitized prompt on the
// clipboard, then runs a FIXED script (see prompt-sender-core.ts) that brings
// the watched window forward and pastes (it never presses Enter — the user
// reads the prompt and runs it):
//   - Windows: PowerShell (AppActivate, foreground check, SendKeys Ctrl+V)
//   - macOS:   osascript (activate the owning app, verify it is frontmost,
//              then System Events Cmd+V)
// The prompt text and the target are never part of the command string — text
// travels via the clipboard, the target via MYBUILDY_TARGET_* environment
// variables.
//
// Serialized: one send at a time. A second send while one is in flight is
// rejected (not queued) by the caller via isSendInFlight().

import { clipboard, desktopCapturer, systemPreferences } from 'electron'
import { spawn } from 'child_process'
import type { SendPromptResult } from '../renderer/src/types'
import { performSend, type SendCommand, type SendExit, type SendTarget } from './prompt-sender-core'
import { findWatchedSource } from './capture-guard'
import { debugLog } from './debug-log'

const SEND_TIMEOUT_MS = 5_000
// macOS shows a one-time "MyBuildy wants to control System Events" consent
// dialog on the first send; osascript waits while it is open, so allow time to
// answer it instead of killing the script mid-dialog.
const MAC_SEND_TIMEOUT_MS = 30_000

let sendInFlight = false
// isTrustedAccessibilityClient(true) shows macOS's own prompt; ask once per run.
let accessibilityPromptShown = false

export function isSendInFlight(): boolean {
  return sendInFlight
}

/**
 * True if the watched window's source id is present in the live window list
 * (identity is the id alone — titles change every agent turn; see
 * capture-guard.ts). Used by send eligibility: not eligible while missing.
 */
export async function isWatchedWindowPresent(watchedId: string | null): Promise<boolean> {
  if (!watchedId) return false
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    })
    return findWatchedSource(sources, watchedId) !== null
  } catch (error) {
    console.warn('[Send] window presence check failed:', error)
    return false
  }
}

/**
 * Execute the send sequence (sanitize → clipboard → platform script). On any
 * failure the sanitized text is left on the clipboard so the user can paste
 * manually. Resolves, never rejects.
 */
export async function executeSend(
  promptText: string,
  target: SendTarget,
  bindingChanged?: () => string | null
): Promise<SendPromptResult> {
  if (sendInFlight) {
    console.log('[Send] rejected: a send is already in flight')
    return { sent: false, reason: 'not_eligible' }
  }
  sendInFlight = true
  try {
    // Window titles can contain user content — gate behind MYBUILDY_DEBUG.
    debugLog(`[Send] activating target window "${target.title}"`)
    return await performSend(promptText, target, {
      platform: process.platform,
      writeClipboard: (text) => clipboard.writeText(text),
      isAccessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
      requestAccessibilityPrompt: () => {
        if (accessibilityPromptShown) return
        accessibilityPromptShown = true
        systemPreferences.isTrustedAccessibilityClient(true)
      },
      runScript: runSendScript,
      log: (message) => console.log(message),
      bindingChanged,
    })
  } catch (error) {
    console.error('[Send] failed:', error)
    return { sent: false, reason: 'unknown' }
  } finally {
    sendInFlight = false
  }
}

/**
 * Spawn a fixed send script and resolve with its exit code, or null on timeout
 * (the process is killed after the platform's timeout).
 */
function runSendScript(command: SendCommand): Promise<SendExit> {
  const timeoutMs = process.platform === 'darwin' ? MAC_SEND_TIMEOUT_MS : SEND_TIMEOUT_MS

  return new Promise((resolve) => {
    const child = spawn(command.exe, command.args, {
      env: { ...process.env, ...command.env },
      windowsHide: true,
      stdio: 'ignore',
    })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* already gone */ }
      resolve(null)
    }, timeoutMs)

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.error('[Send] spawn error:', error)
      resolve(1)
    })
  })
}
