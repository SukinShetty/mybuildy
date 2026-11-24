// nemp-bridge.audit.test.ts — distinct facts keep distinct keys (LA-08) and a
// failed reset is reported, not shown as "Memory cleared" (LA-09).
// Pre-launch audit (Codex, 2026-11-11). Synthetic temp stores only.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import nativeFs from 'node:fs'

const fixture = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { root: mkdtempSync(join(tmpdir(), 'mybuildy-nemp-audit-')) }
})
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('./memory', () => ({ loadProjectMemory: async () => ({ completedFeatures: [], activeBlockers: [] }), loadGoal: async () => null }))
import * as nemp from './nemp-bridge'
import { isSemanticDuplicate } from './semantic-dedup'

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports() })
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }))

const first = 'Implement customer account settings page with password reset and email verification using validated database links'
const second = 'Implement customer account settings page with billing invoices tax categories subscription upgrades currency selection'

describe('durable facts keep their own keys (LA-08)', () => {
  it('two different completed features with the same first 40 characters are both kept', async () => {
    await nemp.init('synthetic-collision')
    expect(isSemanticDuplicate(first, second)).toBe(false)
    await nemp.recordCompletion(first)
    await nemp.recordCompletion(second)
    expect((await nemp.getSnapshot()).completed.map((e) => e.value).sort()).toEqual([first, second].sort())
  })

  it('two different blockers with the same first 40 characters are both kept', async () => {
    await nemp.init('synthetic-blockers')
    await nemp.recordBlocker(first)
    await nemp.recordBlocker(second)
    expect((await nemp.getSnapshot()).blockersOpen).toHaveLength(2)
  })

  it('the same blocker recorded twice is still one entry', async () => {
    await nemp.init('synthetic-same-blocker')
    await nemp.recordBlocker('The login page shows a blank screen')
    await nemp.recordBlocker('The login page shows a blank screen')
    expect((await nemp.getSnapshot()).blockersOpen).toHaveLength(1)
  })
})

describe('a failed memory reset is reported (LA-09)', () => {
  it('rejects when the memory file cannot be written, and the memory is still there', async () => {
    await nemp.init('synthetic-reset-failure')
    await nemp.recordCompletion('Synthetic export dashboard implemented')
    const original = nativeFs.writeFileSync
    vi.spyOn(nativeFs, 'writeFileSync').mockImplementation((path, data, options) => {
      if (String(path).endsWith('memories.json')) throw Object.assign(new Error('synthetic disk denied'), { code: 'EACCES' })
      return original(path, data, options)
    })
    syncBuiltinESMExports()
    await expect(nemp.resetMemory()).rejects.toThrow('synthetic disk denied')
    vi.restoreAllMocks(); syncBuiltinESMExports()
    expect((await nemp.getSnapshot()).completed).toHaveLength(1)
  })

  it('a reset that works clears MyBuildy memories', async () => {
    await nemp.init('synthetic-reset-ok')
    await nemp.recordCompletion('Synthetic invoices page implemented')
    await nemp.resetMemory()
    expect((await nemp.getSnapshot()).completed).toHaveLength(0)
  })
})
