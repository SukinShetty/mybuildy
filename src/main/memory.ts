// memory.ts — main process
// Local JSON persistence for project memory and app settings.
// Stored in the Electron userData directory so it survives app updates.
//
// On Windows: C:\Users\<user>\AppData\Roaming\MyBuildy\
// On macOS:   ~/Library/Application Support/MyBuildy/

import { app } from 'electron'
import { isAllowedProviderUrl, customKeyAllowed } from './provider-origins'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { join, dirname, basename } from 'path'
import type {
  ProjectMemory,
  AppSettings,
  NonSecretSettings,
  RedactedSettings,
  Goal,
} from '../renderer/src/types'
import {
  emptyProjectMemory, defaultNonSecretSettings,
  HOURLY_CALL_CAP_MIN, HOURLY_CALL_CAP_MAX, isBuildyVoice,
} from '../renderer/src/types'
import { getSecret, hasSecret, secretKeyForProvider, getAllRedacted, getCustomKeyOrigin } from './secure-store'

const userDataDirectory = app.getPath('userData')
export const settingsFilePath = join(userDataDirectory, 'settings.json')

// ─── Project memory ───────────────────────────────────────────────────────────
// Project memory (and the goal stored on it) is NAMESPACED PER PROJECT: after
// projects.ts activates a project, reads/writes go to that project's store dir
// (userData/mybuildy-memory/<projectId>/project-memory.json). The legacy
// un-namespaced userData/project-memory.json is only used as a fallback before
// initialisation and is never written to after migration.

let activeMemoryDirectory: string | null = null

/** Point project-memory persistence at the ACTIVE project's store directory.
 *  Called by projects.ts on startup and on every project switch. */
export function setActiveMemoryDir(directory: string): void {
  activeMemoryDirectory = directory
}

/** Thrown when the active project changed while a write for another project was in flight. */
export class ProjectChangedError extends Error {
  constructor() {
    super('The project changed while this was being saved, so nothing was saved.')
    this.name = 'ProjectChangedError'
  }
}

function projectMemoryFilePath(directory: string | null = activeMemoryDirectory): string {
  return directory
    ? join(directory, 'project-memory.json')
    : join(userDataDirectory, 'project-memory.json') // pre-init legacy fallback
}

export async function loadProjectMemory(directory: string | null = activeMemoryDirectory): Promise<ProjectMemory> {
  try {
    const fileContent = await fs.readFile(projectMemoryFilePath(directory), 'utf-8')
    const raw = JSON.parse(fileContent) as Partial<ProjectMemory>
    // Merge over defaults so files written by older versions gain new fields
    // (goal, goalPromptSeen) without breaking. A field of the wrong type (a
    // damaged or hand-edited file) falls back to its default instead of reaching callers.
    return normalizeProjectMemory(raw)
  } catch {
    // File doesn't exist yet or is corrupt — return a blank project
    return emptyProjectMemory()
  }
}

/**
 * Save project memory. With `expectedDirectory` (captured when the operation
 * started) the write goes ONLY to that project and is refused if the active
 * project has changed since.
 */
export async function saveProjectMemory(projectMemory: ProjectMemory, expectedDirectory?: string | null): Promise<void> {
  if (expectedDirectory !== undefined && expectedDirectory !== activeMemoryDirectory) throw new ProjectChangedError()
  const filePath = projectMemoryFilePath(expectedDirectory === undefined ? activeMemoryDirectory : expectedDirectory)
  await fs.mkdir(dirname(filePath), { recursive: true })
  const updatedMemory: ProjectMemory = {
    ...projectMemory,
    updatedAt: new Date().toISOString(),
  }
  // Atomic: a failed or interrupted write leaves the last saved file intact.
  await writeFileAtomic(filePath, JSON.stringify(updatedMemory, null, 2))
}

/** Defaults for missing fields, and for fields of the wrong type. */
function normalizeProjectMemory(raw: unknown): ProjectMemory {
  const base = emptyProjectMemory()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const merged = { ...base, ...(raw as Partial<ProjectMemory>) } as ProjectMemory
  const fields = merged as unknown as Record<string, unknown>
  const defaults = base as unknown as Record<string, unknown>
  for (const key of Object.keys(defaults)) {
    const fallback = defaults[key]
    const value = fields[key]
    if (key === 'goal') continue
    if (Array.isArray(fallback)) {
      fields[key] = Array.isArray(value) ? value.filter((item) => typeof item === 'string') : fallback
    } else if (fallback !== null && typeof value !== typeof fallback) {
      fields[key] = fallback
    }
  }
  const goal = fields.goal as Partial<Goal> | null | undefined
  merged.goal = goal && typeof goal === 'object' && !Array.isArray(goal) && typeof goal.purpose === 'string'
    ? (goal as Goal)
    : null
  return merged
}

// ─── Goal ───────────────────────────────────────────────────────────────────
// The goal lives on the project memory file (same local JSON, nothing leaves the device).

export async function loadGoal(): Promise<Goal | null> {
  const project = await loadProjectMemory()
  return project.goal ?? null
}

/**
 * Create or replace the goal. Stamps createdAt + lastReviewedAt and marks the
 * goal prompt as seen so the first-launch screen won't reappear.
 */
export async function setGoal(input: Partial<Goal>): Promise<Goal> {
  const directory = activeMemoryDirectory // the project this save is for
  const project = await loadProjectMemory(directory)
  const now = new Date().toISOString()
  const goal: Goal = {
    purpose: (input.purpose ?? '').trim(),
    audience: input.audience?.trim() || undefined,
    mostImportant: input.mostImportant?.trim() || undefined,
    successCriteria: input.successCriteria?.trim() || undefined,
    createdAt: project.goal?.createdAt ?? now,
    lastReviewedAt: now,
  }
  await saveProjectMemory({ ...project, goal, goalPromptSeen: true }, directory)
  return goal
}

/**
 * Merge a partial update into the existing goal (e.g. bumping lastReviewedAt).
 * No-op (returns null) if no goal exists yet.
 */
export async function updateGoal(partial: Partial<Goal>): Promise<Goal | null> {
  const directory = activeMemoryDirectory // the project this update is for
  const project = await loadProjectMemory(directory)
  if (!project.goal) return null
  const goal: Goal = { ...project.goal, ...partial }
  await saveProjectMemory({ ...project, goal }, directory)
  return goal
}

// ─── Settings ─────────────────────────────────────────────────────────────────
// Secrets (API keys) are NOT stored here — they live encrypted in secure-store.
// settings.json holds only NON-SECRET fields. Three views:
//   - loadNonSecretSettings(): what's on disk (no secrets)
//   - loadSettings(): main-internal full settings (secrets injected) — never sent to renderer
//   - loadRedactedSettings(): what the renderer gets (non-secret + has* booleans)

/** Read the non-secret settings from disk, tolerant of old/missing fields. */
export async function loadNonSecretSettings(): Promise<NonSecretSettings> {
  const d = defaultNonSecretSettings()
  try {
    const raw = JSON.parse(await fs.readFile(settingsFilePath, 'utf-8')) as Record<string, unknown>
    const rawCap = Number(raw.hourlyCallCap ?? d.hourlyCallCap)
    const hourlyCallCap = Number.isFinite(rawCap)
      ? Math.min(HOURLY_CALL_CAP_MAX, Math.max(HOURLY_CALL_CAP_MIN, Math.round(rawCap)))
      : d.hourlyCallCap
    return {
      provider: (raw.provider as NonSecretSettings['provider']) ?? d.provider,
      modelId: String(raw.modelId ?? d.modelId),
      baseUrl: String(raw.baseUrl ?? ''),
      autoAnalysisIntervalSeconds: Number(raw.autoAnalysisIntervalSeconds ?? d.autoAnalysisIntervalSeconds),
      elevenLabsVoiceId: String(raw.elevenLabsVoiceId ?? d.elevenLabsVoiceId),
      buildyVoice: isBuildyVoice(raw.buildyVoice) ? raw.buildyVoice : d.buildyVoice,
      hourlyCallCap,
      captureNoticeAccepted: raw.captureNoticeAccepted === true,
      wakeWordEnabled: raw.wakeWordEnabled === true,
    }
  } catch {
    return d
  }
}

/** Inject secrets from the encrypted store → main-internal full settings. */
export function resolveSettings(nonSecret: NonSecretSettings): AppSettings {
  const providerSecret = secretKeyForProvider(nonSecret.provider)
  // A saved base URL that isn't allowed for this provider (e.g. from an older
  // version) is ignored: the provider's own default origin is used instead.
  const baseUrl = isAllowedProviderUrl(nonSecret.provider, nonSecret.baseUrl) ? nonSecret.baseUrl : ''
  let apiKey = providerSecret ? getSecret(providerSecret) : ''
  // The custom key only ever goes to the origin it was entered for.
  if (nonSecret.provider === 'custom' && apiKey && !customKeyAllowed(getCustomKeyOrigin(), baseUrl)) apiKey = ''
  return {
    ...nonSecret,
    baseUrl,
    apiKey,
    elevenLabsApiKey: getSecret('elevenLabsApiKey'),
  }
}

/** Build the redacted view (booleans only) for the renderer. */
export function redactSettings(nonSecret: NonSecretSettings): RedactedSettings {
  const providerSecret = secretKeyForProvider(nonSecret.provider)
  return {
    ...nonSecret,
    hasApiKey: providerSecret ? hasSecret(providerSecret) : false,
    hasElevenLabsKey: hasSecret('elevenLabsApiKey'),
    secretFlags: getAllRedacted(),
    customKeyNeedsEndpoint: hasSecret('customApiKey') && !getCustomKeyOrigin(),
  }
}

/** MAIN-internal: full settings with secrets injected. NEVER send this to the renderer. */
export async function loadSettings(): Promise<AppSettings> {
  return resolveSettings(await loadNonSecretSettings())
}

/** Renderer-safe redacted settings. */
export async function loadRedactedSettings(): Promise<RedactedSettings> {
  return redactSettings(await loadNonSecretSettings())
}

// Every settings change goes through ONE queue and is computed from the
// latest saved settings, so two changes never overwrite each other (e.g. a
// general Settings save that started first can't put back a wake word the
// user has just switched off).
let settingsQueue: Promise<unknown> = Promise.resolve()

/**
 * Change the saved settings: `change` gets the settings as saved right now
 * (after every earlier change has finished) and returns the new settings.
 */
export function updateNonSecretSettings(
  change: (current: NonSecretSettings) => NonSecretSettings
): Promise<NonSecretSettings> {
  const run = settingsQueue.then(async () => {
    const current = await loadNonSecretSettings()
    const next = cleanSettings(change(current), current)
    await ensureUserDataDirectoryExists()
    await writeFileAtomic(settingsFilePath, JSON.stringify(next, null, 2))
    return next
  })
  settingsQueue = run.catch(() => undefined)
  return run
}

/** A general Settings save: everything except the settings that have their
 *  own switch (wake word, Buildy's voice), which keep their saved value. */
export function saveGeneralSettings(s: NonSecretSettings): Promise<NonSecretSettings> {
  return updateNonSecretSettings((current) => ({
    ...s,
    wakeWordEnabled: current.wakeWordEnabled,
    buildyVoice: current.buildyVoice,
  }))
}

/** Persist ONLY non-secret fields. Any stray secret/proxy fields are dropped. */
export async function saveNonSecretSettings(s: NonSecretSettings): Promise<void> {
  await updateNonSecretSettings(() => s)
}

function cleanSettings(s: NonSecretSettings, onDisk: NonSecretSettings): NonSecretSettings {
  // captureNoticeAccepted is STICKY-TRUE: once the user has accepted the
  // one-time disclosure, a stale settings save from another window can't
  // silently reset it. Only "Delete all MyBuildy data" clears it (fresh file).
  return {
    provider: s.provider,
    modelId: s.modelId,
    baseUrl: s.baseUrl,
    autoAnalysisIntervalSeconds: s.autoAnalysisIntervalSeconds,
    elevenLabsVoiceId: s.elevenLabsVoiceId,
    buildyVoice: s.buildyVoice,
    hourlyCallCap: s.hourlyCallCap,
    captureNoticeAccepted: s.captureNoticeAccepted || onDisk.captureNoticeAccepted,
    wakeWordEnabled: s.wakeWordEnabled === true,
  }
}

// ─── Delete all MyBuildy data (Settings → restart to first run) ─────────────────
// Deletes ONLY MyBuildy's own files inside its userData directory: encrypted
// keys, settings, project records, every project's memory (mybuildy-memory/*,
// including each project's Nemp store), the legacy un-namespaced memory file,
// and the vision-check approvals. Nothing outside userData is ever touched.
// The caller relaunches the app afterwards (first-run experience).
export async function deleteAllMyBuildyData(): Promise<void> {
  const targets = [
    'secrets.enc',           // encrypted API keys
    'settings.json',         // non-secret settings (incl. captureNoticeAccepted)
    'projects.json',         // project records + active project id
    'project-memory.json',   // legacy un-namespaced project memory
    'vision-approvals.json', // vision-check passes (keyed to key fingerprints)
    'mybuildy-memory',         // every project's memory + Nemp stores (recursive)
    'logs',                  // the local watch log (watch-log.ts)
    'setup-state.json',      // where the setup wizard is up to (setup-state.ts)
    'robot-prefs.json',      // the robot's size (robot-prefs.ts)
  ]
  // The project list's backup and recovery copies (projects.json.backup,
  // projects.json.damaged-*) and any temp file left by an interrupted atomic
  // write (<name>.<uuid>.tmp) hold project names and goals too.
  const siblings = await fs.readdir(userDataDirectory).catch(() => [] as string[])
  for (const name of siblings) {
    if (/^projects\.json\./.test(name) || /^(settings|project-memory)\.json\..*\.tmp$/.test(name)) targets.push(name)
  }
  const failed: string[] = []
  for (const name of targets) {
    const target = join(userDataDirectory, name)
    try {
      // maxRetries: Windows can transiently lock files (AV scans, open handles).
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (error) {
      console.warn(`[DataWipe] could not delete ${name}:`, error)
      failed.push(name)
    }
  }
  if (failed.length > 0) {
    // Rethrow so the caller does NOT relaunch as "fresh" after a partial wipe —
    // the Settings UI surfaces this instead of pretending everything is gone.
    throw new Error(
      `Could not delete: ${failed.join(', ')}. Close other programs using these files and try again.`
    )
  }
  console.log('[DataWipe] MyBuildy data deleted (keys, settings, all project memory)')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Write a synced sibling, then rename it over the file: an interrupted or
 *  failed write can never truncate the saved file (same as projects-core). */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temp = join(dirname(filePath), `${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, filePath)
  } finally {
    await fs.rm(temp, { force: true })
  }
}

async function ensureUserDataDirectoryExists(): Promise<void> {
  try {
    await fs.mkdir(userDataDirectory, { recursive: true })
  } catch {
    // Already exists — fine
  }
}
