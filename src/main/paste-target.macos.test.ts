// REAL macOS: the osascript send script and its front-window rule run against
// the real window server (no keystroke is ever sent by these tests — every
// case ends before the paste). Runs only on macOS (the build-and-test macOS CI
// job); skipped elsewhere.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { MAC_SEND_SCRIPT } from './prompt-sender-core'
import { MAC_FRONT_WINDOW_FN } from './paste-target'

const isMac = process.platform === 'darwin'

function osascript(program: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', program], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

describe.skipIf(!isMac)('macOS send script against the real window server', () => {
  it('compiles and refuses without a target (exit 3) — nothing typed', () => {
    expect(osascript(MAC_SEND_SCRIPT, { MYBUILDY_TARGET_WINDOW_ID: '' }).status).toBe(3)
  })

  it('a window number that does not exist: window gone (exit 4) — nothing typed', () => {
    expect(osascript(MAC_SEND_SCRIPT, { MYBUILDY_TARGET_WINDOW_ID: '2147480000' }).status).toBe(4)
  })

  it('the front-window rule reads the real on-screen window list (a window number or -1, never an error)', () => {
    const r = osascript(`ObjC.import('CoreGraphics');
${MAC_FRONT_WINDOW_FN}
var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, $.kCGNullWindowID))) || [];
JSON.stringify({ n: frontWindowNumber(list), count: list.length });`)
    expect(r.stderr).toBe('')
    const out = JSON.parse(r.stdout) as { n: number; count: number }
    expect(typeof out.n).toBe('number')
    expect(out.n === -1 || out.n > 0).toBe(true)
  })
})
