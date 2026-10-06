// WindowPicker.tsx
// Shows all open windows so the user can choose which one to watch.
// Thumbnails come from desktopCapturer — deliberately low-resolution.
// (MyBuildy does NOT auto-detect Claude Code — the user always picks.)

import React from 'react'
import type { WindowSource } from '../types'

interface Props {
  windows: WindowSource[]
  selectedId: string | null
  onSelect: (windowId: string) => void
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
}

export function WindowPicker({
  windows,
  selectedId,
  onSelect,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm — analyze this window',
}: Props): React.ReactElement {
  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <h2 style={styles.title}>Show MyBuildy your coding agent</h2>
          <p style={styles.subtitle}>
            Choose the window your AI coding agent is running in (for example Terminal or PowerShell), then click Confirm. MyBuildy only looks at this one window.
          </p>
        </div>

        <div style={styles.windowList}>
          {windows.map((win) => (
            <WindowItem
              key={win.id}
              window={win}
              isSelected={selectedId === win.id}
              onSelect={() => onSelect(win.id)}
            />
          ))}

          {windows.length === 0 && (
            <div style={styles.emptyState}>
              No windows found. Make sure Claude Code is open and try again.
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={onConfirm}
            disabled={!selectedId}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function WindowItem({
  window: win,
  isSelected,
  onSelect,
}: {
  window: WindowSource
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      data-window-id={win.id}
      data-window-name={win.name}
      onClick={onSelect}
      style={{
        ...styles.windowItem,
        ...(isSelected ? styles.windowItemSelected : styles.windowItemDefault),
      }}
    >
      {/* Thumbnail */}
      <div style={styles.thumbnailContainer}>
        {win.thumbnailBase64 ? (
          <img
            src={`data:image/jpeg;base64,${win.thumbnailBase64}`}
            alt={win.name}
            style={styles.thumbnail}
          />
        ) : (
          <div style={styles.thumbnailPlaceholder}>🖥️</div>
        )}
      </div>

      {/* Window info */}
      <div style={styles.windowInfo}>
        <div style={styles.windowName}>{win.name}</div>
      </div>

      {isSelected && <div style={styles.selectedCheckmark}>✓</div>}
    </button>
  )
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: 16,
  },
  panel: {
    background: 'var(--color-bg)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--color-border-strong)',
    width: '100%',
    maxWidth: 460,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  header: {
    padding: '16px 16px 12px',
    borderBottom: '1px solid var(--color-border)',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--color-text)',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.4,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: 'var(--color-text-dim)',
    padding: '8px 4px 4px',
  },
  windowList: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  windowItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid transparent',
    width: '100%',
    textAlign: 'left' as const,
    cursor: 'pointer',
    transition: 'background 0.1s, border-color 0.1s',
  },
  windowItemDefault: {
    background: 'var(--color-surface)',
    borderColor: 'var(--color-border)',
    color: 'var(--color-text)',
  },
  windowItemSelected: {
    background: 'var(--color-accent-muted)',
    borderColor: 'var(--color-accent)',
    color: 'var(--color-text)',
  },
  thumbnailContainer: {
    width: 64,
    height: 40,
    borderRadius: 4,
    overflow: 'hidden',
    background: 'var(--color-surface-2)',
    flexShrink: 0,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  thumbnailPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
  },
  windowInfo: {
    flex: 1,
    minWidth: 0,
  },
  windowName: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--color-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  suggestedBadge: {
    fontSize: 10,
    color: 'var(--color-success)',
    marginTop: 2,
    fontWeight: 600,
  },
  selectedCheckmark: {
    fontSize: 14,
    color: 'var(--color-accent)',
    fontWeight: 700,
    flexShrink: 0,
  },
  emptyState: {
    padding: '32px 16px',
    textAlign: 'center' as const,
    color: 'var(--color-text-muted)',
    fontSize: 13,
  },
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid var(--color-border)',
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
}
