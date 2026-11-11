// MemoryScreen.tsx
// MyBuildy's project memory, backed by the Nemp memory layer (loop engineering
// Block 2). Shows what MyBuildy knows — completed work, blockers, decisions,
// patterns, and recent activity — plus export + reset.

import React, { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { MemorySnapshot, MemoryEntry } from '../types'

const EMPTY_SNAPSHOT: MemorySnapshot = {
  goal: null,
  completed: [],
  inProgress: [],
  blockersOpen: [],
  blockersResolved: [],
  decisions: [],
  patterns: [],
  recent: [],
}

export function MemoryScreen(): React.ReactElement {
  const { setCurrentScreen, activeProject, setActiveProject } = useAppStore()
  const [snap, setSnap] = useState<MemorySnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  // Snapshot, export and reset all act on the ACTIVE project only — the header
  // names it so it's always clear whose memory this is.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, active] = await Promise.all([
        window.mybuildy.memory.get(),
        window.mybuildy.projects.getActive(),
      ])
      setSnap(s)
      setActiveProject(active)
    } catch (e) {
      console.warn('[MemoryScreen] load failed:', e)
    } finally {
      setLoading(false)
    }
  }, [setActiveProject])

  useEffect(() => { load() }, [load])

  function flash(msg: string): void {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  async function onExport(): Promise<void> {
    try {
      const res = await window.mybuildy.memory.exportMyBuildyMd()
      flash(res.saved ? `Exported to ${res.path}` : 'Export cancelled')
    } catch (e) {
      console.warn('[MemoryScreen] export failed:', e)
      flash('Export failed')
    }
  }

  async function onReset(): Promise<void> {
    setConfirmReset(false)
    try {
      await window.mybuildy.memory.reset()
      flash('Memory cleared')
      load()
    } catch (e) {
      console.warn('[MemoryScreen] reset failed:', e)
      flash('Memory could not be cleared. Try again.')
      load()
    }
  }

  const totalCount =
    snap.completed.length + snap.inProgress.length + snap.blockersOpen.length +
    snap.blockersResolved.length + snap.decisions.length + snap.patterns.length

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div style={S.headerRow}>
          <div style={S.headerTitle}>
            🧠 {activeProject?.name ? `${activeProject.name} — Memory` : 'Project Memory'}
          </div>
          <button className="btn-ghost" onClick={load} style={S.smallBtn} title="Refresh">↻</button>
        </div>
        <div style={S.headerSub}>
          What MyBuildy remembers about this project. Stored only on this computer.
          Relevant entries are sent to your AI provider with each analysis.
        </div>
      </div>

      <div style={S.body}>
        {/* Goal */}
        <div style={S.goalCard}>
          <div style={S.goalLabel}>GOAL</div>
          <div style={S.goalText}>
            {snap.goal?.purpose || 'No goal set yet.'}
          </div>
          <button style={S.goalEdit} onClick={() => setCurrentScreen('goal')}>
            {snap.goal?.purpose ? 'Edit goal →' : 'Set a goal →'}
          </button>
        </div>

        {loading && <div style={S.muted}>Loading memory…</div>}

        {!loading && totalCount === 0 && snap.recent.length === 0 && (
          <div style={S.empty}>
            MyBuildy hasn't learned anything yet. Start a watching session and it will
            remember what you build.
          </div>
        )}

        <Section title="Completed features" count={snap.completed.length} color="var(--color-success)">
          <EntryList items={snap.completed} color="var(--color-success)" />
        </Section>

        <Section title="In progress" count={snap.inProgress.length} color="var(--color-accent)">
          <EntryList items={snap.inProgress} color="var(--color-accent)" />
        </Section>

        <Section title="Open blockers" count={snap.blockersOpen.length} color="var(--color-danger)">
          <EntryList items={snap.blockersOpen} color="var(--color-danger)" />
        </Section>

        <Section title="Resolved blockers" count={snap.blockersResolved.length} color="var(--color-text-dim)">
          <EntryList items={snap.blockersResolved} color="var(--color-text-dim)" />
        </Section>

        <Section title="Key decisions" count={snap.decisions.length} color="var(--color-accent)">
          <EntryList items={snap.decisions} color="var(--color-accent)" />
        </Section>

        <Section title="Patterns MyBuildy noticed" count={snap.patterns.length} color="var(--color-warning)">
          <EntryList items={snap.patterns} color="var(--color-warning)" />
        </Section>

        <Section title="Recent activity" count={snap.recent.length} color="var(--color-text-muted)" defaultOpen={false}>
          <EntryList items={snap.recent} color="var(--color-text-muted)" />
        </Section>

        {/* Actions */}
        <div style={S.actions}>
          <button className="btn-primary" onClick={onExport} style={{ flex: 1, justifyContent: 'center' }}>
            Export MYBUILDY.md
          </button>
          <button className="btn-ghost" onClick={() => setConfirmReset(true)} style={S.resetBtn}>
            Reset memory
          </button>
        </div>
      </div>

      {toast && <div style={S.toast}>{toast}</div>}

      {confirmReset && (
        <div style={S.modalOverlay}>
          <div style={S.modalCard}>
            <div style={S.modalTitle}>Reset all memory?</div>
            <div style={S.modalText}>
              This permanently deletes everything MyBuildy has learned about this
              project (completed work, blockers, decisions, patterns). Your goal is
              kept. This cannot be undone.
            </div>
            <div style={S.modalButtons}>
              <button className="btn-ghost" onClick={() => setConfirmReset(false)} style={{ flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button onClick={onReset} style={S.dangerBtn}>Reset memory</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Collapsible section ────────────────────────────────────────────────────────

function Section({
  title,
  count,
  color,
  defaultOpen = true,
  children,
}: {
  title: string
  count: number
  color: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen)
  if (count === 0) return null
  return (
    <div style={S.section}>
      <button style={S.sectionHead} onClick={() => setOpen((o) => !o)}>
        <span style={{ ...S.sectionDot, background: color }} />
        <span style={S.sectionTitle}>{title}</span>
        <span style={S.sectionCount}>{count}</span>
        <span style={S.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={S.sectionBody}>{children}</div>}
    </div>
  )
}

function EntryList({ items, color }: { items: MemoryEntry[]; color: string }): React.ReactElement {
  return (
    <div style={S.list}>
      {items.map((m) => (
        <div key={m.key} style={S.entry}>
          <span style={{ ...S.entryDot, background: color }} />
          <div style={S.entryMain}>
            <div style={S.entryText}>{m.value}</div>
            <div style={S.entryTime}>{formatTime(m.timestamp)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso.slice(0, 16)
  }
}

// ─── Styles ─────────────────────────────────────────────────────────────────────

const S = {
  container: { display: 'flex', flexDirection: 'column' as const, height: '100%', overflow: 'hidden', position: 'relative' as const },
  header: { padding: '12px 16px 8px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 },
  headerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerTitle: { fontSize: 14, fontWeight: 700, color: 'var(--color-text)' },
  headerSub: { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 },
  smallBtn: { fontSize: 14, padding: '2px 8px' },
  body: { flex: 1, overflowY: 'auto' as const, padding: '12px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  goalCard: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 12 },
  goalLabel: { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--color-text-muted)' },
  goalText: { fontSize: 13, color: 'var(--color-text)', marginTop: 4, lineHeight: 1.4 },
  goalEdit: { marginTop: 6, background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12, padding: 0 },
  muted: { fontSize: 12, color: 'var(--color-text-muted)', padding: '8px 0' },
  empty: { fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5, padding: '12px', background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' },
  section: { border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' },
  sectionHead: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', background: 'var(--color-surface)', border: 'none', cursor: 'pointer', textAlign: 'left' as const },
  sectionDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--color-text)', flex: 1 },
  sectionCount: { fontSize: 11, color: 'var(--color-text-muted)', background: 'var(--color-bg)', borderRadius: 999, padding: '1px 7px' },
  chevron: { fontSize: 10, color: 'var(--color-text-dim)' },
  sectionBody: { padding: '6px 10px 10px' },
  list: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  entry: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  entryDot: { width: 6, height: 6, borderRadius: '50%', marginTop: 5, flexShrink: 0 },
  entryMain: { flex: 1, minWidth: 0 },
  entryText: { fontSize: 12, color: 'var(--color-text)', lineHeight: 1.4, whiteSpace: 'pre-wrap' as const },
  entryTime: { fontSize: 10, color: 'var(--color-text-dim)', marginTop: 1 },
  actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
  resetBtn: { fontSize: 12, padding: '6px 12px', color: 'var(--color-danger)', whiteSpace: 'nowrap' as const },
  toast: { position: 'absolute' as const, bottom: 16, left: '50%', transform: 'translateX(-50%)', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontSize: 12, color: 'var(--color-text)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)', maxWidth: '90%' },
  modalOverlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 },
  modalCard: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 20, maxWidth: 360, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' },
  modalTitle: { fontSize: 15, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 },
  modalText: { fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5, marginBottom: 16 },
  modalButtons: { display: 'flex', gap: 8 },
  dangerBtn: { flex: 1, justifyContent: 'center', display: 'flex', alignItems: 'center', background: 'var(--color-danger)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
}
