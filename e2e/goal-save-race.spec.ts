// goal-save-race.spec.ts — a goal save whose reply arrives after the user
// opened a new project does not put the old goal on the new project's screen
// (pre-launch audit LA-11). The real goal handler runs; only its reply is held
// back until after "+ New project" is clicked. Throwaway profile.
import { test, expect } from '@playwright/test'
import { launchMyBuildy } from './helpers'

test('a late goal-save reply does not show project A\'s goal on the new project', async () => {
  const m = await launchMyBuildy()
  try {
    await m.main.evaluate(async () => (window as unknown as { mybuildy: { setup: { finish(): Promise<void> } } }).mybuildy.setup.finish())
    await m.companion.evaluate(() => (window as unknown as { mybuildy: { openPanel(): void } }).mybuildy.openPanel())
    await m.main.reload()
    await m.main.getByTitle('Set Goal', { exact: true }).click()

    // Hold the reply of the real goal handler (after it has saved).
    await m.app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const channel = [...handlers.keys()].find((k) => /goal.*set$/.test(k))
      if (!channel) throw new Error('goal setter not registered')
      const original = handlers.get(channel)!
      const state = globalThis as unknown as { __goalHeld: boolean; __releaseGoal?: () => void }
      state.__goalHeld = false
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const result = await original(...args)
        state.__goalHeld = true
        await new Promise<void>((r) => { state.__releaseGoal = r })
        return result
      })
    })

    const goalA = 'Synthetic project A goal from a delayed save'
    await m.main.locator('textarea').first().fill(goalA)
    await m.main.getByRole('button', { name: 'Save and start building', exact: true }).click()
    await expect.poll(() => m.app.evaluate(() => (globalThis as unknown as { __goalHeld: boolean }).__goalHeld)).toBe(true)

    await m.main.getByRole('button', { name: '+ New project', exact: true }).click()
    await expect(m.main.locator('textarea').first()).toHaveValue('')
    await m.app.evaluate(() => (globalThis as unknown as { __releaseGoal: () => void }).__releaseGoal())
    await m.main.waitForTimeout(300)

    // Still on the new project's goal screen, still blank; project B has no goal.
    await m.main.getByTitle('Set Goal', { exact: true }).click()
    await expect(m.main.locator('textarea').first()).toHaveValue('')
    const stored = await m.main.evaluate(() => (window as unknown as { mybuildy: { loadProject(): Promise<{ goal: unknown }> } }).mybuildy.loadProject())
    expect(stored.goal).toBeNull()
    // Project A kept its goal (the save itself was not lost).
    const projects = await m.main.evaluate(() => (window as unknown as { mybuildy: { projects: { list(): Promise<Array<{ goalText?: string }>> } } }).mybuildy.projects.list())
    expect(projects.some((p) => p.goalText === goalA)).toBe(true)
    expect(await m.mainErrors()).toEqual([])
  } finally { await m.close() }
})
