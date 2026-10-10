// paste-target.ts — main process (ELECTRON-FREE, unit-tested)
// Which window "Paste into terminal" may paste into: ONLY the exact window the
// user picked. A window is identified by what it IS, never by what it is
// called — titles are not unique (two terminals can both be "Windows
// PowerShell") and change all the time (Claude Code retitles its window every
// turn), so a title can never prove that the window in front is the picked one.
//
//   Windows: the window handle (HWND, from the desktopCapturer source id
//            "window:<HWND>:0") plus the process that owned it at pick time.
//            Handles can be reused after a window closes, so the owner must
//            still match.
//   macOS:   the CGWindowID (from "window:<id>:0"), unique for the login
//            session; the paste happens only when THAT window is the front one.
//
// The send scripts in prompt-sender-core.ts apply these same rules natively at
// the last moment before the paste keystroke; this module states them as pure
// functions so they are unit-tested, and MAC_FRONT_WINDOW_FN is the exact
// function source the macOS script embeds.

export type PasteDecision = 'paste' | 'not_in_front' | 'window_gone' | 'window_changed'

export interface PickedWindow {
  hwnd: string
  ownerPid: number | null   // owning process at pick time
  title?: string            // informational only — never used to decide
}

export interface ObservedWindow {
  exists: boolean           // IsWindow(hwnd)
  ownerPid: number | null   // GetWindowThreadProcessId(hwnd) now
  foregroundHwnd: string    // GetForegroundWindow() now
  title?: string
  foregroundTitle?: string
}

/** The Windows rule, in the order the send script checks it. Titles are ignored. */
export function decidePasteTarget(picked: PickedWindow, observed: ObservedWindow): PasteDecision {
  if (!observed.exists) return 'window_gone'
  if (picked.ownerPid === null || observed.ownerPid !== picked.ownerPid) return 'window_changed'
  if (observed.foregroundHwnd !== picked.hwnd) return 'not_in_front'
  return 'paste'
}

/**
 * The macOS front-window rule, as JavaScript source embedded in the osascript
 * send script (and evaluated by the unit tests). Input: the on-screen window
 * list from CGWindowListCopyWindowInfo, which is ordered front to back. The
 * front window is the first ordinary (layer 0), visible, non-tiny window —
 * skipping the menu bar, MyBuildy's own always-on-top robot and panel, and
 * invisible helper windows. Returns its window number, or -1.
 */
export const MAC_FRONT_WINDOW_FN = `function frontWindowNumber(infos) {
  for (var i = 0; i < (infos || []).length; i++) {
    var w = infos[i];
    if (!w || w.kCGWindowLayer !== 0) continue;
    if (typeof w.kCGWindowAlpha === 'number' && w.kCGWindowAlpha <= 0) continue;
    var b = w.kCGWindowBounds || {};
    if (!(b.Width > 40 && b.Height > 40)) continue;
    return w.kCGWindowNumber;
  }
  return -1;
}`
