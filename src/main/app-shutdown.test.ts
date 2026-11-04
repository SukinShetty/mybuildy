import { describe, it, expect } from 'vitest'
import { createShutdown, type ShutdownSteps } from './app-shutdown'

function steps(calls: string[]): ShutdownSteps {
  const s = {} as ShutdownSteps
  for (const k of ['markQuitting', 'stopWatching', 'stopVoice', 'tellRobot', 'destroyRobot', 'destroyGuidance', 'destroyVoicePlayer', 'destroyMainWindow', 'destroyTray', 'releaseShortcuts'] as const) {
    s[k] = () => { calls.push(k) }
  }
  return s
}

describe('quit clean-up', () => {
  it('a normal quit destroys every window', () => {
    const calls: string[] = []
    createShutdown(steps(calls))()
    expect(calls).toContain('destroyMainWindow')
    expect(calls).toContain('destroyRobot')
  })

  it('quitting to install an update stops the work but destroys no window (the updater owns the quit)', () => {
    const calls: string[] = []
    createShutdown(steps(calls))({ forUpdate: true })
    expect(calls).toEqual(['markQuitting', 'stopWatching', 'stopVoice', 'releaseShortcuts'])
  })
})
