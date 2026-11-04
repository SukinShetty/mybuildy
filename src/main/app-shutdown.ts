// app-shutdown.ts — main process. The one clean-up every quit runs: the robot's
// Quit button, the tray's Quit MyBuildy, the macOS menu's Quit (Cmd+Q), and
// any other app.quit() (Dock → Quit, logout) via 'before-quit'. Idempotent, so
// all of those can call it. The steps are injected (index.ts), so the order and
// completeness are unit-tested (app-shutdown.test.ts).

export interface ShutdownSteps {
  markQuitting: () => void       // let the main window really close (it hides otherwise)
  stopWatching: () => void       // the analysis loop, and everything in flight
  stopVoice: () => void          // speech + the voice queue
  tellRobot: () => void          // the robot window stops its own audio
  destroyRobot: () => void
  destroyGuidance: () => void
  destroyVoicePlayer: () => void
  destroyMainWindow: () => void
  destroyTray: () => void
  releaseShortcuts: () => void   // Ctrl/Cmd+Alt+B
}

/**
 * `forUpdate`: electron-updater is quitting to install (Restart to update). It
 * owns the windows and the quit (macOS: Squirrel's async handoff, then quit and
 * relaunch), so only the work stops; no window, tray or robot is destroyed here.
 */
export function createShutdown(steps: ShutdownSteps): (opts?: { forUpdate?: boolean }) => void {
  let done = false
  return (opts = {}) => {
    steps.markQuitting()
    if (done) return
    done = true
    if (opts.forUpdate) {
      for (const step of [steps.stopWatching, steps.stopVoice, steps.releaseShortcuts]) {
        try { step() } catch (error) { console.warn('[Shutdown] step failed (continuing):', error) }
      }
      return
    }
    const run = (step: () => void): void => {
      try {
        step()
      } catch (error) {
        // A window that is already gone must not stop the rest of the clean-up.
        console.warn('[Shutdown] step failed (continuing):', error)
      }
    }
    run(steps.stopWatching)
    run(steps.stopVoice)
    run(steps.tellRobot)
    run(steps.destroyRobot)
    run(steps.destroyGuidance)
    run(steps.destroyVoicePlayer)
    run(steps.destroyMainWindow)
    run(steps.destroyTray)
    run(steps.releaseShortcuts)
  }
}
