// Paste into terminal goes to the EXACT window the user picked — identified by
// its window handle and owning process captured at pick time — never to "a
// window with the same title". These are the rules the send scripts apply at
// the last moment before the paste keystroke (prompt-sender-core.ts).
import { describe, it, expect } from 'vitest'
import { decidePasteTarget, MAC_FRONT_WINDOW_FN } from './paste-target'

const picked = { hwnd: '1001', ownerPid: 500, title: 'Claude Code - my-app' }

describe('decidePasteTarget — Windows', () => {
  it('same window, in front: paste', () => {
    expect(decidePasteTarget(picked, { exists: true, ownerPid: 500, foregroundHwnd: '1001', title: 'Claude Code - my-app' })).toBe('paste')
  })

  it('a DIFFERENT window with the same title is in front: refuse (never paste into it)', () => {
    expect(decidePasteTarget(picked, { exists: true, ownerPid: 500, foregroundHwnd: '2002', title: 'Claude Code - my-app', foregroundTitle: 'Claude Code - my-app' }))
      .toBe('not_in_front')
  })

  it('the picked window was closed: window gone', () => {
    expect(decidePasteTarget(picked, { exists: false, ownerPid: null, foregroundHwnd: '2002' })).toBe('window_gone')
  })

  it('the picked window was retitled (Claude Code does this every turn): still the same window, paste', () => {
    expect(decidePasteTarget(picked, { exists: true, ownerPid: 500, foregroundHwnd: '1001', title: '✳ Building the login page' })).toBe('paste')
  })

  it('the handle now belongs to another process (closed, then reused): window changed', () => {
    expect(decidePasteTarget(picked, { exists: true, ownerPid: 777, foregroundHwnd: '1001', title: 'Claude Code - my-app' })).toBe('window_changed')
  })

  it('no owner was recorded at pick time: cannot confirm the window, refuse', () => {
    expect(decidePasteTarget({ ...picked, ownerPid: null }, { exists: true, ownerPid: 500, foregroundHwnd: '1001' })).toBe('window_changed')
  })
})

describe('the macOS front-window rule (runs inside the osascript send script)', () => {
  // Same function source as the script uses, evaluated here.
  const frontWindowNumber = new Function(`${MAC_FRONT_WINDOW_FN}; return frontWindowNumber;`)() as (infos: unknown[]) => number

  const win = (n: number, layer = 0, alpha = 1, w = 800, h = 600, pid = 1) =>
    ({ kCGWindowNumber: n, kCGWindowLayer: layer, kCGWindowAlpha: alpha, kCGWindowOwnerPID: pid, kCGWindowBounds: { Width: w, Height: h } })

  it('the front window is the first normal (layer 0), visible window, front to back', () => {
    expect(frontWindowNumber([win(10), win(11)])).toBe(10)
  })

  it("skips MyBuildy's own always-on-top robot and panel (higher layers) and the menu bar", () => {
    expect(frontWindowNumber([win(1, 25), win(2, 1000), win(42), win(43)])).toBe(42)
  })

  it('skips invisible and tiny windows', () => {
    expect(frontWindowNumber([win(3, 0, 0), win(4, 0, 1, 1, 1), win(42)])).toBe(42)
  })

  it('no normal window at all: -1 (the script then refuses)', () => {
    expect(frontWindowNumber([])).toBe(-1)
    expect(frontWindowNumber([win(1, 25)])).toBe(-1)
  })

  it('two windows of the same app with the same title: only the window NUMBER decides', () => {
    const list = [win(77, 0, 1, 800, 600, 9), win(42, 0, 1, 800, 600, 9)]
    expect(frontWindowNumber(list)).toBe(77) // 42 (the picked one) is behind: the script must raise it or refuse
  })
})
