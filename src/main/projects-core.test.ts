// projects-core.test.ts
// Unit tests for the electron-free project-scoped memory logic:
// naming, path namespacing, projects.json CRUD, and the one-time legacy
// migration. Uses real temp directories (no Electron, no mocks).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  deriveProjectNameFromGoal,
  projectStoreDir,
  projectMemoryFilePath,
  legacyNempStoreDir,
  legacyProjectMemoryFilePath,
  loadProjectsFile,
  readProjectsBackup,
  restoreProjectsBackup,
  readCompletionCount,
  ensureProjectsInitialized,
  createProject,
  renameProjectRecord,
  setActiveProjectRecord,
  applyGoalSaved,
  DEFAULT_PROJECT_NAME,
  PREVIOUS_SESSIONS_NAME,
  type MigrationDeps,
} from './projects-core'

// Sequential, deterministic ids/timestamps for assertions.
function makeDeps(prefix = 'id'): MigrationDeps {
  let n = 0
  return {
    newId: () => `${prefix}-${++n}`,
    now: () => '2026-01-02T03:04:05.000Z',
  }
}

let userDataDir = ''

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'mybuildy-projects-test-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

// ─── Helpers to build legacy fixtures (neutral sample data only) ──────────────

function writeLegacyNempStore(): void {
  const nempDir = join(legacyNempStoreDir(userDataDir), '.nemp')
  mkdirSync(nempDir, { recursive: true })
  writeFileSync(
    join(nempDir, 'memories.json'),
    JSON.stringify([
      {
        key: 'completion:sample-feature',
        value: 'Sample feature finished',
        tags: ['mybuildy', 'completion'],
        timestamp: '2025-12-01T00:00:00.000Z',
        source: 'mybuildy',
        agent_id: 'mybuildy',
      },
    ]),
    'utf-8'
  )
}

function writeLegacyProjectMemory(goalPurpose: string): void {
  writeFileSync(
    legacyProjectMemoryFilePath(userDataDir),
    JSON.stringify({
      projectName: 'Project A',
      completedFeatures: ['Sample feature finished'],
      goal: { purpose: goalPurpose, createdAt: '2025-12-01T00:00:00.000Z' },
      goalPromptSeen: true,
    }),
    'utf-8'
  )
}

function writeCompletionInto(projectId: string, value: string): void {
  const nempDir = join(projectStoreDir(userDataDir, projectId), '.nemp')
  mkdirSync(nempDir, { recursive: true })
  writeFileSync(
    join(nempDir, 'memories.json'),
    JSON.stringify([
      {
        key: `completion:${value.toLowerCase().replace(/\s+/g, '-')}`,
        value,
        tags: ['mybuildy', 'completion'],
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'mybuildy',
        agent_id: 'mybuildy',
      },
    ]),
    'utf-8'
  )
}

// ─── Goal-derived project naming ──────────────────────────────────────────────

describe('deriveProjectNameFromGoal', () => {
  it('uses a capitalized leading product name before an app/site keyword', () => {
    expect(deriveProjectNameFromGoal('TaskFlow app for tracking tasks')).toBe('TaskFlow')
    expect(deriveProjectNameFromGoal('Sample Tracker app to log workouts')).toBe('Sample Tracker')
  })

  it('uses a quoted leading name', () => {
    expect(deriveProjectNameFromGoal('"Project A" website for local bakers')).toBe('Project A')
  })

  it('falls back to the default name for plain sentences', () => {
    expect(deriveProjectNameFromGoal('I want to build a simple CRM for my business')).toBe(DEFAULT_PROJECT_NAME)
    expect(deriveProjectNameFromGoal('build a website for my shop')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('falls back for empty or whitespace goals', () => {
    expect(deriveProjectNameFromGoal('')).toBe(DEFAULT_PROJECT_NAME)
    expect(deriveProjectNameFromGoal('   ')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('does not treat capitalized sentence starters as product names', () => {
    expect(deriveProjectNameFromGoal('The best app ever')).toBe(DEFAULT_PROJECT_NAME)
    expect(deriveProjectNameFromGoal('Build App features quickly')).toBe(DEFAULT_PROJECT_NAME)
  })
})

// ─── Path namespacing ─────────────────────────────────────────────────────────

describe('namespacing paths', () => {
  it('gives every project its own store directory under mybuildy-memory/', () => {
    const a = projectStoreDir(userDataDir, 'proj-a')
    const b = projectStoreDir(userDataDir, 'proj-b')
    expect(a).not.toBe(b)
    expect(a).toBe(join(userDataDir, 'mybuildy-memory', 'proj-a'))
    expect(projectMemoryFilePath(userDataDir, 'proj-a')).toBe(join(a, 'project-memory.json'))
  })

  it('a completion written in project A is counted for A and absent from B', () => {
    writeCompletionInto('proj-a', 'Login screen finished')
    expect(readCompletionCount(userDataDir, 'proj-a')).toBe(1)
    expect(readCompletionCount(userDataDir, 'proj-b')).toBe(0)
  })
})

// ─── Migration ────────────────────────────────────────────────────────────────

describe('ensureProjectsInitialized — legacy migration', () => {
  it('moves legacy memory into an inactive "Previous sessions" project and starts a fresh active project', () => {
    writeLegacyNempStore()
    writeLegacyProjectMemory('TaskFlow app for freelancers')

    const file = ensureProjectsInitialized(userDataDir, makeDeps())

    expect(file.projects).toHaveLength(2)
    const prev = file.projects.find((p) => p.name === PREVIOUS_SESSIONS_NAME)!
    const active = file.projects.find((p) => p.id === file.activeProjectId)!
    expect(prev).toBeDefined()
    expect(prev.id).not.toBe(active.id)

    // Active project is named from the goal and starts with EMPTY memory.
    expect(active.name).toBe('TaskFlow')
    expect(active.goalText).toBe('TaskFlow app for freelancers')
    expect(readCompletionCount(userDataDir, active.id)).toBe(0)

    // The active project keeps the goal (editing/keeping the goal must not require re-entry).
    const activePm = JSON.parse(readFileSync(projectMemoryFilePath(userDataDir, active.id), 'utf-8'))
    expect(activePm.goal.purpose).toBe('TaskFlow app for freelancers')

    // Legacy memory landed in "Previous sessions".
    expect(readCompletionCount(userDataDir, prev.id)).toBe(1)
    const prevPm = JSON.parse(readFileSync(projectMemoryFilePath(userDataDir, prev.id), 'utf-8'))
    expect(prevPm.completedFeatures).toContain('Sample feature finished')

    // Nothing was deleted — originals untouched.
    expect(existsSync(legacyProjectMemoryFilePath(userDataDir))).toBe(true)
    expect(existsSync(join(legacyNempStoreDir(userDataDir), '.nemp', 'memories.json'))).toBe(true)
  })

  it('running the migration twice is a no-op', () => {
    writeLegacyNempStore()
    writeLegacyProjectMemory('TaskFlow app for freelancers')

    const first = ensureProjectsInitialized(userDataDir, makeDeps('first'))
    const second = ensureProjectsInitialized(userDataDir, makeDeps('second'))

    expect(second).toEqual(first)
    expect(loadProjectsFile(userDataDir)!.projects).toHaveLength(2)
    expect(second.migratedAt).toBe(first.migratedAt)
  })

  it('with no legacy goal the active project is named "My project"', () => {
    writeLegacyNempStore() // legacy memories but no goal
    const file = ensureProjectsInitialized(userDataDir, makeDeps())
    const active = file.projects.find((p) => p.id === file.activeProjectId)!
    expect(active.name).toBe(DEFAULT_PROJECT_NAME)
    expect(file.projects.some((p) => p.name === PREVIOUS_SESSIONS_NAME)).toBe(true)
  })

  it('fresh install (no legacy data): single empty active project, still idempotent', () => {
    const file = ensureProjectsInitialized(userDataDir, makeDeps())
    expect(file.projects).toHaveLength(1)
    expect(file.projects[0].name).toBe(DEFAULT_PROJECT_NAME)
    expect(file.activeProjectId).toBe(file.projects[0].id)
    expect(file.migratedAt).toBeTruthy()

    const again = ensureProjectsInitialized(userDataDir, makeDeps('other'))
    expect(again).toEqual(file)
  })
})

// ─── Project CRUD ─────────────────────────────────────────────────────────────

describe('project records', () => {
  it('createProject adds a record and makes it active', () => {
    ensureProjectsInitialized(userDataDir, makeDeps())
    const { file, project } = createProject(userDataDir, { goalText: 'Notes app for students' }, makeDeps('new'))
    expect(project.name).toBe('Notes')
    expect(file.activeProjectId).toBe(project.id)
    expect(file.projects.map((p) => p.id)).toContain(project.id)
  })

  it('renameProjectRecord changes only the name', () => {
    const init = ensureProjectsInitialized(userDataDir, makeDeps())
    const id = init.activeProjectId
    const file = renameProjectRecord(userDataDir, id, 'Project B')
    const rec = file.projects.find((p) => p.id === id)!
    expect(rec.name).toBe('Project B')
    expect(rec.goalText).toBe(init.projects[0].goalText)
    expect(file.activeProjectId).toBe(id)
  })

  it('setActiveProjectRecord switches the active project', () => {
    ensureProjectsInitialized(userDataDir, makeDeps())
    const { file, project } = createProject(userDataDir, {}, makeDeps('new'))
    const firstId = file.projects[0].id
    const switched = setActiveProjectRecord(userDataDir, firstId, makeDeps('later'))
    expect(switched.activeProjectId).toBe(firstId)
    expect(switched.projects.map((p) => p.id)).toContain(project.id) // nothing lost
  })

  it('a corrupt projects.json blocks initialization without overwriting the damaged bytes', () => {
    const damaged = 'not valid json {{{'
    writeFileSync(join(userDataDir, 'projects.json'), damaged, 'utf-8')
    expect(() => loadProjectsFile(userDataDir)).toThrow(/project/i)
    expect(() => ensureProjectsInitialized(userDataDir, makeDeps())).toThrow(/project/i)
    expect(readFileSync(join(userDataDir, 'projects.json'), 'utf-8')).toBe(damaged)
  })

  it('an explicit backup restore keeps the saved project identity', () => {
    const initial = ensureProjectsInitialized(userDataDir, makeDeps())
    renameProjectRecord(userDataDir, initial.activeProjectId, 'New name')
    const backup = readProjectsBackup(userDataDir)!
    writeFileSync(join(userDataDir, 'projects.json'), '{', 'utf-8')
    expect(restoreProjectsBackup(userDataDir)).toEqual(backup)
    expect(ensureProjectsInitialized(userDataDir, makeDeps())).toEqual(backup)
  })

  it('renameProjectRecord with an empty or whitespace name is a no-op', () => {
    const init = ensureProjectsInitialized(userDataDir, makeDeps())
    const id = init.activeProjectId
    const originalName = init.projects[0].name
    expect(renameProjectRecord(userDataDir, id, '').projects[0].name).toBe(originalName)
    expect(renameProjectRecord(userDataDir, id, '   ').projects[0].name).toBe(originalName)
  })

  it('setActiveProjectRecord with a nonexistent id leaves the file unchanged', () => {
    const init = ensureProjectsInitialized(userDataDir, makeDeps())
    const after = setActiveProjectRecord(userDataDir, 'does-not-exist', makeDeps('later'))
    expect(after).toEqual(init)
    expect(loadProjectsFile(userDataDir)).toEqual(init)
  })

  it('applyGoalSaved updates goalText and only renames an untouched default-named project', () => {
    const deps = makeDeps()
    const base = ensureProjectsInitialized(userDataDir, deps)

    // Default-named project with no goal yet → gets a derived name.
    const renamed = applyGoalSaved(base, 'Recipe Box app for home cooks', base.activeProjectId)
    const activeAfter = renamed.projects.find((p) => p.id === renamed.activeProjectId)!
    expect(activeAfter.goalText).toBe('Recipe Box app for home cooks')
    expect(activeAfter.name).toBe('Recipe Box')

    // A custom-named project keeps its name when the goal changes.
    const custom = renameProjectRecord(userDataDir, base.activeProjectId, 'Project A')
    const after = applyGoalSaved(custom, 'Notes app for students', custom.activeProjectId)
    expect(after.projects.find((p) => p.id === after.activeProjectId)!.name).toBe('Project A')
    expect(after.projects.find((p) => p.id === after.activeProjectId)!.goalText).toBe('Notes app for students')
  })
})
