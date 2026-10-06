// companion-window.ts — main process
// Creates the floating always-on-top companion window.
// This is the PRIMARY UI — it must be visible on launch, no exceptions.
//
// Visibility guarantees:
//   - Explicit show() + focus() after ready-to-show
//   - Position validated against all displays
//   - Background color fallback so window is never invisible
//   - Detailed startup logging

import { BrowserWindow, screen } from 'electron'
import { floatingWindowOptions, floatOnAllWorkspaces } from './floating-window'
import { clampRobotScale, robotWindowSize } from '../renderer/src/robot-size'
import { join } from 'path'
import { IPC } from '../renderer/src/types'
import { repositionGuidanceWindow, hideGuidanceWindow } from './guidance-window'

// Compact mascot window: holds ONLY the mascot, status label, and control pill.
// Guidance renders in a separate window (see guidance-window.ts), so this window
// never grows and the mascot is always visible. Width is sized to fit the
// 7-control pill (a strict 200px would clip it).
// The robot window: 340×300 at Medium, scaled by the robot size (robot-size.ts).
// The zoom factor scales robot, bar, icons and text together.
let robotScale = 1
const robotSize = (): { width: number; height: number } => robotWindowSize(robotScale)

let companionRef: BrowserWindow | null = null

/**
 * Calculate a safe, visible default position: center-right of the primary display.
 */
function safeDefaultPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.workAreaSize
  const { x: ox, y: oy } = display.workArea

  return {
    x: ox + width - robotSize().width - 80,
    y: oy + Math.round((height - robotSize().height) / 2),
  }
}

/** The robot size to use when the window is created (saved preference). */
export function setInitialRobotScale(scale: number): void {
  robotScale = clampRobotScale(scale)
}

export function getRobotScale(): number {
  return robotScale
}

/**
 * Resize the robot: zoom its page and grow/shrink the window around its
 * current centre, kept on screen; the guidance panel follows. Returns the
 * (clamped) scale now in use.
 */
export function applyRobotScale(scale: number): number {
  robotScale = clampRobotScale(scale)
  if (!companionRef || companionRef.isDestroyed()) return robotScale
  companionRef.webContents.setZoomFactor(robotScale)
  const b = companionRef.getBounds()
  const { width, height } = robotSize()
  const area = screen.getDisplayMatching(b).workArea
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - width / 2, area.x), area.x + area.width - width))
  const y = Math.round(Math.min(Math.max(b.y + b.height / 2 - height / 2, area.y), area.y + area.height - height))
  companionRef.setBounds({ x, y, width, height })
  repositionGuidanceWindow()
  return robotScale
}

/**
 * Check if a position is within any connected display's bounds.
 */
function isOnScreen(x: number, y: number): boolean {
  const displays = screen.getAllDisplays()
  for (const display of displays) {
    const { x: dx, y: dy, width, height } = display.workArea
    if (
      x + 100 > dx && x < dx + width &&
      y + 50 > dy && y < dy + height
    ) {
      return true
    }
  }
  return false
}

/**
 * Never let the mascot end up (almost) off every display: when a drag ends with
 * less than a grab-able corner visible, pull it fully back inside the work area
 * of the display it is nearest to. Runs at drag END (the 350ms quiet timer), so
 * it never fights the pointer mid-drag.
 */
function pullBackOnScreen(window: BrowserWindow): void {
  const bounds = window.getBounds()
  if (isOnScreen(bounds.x, bounds.y)) return
  const area = screen.getDisplayMatching(bounds).workArea
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height)
  console.log('[Companion] dragged off-screen — pulling back into the work area')
  window.setBounds({ ...bounds, x, y })
}

export function createCompanionWindow(): BrowserWindow {
  const pos = safeDefaultPosition()

  console.log(`[Companion] Creating window at x=${pos.x} y=${pos.y} (${robotSize().width}x${robotSize().height})`)

  const window = new BrowserWindow({
    width: robotSize().width,
    height: robotSize().height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: false,        // keep it in the taskbar so it can be summoned
    hasShadow: false,
    alwaysOnTop: true,
    // NOTE: intentionally left focusable (default). The mascot hosts the
    // click-to-talk mic (getUserMedia), which fails in non-focusable windows on
    // some platforms. Visibility is guaranteed by the 'screen-saver' always-on-top
    // level + visibleOnAllWorkspaces below, not by focus behaviour.
    show: false,
    ...floatingWindowOptions(), // macOS: a panel, so MyBuildy keeps its Dock icon (floating-window.ts)
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.setAlwaysOnTop(true, 'screen-saver')
  floatOnAllWorkspaces(window)
  // The taskbar button: minimizing the robot hides it, restoring brings it back.
  window.on('minimize', () => onRobotMinimized())
  window.on('restore', () => onRobotRestored())
  // The robot size is a zoom factor; re-apply it whenever the page (re)loads.
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor(robotScale))

  if (process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?companion=true`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { companion: 'true' },
    })
  }

  window.setIgnoreMouseEvents(false)

  // Keep the guidance window anchored to the mascot as it's dragged around,
  // and hide guidance whenever the mascot itself is hidden.
  //
  // Drag signal for the robot's running animation: -webkit-app-region drags
  // deliver NO mouse events to the renderer, so main is the only reliable
  // source. 'move' fires repeatedly during a drag; 350ms of silence means the
  // drag ended. The direction (left/right) is re-sent whenever it flips.
  // A move that comes with a size change is a resize (robot size, pulled back
  // on screen), not the user dragging — the robot doesn't run for it.
  let dragEndTimer: ReturnType<typeof setTimeout> | null = null
  let last = window.getBounds()
  let dragDirection: 'left' | 'right' | null = null
  window.on('move', () => {
    repositionGuidanceWindow()
    if (window.isDestroyed()) return
    const now = window.getBounds()
    // > 2px: on scaled displays a plain move can round the size by a pixel.
    const resized = Math.abs(now.width - last.width) > 2 || Math.abs(now.height - last.height) > 2
    const direction = now.x < last.x ? 'left' : now.x > last.x ? 'right' : dragDirection
    last = now
    if (resized) return
    if (dragEndTimer === null || direction !== dragDirection) {
      dragDirection = direction
      window.webContents.send(IPC.COMPANION_DRAG, true, direction)
    }
    if (dragEndTimer !== null) clearTimeout(dragEndTimer)
    dragEndTimer = setTimeout(() => {
      dragEndTimer = null
      dragDirection = null
      if (window.isDestroyed()) return
      window.webContents.send(IPC.COMPANION_DRAG, false, null)
      pullBackOnScreen(window)
      last = window.getBounds()
    }, 350)
  })
  window.on('closed', () => {
    if (dragEndTimer !== null) { clearTimeout(dragEndTimer); dragEndTimer = null }
  })
  window.on('hide', () => hideGuidanceWindow())

  // Guaranteed show after content is ready
  window.once('ready-to-show', () => {
    const bounds = window.getBounds()
    console.log(`[Companion] ready-to-show — bounds: x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`)

    // Validate position
    if (!isOnScreen(bounds.x, bounds.y)) {
      console.log('[Companion] Window is off-screen, resetting position')
      const safe = safeDefaultPosition()
      window.setBounds({ x: safe.x, y: safe.y, ...robotSize() })
    }

    window.show()
    console.log('[Companion] show() called')

    window.setAlwaysOnTop(true, 'screen-saver')
    window.focus()
    console.log('[Companion] focus() called')

    // Second focus after a short delay — Windows sometimes loses focus to the previous window
    setTimeout(() => {
      if (!window.isDestroyed()) {
        window.setAlwaysOnTop(true, 'screen-saver')
        window.focus()
        const finalBounds = window.getBounds()
        console.log(`[Companion] Visible and focused at x=${finalBounds.x} y=${finalBounds.y}`)
      }
    }, 300)
  })

  companionRef = window
  console.log('[Companion] Window created (waiting for ready-to-show)')
  return window
}

/**
 * Reset companion to a safe, visible position and bring it to front.
 */
export function resetCompanionPosition(): void {
  if (!companionRef || companionRef.isDestroyed()) return

  const pos = safeDefaultPosition()
  console.log(`[Companion] Resetting position to x=${pos.x} y=${pos.y}`)

  companionRef.setBounds({
    x: pos.x,
    y: pos.y,
    ...robotSize(),
  })

  companionRef.show()
  companionRef.setAlwaysOnTop(true, 'screen-saver')
  companionRef.focus()
}

// What the app does when the robot's window is minimized or restored from the
// taskbar (index.ts wires these to Hide / bring back, robot-visibility.ts).
let onRobotMinimized: () => void = () => {}
let onRobotRestored: () => void = () => {}
export function setRobotWindowHandlers(handlers: { minimized(): void; restored(): void }): void {
  onRobotMinimized = handlers.minimized
  onRobotRestored = handlers.restored
}

/**
 * Show the companion and ensure it's visible on-screen.
 */
export function showCompanion(): void {
  if (!companionRef || companionRef.isDestroyed()) return
  if (companionRef.isMinimized()) companionRef.restore()

  const bounds = companionRef.getBounds()
  if (!isOnScreen(bounds.x, bounds.y)) {
    resetCompanionPosition()
  } else {
    companionRef.show()
    // Re-assert top-most every time we summon — z-order can be lost after the
    // user interacts with other apps.
    companionRef.setAlwaysOnTop(true, 'screen-saver')
    // Windows: re-assert all-workspaces too. macOS: the collection behaviour set
    // at creation sticks, and every call re-transforms the process type, which
    // briefly hides the window and the Dock icon — so don't repeat it there.
    if (process.platform !== 'darwin') {
      companionRef.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    companionRef.focus()
  }
  console.log('[Companion] showCompanion() — visible and re-asserted top-most')
}

/**
 * Hide the companion (the robot's Hide button). Windows: minimized, so its
 * taskbar button stays and one click brings the robot back. macOS: hidden; the
 * Dock icon brings it back (app 'activate'). The guidance window follows via
 * the companion's 'hide' event, and robot-visibility.ts hides it too.
 */
export function hideCompanion(): void {
  if (!companionRef || companionRef.isDestroyed()) return
  if (process.platform === 'win32') companionRef.minimize()
  else companionRef.hide()
  console.log('[Companion] hideCompanion() — hidden')
}
