// robot-size.ts — pure: the robot's size (a zoom factor for the whole robot
// window — robot, bar, icons and "Next:" line scale together and stay sharp).
// Shared by main (companion-window.ts, robot-prefs.ts) and Settings, where a
// "Robot size" slider (60%–200%) and a Reset button set it.

/** 100% — the robot's default size. */
export const ROBOT_DEFAULT_SCALE = 1
export const ROBOT_MIN_SCALE = 0.6
export const ROBOT_MAX_SCALE = 2

/** The Settings slider moves in 5% steps. */
export const ROBOT_SLIDER_STEP = 0.05
/** Ctrl/Cmd + scroll wheel over the robot: steps of 10%. */
export const ROBOT_ZOOM_STEP = 0.1

/** The robot window's size at scale 1 (companion-window.ts): wide enough for the
 *  whole toolbar (up to ten buttons with Hide and Quit), 300px tall as before. */
export const ROBOT_BASE_WIDTH = 340
export const ROBOT_BASE_HEIGHT = 300

export function clampRobotScale(scale: unknown): number {
  const n = typeof scale === 'number' && Number.isFinite(scale) ? scale : ROBOT_DEFAULT_SCALE
  return Math.round(Math.min(ROBOT_MAX_SCALE, Math.max(ROBOT_MIN_SCALE, n)) * 100) / 100
}

/** One wheel notch: bigger (up) or smaller (down). */
export function zoomedRobotScale(current: number, direction: 'in' | 'out'): number {
  return clampRobotScale(current + (direction === 'in' ? ROBOT_ZOOM_STEP : -ROBOT_ZOOM_STEP))
}

/** Scale ↔ the slider's whole-percent value (60…200). */
export function robotScaleToPercent(scale: number): number {
  return Math.round(clampRobotScale(scale) * 100)
}
export function robotPercentToScale(percent: number): number {
  return clampRobotScale(percent / 100)
}

/** "Robot size: 120%" — shown briefly while zooming or sliding. */
export function robotSizeText(scale: number): string {
  return `Robot size: ${robotScaleToPercent(scale)}%`
}

/** The robot window's pixel size at a scale. */
export function robotWindowSize(scale: number): { width: number; height: number } {
  const s = clampRobotScale(scale)
  return { width: Math.round(ROBOT_BASE_WIDTH * s), height: Math.round(ROBOT_BASE_HEIGHT * s) }
}
