// window-list.ts — main process (ELECTRON-FREE, unit-tested)
// Which windows the "Show MyBuildy your coding agent" picker offers, and in
// what order. Every picker (robot, Guidance tab, setup) shows this one list:
//   - never MyBuildy's own windows (the robot, its panel, the main window), nor
//     another running copy of MyBuildy
//   - never system overlays (NVIDIA GeForce Overlay, cursor and status
//     overlays): on Windows the OS says so (tool windows, click-through
//     windows, cloaked or hidden windows); a few known names are dropped on
//     every OS
//   - terminals and coding apps first (PowerShell, Windows Terminal, Terminal,
//     iTerm, VS Code, Cursor, the Claude app, a Claude Code tab), then the rest
//     in the order the OS gave them

/** What Windows says about a window (window-presence.ts probeWindowFlags). */
export interface WindowFlags {
  visible: boolean
  cloaked: boolean      // hidden by the OS (a suspended or closed Store app, another desktop)
  toolWindow: boolean   // a floating tool / overlay, not an app window
  transparent: boolean  // clicks pass through it
  noActivate: boolean   // can never be the active window
}

// Overlays and shell windows that are never a coding agent, whatever the OS says.
const NEVER_LISTED: RegExp[] = [
  /^MyBuildy$/,                       // another running copy of MyBuildy
  /overlay/i,                         // NVIDIA GeForce Overlay, cursor overlays, game overlays
  /^Program Manager$/,
  /^Windows Input Experience$/,
  /^Microsoft Text Input Application$/,
  /^Windows Shell Experience Host$/,
]

// A browser tab can mention Claude or Cursor in its title; it is not the app.
const BROWSER = /(google chrome|microsoft edge|mozilla firefox|firefox|safari|brave|opera|arc|vivaldi)\s*$/i

const CODING_WINDOW: RegExp[] = [
  /^[✳✻✽✶✢·⠀-⣿]/, // Claude Code sets a spinner or ✳ at the start of the terminal title
  /claude code/i,
  /^claude$/i,                        // the Claude desktop app
  /powershell|pwsh/i,
  /windows terminal/i,
  /command prompt|cmd\.exe/i,
  /\bterminal\b/i,
  /\biterm/i,
  /visual studio code|\bvs ?code\b/i,
  /\bcursor\b/i,
  /\bcodex\b/i,
  /\bwarp\b/i,
  /git bash|mingw|\bwsl\b|ubuntu/i,
  /\b(zsh|bash|fish)\b/i,             // macOS Terminal / iTerm titles name the shell
]

/** Is this the robot's own kind of window, an overlay, or a hidden window? */
export function isPickableWindow(
  source: { id: string; name: string },
  ownIds: ReadonlySet<string>,
  flags: WindowFlags | undefined,
): boolean {
  const name = source.name.trim()
  if (!name) return false
  if (ownIds.has(source.id)) return false
  if (NEVER_LISTED.some((re) => re.test(name))) return false
  if (flags) {
    if (!flags.visible || flags.cloaked || flags.toolWindow) return false
    if (flags.transparent && flags.noActivate) return false // a click-through overlay
  }
  return true
}

/** 0 for a terminal or coding app, 1 for anything else. */
export function codingRank(name: string): number {
  if (BROWSER.test(name)) return 1
  return CODING_WINDOW.some((re) => re.test(name)) ? 0 : 1
}

/** The picker's list: pickable windows, terminals and coding apps first (stable otherwise). */
export function pickableWindows<T extends { id: string; name: string }>(
  sources: T[],
  ownIds: ReadonlySet<string>,
  flagsById: ReadonlyMap<string, WindowFlags> | null,
): T[] {
  return sources
    .filter((s) => isPickableWindow(s, ownIds, flagsById?.get(s.id)))
    .map((s, i) => ({ s, i, rank: codingRank(s.name) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ s }) => s)
}
