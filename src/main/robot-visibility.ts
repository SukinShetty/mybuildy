// robot-visibility.ts — main process. The robot's Hide button: the robot and
// the guidance panel go away but watching carries on. It comes back when the
// user clicks MyBuildy in the taskbar (Windows) or Dock (macOS), opens MyBuildy
// again from the Start menu or Applications, clicks the tray icon, or presses
// Ctrl/Cmd+Alt+B (robot-shortcut.ts — kept, but never offered as the way).
// While hidden, a hand-off or an alert (blocked, the agent asking a question)
// arrives as a system notification instead — the same moments that raise the
// robot's "!" badge.

import { Notification } from 'electron'
import type { AnalysisResult } from '../renderer/src/types'
import { showCompanion, hideCompanion } from './companion-window'
import { hideGuidanceWindow, setGuidanceSuppressed } from './guidance-window'
import { bringBackHint } from '../renderer/src/robot-hidden'

let hidden = false
let previous: AnalysisResult | null = null

export function isRobotHidden(): boolean {
  return hidden
}

/** Hide the robot and its guidance panel. Watching is NOT touched. */
export function hideRobot(): void {
  hidden = true
  setGuidanceSuppressed(true) // new guidance is kept for later, not popped up
  hideGuidanceWindow()
  hideCompanion()
  console.log('[Robot] hidden — watching continues')
}

export function showRobot(): void {
  hidden = false
  setGuidanceSuppressed(false)
  showCompanion()
}

/** The robot's window was minimized from the taskbar: the same as Hide. */
export function robotWindowMinimized(): void {
  if (!hidden) hideRobot()
}

/** The robot's window was restored from the taskbar: bring the robot back. */
export function robotWindowRestored(): void {
  if (hidden) showRobot()
}

/**
 * PURE: the notification to show for this analysis while the robot is hidden,
 * or null. A new hand-off or blocked state, or the agent newly asking a
 * question — never a repeat of the same moment.
 */
export function hiddenAlertFor(
  current: AnalysisResult,
  prev: AnalysisResult | null,
  platform: string
): { title: string; body: string } | null {
  // The same transitions that raise the robot's "!" badge (mascot-signals.ts):
  // into blocked / hand-off, or into the agent asking a permission question.
  const alerting = (a: AnalysisResult | null): boolean => !!a && (a.goalAlignment === 'blocked' || !!a.needsHumanJudgment)
  const bringBack = bringBackHint(platform)
  if (alerting(current) && !alerting(prev)) {
    if (current.needsHumanJudgment) {
      return { title: 'MyBuildy needs your decision', body: `${current.humanJudgmentReason || 'A decision is waiting for you.'} ${bringBack}` }
    }
    return { title: 'MyBuildy: your agent looks stuck', body: bringBack }
  }
  if (current.terminalState === 'permission_prompt' && prev?.terminalState !== 'permission_prompt') {
    return { title: 'Your coding agent is asking you something', body: bringBack }
  }
  return null
}

/** Every analysis the robot is sent passes through here (analysis-loop.ts). */
export function noteAnalysisForRobot(analysis: AnalysisResult): void {
  const prev = previous
  previous = analysis
  if (!hidden) return
  const alert = hiddenAlertFor(analysis, prev, process.platform)
  if (!alert || !Notification.isSupported()) return
  const n = new Notification({ title: alert.title, body: alert.body, silent: false })
  n.on('click', () => showRobot())
  n.show()
}
