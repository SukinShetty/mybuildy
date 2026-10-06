// GuidanceWorkspace.tsx
// The Guidance tab. It is a second view of the robot's one watch — main owns
// it (analysis-loop.ts) and both show the same thing:
//   - the watched window: choosing one here or on the robot sets it for both
//   - Analyze Now: the watch's own analysis of that window, run now; the robot
//     works and thinks while it runs, and the result shows in both places
//   - Auto: the robot watching (on) or paused (off)
//   - Stop: ends the watch everywhere

import React, { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { GuidanceSections } from '../components/GuidanceSections'
import { PromptCard } from '../components/PromptCard'
import { WindowPicker } from '../components/WindowPicker'
import { CAPTURE_NOTICE_MESSAGE } from '../types'
import type { WindowSource } from '../types'

// What choosing a window here goes on to do.
type PickPurpose = 'analyze' | 'auto'

export function GuidanceWorkspace(): React.ReactElement {
  const { project, settings, watchStatus, latestAnalysis, setCurrentScreen, setSettings } = useAppStore()

  const [picker, setPicker] = useState<{ purpose: PickPurpose; windows: WindowSource[] } | null>(null)
  const [pendingWindowId, setPendingWindowId] = useState<string | null>(null)
  const [listingWindows, setListingWindows] = useState(false)
  // The one-time capture notice, shown before the first window is watched.
  const [noticePending, setNoticePending] = useState<{ win: WindowSource; purpose: PickPurpose } | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  // settings is REDACTED (no raw keys) — check the has* boolean + base URL.
  const apiIsConfigured = settings.hasApiKey || settings.baseUrl.trim().length > 0
  const projectIsConfigured = project.projectName.trim().length > 0
  const watching = watchStatus.windowName !== null
  const isAnalyzing = watchStatus.analyzing

  // ─── Choosing the window (the same one the robot watches) ─────────────────

  async function openPicker(purpose: PickPurpose): Promise<void> {
    setPickError(null)
    setListingWindows(true)
    try {
      const windows = await window.mybuildy.listWindows() // a fresh list every time
      setPendingWindowId(windows[0]?.id ?? null)
      setPicker({ purpose, windows })
    } catch (error) {
      setPickError(String(error))
    } finally {
      setListingWindows(false)
    }
  }

  async function watchWindow(win: WindowSource, purpose: PickPurpose): Promise<void> {
    // Analyze Now on a new window: one analysis, Auto stays off. Auto on: watching.
    const result = await window.mybuildy.selectWatchSource(win.id, win.name, purpose === 'auto')
    if (!result.started && result.message) setPickError(result.message)
  }

  async function confirmPicker(): Promise<void> {
    const win = picker?.windows.find((w) => w.id === pendingWindowId)
    const purpose = picker?.purpose ?? 'analyze'
    setPicker(null)
    if (!win) return
    if (!settings.captureNoticeAccepted) {
      setNoticePending({ win, purpose })
      return
    }
    await watchWindow(win, purpose)
  }

  async function acceptNoticeAndContinue(): Promise<void> {
    const pending = noticePending
    setNoticePending(null)
    await window.mybuildy.acceptCaptureNotice()
    setSettings({ ...useAppStore.getState().settings, captureNoticeAccepted: true })
    if (pending) await watchWindow(pending.win, pending.purpose)
  }

  // ─── Controls ─────────────────────────────────────────────────────────────

  async function handleAnalyzeNowClick(): Promise<void> {
    if (!apiIsConfigured) {
      setCurrentScreen('settings')
      return
    }
    setPickError(null)
    const result = await window.mybuildy.analyzeNow()
    if (result === 'no-window') await openPicker('analyze')
  }

  async function handleAutoClick(): Promise<void> {
    if (watchStatus.auto) await window.mybuildy.pauseCompanion()
    else if (watching) await window.mybuildy.resumeCompanion()
    else await openPicker('auto')
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const message = pickError ?? watchStatus.message

  return (
    <div style={styles.container}>
      {/* Window picker overlay — the same window list the robot shows */}
      {picker && (
        <WindowPicker
          windows={picker.windows}
          selectedId={pendingWindowId}
          onSelect={setPendingWindowId}
          onConfirm={() => { void confirmPicker() }}
          onCancel={() => setPicker(null)}
          confirmLabel={picker.purpose === 'auto' ? 'Watch this window' : 'Analyze this window'}
        />
      )}

      {/* One-time capture notice: nothing is captured until Continue */}
      {noticePending && (
        <div style={styles.noticeCard} role="alertdialog" aria-label="Before MyBuildy looks at your screen">
          <div style={styles.noticeText}>{CAPTURE_NOTICE_MESSAGE}</div>
          <div style={styles.noticeActions}>
            <button className="btn-primary" onClick={() => { void acceptNoticeAndContinue() }}>Continue</button>
            <button className="btn-icon" onClick={() => setNoticePending(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Current goal — always visible during the build session */}
      <CurrentGoalCard
        goalPurpose={project.goal?.purpose ?? null}
        onEdit={() => setCurrentScreen('goal')}
      />

      {/* Controls */}
      <div style={styles.controls}>
        <button
          className="btn-primary"
          onClick={() => { void handleAnalyzeNowClick() }}
          disabled={isAnalyzing || listingWindows}
          style={styles.analyzeButton}
        >
          {isAnalyzing ? 'Analyzing…' : listingWindows ? 'Finding windows…' : '📸 Analyze Now'}
        </button>

        <div style={styles.rightControls}>
          {/* Change window — sets it for the robot too */}
          {watching && (
            <button
              className="btn-ghost"
              onClick={() => { void openPicker(watchStatus.auto ? 'auto' : 'analyze') }}
              style={styles.smallButton}
              title="Change which window MyBuildy watches"
              aria-label="Change window"
            >
              🖥️
            </button>
          )}

          {/* Auto = the robot watching */}
          <button
            className={watchStatus.auto ? 'btn-secondary' : 'btn-ghost'}
            onClick={() => { void handleAutoClick() }}
            style={styles.autoButton}
            disabled={!apiIsConfigured}
            aria-label={watchStatus.auto ? 'Turn Auto off' : 'Turn Auto on'}
            title={watchStatus.auto ? 'Watching — click to pause' : 'Watch continuously, like the robot'}
          >
            {watchStatus.auto ? '⏸ Auto: on' : '▶ Auto'}
          </button>

          {/* Stop — ends the watch on the robot too */}
          {watching && (
            <button
              className="btn-ghost"
              onClick={() => { void window.mybuildy.stopCompanion() }}
              style={styles.autoButton}
              title="Stop watching (the robot stops too)"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* The watched window — the robot watches the same one */}
      {watching && (
        <div style={styles.watchedRow}>
          <span style={styles.watchedLabel}>{watchStatus.auto ? 'Watching' : 'Window'}:</span>
          <span data-testid="watched-window" style={styles.watchedName} title={watchStatus.windowName ?? ''}>
            {watchStatus.windowName}
          </span>
        </div>
      )}

      {/* No project warning */}
      {!projectIsConfigured && (
        <div style={styles.setupNudge}>
          <span>💡 Set up your project in</span>
          <button
            style={styles.nudgeLink}
            onClick={() => setCurrentScreen('brainstorm')}
          >
            Brainstorm
          </button>
          <span>for better guidance.</span>
        </div>
      )}

      {/* Content */}
      <div style={styles.content}>
        {/* Why watching stopped, can't start, or needs you — the robot says the same */}
        {message && !isAnalyzing && (
          <ErrorCard message={message} onRetry={() => { void handleAnalyzeNowClick() }} />
        )}

        {/* Analyzing in-progress */}
        {isAnalyzing && <LoadingCard />}

        {/* Results */}
        {latestAnalysis && (
          <>
            <GuidanceSections result={latestAnalysis} />
            {latestAnalysis.nextPrompt && (
              <PromptCard promptText={latestAnalysis.nextPrompt} />
            )}
          </>
        )}

        {/* Empty state */}
        {!latestAnalysis && !isAnalyzing && !message && (
          <EmptyState onAnalyze={() => { void handleAnalyzeNowClick() }} apiConfigured={!!apiIsConfigured} />
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CurrentGoalCard({
  goalPurpose,
  onEdit,
}: {
  goalPurpose: string | null
  onEdit: () => void
}): React.ReactElement {
  const hasGoal = !!(goalPurpose && goalPurpose.trim())
  return (
    <div style={styles.goalCard}>
      <div style={styles.goalCardMain}>
        <div style={styles.goalCardLabel}>🎯 Current goal</div>
        {hasGoal ? (
          <div style={styles.goalCardText}>{goalPurpose}</div>
        ) : (
          <div style={styles.goalCardEmpty}>No goal set yet — set one so MyBuildy can keep you on track.</div>
        )}
      </div>
      <button
        onClick={onEdit}
        style={styles.goalEditBtn}
        title={hasGoal ? 'Edit your goal' : 'Set your goal'}
        aria-label={hasGoal ? 'Edit goal' : 'Set goal'}
      >
        ✏️
      </button>
    </div>
  )
}

function EmptyState({
  onAnalyze,
  apiConfigured,
}: {
  onAnalyze: () => void
  apiConfigured: boolean
}): React.ReactElement {
  return (
    <div style={styles.emptyState}>
      <div style={styles.emptyStateIcon}>👁️</div>
      <div style={styles.emptyStateTitle}>Ready to watch Claude Code</div>
      <p style={styles.emptyStateText}>
        Open Claude Code, start working, then click Analyze Now. MyBuildy will look at your
        screen and tell you exactly what's happening and what to do next.
      </p>
      {apiConfigured ? (
        <button className="btn-primary" onClick={onAnalyze} style={{ marginTop: 16 }}>
          Analyze Now
        </button>
      ) : (
        <p style={{ ...styles.emptyStateText, marginTop: 12, color: 'var(--color-warning)' }}>
          ⚠️ Add your API key in Settings first.
        </p>
      )}
    </div>
  )
}

function LoadingCard(): React.ReactElement {
  const message = '🤖 MyBuildy is reading your screen and thinking…'

  return (
    <div style={styles.loadingCard}>
      <div style={styles.loadingDot} />
      <span style={styles.loadingText}>{message}</span>
    </div>
  )
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.ReactElement {
  return (
    <div style={styles.errorCard}>
      <div style={styles.errorHeader}>
        <span>⚠️</span>
        <span style={{ fontWeight: 600 }}>Needs your attention</span>
      </div>
      <p style={styles.errorText}>{message}</p>
      <button className="btn-secondary" onClick={onRetry} style={{ marginTop: 8 }}>
        Try again
      </button>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  noticeCard: {
    margin: '12px 0',
    padding: '14px 16px',
    borderRadius: 12,
    border: '1px solid rgba(252, 132, 0, 0.45)',
    background: 'rgba(252, 132, 0, 0.08)',
  } as React.CSSProperties,
  noticeText: {
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--color-text)',
  } as React.CSSProperties,
  noticeActions: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
  } as React.CSSProperties,
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
  },
  goalCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 16px',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  goalCardMain: {
    flex: 1,
    minWidth: 0,
  },
  goalCardLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--color-text-muted)',
    marginBottom: 2,
  },
  goalCardText: {
    fontSize: 13,
    color: 'var(--color-text)',
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden',
  },
  goalCardEmpty: {
    fontSize: 12,
    color: 'var(--color-text-dim)',
    lineHeight: 1.4,
    fontStyle: 'italic' as const,
  },
  goalEditBtn: {
    flexShrink: 0,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    padding: 2,
    lineHeight: 1,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  analyzeButton: {
    flex: 1,
    justifyContent: 'center',
  },
  rightControls: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
  },
  smallButton: {
    padding: '6px',
    fontSize: 14,
  },
  autoButton: {
    fontSize: 12,
    padding: '6px 10px',
    whiteSpace: 'nowrap' as const,
  },
  watchedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 16px',
    fontSize: 12,
    color: 'var(--color-text-muted)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
    minWidth: 0,
  },
  watchedLabel: {
    flexShrink: 0,
  },
  watchedName: {
    color: 'var(--color-text)',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  setupNudge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 16px',
    fontSize: 12,
    color: 'var(--color-text-muted)',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  nudgeLink: {
    background: 'none',
    border: 'none',
    color: 'var(--color-accent)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '0 2px',
    textDecoration: 'underline',
  },
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    textAlign: 'center' as const,
    padding: '32px 24px',
  },
  emptyStateIcon: {
    fontSize: 36,
    marginBottom: 12,
  },
  emptyStateTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--color-text)',
    marginBottom: 8,
  },
  emptyStateText: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    lineHeight: 1.55,
    maxWidth: 320,
  },
  loadingCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 16px',
    background: 'var(--color-surface)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border)',
  },
  loadingDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--color-accent)',
    animation: 'pulse 1.2s ease-in-out infinite',
    flexShrink: 0,
  },
  loadingText: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  errorCard: {
    padding: '12px',
    background: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-danger)30',
  },
  errorHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: 'var(--color-danger)',
    marginBottom: 6,
  },
  errorText: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
  },
}
