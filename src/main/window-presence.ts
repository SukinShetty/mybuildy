// window-presence.ts — main process, Windows only.
// Asks Windows whether a watched window still exists, for the continuity rules
// in capture-guard.ts.
//
// Why: on Windows, Electron's window list (desktopCapturer) leaves out a
// window while it is MINIMIZED or hidden, and lists it again under the same id
// when it is restored (measured on this build). Without this check a minimized
// terminal looked closed: after 60 s, or on restore after 15 s with the new
// title Claude Code gives the terminal every turn, the watch was dropped.
//
// The probe is only run at decision points (a window going missing, or the
// rules about to declare it lost), never on every 2 s poll. It runs a FIXED
// PowerShell script; the only input, the window handle, is validated as digits
// and passed through an environment variable, never spliced into the script.

import { execFile } from 'child_process'
import type { WindowPresence } from './capture-guard'
import type { WindowFlags } from './window-list'

const PROBE_TIMEOUT_MS = 8000

const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MyBuildyWindowPresence {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [IntPtr][Int64]$env:MYBUILDY_HWND
if (-not [MyBuildyWindowPresence]::IsWindow($h)) { 'exists=0'; exit 0 }
$ownerPid = [uint32]0
[void][MyBuildyWindowPresence]::GetWindowThreadProcessId($h, [ref]$ownerPid)
'exists=1 minimized=' + [int][MyBuildyWindowPresence]::IsIconic($h) + ' pid=' + $ownerPid
`

/** The HWND in a Windows desktopCapturer id ("window:<HWND>:<n>"), or null. */
export function hwndFromSourceId(sourceId: string): string | null {
  const m = /^window:(\d{1,20}):\d+$/.exec(sourceId)
  return m ? m[1] : null
}

/** Parse the probe's one-line output; null when it is not recognisable. */
export function parsePresenceOutput(output: string): WindowPresence | null {
  const line = output.trim().split(/\r?\n/).pop() || ''
  if (line === 'exists=0') return { exists: false, minimized: false, ownerPid: null }
  const m = /^exists=1 minimized=([01]) pid=(\d+)$/.exec(line)
  if (!m) return null
  const pid = Number(m[2])
  return { exists: true, minimized: m[1] === '1', ownerPid: pid > 0 ? pid : null }
}

/**
 * Presence of the window behind a source id. Null when it cannot be known (not
 * Windows, not a window id, or the probe failed) — the caller then applies the
 * continuity rules unchanged.
 */
export function probeWindowPresence(sourceId: string): Promise<WindowPresence | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const hwnd = hwndFromSourceId(sourceId)
  if (!hwnd) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
      { env: { ...process.env, MYBUILDY_HWND: hwnd }, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) { console.warn('[Watch] window presence probe failed'); resolve(null); return }
        resolve(parsePresenceOutput(String(stdout)))
      }
    )
  })
}

// ─── Window flags, for the window picker (window-list.ts) ────────────────────
// One PowerShell run for the whole list (~0.4 s): is each window visible, cloaked
// by the OS, a tool window (overlays), click-through, or never activatable?
// Same rules as above: a FIXED script, handles validated as digits and passed
// in one environment variable.

const FLAGS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MyBuildyWindowFlags {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
}
"@
foreach ($s in $env:MYBUILDY_HWNDS.Split(',')) {
  $h = [IntPtr][Int64]$s
  if (-not [MyBuildyWindowFlags]::IsWindow($h)) { "$s gone"; continue }
  $cloaked = 0
  [void][MyBuildyWindowFlags]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
  $ex = [Int64][MyBuildyWindowFlags]::GetWindowLongPtr($h, -20)
  "$s " + [int][MyBuildyWindowFlags]::IsWindowVisible($h) + [int]($cloaked -ne 0) + [int](($ex -band 0x80) -ne 0) + [int](($ex -band 0x20) -ne 0) + [int](($ex -band 0x08000000) -ne 0)
}
`

/** Parse the flags probe: "<hwnd> <visible><cloaked><tool><transparent><noactivate>" or "<hwnd> gone" per line. */
export function parseFlagsOutput(output: string): Map<string, WindowFlags> {
  const flags = new Map<string, WindowFlags>()
  for (const line of output.split(/\r?\n/)) {
    const gone = /^(\d{1,20}) gone$/.exec(line.trim())
    if (gone) {
      flags.set(gone[1], { visible: false, cloaked: false, toolWindow: false, transparent: false, noActivate: false })
      continue
    }
    const m = /^(\d{1,20}) ([01])([01])([01])([01])([01])$/.exec(line.trim())
    if (!m) continue
    flags.set(m[1], {
      visible: m[2] === '1', cloaked: m[3] === '1', toolWindow: m[4] === '1', transparent: m[5] === '1', noActivate: m[6] === '1',
    })
  }
  return flags
}

/**
 * Flags for every window source id, keyed by source id. Null when they cannot
 * be known (not Windows, or the probe failed): the picker then filters by name only.
 */
export function probeWindowFlags(sourceIds: string[]): Promise<Map<string, WindowFlags> | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const hwndToId = new Map<string, string>()
  for (const id of sourceIds) {
    const hwnd = hwndFromSourceId(id)
    if (hwnd) hwndToId.set(hwnd, id)
  }
  if (hwndToId.size === 0) return Promise.resolve(new Map())
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FLAGS_SCRIPT],
      { env: { ...process.env, MYBUILDY_HWNDS: [...hwndToId.keys()].join(',') }, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) { console.warn('[Picker] window flags probe failed — filtering by name only'); resolve(null); return }
        const byId = new Map<string, WindowFlags>()
        for (const [hwnd, flags] of parseFlagsOutput(String(stdout))) {
          const id = hwndToId.get(hwnd)
          if (id) byId.set(id, flags)
        }
        resolve(byId)
      }
    )
  })
}
