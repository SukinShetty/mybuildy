// prompt-sender-core.ts — main process (ELECTRON-FREE, unit-tested)
// Pure building blocks for "Send to Claude Code" (approve-and-send):
//   - sanitizePromptForSend: make the displayed prompt safe to paste as ONE line
//   - evaluateSendEligibility: the single decision point for whether sending is
//     allowed right now (the renderer only renders the result, never decides)
//   - buildSendCommand: the FIXED PowerShell invocation. The prompt text and the
//     target are NEVER interpolated into the command string — the prompt
//     travels via the clipboard only, and the picked window's handle and
//     pick-time owner travel as environment variables read inside the script.
//     The target is the EXACT picked window (paste-target.ts), never a title.
//   - buildMacSendCommand: the macOS equivalent — a FIXED osascript program with
//     the same rules (prompt via clipboard, target via environment variables).
//   - performSend: the shared send sequence (sanitize → clipboard → platform
//     script → exit-code mapping), with every side effect injected so both
//     platforms are unit-testable without Electron.

import { MAC_FRONT_WINDOW_FN } from './paste-target'
import type { SendEligibility, SendPromptResult, TerminalState } from '../renderer/src/types'

// ─── Sanitize ────────────────────────────────────────────────────────────────

/**
 * Sanitize the displayed prompt for keystroke-sending: collapse every newline
 * run to a single space, strip remaining control characters, trim. The card's
 * DISPLAY text is unchanged — this only affects what is pasted. (Windows
 * Terminal shows a warning dialog on multi-line paste by default; a single
 * line avoids it.)
 */
export function sanitizePromptForSend(promptText: string): string {
  return (promptText || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(new RegExp('[\\u0000-\\u001F\\u007F]', 'g'), '')
    .trim()
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

export interface SendEligibilityInput {
  platform: string                         // process.platform
  watchActive: boolean                     // analysis loop running on a watched window
  windowFound: boolean                     // findWatchedSource still resolves the watched window
  terminalState: TerminalState | undefined // from the LATEST analysis
  hasDisplayedPrompt: boolean              // a non-empty prompt is currently displayed
  sendInFlight: boolean                    // a previous send has not finished yet
}

/**
 * Sending is allowed only when ALL conditions hold. Returns the first blocking
 * reason (as tooltip-ready text) so the renderer can explain the disabled button.
 */
export function evaluateSendEligibility(input: SendEligibilityInput): SendEligibility {
  if (input.platform !== 'win32' && input.platform !== 'darwin') {
    return { canSend: false, sendBlockedReason: 'Sending is only supported on Windows and macOS — use Copy instead' }
  }
  if (!input.watchActive) {
    return { canSend: false, sendBlockedReason: 'Not watching a window' }
  }
  if (!input.windowFound) {
    return { canSend: false, sendBlockedReason: 'The watched window is no longer available' }
  }
  if (input.terminalState !== 'awaiting_prompt') {
    return { canSend: false, sendBlockedReason: "The coding agent isn't awaiting a prompt yet" }
  }
  if (!input.hasDisplayedPrompt) {
    return { canSend: false, sendBlockedReason: 'No prompt to send yet' }
  }
  if (input.sendInFlight) {
    return { canSend: false, sendBlockedReason: 'A send is already in progress' }
  }
  return { canSend: true, sendBlockedReason: '' }
}

// ─── Destructive-prompt guard ────────────────────────────────────────────────
// A SPEED BUMP, NOT A SANDBOX: this scan cannot catch every dangerous phrasing
// and is trivially bypassable by rewording. Its only job is to make the user
// pause and read before one click sends a destructive or exfiltrating
// instruction into a coding agent. Matching errs slightly toward caution, but
// normal build prompts must always pass without friction.

interface DestructivePromptRule {
  reason: string
  patterns: RegExp[]
}

const DESTRUCTIVE_PROMPT_RULES: DestructivePromptRule[] = [
  {
    reason: 'This prompt recursively deletes files (rm -rf / Remove-Item -Recurse / del /s).',
    patterns: [
      /\brm\s+(-[a-z]+\s+)*-[a-z]*(rf|fr)[a-z]*\b/i,   // rm -rf, rm -fr, rm -Rf, rm -v -rf
      /\brm\s+(-[a-z]+\s+)*-r\s+(-[a-z]+\s+)*-f\b/i,   // rm -r -f (split flags)
      /\brm\s+(-[a-z]+\s+)*-f\s+(-[a-z]+\s+)*-r\b/i,   // rm -f -r
      /\bremove-item\b[^\n]{0,80}-recurse\b/i,          // PowerShell recursive delete
      /\bdel\s+(\/[a-z]+\s+)*\/s\b/i,                   // cmd.exe del /s (subdirectories)
      /\b(rd|rmdir)\s+(\/[a-z]+\s+)*\/s\b/i,            // cmd.exe rd /s, rmdir /s (with or without /q)
    ],
  },
  {
    reason: 'This prompt force-deletes files (del /f / Remove-Item -Force).',
    patterns: [
      /\bdel\s+(\/[a-z]+\s+)*\/f\b/i,                   // cmd.exe del /f (read-only files too)
      /\bremove-item\b[^\n]{0,80}-force\b/i,            // PowerShell forced delete
    ],
  },
  {
    reason: 'This prompt formats (wipes) a drive or filesystem.',
    patterns: [
      /\bformat\s+[a-z]:/i,   // format c:
      /\bmkfs\b/i,            // mkfs, mkfs.ext4 ("\b" matches before the dot)
    ],
  },
  {
    reason: 'This prompt runs diskpart, which can erase or repartition disks.',
    patterns: [/\bdiskpart\b/i],
  },
  {
    reason: 'This prompt force-pushes to git, overwriting remote history.',
    patterns: [/\bgit\s+push\b[^\n]{0,80}--force\b/i, /\bgit\s+push\b[^\n]{0,80}\s-f\b/i],
  },
  {
    reason: 'This prompt hard-resets git, discarding local work.',
    patterns: [/\bgit\s+reset\b[^\n]{0,40}--hard\b/i],
  },
  {
    reason: 'This prompt runs git clean, deleting untracked files.',
    patterns: [/\bgit\s+clean\b[^\n]{0,40}-[a-z]*f[a-z]*\b/i],
  },
  {
    reason: 'This prompt drops or deletes a database or table.',
    patterns: [
      /\bdrop\s+(the\s+)?(table|database|schema)s?\b/i,
      /\bdelet(e|ing|es)\s+(the\s+|this\s+)?(entire\s+|whole\s+|production\s+)?database\b/i,
    ],
  },
  {
    reason: 'This prompt deletes all files.',
    patterns: [/\bdelet(e|ing|es)\s+all\s+(the\s+|of\s+the\s+)?files\b/i],
  },
  {
    reason: 'This prompt skips, disables, or deletes tests instead of fixing them.',
    patterns: [
      /\bskip(s|ping)?\s+(the\s+|all\s+)?tests?\b/i,
      /\bdelet(e|ing|es)\s+(the\s+|all\s+)?tests?\b/i,
      /\bdisabl(e|ing|es)\s+(the\s+|all\s+)?tests?\b/i,
      /\bremov(e|ing|es)\s+(the\s+|all\s+)?tests?\b/i,
      /\.skip\b/,                                      // describe.skip / it.skip / test.skip
    ],
  },
  {
    reason: 'This prompt pipes a downloaded script straight into a shell.',
    patterns: [
      /\b(curl|wget)\b[^\n|]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/i,
      /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]{0,200}\|\s*(iex|invoke-expression)\b/i,
    ],
  },
  {
    reason: 'This prompt exposes .env contents (secrets/credentials).',
    patterns: [
      /\b(cat|type|print|echo|show|display|dump|upload|send|post|email|paste|read\s+out)\b[^\n]{0,60}\.env\b/i,
    ],
  },
  {
    reason: 'This prompt prints or sends API keys, tokens, secrets, or credentials.',
    patterns: [
      /\b(print|show|display|dump|reveal|echo|log|output|upload|send|post|email|paste|leak|share|exfiltrate)\b[^\n]{0,60}\b(api[\s_-]?keys?|secret\s+keys?|secrets|access\s+tokens?|auth\s+tokens?|tokens?|credentials?)\b/i,
    ],
  },
]

// Sending data to an external URL: tool + POST/data flag + http(s) URL must all
// be present (checked separately so flag order doesn't matter).
const EXTERNAL_SEND_TOOL = /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i
const EXTERNAL_SEND_POSTISH =
  /(-x\s*post|--data\b|--data-raw\b|--data-binary\b|--data-urlencode\b|-d\s|--form\b|--upload-file\b|--post-data\b|--post-file\b|-method\s+post|-body\b|-infile\b)/i
const EXTERNAL_SEND_URL = /https?:\/\//i

/**
 * Scan a displayed prompt for destructive or exfiltrating instructions before
 * it is sent into a coding agent. Returns null when the prompt looks like a
 * normal build instruction, or { reason } describing the FIRST matched hazard.
 *
 * This is a speed bump, not a sandbox (see the note above the rule table): the
 * UI uses a non-null result to demand a second, deliberate click — it never
 * makes sending impossible.
 */
export function detectDestructivePrompt(promptText: string): { reason: string } | null {
  const text = promptText || ''
  if (!text.trim()) return null

  for (const rule of DESTRUCTIVE_PROMPT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { reason: rule.reason }
    }
  }

  if (
    EXTERNAL_SEND_TOOL.test(text) &&
    EXTERNAL_SEND_POSTISH.test(text) &&
    EXTERNAL_SEND_URL.test(text)
  ) {
    return { reason: 'This prompt uploads (POSTs) data to an external URL.' }
  }

  return null
}

// ─── Fixed PowerShell send script ────────────────────────────────────────────

// The script pastes ONLY into the exact window the user picked: the window
// handle (HWND) from the desktopCapturer source id, owned by the same process
// as at pick time (paste-target.ts). Titles are never used — another window
// can have the same title, and the picked one is retitled all the time.
//
// Exit codes: 0 = pasted; 2 = the picked window is not the foreground window
// after activation; 3 = no target in the environment; 4 = the picked window no
// longer exists; 8 = the handle now belongs to a different process (the picked
// window closed and the handle was reused). The script contains NO user
// content: it reads the target from $env:MYBUILDY_TARGET_HWND and
// $env:MYBUILDY_TARGET_PID and sends only the fixed keystroke Ctrl+V (the
// prompt is already on the clipboard). It NEVER presses Enter: the user reads
// the pasted prompt and runs it themselves. Everything slow (loading
// System.Windows.Forms, compiling the helper) happens BEFORE activation, and
// the three identity checks run on the lines directly before the keystroke.
export const POWERSHELL_SEND_SCRIPT = `
$hv = $env:MYBUILDY_TARGET_HWND
$pv = $env:MYBUILDY_TARGET_PID
if (-not $hv -or -not $pv) { exit 3 }
$h = [IntPtr][long]$hv
$expectedPid = [uint32]$pv
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MyBuildyTarget {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static uint OwnerPid(IntPtr hWnd) { uint p; GetWindowThreadProcessId(hWnd, out p); return p; }
  public static void Activate(IntPtr hWnd) {
    if (IsIconic(hWnd)) { ShowWindowAsync(hWnd, 9); System.Threading.Thread.Sleep(150); }
    if (SetForegroundWindow(hWnd) && GetForegroundWindow() == hWnd) return;
    uint ignored;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try { BringWindowToTop(hWnd); SetForegroundWindow(hWnd); }
    finally { if (attached) AttachThreadInput(me, fgThread, false); }
  }
}
"@
if (-not ([MyBuildyTarget]::IsWindow($h))) { exit 4 }
if ([MyBuildyTarget]::OwnerPid($h) -ne $expectedPid) { exit 8 }
[MyBuildyTarget]::Activate($h)
Start-Sleep -Milliseconds 200
if (-not ([MyBuildyTarget]::IsWindow($h))) { exit 4 }
if ([MyBuildyTarget]::OwnerPid($h) -ne $expectedPid) { exit 8 }
if ([MyBuildyTarget]::GetForegroundWindow().ToInt64() -ne $h.ToInt64()) { exit 2 }
[System.Windows.Forms.SendKeys]::SendWait('^v')
exit 0
`.trim()

export interface SendCommand {
  exe: string
  args: string[]
  env: Record<string, string>
}

/** The exact picked Windows window: its handle and the process that owned it at pick time. */
export interface WindowsSendTarget {
  hwnd: string
  ownerPid: number
}

/**
 * Build the powershell.exe invocation for a send. Takes the prompt so the call
 * site mirrors the real send, but neither the prompt nor the target may appear
 * in the command string: the prompt travels via the clipboard, the target via
 * the environment.
 */
export function buildSendCommand(_promptText: string, target: WindowsSendTarget): SendCommand {
  return {
    exe: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SEND_SCRIPT],
    env: { MYBUILDY_TARGET_HWND: target.hwnd, MYBUILDY_TARGET_PID: String(target.ownerPid) },
  }
}

// ─── Fixed macOS send script (osascript, JavaScript for Automation) ──────────
//
// Same contract as the PowerShell script: NO user content in the program text.
// The target arrives only through environment variables:
//   MYBUILDY_TARGET_WINDOW_ID — the CGWindowID from the desktopCapturer source
//                               id "window:<id>:0" (a number): the EXACT window
//                               the user picked
//   MYBUILDY_TARGET_TITLE     — the watched window's last known title, used
//                               ONLY to try that window first when raising
//                               windows; it never decides where the paste goes
// and the prompt is already on the clipboard; the only keystrokes sent are the
// fixed Cmd+V — never Return: the user reads the pasted prompt and runs it.
//
// Why JavaScript for Automation rather than AppleScript: Electron's window
// sources do not expose the owning application, so the script resolves it from
// the window number via CoreGraphics (CGWindowListCopyWindowInfo), which only
// the JXA Objective-C bridge can call. Activation is by application (the owning
// process). On macOS 14+ a background process such as osascript can no longer
// force activation through NSRunningApplication, so the System Events
// `frontmost = true` that follows is what actually brings the app forward.
// Bringing the app forward is not enough when it has several windows (two
// Terminal windows can even share a title), so the script then raises that
// app's windows one by one until the picked window NUMBER is the front window
// (frontWindowNumber, paste-target.ts). Right before Cmd+V it checks both that
// the owning process is frontmost (System Events — NSWorkspace's
// frontmostApplication is stale outside a run loop, which osascript never
// spins) and that the front window is the picked window number. Otherwise
// nothing is typed.
//
// Exit codes: 0 = sent; 2 = the picked window is not the front window after
// activation; 3 = no target in the environment; 4 = the window / its app no
// longer exists; 5 = macOS refused Automation of System Events (error -1743);
// 6 = macOS refused the keystroke (Accessibility); 7 = any other keystroke
// failure.
export const MAC_SEND_SCRIPT = `
ObjC.import('stdlib');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function readEnv(name) {
  var value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return value.isNil() ? '' : ObjC.unwrap(value);
}
function isAutomationDenied(e) { return e && e.errorNumber === -1743; }
function isKeystrokeDenied(e) { return e && (e.errorNumber === 1002 || e.errorNumber === -1719 || e.errorNumber === -25211); }
${MAC_FRONT_WINDOW_FN}
function windowList(option) { return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(option, $.kCGNullWindowID))) || []; }
// kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16), as numbers so a
// missing bridge constant can never turn this into the unordered "all windows" list.
function onScreen() { return windowList(17); }
var windowId = parseInt(readEnv('MYBUILDY_TARGET_WINDOW_ID'), 10);
var title = readEnv('MYBUILDY_TARGET_TITLE');
if (!(windowId > 0)) $.exit(3);
var windows = windowList($.kCGWindowListOptionAll);
var owner = null;
for (var i = 0; i < windows.length; i++) {
  if (windows[i].kCGWindowNumber === windowId) { owner = windows[i]; break; }
}
if (!owner) $.exit(4);
var pid = owner.kCGWindowOwnerPID;
var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
if (app.isNil()) $.exit(4);
app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
var systemEvents = Application('System Events');
try {
  var proc = systemEvents.processes.whose({ unixId: pid })[0];
  proc.frontmost = true;
  delay(0.15);
  if (frontWindowNumber(onScreen()) !== windowId) {
    var axWindows = proc.windows();
    var order = [];
    for (var j = 0; j < axWindows.length && j < 20; j++) {
      var name = '';
      try { name = axWindows[j].name(); } catch (e) {}
      if (title && name === title) order.unshift(axWindows[j]); else order.push(axWindows[j]);
    }
    for (var k = 0; k < order.length; k++) {
      try { order[k].actions.byName('AXRaise').perform(); } catch (e) { if (isAutomationDenied(e)) throw e; }
      delay(0.1);
      if (frontWindowNumber(onScreen()) === windowId) break;
    }
  }
} catch (e) {
  if (isAutomationDenied(e)) $.exit(5);
}
delay(0.2);
var frontPid = -1;
try {
  var frontmost = systemEvents.processes.whose({ frontmost: true });
  if (frontmost.length > 0) frontPid = frontmost[0].unixId();
} catch (e) {
  if (isAutomationDenied(e)) $.exit(5);
}
if (frontPid !== pid) $.exit(2);
if (frontWindowNumber(onScreen()) !== windowId) $.exit(2);
try {
  systemEvents.keystroke('v', { using: 'command down' });
} catch (e) {
  if (isAutomationDenied(e)) $.exit(5);
  if (isKeystrokeDenied(e)) $.exit(6);
  $.exit(7);
}
$.exit(0);
`.trim()

/**
 * The CGWindowID inside a desktopCapturer window source id ("window:<id>:0"),
 * or null for screens and malformed ids.
 */
export function macWindowIdFromSourceId(sourceId: string | null): string | null {
  const match = /^window:(\d+):/.exec(sourceId || '')
  return match ? match[1] : null
}

/**
 * Build the osascript invocation for a macOS send. Like buildSendCommand, it
 * takes the prompt only to mirror the real call site: neither the prompt nor
 * the target may appear in the command string.
 */
export function buildMacSendCommand(
  _promptText: string,
  target: { windowId: string; title: string }
): SendCommand {
  return {
    exe: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', MAC_SEND_SCRIPT],
    env: { MYBUILDY_TARGET_WINDOW_ID: target.windowId, MYBUILDY_TARGET_TITLE: target.title },
  }
}

// ─── Shared send sequence ────────────────────────────────────────────────────

/** Exit code of the send script, or null when it timed out and was killed. */
export type SendExit = number | null

export interface SendTarget {
  title: string             // last known title (macOS: only to try that window first; never decides)
  sourceId: string | null   // desktopCapturer source id of the watched window — its identity
  /** Windows: the process that owned the window when it was picked (null/absent = unknown → refuse). */
  ownerPid?: number | null
}

/** Every side effect of a send, injected so the sequence is testable. */
export interface SendDeps {
  platform: string
  writeClipboard(text: string): void
  /** macOS: may this app post synthetic keystrokes? (never prompts) */
  isAccessibilityTrusted(): boolean
  /** macOS: ask macOS to show its Accessibility prompt (the caller limits how often). */
  requestAccessibilityPrompt(): void
  runScript(command: SendCommand): Promise<SendExit>
  log(message: string): void
  /**
   * The click-time binding check (send-authorization.ts): null while the prompt,
   * project, watch session and window are unchanged, otherwise the reason. Run as
   * the LAST step before the keystroke script, after every earlier await.
   */
  bindingChanged?(): string | null
}

/**
 * Sanitize → clipboard → fixed platform script → map the exit code. On every
 * failure the sanitized text stays on the clipboard for a manual paste. On
 * macOS, keystrokes are never attempted without the Accessibility permission
 * (macOS would silently drop them).
 */
export async function performSend(
  promptText: string,
  target: SendTarget,
  deps: SendDeps
): Promise<SendPromptResult> {
  const sanitized = sanitizePromptForSend(promptText)
  if (!sanitized) {
    deps.log('[Send] rejected: prompt empty after sanitize')
    return { sent: false, reason: 'not_eligible' }
  }

  deps.writeClipboard(sanitized)
  deps.log(`[Send] clipboard set (${sanitized.length} chars)`)

  let command: SendCommand
  if (deps.platform === 'darwin') {
    if (!deps.isAccessibilityTrusted()) {
      deps.requestAccessibilityPrompt()
      deps.log('[Send] macOS Accessibility permission missing — keystrokes not attempted, text left on clipboard')
      return { sent: false, reason: 'accessibility_permission' }
    }
    const windowId = macWindowIdFromSourceId(target.sourceId)
    if (!windowId) {
      deps.log('[Send] watched source has no window number — text left on clipboard')
      return { sent: false, reason: 'unknown' }
    }
    command = buildMacSendCommand('', { windowId, title: target.title })
    deps.log('[Send] spawning osascript (fixed script, target via env)')
  } else if (deps.platform === 'win32') {
    const hwnd = macWindowIdFromSourceId(target.sourceId) // same "window:<HWND>:0" shape on Windows
    if (!hwnd || typeof target.ownerPid !== 'number' || !(target.ownerPid > 0)) {
      // Without the picked window's handle AND its pick-time owner there is no
      // way to prove the window in front is the picked one — refuse.
      deps.log('[Send] picked window identity unknown (handle or owner missing) — nothing pasted, text left on clipboard')
      return { sent: false, reason: 'window_changed' }
    }
    command = buildSendCommand('', { hwnd, ownerPid: target.ownerPid })
    deps.log('[Send] spawning powershell (fixed script, window handle + owner via env)')
  } else {
    deps.log(`[Send] rejected: no send implementation on ${deps.platform}`)
    return { sent: false, reason: 'not_eligible' }
  }

  const changed = deps.bindingChanged?.() ?? null
  if (changed) {
    deps.log(`[Send] aborted before the paste keystroke: ${changed}`)
    return { sent: false, reason: 'stale', detail: changed }
  }

  return interpretSendExit(deps.platform, await deps.runScript(command), deps.log)
}

/** Map a send script's exit code to a result (and its [Send] log line). */
function interpretSendExit(platform: string, exit: SendExit, log: (message: string) => void): SendPromptResult {
  const tool = platform === 'darwin' ? 'osascript' : 'PowerShell'
  if (exit === 0) {
    log('[Send] keystrokes delivered (exit 0)')
    return { sent: true }
  }
  if (exit === 2) {
    log('[Send] target window not in foreground (exit 2) — text left on clipboard')
    return { sent: false, reason: 'window_not_in_front' }
  }
  if (exit === null) {
    log(`[Send] ${tool} timed out — killed, text left on clipboard`)
    return { sent: false, reason: 'timeout' }
  }
  if (exit === 4) {
    log('[Send] picked window no longer exists (exit 4) — text left on clipboard')
    return { sent: false, reason: 'window_gone' }
  }
  if (platform === 'win32' && exit === 8) {
    log('[Send] picked window handle now belongs to another process (exit 8) — text left on clipboard')
    return { sent: false, reason: 'window_changed' }
  }
  if (platform === 'darwin') {
    if (exit === 5) {
      log('[Send] macOS Automation permission for System Events missing (exit 5) — text left on clipboard')
      return { sent: false, reason: 'automation_permission' }
    }
    if (exit === 6) {
      log('[Send] macOS Accessibility permission missing (exit 6) — text left on clipboard')
      return { sent: false, reason: 'accessibility_permission' }
    }
  }
  log(`[Send] ${tool} exited ${exit} — text left on clipboard`)
  return { sent: false, reason: 'unknown' }
}
