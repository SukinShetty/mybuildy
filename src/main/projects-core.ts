// projects-core.ts — main process (ELECTRON-FREE, unit-tested)
// Pure building blocks for project-scoped memory:
//   - one ProjectRecord per project, persisted in userData/projects.json along
//     with the active project id (A1)
//   - every memory store namespaced by project id under
//     userData/mybuildy-memory/<projectId> (A2)
//   - a one-time, idempotent migration of legacy un-namespaced memory into an
//     inactive "Previous sessions" project — data is COPIED, never deleted (A3)
//   - goal-derived project naming ("TaskFlow app …" → "TaskFlow", else "My project")
//
// This module never imports Electron: the userData directory is always passed
// in, so everything here is unit-testable with plain temp dirs (same pattern as
// prompt-sender-core.ts).

import {
  mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, copyFileSync, rmSync,
  openSync, closeSync, fsyncSync, renameSync, readdirSync,
} from 'fs'
import { join, dirname, resolve, basename } from 'path'
import { randomUUID } from 'crypto'
import type { ProjectRecord, Goal } from '../renderer/src/types'
import { emptyProjectMemory } from '../renderer/src/types'

export const DEFAULT_PROJECT_NAME = 'My project'
export const PREVIOUS_SESSIONS_NAME = 'Previous sessions'

/** On-disk shape of userData/projects.json. Its `migratedAt` field doubles as
 *  the migration marker: once the file exists, migration never runs again. */
export interface ProjectsFile {
  projects: ProjectRecord[]
  activeProjectId: string
  migratedAt: string
}

/** Injectable id/clock so tests are deterministic. */
export interface MigrationDeps {
  newId: () => string
  now: () => string
}

const defaultDeps: MigrationDeps = {
  newId: () => randomUUID(),
  now: () => new Date().toISOString(),
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function projectsFilePath(userDataDir: string): string {
  return join(userDataDir, 'projects.json')
}

/** Per-project store root. The Nemp bridge points here (it writes `.nemp/`
 *  inside), and the project's own project-memory.json lives here too. */
export function projectStoreDir(userDataDir: string, projectId: string): string {
  return join(userDataDir, 'mybuildy-memory', projectId)
}

export function projectMemoryFilePath(userDataDir: string, projectId: string): string {
  return join(projectStoreDir(userDataDir, projectId), 'project-memory.json')
}

/** Legacy (pre-project-scoping) locations — read-only after migration. */
export function legacyNempStoreDir(userDataDir: string): string {
  return join(userDataDir, 'mybuildy-memory', 'default')
}

export function legacyProjectMemoryFilePath(userDataDir: string): string {
  return join(userDataDir, 'project-memory.json')
}

// ─── Goal-derived naming ──────────────────────────────────────────────────────

// Words that follow a product name ("TaskFlow app", "Recipe Box website").
const TYPE_KEYWORDS = new Set([
  'app', 'apps', 'application', 'website', 'webapp', 'site', 'tool', 'platform',
  'product', 'dashboard', 'saas', 'crm', 'bot', 'game', 'service', 'store', 'api',
])

// Verbs that can follow a product name ("TaskFlow builds …" is still a name).
const BUILD_VERBS = new Set([
  'build', 'builds', 'building', 'create', 'creates', 'creating', 'make', 'makes',
  'making', 'develop', 'develops', 'developing', 'design', 'designs', 'designing',
])

// Capitalized words that start ordinary sentences, not product names.
const SENTENCE_STARTERS = new Set([
  'i', 'we', 'a', 'an', 'the', 'my', 'our', 'this', 'it', 'its', 'to', 'for',
  'build', 'building', 'create', 'creating', 'make', 'making', 'develop',
  'developing', 'design', 'designing', 'launch', 'launching', 'write', 'writing',
  'help', 'want', 'need', 'please', 'add', 'fix', 'ship', 'start', 'get', 'let',
])

/**
 * Derive a project name from goal text: a QUOTED leading name, or capitalized
 * leading word(s) immediately followed by an app/site keyword or build verb.
 * Ordinary sentences ("I want to build …") fall back to "My project".
 */
export function deriveProjectNameFromGoal(goalText: string): string {
  const text = (goalText || '').trim()
  if (!text) return DEFAULT_PROJECT_NAME

  // Quoted leading name: "Project A" website … / 'Acme' app …
  const quoted = text.match(/^["'“‘]([^"'”’]{1,60})["'”’]/)
  if (quoted && quoted[1].trim()) return quoted[1].trim()

  // Capitalized leading word(s) followed by a type keyword or build verb.
  const words = text.split(/\s+/)
  const isCapitalized = (w: string): boolean => /^[A-Z][A-Za-z0-9'&.-]*$/.test(w)

  if (!isCapitalized(words[0]) || SENTENCE_STARTERS.has(words[0].toLowerCase())) {
    return DEFAULT_PROJECT_NAME
  }

  const nameWords: string[] = []
  let i = 0
  while (i < words.length && i < 4 && isCapitalized(words[i])) {
    nameWords.push(words[i])
    i++
  }
  const next = (words[i] || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (nameWords.length > 0 && (TYPE_KEYWORDS.has(next) || BUILD_VERBS.has(next))) {
    return nameWords.join(' ')
  }
  return DEFAULT_PROJECT_NAME
}

// ─── projects.json I/O ────────────────────────────────────────────────────────

function projectsRecoveryError(message: string): Error {
  const error = new Error(message)
  error.name = 'ProjectsRecoveryError'
  return error
}

export function isProjectsRecoveryError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ProjectsRecoveryError'
}

function parseProjectsFile(text: string): ProjectsFile {
  const raw = JSON.parse(text) as ProjectsFile
  if (!raw || !Array.isArray(raw.projects) || raw.projects.length === 0 ||
      typeof raw.activeProjectId !== 'string' || typeof raw.migratedAt !== 'string') {
    throw new Error('Invalid project registry')
  }
  const ids = new Set<string>()
  for (const project of raw.projects) {
    if (!project || typeof project.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(project.id) ||
        ids.has(project.id) || typeof project.name !== 'string' || typeof project.goalText !== 'string' ||
        typeof project.createdAt !== 'string' || typeof project.lastActiveAt !== 'string') {
      throw new Error('Invalid project record')
    }
    ids.add(project.id)
  }
  if (!ids.has(raw.activeProjectId)) throw new Error('Active project is missing')
  return raw
}

export function projectsBackupPath(userDataDir: string): string {
  return join(userDataDir, 'projects.json.backup')
}

export function readProjectsBackup(userDataDir: string): ProjectsFile | null {
  try { return parseProjectsFile(readFileSync(projectsBackupPath(userDataDir), 'utf-8')) }
  catch { return null }
}

/** Missing is different from unreadable/corrupt: never silently reset an existing registry. */
export function loadProjectsFile(userDataDir: string): ProjectsFile | null {
  let text: string
  try { text = readFileSync(projectsFilePath(userDataDir), 'utf-8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw projectsRecoveryError('MyBuildy cannot read the project list. No project was opened.')
  }
  try { return parseProjectsFile(text) }
  catch { throw projectsRecoveryError('The saved project list is damaged. No project was opened.') }
}

/** Write a synced sibling then rename; an interrupted write cannot truncate the live file. */
function atomicWrite(filePath: string, content: string): void {
  const temp = filePath + '.' + randomUUID() + '.tmp'
  let fd: number | null = null
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, content, 'utf-8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, filePath)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(temp, { force: true })
  }
}

/** Preserve exact damaged bytes before any explicit recovery operation. */
export function preserveDamagedProjectsFile(userDataDir: string): string | null {
  const path = projectsFilePath(userDataDir)
  if (!existsSync(path)) return null
  const copy = path + '.damaged-' + randomUUID()
  // Random destination; refuse collision rather than overwrite an earlier recovery copy.
  copyFileSync(path, copy, 1)
  return copy
}

export function saveProjectsFile(userDataDir: string, file: ProjectsFile): void {
  const serialized = JSON.stringify(file, null, 2)
  parseProjectsFile(serialized) // validate before touching the existing registry or backup
  mkdirSync(userDataDir, { recursive: true })
  const previous = loadProjectsFile(userDataDir) // a corrupt primary must never poison its backup
  const backup = JSON.stringify(previous ?? file, null, 2)
  atomicWrite(projectsBackupPath(userDataDir), backup)
  atomicWrite(projectsFilePath(userDataDir), serialized)
}

/** Called only after the user chooses the named backup project in the recovery dialog. */
export function restoreProjectsBackup(userDataDir: string): ProjectsFile {
  const backup = readProjectsBackup(userDataDir)
  if (!backup) throw projectsRecoveryError('No readable project-list backup is available.')
  preserveDamagedProjectsFile(userDataDir) // failure here must stop restoration
  atomicWrite(projectsFilePath(userDataDir), JSON.stringify(backup, null, 2))
  return backup
}

// ─── Per-project store reads ──────────────────────────────────────────────────

interface StoredMemory { tags?: unknown }

/** Number of completed features recorded in a project's Nemp store (for the
 *  project switcher). Reads the store file directly — works for INACTIVE
 *  projects without re-pointing the Nemp bridge. */
export function readCompletionCount(userDataDir: string, projectId: string): number {
  try {
    const memoriesPath = join(projectStoreDir(userDataDir, projectId), '.nemp', 'memories.json')
    const memories = JSON.parse(readFileSync(memoriesPath, 'utf-8')) as StoredMemory[]
    if (!Array.isArray(memories)) return 0
    return memories.filter((m) => Array.isArray(m.tags) && (m.tags as unknown[]).includes('completion')).length
  } catch {
    return 0
  }
}

// ─── Migration (A3) ───────────────────────────────────────────────────────────

function readLegacyGoal(userDataDir: string): Goal | null {
  try {
    const raw = JSON.parse(readFileSync(legacyProjectMemoryFilePath(userDataDir), 'utf-8'))
    const goal = raw?.goal
    return goal && typeof goal.purpose === 'string' ? (goal as Goal) : null
  } catch {
    return null
  }
}

/**
 * One-time initialisation + legacy migration. Idempotent: if projects.json
 * already exists this is a pure read. Legacy data is COPIED into an inactive
 * "Previous sessions" project — the originals are never deleted — and a NEW
 * active project (empty memory, goal carried over) is created, named from the
 * goal text when possible.
 */
export function ensureProjectsInitialized(
  userDataDir: string,
  deps: MigrationDeps = defaultDeps
): ProjectsFile {
  const existing = loadProjectsFile(userDataDir)
  if (existing) return existing // marker: migration already ran (or fresh file exists)
  if (existsSync(projectsBackupPath(userDataDir))) {
    throw projectsRecoveryError('The project list is missing, but a backup exists. No project was opened.')
  }
  // A missing registry must not strand existing namespaced stores either.
  const storeRoot = join(userDataDir, 'mybuildy-memory')
  if (existsSync(storeRoot) && readdirSync(storeRoot, { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name !== 'default')) {
    throw projectsRecoveryError('The project list is missing, but project memory folders still exist. No project was opened.')
  }
  // Legacy/default migration is still handled below.


  const now = deps.now()
  const projects: ProjectRecord[] = []

  const legacyNempDir = legacyNempStoreDir(userDataDir)
  const legacyPmPath = legacyProjectMemoryFilePath(userDataDir)
  const hasLegacyNemp = existsSync(join(legacyNempDir, '.nemp'))
  const hasLegacyPm = existsSync(legacyPmPath)
  const legacyGoal = readLegacyGoal(userDataDir)

  if (hasLegacyNemp || hasLegacyPm) {
    const prev: ProjectRecord = {
      id: deps.newId(),
      name: PREVIOUS_SESSIONS_NAME,
      goalText: legacyGoal?.purpose ?? '',
      createdAt: now,
      lastActiveAt: now,
    }
    const prevDir = projectStoreDir(userDataDir, prev.id)
    mkdirSync(prevDir, { recursive: true })
    if (hasLegacyNemp) {
      // COPY (not move) the whole legacy store, .nemp/ included.
      cpSync(legacyNempDir, prevDir, { recursive: true })
    }
    if (hasLegacyPm) {
      copyFileSync(legacyPmPath, projectMemoryFilePath(userDataDir, prev.id))
    }
    projects.push(prev)
  }

  // The active project starts with EMPTY memory; the goal (if any) carries over.
  const active: ProjectRecord = {
    id: deps.newId(),
    name: legacyGoal?.purpose ? deriveProjectNameFromGoal(legacyGoal.purpose) : DEFAULT_PROJECT_NAME,
    goalText: legacyGoal?.purpose ?? '',
    createdAt: now,
    lastActiveAt: now,
  }
  mkdirSync(projectStoreDir(userDataDir, active.id), { recursive: true })
  if (legacyGoal) {
    const pm = { ...emptyProjectMemory(), goal: legacyGoal, goalPromptSeen: true }
    writeProjectMemoryFile(userDataDir, active.id, pm)
  }
  projects.push(active)

  const file: ProjectsFile = { projects, activeProjectId: active.id, migratedAt: now }
  saveProjectsFile(userDataDir, file)
  return file
}

function writeProjectMemoryFile(userDataDir: string, projectId: string, pm: unknown): void {
  const filePath = projectMemoryFilePath(userDataDir, projectId)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(pm, null, 2), 'utf-8')
}

// ─── Project record CRUD ──────────────────────────────────────────────────────

function requireFile(userDataDir: string): ProjectsFile {
  const file = loadProjectsFile(userDataDir)
  if (!file) throw new Error('projects.json missing — call ensureProjectsInitialized first')
  return file
}

/** Create a new project (named explicitly or from its goal text) and make it active. */
export function createProject(
  userDataDir: string,
  input: { name?: string; goalText?: string },
  deps: MigrationDeps = defaultDeps
): { file: ProjectsFile; project: ProjectRecord } {
  const file = requireFile(userDataDir)
  const now = deps.now()
  const goalText = (input.goalText ?? '').trim()
  const project: ProjectRecord = {
    id: deps.newId(),
    name: (input.name ?? '').trim() || deriveProjectNameFromGoal(goalText),
    goalText,
    createdAt: now,
    lastActiveAt: now,
  }
  mkdirSync(projectStoreDir(userDataDir, project.id), { recursive: true })
  const updated: ProjectsFile = {
    ...file,
    projects: [...file.projects, project],
    activeProjectId: project.id,
  }
  saveProjectsFile(userDataDir, updated)
  return { file: updated, project }
}

export function renameProjectRecord(
  userDataDir: string,
  projectId: string,
  newName: string
): ProjectsFile {
  const file = requireFile(userDataDir)
  const name = newName.trim()
  const updated: ProjectsFile = {
    ...file,
    projects: file.projects.map((p) => (p.id === projectId && name ? { ...p, name } : p)),
  }
  saveProjectsFile(userDataDir, updated)
  return updated
}

export function setActiveProjectRecord(
  userDataDir: string,
  projectId: string,
  deps: MigrationDeps = defaultDeps
): ProjectsFile {
  const file = requireFile(userDataDir)
  if (!file.projects.some((p) => p.id === projectId)) return file // unknown id — no-op
  const now = deps.now()
  const updated: ProjectsFile = {
    ...file,
    activeProjectId: projectId,
    projects: file.projects.map((p) => (p.id === projectId ? { ...p, lastActiveAt: now } : p)),
  }
  saveProjectsFile(userDataDir, updated)
  return updated
}

// ─── Delete a project ─────────────────────────────────────────────────────────

export type DeleteRefusal = 'unknown' | 'last' | 'watching'

export type DeletionPlan =
  | { ok: true; wasActive: boolean; nextActiveId: string | null }
  | { ok: false; reason: DeleteRefusal }

/**
 * PURE: may this project be deleted, and which project becomes active if it
 * was the active one? Rules: it must exist; the last remaining project can't
 * be deleted; the project being watched (always the active one) can't be
 * deleted while watching. When the active project goes, the most recently
 * used other project takes over.
 */
export function planProjectDeletion(file: ProjectsFile, projectId: string, watching: boolean): DeletionPlan {
  if (!file.projects.some((p) => p.id === projectId)) return { ok: false, reason: 'unknown' }
  if (file.projects.length <= 1) return { ok: false, reason: 'last' }
  const wasActive = file.activeProjectId === projectId
  if (wasActive && watching) return { ok: false, reason: 'watching' }
  if (!wasActive) return { ok: true, wasActive, nextActiveId: null }
  const next = file.projects
    .filter((p) => p.id !== projectId)
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
  return { ok: true, wasActive, nextActiveId: next.id }
}

/** Remove a project's record from projects.json. It must not be the active one. */
export function removeProjectRecord(userDataDir: string, projectId: string): ProjectsFile {
  const file = requireFile(userDataDir)
  if (file.activeProjectId === projectId) throw new Error('Switch away from a project before removing it')
  const updated: ProjectsFile = { ...file, projects: file.projects.filter((p) => p.id !== projectId) }
  saveProjectsFile(userDataDir, updated)
  return updated
}

/**
 * Delete ONE project's memory folder (userData/mybuildy-memory/<projectId>) and
 * nothing else: the path must resolve to a direct child of mybuildy-memory, so
 * an id like "../x" or "" can never reach another folder.
 */
export function deleteProjectStore(userDataDir: string, projectId: string): void {
  const root = resolve(userDataDir, 'mybuildy-memory')
  const target = resolve(projectStoreDir(userDataDir, projectId))
  if (dirname(target) !== root || basename(target) !== projectId || !projectId || projectId === '.' || projectId === '..') {
    throw new Error('Refusing to delete a folder outside this project')
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

/**
 * PURE: reflect a saved goal onto the active project record. Updates goalText;
 * additionally derives a name ONLY for an untouched project (still default-named
 * with no goal yet). Editing the goal of an established project NEVER renames it
 * — and never creates a new project or wipes memory (A4).
 */
/**
 * Record a saved goal on `projectId` — the project captured when the save
 * STARTED, never whatever is active by the time it finishes.
 */
export function applyGoalSaved(file: ProjectsFile, goalText: string, projectId: string): ProjectsFile {
  const text = (goalText || '').trim()
  if (!file.projects.some((p) => p.id === projectId)) return file
  return {
    ...file,
    projects: file.projects.map((p) => {
      if (p.id !== projectId) return p
      const shouldDeriveName = p.name === DEFAULT_PROJECT_NAME && !p.goalText.trim()
      return {
        ...p,
        goalText: text,
        name: shouldDeriveName ? deriveProjectNameFromGoal(text) : p.name,
      }
    }),
  }
}

/** Load-modify-save wrapper around applyGoalSaved for one specific project. */
export function updateProjectGoal(userDataDir: string, projectId: string, goalText: string): ProjectsFile {
  const updated = applyGoalSaved(requireFile(userDataDir), goalText, projectId)
  saveProjectsFile(userDataDir, updated)
  return updated
}
