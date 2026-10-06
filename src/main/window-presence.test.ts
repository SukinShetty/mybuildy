import { describe, it, expect, vi } from 'vitest'
import {
  startContinuity, pollContinuityWithPresence, isSameWindowStillOpen,
  MISSING_LOST_MS, type WindowPresence,
} from './capture-guard'
import { hwndFromSourceId, parsePresenceOutput } from './window-presence'
import { formatWatchLogLine } from './watch-log'

const ID = 'window:854860:0'
const T0 = 1_000_000
const open = (minimized = true, ownerPid: number | null = 6604): WindowPresence => ({ exists: true, minimized, ownerPid })
const closed: WindowPresence = { exists: false, minimized: false, ownerPid: null }

describe('continuity with the OS presence check', () => {
  it('a minimized window (same process) is never lost, however long', async () => {
    const watch = startContinuity(ID, '✳ Tally', 6604)
    const probe = vi.fn(async () => open())
    expect(await pollContinuityWithPresence(watch, [], T0, probe))
      .toEqual({ kind: 'went-missing', stillOpen: true, minimized: true })
    for (let t = T0 + 2000; t <= T0 + 10 * 60_000; t += 2000) {
      const e = await pollContinuityWithPresence(watch, [], t, probe)
      expect(e.kind).not.toBe('lost')
    }
    // The OS is asked only at decision points, not on every poll.
    expect(probe.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('restored after the 15 s grace with a new title resumes', async () => {
    const watch = startContinuity(ID, '✳ Tally', 6604)
    await pollContinuityWithPresence(watch, [], T0, async () => open())
    const e = await pollContinuityWithPresence(watch, [{ id: ID, name: '⠋ Fix invoice totals' }], T0 + 30_000, async () => open(false))
    expect(e).toEqual({ kind: 'resumed', title: '⠋ Fix invoice totals' })
    expect(watch.state).toBe('watching')
  })

  it('a closed window is lost, with the reason', async () => {
    const watch = startContinuity(ID, '✳ Tally', 6604)
    await pollContinuityWithPresence(watch, [], T0, async () => closed)
    expect(await pollContinuityWithPresence(watch, [], T0 + MISSING_LOST_MS, async () => closed))
      .toEqual({ kind: 'lost', reason: 'closed' })
  })

  it('a handle now owned by a DIFFERENT process is not the watched window', async () => {
    const watch = startContinuity(ID, '✳ Tally', 6604)
    await pollContinuityWithPresence(watch, [], T0, async () => open(false, 999))
    const e = await pollContinuityWithPresence(watch, [{ id: ID, name: 'Other app' }], T0 + 30_000, async () => open(false, 999))
    expect(e).toEqual({ kind: 'lost', reason: 'returned-with-new-title' })
  })

  it('no presence information (not Windows, probe failed, owner unknown): rules unchanged', async () => {
    const watch = startContinuity(ID, '✳ Tally') // owner unknown
    await pollContinuityWithPresence(watch, [], T0, async () => open())
    expect(await pollContinuityWithPresence(watch, [], T0 + MISSING_LOST_MS, async () => null))
      .toEqual({ kind: 'lost', reason: 'missing-too-long' })
    expect(isSameWindowStillOpen(startContinuity(ID, 'x'), open())).toBe(false)
  })
})

describe('window presence probe parsing', () => {
  it('reads the HWND from a Windows source id only', () => {
    expect(hwndFromSourceId('window:854860:0')).toBe('854860')
    expect(hwndFromSourceId('window:85134068:1')).toBe('85134068')
    expect(hwndFromSourceId('screen:0:0')).toBeNull()
    expect(hwndFromSourceId('window:12;calc:0')).toBeNull()
  })

  it('parses the probe output', () => {
    expect(parsePresenceOutput('exists=1 minimized=1 pid=6604\r\n')).toEqual({ exists: true, minimized: true, ownerPid: 6604 })
    expect(parsePresenceOutput('exists=0')).toEqual({ exists: false, minimized: false, ownerPid: null })
    expect(parsePresenceOutput('garbage')).toBeNull()
  })
})

describe('watch log lines', () => {
  it('leave window titles out unless debug is on', () => {
    const plain = formatWatchLogLine('2026-01-01T00:00:00.000Z', 'title-changed', { session: 3 }, { to: 'Secret project' })
    expect(plain).toBe('2026-01-01T00:00:00.000Z title-changed session=3')
    const debug = formatWatchLogLine('2026-01-01T00:00:00.000Z', 'title-changed', { session: 3 }, { to: 'Secret project' }, true)
    expect(debug).toContain('to="Secret project"')
  })
})
