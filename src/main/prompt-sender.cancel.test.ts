import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ clipboard: {}, desktopCapturer: {}, systemPreferences: {} }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
import { runSendScript } from './prompt-sender'
import { pasteFailureMessage } from '../renderer/src/types'

const command = { exe: 'synthetic-no-process', args: [], env: {} }
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.useFakeTimers()
  child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
  mocks.spawn.mockReset().mockReturnValue(child)
})
afterEach(() => vi.useRealTimers())
describe('cancel pending native paste dispatch', () => {
  it('never spawns if already cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await runSendScript(command, controller.signal)).toBe('cancelled')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('kills a pending child and reports uncertainty, ignoring a late success', async () => {
    const controller = new AbortController()
    const pending = runSendScript(command, controller.signal)
    controller.abort(); child.emit('exit', 0)
    expect(await pending).toBe('cancelled')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves confirmed success if exit arrived before cancellation', async () => {
    const controller = new AbortController()
    const pending = runSendScript(command, controller.signal)
    child.emit('exit', 0); controller.abort()
    expect(await pending).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not claim nothing was pasted for an uncertain cancellation', () => {
    const message = pasteFailureMessage({ sent: false, reason: 'cancelled' }, true)
    expect(message).toMatch(/may already have reached/)
    expect(message).not.toMatch(/Nothing was pasted|press Enter/)
  })
})
