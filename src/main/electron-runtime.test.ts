// electron-runtime.test.ts — the Electron runtime we ship is not in a published
// security advisory's affected range.
//
// GHSA-jr5w-w6x2-84p9 (high, published 2026-10-23): Chromium networking and Node
// TLS/HTTPS/fetch could trust a forged chain from compromised eMudhra
// intermediates. Affected on the 44 line: >= 44.0.0-alpha.1, < 44.9.1. Every
// cloud AI call (API key + screenshot) goes over that TLS stack.
// https://github.com/advisories/GHSA-jr5w-w6x2-84p9
//
// The packaged app's own runtime version is checked in e2e/launch.spec.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Lowest Electron 44 release with the GHSA-jr5w-w6x2-84p9 fix. */
const MIN_PATCHED_ELECTRON_44 = '44.9.1'

function parse(version: string): number[] {
  const core = version.replace(/^[^\d]*/, '').split('-')[0]
  return core.split('.').map((n) => Number(n))
}

function atLeast(version: string, minimum: string): boolean {
  const a = parse(version)
  const b = parse(minimum)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

describe('shipped Electron runtime', () => {
  it('the locked Electron version has the GHSA-jr5w-w6x2-84p9 TLS fix (>= 44.9.1)', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '../../package-lock.json'), 'utf8'))
    const locked: string = lock.packages['node_modules/electron'].version
    expect(locked.startsWith('44.')).toBe(true) // the 44 line is what the fix range above describes
    expect(atLeast(locked, MIN_PATCHED_ELECTRON_44)).toBe(true)
  })

  it('compares versions numerically, not as text', () => {
    expect(atLeast('44.4.5', '44.9.1')).toBe(false)
    expect(atLeast('44.9.0', '44.9.1')).toBe(false)
    expect(atLeast('44.9.1', '44.9.1')).toBe(true)
    expect(atLeast('44.10.0', '44.9.1')).toBe(true)
    expect(atLeast('44.11.1', '44.9.1')).toBe(true)
  })
})
