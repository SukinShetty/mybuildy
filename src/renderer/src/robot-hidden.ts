// robot-hidden.ts — pure, shared by main and the robot window: how a hidden
// robot comes back, in the words people see. The taskbar (Windows) or Dock
// (macOS) icon is the way; Ctrl/Cmd+Alt+B still works but is never the hint.

/** "taskbar" on Windows and Linux, "Dock" on macOS. */
export function appIconPlace(platform: string): string {
  return platform === 'darwin' ? 'Dock' : 'taskbar'
}

/** Shown when Hide is clicked. */
export function robotHiddenMessage(platform: string): string {
  return `Buildy is hidden. Click MyBuildy in your ${appIconPlace(platform)} to bring him back.`
}

/** The Hide button's tooltip. */
export function hideButtonTitle(platform: string): string {
  return `Hide the robot (keeps watching). Bring him back: click MyBuildy in your ${appIconPlace(platform)}`
}

/** The last line of a notification sent while the robot is hidden. */
export function bringBackHint(platform: string): string {
  return `Click MyBuildy in your ${appIconPlace(platform)} to see it.`
}
