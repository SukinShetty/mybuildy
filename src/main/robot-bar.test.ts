// The robot bar: size setting, hidden state, the bring-back shortcut, and Quit
// shutting everything down. Electron and the window modules are mocked.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AnalysisResult } from '../renderer/src/types'

const h = vi.hoisted(() => ({
  notifications: [] as Array<{ title: string; body: string }>,
  shown: 0,
  hidden: 0,
  guidanceHidden: 0,
  suppressed: [] as boolean[],
}))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean { return true }
    constructor(private readonly opts: { title: string; body: string }) {}
    on(): void {}
    show(): void { h.notifications.push({ title: this.opts.title, body: this.opts.body }) }
  },
}))
vi.mock('./companion-window', () => ({ showCompanion: () => { h.shown++ }, hideCompanion: () => { h.hidden++ } }))
vi.mock('./guidance-window', () => ({
  hideGuidanceWindow: () => { h.guidanceHidden++ },
  setGuidanceSuppressed: (v: boolean) => { h.suppressed.push(v) },
}))

import {
  robotWindowSize, clampRobotScale, zoomedRobotScale, robotSizeText, robotScaleToPercent, robotPercentToScale,
  ROBOT_DEFAULT_SCALE, ROBOT_MIN_SCALE, ROBOT_MAX_SCALE, ROBOT_SLIDER_STEP,
} from '../renderer/src/robot-size'
import { loadRobotScale, saveRobotScale } from './robot-prefs'
import { ROBOT_SHORTCUT, robotShortcutLabel, registerRobotShortcut, pressRobotShortcut } from './robot-shortcut'
import { createShutdown, type ShutdownSteps } from './app-shutdown'
import { hideRobot, showRobot, isRobotHidden, noteAnalysisForRobot, hiddenAlertFor, robotWindowMinimized, robotWindowRestored } from './robot-visibility'
import { robotHiddenMessage, hideButtonTitle } from '../renderer/src/robot-hidden'

const dir = mkdtempSync(join(tmpdir(), 'mybuildy-robot-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    screenContentVisible: true, whatIsHappening: '', whatItMeans: '', whatIsBuilt: [], whatIsMissing: [], whatIsBroken: [],
    whereUserIsStuck: null, bestNextMove: '', nextPrompt: '', builderNote: '', goalAlignment: 'on-track',
    analyzedAt: new Date().toISOString(), analysisDurationMs: 1, ...over,
  }
}

describe('robot size slider', () => {
  it("runs from 60% to 200% in 5% steps, with 100% (today's size) as Reset", () => {
    expect(robotScaleToPercent(ROBOT_MIN_SCALE)).toBe(60)
    expect(robotScaleToPercent(ROBOT_MAX_SCALE)).toBe(200)
    expect(Math.round(ROBOT_SLIDER_STEP * 100)).toBe(5)
    expect(robotScaleToPercent(ROBOT_DEFAULT_SCALE)).toBe(100)
  })
  it('slider value <-> scale round-trips and is clamped to the range', () => {
    for (let p = 60; p <= 200; p += 5) expect(robotScaleToPercent(robotPercentToScale(p))).toBe(p)
    expect(robotPercentToScale(20)).toBe(0.6)
    expect(robotPercentToScale(500)).toBe(2)
    expect(robotScaleToPercent(1.234)).toBe(123)
  })
  it('the window grows with the scale: 100% is 340x300 (whole bar fits); 200% doubles it; 60% shrinks it', () => {
    expect(robotWindowSize(1)).toEqual({ width: 340, height: 300 })
    expect(robotWindowSize(2)).toEqual({ width: 680, height: 600 })
    expect(robotWindowSize(0.6)).toEqual({ width: 204, height: 180 })
    expect(robotWindowSize(9)).toEqual({ width: 680, height: 600 })
  })
  it('Ctrl/Cmd + scroll steps 10% at a time, within the same limits', () => {
    expect(zoomedRobotScale(1, 'in')).toBe(1.1)
    expect(zoomedRobotScale(1, 'out')).toBe(0.9)
    expect(zoomedRobotScale(2, 'in')).toBe(2)
    expect(zoomedRobotScale(0.6, 'out')).toBe(0.6)
    expect(clampRobotScale('huge')).toBe(1)
  })
  it('shows the size as a percentage while zooming or sliding', () => {
    expect(robotSizeText(1.5)).toBe('Robot size: 150%')
    expect(robotSizeText(1.2)).toBe('Robot size: 120%')
  })
  it('is remembered across launches; a missing or broken file means 100%', () => {
    expect(loadRobotScale(dir)).toBe(1)
    saveRobotScale(dir, 1.5)
    expect(loadRobotScale(dir)).toBe(1.5)
    writeFileSync(join(dir, 'robot-prefs.json'), '{"scale": 99}')
    expect(loadRobotScale(dir)).toBe(2)
    writeFileSync(join(dir, 'robot-prefs.json'), 'nope')
    expect(loadRobotScale(dir)).toBe(1)
  })
})

describe('hidden robot', () => {
  beforeEach(() => {
    showRobot()
    Object.assign(h, { notifications: [], shown: 0, hidden: 0, guidanceHidden: 0, suppressed: [] })
  })

  it('Hide hides the robot and the guidance panel, and suppresses new guidance; watching is untouched', () => {
    hideRobot()
    expect(isRobotHidden()).toBe(true)
    expect(h.hidden).toBe(1)
    expect(h.guidanceHidden).toBe(1)
    expect(h.suppressed).toEqual([true])
    showRobot()
    expect(isRobotHidden()).toBe(false)
    expect(h.shown).toBe(1)
    expect(h.suppressed).toEqual([true, false])
  })

  it('while hidden, a new hand-off or alert shows a system notification — once, never while visible', () => {
    noteAnalysisForRobot(analysis({ needsHumanJudgment: true, humanJudgmentReason: 'Monthly or yearly plans?' }))
    expect(h.notifications).toHaveLength(0) // visible: the robot's "!" badge handles it

    noteAnalysisForRobot(analysis())
    hideRobot()
    noteAnalysisForRobot(analysis({ needsHumanJudgment: true, humanJudgmentReason: 'Monthly or yearly plans?' }))
    noteAnalysisForRobot(analysis({ needsHumanJudgment: true, humanJudgmentReason: 'Monthly or yearly plans?' }))
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0].title).toBe('MyBuildy needs your decision')
    expect(h.notifications[0].body).toContain('Monthly or yearly plans?')
  })

  it('alerts: blocked, and the agent asking a question; the notification says how to bring the robot back', () => {
    const blocked = hiddenAlertFor(analysis({ goalAlignment: 'blocked' }), analysis(), 'win32')
    expect(blocked?.title).toMatch(/stuck/)
    expect(blocked?.body).toContain('Click MyBuildy in your taskbar to see it.')
    expect(blocked?.body).not.toContain('Ctrl+Alt+B') // the shortcut is never the way we offer
    const asking = hiddenAlertFor(analysis({ terminalState: 'permission_prompt' }), analysis(), 'darwin')
    expect(asking?.title).toMatch(/asking you something/)
    expect(asking?.body).toContain('Click MyBuildy in your Dock to see it.')
    expect(hiddenAlertFor(analysis(), analysis(), 'win32')).toBeNull()
  })
})

describe('bring-back shortcut', () => {
  it('is Ctrl+Alt+B on Windows and Cmd+Option+B on Mac', () => {
    expect(ROBOT_SHORTCUT).toBe('CommandOrControl+Alt+B')
    expect(robotShortcutLabel('win32')).toBe('Ctrl+Alt+B')
    expect(robotShortcutLabel('darwin')).toBe('Cmd+Option+B')
  })
  it('registers globally and brings the robot back when pressed', () => {
    const registered = new Map<string, () => void>()
    const registry = {
      register: (acc: string, cb: () => void) => { registered.set(acc, cb); return true },
      isRegistered: (acc: string) => registered.has(acc),
    }
    const bringBack = vi.fn()
    expect(registerRobotShortcut(registry, bringBack)).toBe(true)
    registered.get(ROBOT_SHORTCUT)!()
    pressRobotShortcut()
    expect(bringBack).toHaveBeenCalledTimes(2)
  })
  it('reports when another app owns the shortcut', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(registerRobotShortcut({ register: () => false, isRegistered: () => false }, vi.fn())).toBe(false)
    warn.mockRestore()
  })
})

describe('Quit shuts everything down', () => {
  function steps(): ShutdownSteps & { order: string[] } {
    const order: string[] = []
    const step = (name: string) => () => { order.push(name) }
    return {
      order,
      markQuitting: step('markQuitting'),
      stopWatching: step('stopWatching'),
      stopVoice: step('stopVoice'),
      tellRobot: step('tellRobot'),
      destroyRobot: step('destroyRobot'),
      destroyGuidance: step('destroyGuidance'),
      destroyVoicePlayer: step('destroyVoicePlayer'),
      destroyMainWindow: step('destroyMainWindow'),
      destroyTray: step('destroyTray'),
      releaseShortcuts: step('releaseShortcuts'),
    }
  }

  it('stops watching and the voice queue, and closes the main window, robot, guidance panel and tray', () => {
    const s = steps()
    createShutdown(s)()
    expect(s.order).toEqual([
      'markQuitting', 'stopWatching', 'stopVoice', 'tellRobot', 'destroyRobot', 'destroyGuidance',
      'destroyVoicePlayer', 'destroyMainWindow', 'destroyTray', 'releaseShortcuts',
    ])
  })

  it('runs once, however many quit paths call it', () => {
    const s = steps()
    const cleanUp = createShutdown(s)
    cleanUp(); cleanUp(); cleanUp()
    expect(s.order.filter((n) => n === 'stopWatching')).toHaveLength(1)
  })

  it('one failing step does not stop the rest', () => {
    const s = steps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    s.destroyRobot = () => { throw new Error('already gone') }
    createShutdown(s)()
    expect(s.order).toContain('destroyMainWindow')
    expect(s.order).toContain('releaseShortcuts')
    warn.mockRestore()
  })
})

describe('bringing the hidden robot back, without a shortcut', () => {
  it('Hide says how: the taskbar on Windows, the Dock on Mac', () => {
    expect(robotHiddenMessage('win32')).toBe('Buildy is hidden. Click MyBuildy in your taskbar to bring him back.')
    expect(robotHiddenMessage('darwin')).toBe('Buildy is hidden. Click MyBuildy in your Dock to bring him back.')
    expect(hideButtonTitle('win32')).toMatch(/^Hide the robot \(keeps watching\)\. Bring him back: click MyBuildy in your taskbar$/)
    expect(hideButtonTitle('darwin')).not.toMatch(/Cmd|Ctrl/)
  })
  it('the taskbar button: minimizing the robot hides it (panel too), restoring brings it back', () => {
    if (isRobotHidden()) showRobot()
    h.suppressed.length = 0
    robotWindowMinimized()
    expect(isRobotHidden()).toBe(true)
    expect(h.suppressed).toEqual([true])
    robotWindowMinimized() // Hide itself minimizes: no second hide
    expect(h.suppressed).toEqual([true])
    robotWindowRestored()
    expect(isRobotHidden()).toBe(false)
    expect(h.suppressed).toEqual([true, false])
    robotWindowRestored() // a restore while showing changes nothing
    expect(h.suppressed).toEqual([true, false])
  })
})
