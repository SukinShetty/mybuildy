// memory.data-safety.test.ts — "Delete all data", settings changes that
// overlap, an interrupted project-memory save, and damaged project files.
// Pre-launch audit findings LA-02, LA-03, LA-07 and LA-12 (Codex audit,
// 2026-11-11). Synthetic temp folder only.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'fs'
import { join } from 'node:path'

const fixture = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { root: mkdtempSync(join(tmpdir(), 'mybuildy-data-safety-')) }
})
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('./secure-store', () => ({
  getSecret: () => '', hasSecret: () => false, secretKeyForProvider: () => null,
  getAllRedacted: () => ({}), getCustomKeyOrigin: () => null,
}))

import {
  deleteAllMyBuildyData, loadNonSecretSettings, loadProjectMemory, saveGeneralSettings,
  saveNonSecretSettings, saveProjectMemory, setActiveMemoryDir, updateNonSecretSettings,
} from './memory'
import { ensureProjectsInitialized, preserveDamagedProjectsFile, projectsBackupPath, projectStoreDir } from './projects-core'
import { defaultNonSecretSettings, emptyProjectMemory } from '../renderer/src/types'

afterEach(() => vi.restoreAllMocks())
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }))

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('Delete all data (LA-02)', () => {
  it('removes the project list backup and recovery copies, and the next start is a normal first run', async () => {
    ensureProjectsInitialized(fixture.root)
    expect(existsSync(projectsBackupPath(fixture.root))).toBe(true) // every ordinary profile has one
    preserveDamagedProjectsFile(fixture.root)
    writeFileSync(join(fixture.root, 'settings.json.0000-left-by-a-crash.tmp'), '{}')

    await deleteAllMyBuildyData()

    expect(readdirSync(fixture.root).filter((n) => n.startsWith('projects.json') || n.endsWith('.tmp'))).toEqual([])
    // Before the fix this threw "The project list is missing, but a backup exists"
    // and the app opened the recovery dialog offering to restore the deleted list.
    const fresh = ensureProjectsInitialized(fixture.root)
    expect(fresh.projects).toHaveLength(1)
  })
})

describe('overlapping settings changes (LA-03)', () => {
  it('a general Settings save that started first cannot switch the wake word back on after it was switched off', async () => {
    await saveNonSecretSettings({ ...defaultNonSecretSettings(), wakeWordEnabled: true })
    // The Settings screen's save: built from what it last loaded (wake word on).
    const generalSnapshot = { ...(await loadNonSecretSettings()), modelId: 'synthetic-new-model' }

    // Hold the general save's first read of settings.json: it has read
    // "wake word on" but has not written yet.
    const realRead = fs.readFile.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let held!: () => void
    const isHeld = new Promise<void>((r) => { held = r })
    let armed = true
    vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const data = await realRead(...args)
      if (armed && String(args[0]).endsWith('settings.json')) {
        armed = false
        held()
        await gate
      }
      return data
    }) as typeof fs.readFile)

    const generalSave = saveGeneralSettings(generalSnapshot)
    await isHeld
    // Meanwhile the user switches the wake word off (WAKE_WORD_SET).
    const switchOff = updateNonSecretSettings((current) => ({ ...current, wakeWordEnabled: false }))
    await tick()
    release()
    await Promise.all([generalSave, switchOff])

    const saved = await loadNonSecretSettings()
    expect(saved.wakeWordEnabled).toBe(false)
    expect(saved.modelId).toBe('synthetic-new-model') // the general change is kept too
  })

  it('a general Settings save keeps the voice and wake word saved by their own controls', async () => {
    await saveNonSecretSettings({ ...defaultNonSecretSettings(), buildyVoice: 'puck', wakeWordEnabled: false })
    await saveGeneralSettings({ ...defaultNonSecretSettings(), buildyVoice: 'bella', wakeWordEnabled: true, modelId: 'm' })
    const saved = await loadNonSecretSettings()
    expect(saved.buildyVoice).toBe('puck')
    expect(saved.wakeWordEnabled).toBe(false)
    expect(saved.modelId).toBe('m')
  })
})

describe('project memory survives a failed save (LA-07)', () => {
  it('a save that fails part-way (disk full) leaves the last saved goal and summary intact', async () => {
    const store = projectStoreDir(fixture.root, 'synthetic-a')
    setActiveMemoryDir(store)
    const original = { ...emptyProjectMemory(), productSummary: 'previous synthetic committed content' }
    await saveProjectMemory(original)
    const target = join(store, 'project-memory.json')
    const previousBytes = readFileSync(target, 'utf8')

    // Whichever way the file is written, the disk fills up part-way.
    const realWrite = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation((async (path: unknown, data: unknown, options: unknown) => {
      if (String(path) === target) {
        await realWrite(target, '{"goal":', 'utf-8')
        throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
      }
      return realWrite(path as string, data as string, options as BufferEncoding)
    }) as typeof fs.writeFile)
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
      return realRename(from, to)
    })

    await expect(saveProjectMemory({ ...original, productSummary: 'new synthetic content' })).rejects.toThrow('synthetic disk full')
    vi.restoreAllMocks()
    expect(readFileSync(target, 'utf8')).toBe(previousBytes)
    expect((await loadProjectMemory()).productSummary).toBe(original.productSummary)
    expect(readdirSync(store).filter((n) => n.endsWith('.tmp'))).toEqual([]) // no temp file left behind
  })
})

describe('damaged project memory fields (LA-12)', () => {
  it('fields of the wrong type fall back to safe defaults instead of reaching the app', async () => {
    const store = projectStoreDir(fixture.root, 'synthetic-schema')
    setActiveMemoryDir(store)
    await saveProjectMemory(emptyProjectMemory())
    writeFileSync(join(store, 'project-memory.json'), '{"completedFeatures":null,"activeBlockers":42,"goal":"invalid","productSummary":"kept"}')
    const memory = await loadProjectMemory()
    expect(memory.completedFeatures).toEqual([])
    expect(memory.activeBlockers).toEqual([])
    expect(memory.goal).toBeNull()
    expect(memory.productSummary).toBe('kept')
  })

  it('a valid goal and lists are returned unchanged', async () => {
    const goal = { purpose: 'A CRM', createdAt: 'x', lastReviewedAt: 'y' }
    await saveProjectMemory({ ...emptyProjectMemory(), completedFeatures: ['Login'], goal })
    const memory = await loadProjectMemory()
    expect(memory.completedFeatures).toEqual(['Login'])
    expect(memory.goal).toEqual(goal)
  })
})
