// GoalScreen.tsx
// Captures the user's goal — their stated purpose for what they're building.
// Shown on first launch, from the "Set Goal" nav tab, and when starting a new
// project. The goal is stored locally (project memory) and injected into every
// analysis so MyBuildy can tell the user whether each step moves toward the goal.
//
// Also hosts the PROJECT SWITCHER: each project has its own memory, and
// switching re-points the whole memory layer. Editing the goal text keeps the
// current project (and its memory) — only "New project" starts a fresh one.

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { ProjectMemory } from '../types'
import { ProjectManager } from '../components/ProjectManager'

const PLACEHOLDER =
  'Example: I want to build a simple CRM for my small business to track customers and follow-ups. The main users are me and 2 employees who are not technical.'

export function GoalScreen(): React.ReactElement {
  const {
    project, setProject, patchProject, setCurrentScreen,
    projects, activeProject, setProjects, setActiveProject,
  } = useAppStore()

  const existing = project.goal
  const [purpose, setPurpose] = useState(existing?.purpose ?? '')
  const [audience, setAudience] = useState(existing?.audience ?? '')
  const [mostImportant, setMostImportant] = useState(existing?.mostImportant ?? '')
  const [successCriteria, setSuccessCriteria] = useState(existing?.successCriteria ?? '')
  // Expand the optional fields by default if any were already filled in (editing)
  const [showMore, setShowMore] = useState(
    !!(existing?.audience || existing?.mostImportant || existing?.successCriteria)
  )
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [managing, setManaging] = useState(false)

  const canSave = purpose.trim().length > 0
  // Bumped whenever the project on screen changes (switch, new, manage). A goal
  // save that finishes after that belongs to the project it was saved for, so
  // its reply must not be shown on (or navigate away from) the new project.
  const projectGeneration = useRef(0)

  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      const [list, active] = await Promise.all([
        window.mybuildy.projects.list(),
        window.mybuildy.projects.getActive(),
      ])
      setProjects(list)
      setActiveProject(active)
    } catch (e) {
      console.warn('[GoalScreen] failed to load projects:', e)
    }
  }, [setProjects, setActiveProject])

  useEffect(() => { refreshProjects() }, [refreshProjects])

  // After a switch/new-project the ACTIVE project's memory changed under us —
  // reload it and reset the form fields from its goal.
  function applyLoadedProject(pm: ProjectMemory): void {
    projectGeneration.current++
    setProject(pm)
    setPurpose(pm.goal?.purpose ?? '')
    setAudience(pm.goal?.audience ?? '')
    setMostImportant(pm.goal?.mostImportant ?? '')
    setSuccessCriteria(pm.goal?.successCriteria ?? '')
    setShowMore(!!(pm.goal?.audience || pm.goal?.mostImportant || pm.goal?.successCriteria))
  }

  async function handleSwitchProject(id: string): Promise<void> {
    if (switching || !id || id === activeProject?.id) return
    setSwitching(true)
    projectGeneration.current++
    try {
      await window.mybuildy.projects.switch(id)
      applyLoadedProject(await window.mybuildy.loadProject())
      await refreshProjects()
    } catch (e) {
      console.error('[GoalScreen] failed to switch project:', e)
    } finally {
      setSwitching(false)
    }
  }

  async function handleNewProject(): Promise<void> {
    if (switching) return
    setSwitching(true)
    projectGeneration.current++
    try {
      await window.mybuildy.projects.create({})
      applyLoadedProject(await window.mybuildy.loadProject())
      await refreshProjects()
    } catch (e) {
      console.error('[GoalScreen] failed to create project:', e)
    } finally {
      setSwitching(false)
    }
  }

  async function handleRename(): Promise<void> {
    const name = renameValue.trim()
    if (!name || !activeProject) { setRenaming(false); return }
    try {
      await window.mybuildy.projects.rename(activeProject.id, name)
      await refreshProjects()
    } catch (e) {
      console.error('[GoalScreen] failed to rename project:', e)
    } finally {
      setRenaming(false)
    }
  }

  async function handleSave(): Promise<void> {
    if (!canSave || saving) return
    setSaving(true)
    const savedFor = projectGeneration.current
    try {
      // "Edit goal" KEEPS this project's memory: goal.set only replaces the goal
      // on the active project — it never creates a project or wipes memory.
      const goal = await window.mybuildy.goal.set({
        purpose: purpose.trim(),
        audience: audience.trim() || undefined,
        mostImportant: mostImportant.trim() || undefined,
        successCriteria: successCriteria.trim() || undefined,
      })
      // Another project was opened while this saved: the goal is stored on the
      // project it was written for; leave the project now on screen alone.
      if (projectGeneration.current !== savedFor) {
        setSaving(false)
        return
      }
      // Keep the in-memory project in sync (main process already persisted it)
      patchProject({ goal, goalPromptSeen: true })
      setCurrentScreen('guidance')
    } catch (e) {
      console.error('[GoalScreen] Failed to save goal:', e)
      setSaving(false)
    }
  }

  function handleSkip(): void {
    // Skipping is allowed — record that the prompt was seen so it won't auto-show again.
    const updated = { ...project, goalPromptSeen: true }
    patchProject({ goalPromptSeen: true })
    window.mybuildy.saveProject(updated).catch((e) =>
      console.warn('[GoalScreen] Failed to persist skip:', e)
    )
    setCurrentScreen('guidance')
  }

  return (
    <div style={styles.container}>
      <div style={styles.inner}>
        {/* Project switcher — each project has its own memory */}
        <div style={styles.projectBar}>
          <label htmlFor="goal-project-select" style={styles.projectLabel}>PROJECT</label>
          <div style={styles.projectRow}>
            <select
              id="goal-project-select"
              value={activeProject?.id ?? ''}
              onChange={(e) => handleSwitchProject(e.target.value)}
              disabled={switching || projects.length === 0}
              style={styles.projectSelect}
            >
              {projects.length === 0 && <option value="">Loading…</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.featureCount} {p.featureCount === 1 ? 'feature' : 'features'})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-ghost"
              onClick={handleNewProject}
              disabled={switching}
              style={styles.projectBtn}
            >
              + New project
            </button>
          </div>
          {!renaming ? (
            <div style={styles.linkRow}>
              <button
                type="button"
                onClick={() => { setRenameValue(activeProject?.name ?? ''); setRenaming(true) }}
                disabled={!activeProject}
                style={styles.renameLink}
              >
                Rename
              </button>
              <button type="button" onClick={() => setManaging((m) => !m)} style={styles.renameLink} aria-expanded={managing}>
                {managing ? 'Done managing' : 'Manage projects'}
              </button>
            </div>
          ) : (
            <div style={styles.renameRow}>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
                placeholder="Project name"
                autoFocus
                style={styles.renameInput}
              />
              <button type="button" className="btn-ghost" onClick={handleRename} style={styles.projectBtn}>
                Save
              </button>
              <button type="button" className="btn-ghost" onClick={() => setRenaming(false)} style={styles.projectBtn}>
                Cancel
              </button>
            </div>
          )}
        </div>

        {managing && (
          <ProjectManager
            projects={projects}
            activeId={activeProject?.id ?? null}
            onChanged={async (switched) => {
              if (switched) applyLoadedProject(await window.mybuildy.loadProject())
              await refreshProjects()
            }}
          />
        )}

        <h1 style={styles.heading}>What are you building?</h1>
        <p style={styles.subheading}>
          Tell me in plain English. I will remember this and use it to guide every step.
        </p>

        <textarea
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={8}
          style={styles.textarea}
          autoFocus
        />

        {/* Optional follow-up details — collapsed by default */}
        <button
          type="button"
          onClick={() => setShowMore((s) => !s)}
          style={styles.moreToggle}
        >
          {showMore ? '▾ Hide extra detail' : '▸ Add more detail'}
        </button>

        {showMore && (
          <div style={styles.moreFields}>
            <Field label="Who is this for?">
              <input
                type="text"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="e.g. me and 2 non-technical employees"
              />
            </Field>
            <Field label="What is the single most important thing it should do?">
              <input
                type="text"
                value={mostImportant}
                onChange={(e) => setMostImportant(e.target.value)}
                placeholder="e.g. never lose track of a customer follow-up"
              />
            </Field>
            <Field label="What does success look like in one month?">
              <input
                type="text"
                value={successCriteria}
                onChange={(e) => setSuccessCriteria(e.target.value)}
                placeholder="e.g. my team logs every call without me reminding them"
              />
            </Field>
          </div>
        )}

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={!canSave || saving}
          style={{ ...styles.saveButton, opacity: canSave && !saving ? 1 : 0.5 }}
        >
          {saving ? 'Saving…' : 'Save and start building'}
        </button>

        <button type="button" onClick={handleSkip} style={styles.skipLink}>
          Skip for now
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      {children}
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflowY: 'auto' as const,
    padding: '24px 20px 32px',
  },
  inner: {
    width: '100%',
    maxWidth: 420,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  projectBar: {
    marginBottom: 18,
    padding: '10px 12px',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  projectLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: 'var(--color-text-muted)',
  },
  projectRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  projectSelect: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
  },
  projectBtn: {
    fontSize: 12,
    padding: '4px 10px',
    whiteSpace: 'nowrap' as const,
  },
  renameLink: {
    alignSelf: 'flex-start' as const,
    background: 'none',
    border: 'none',
    color: 'var(--color-accent)',
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
  },
  linkRow: {
    display: 'flex',
    gap: 14,
  },
  renameRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  renameInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
  },
  heading: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--color-text)',
    letterSpacing: '-0.02em',
    margin: 0,
  },
  subheading: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
    margin: '8px 0 18px',
  },
  textarea: {
    width: '100%',
    resize: 'vertical' as const,
    lineHeight: 1.5,
    fontSize: 14,
  },
  moreToggle: {
    alignSelf: 'flex-start' as const,
    background: 'none',
    border: 'none',
    color: 'var(--color-accent)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    padding: '10px 0',
  },
  moreFields: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    marginBottom: 4,
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 5,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
  },
  saveButton: {
    marginTop: 18,
    justifyContent: 'center',
    width: '100%',
  },
  skipLink: {
    marginTop: 12,
    alignSelf: 'center' as const,
    background: 'none',
    border: 'none',
    color: 'var(--color-text-dim)',
    cursor: 'pointer',
    fontSize: 12,
    textDecoration: 'underline',
  },
}
