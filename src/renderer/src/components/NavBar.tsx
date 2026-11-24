// NavBar.tsx
// Top navigation bar with 5 tabs and the MyBuildy name.
// Stays fixed at the top of the app — screen content scrolls below it.

import React from 'react'
import { useAppStore, type AppScreen } from '../store/useAppStore'

interface NavTab {
  id: AppScreen
  label: string
  icon: string
}

const NAV_TABS: NavTab[] = [
  { id: 'goal',       label: 'Set Goal',   icon: '🎯' },
  { id: 'brainstorm', label: 'Brainstorm', icon: '💡' },
  { id: 'guidance',   label: 'Guidance',   icon: '👁️' },
  { id: 'memory',     label: 'Memory',     icon: '📋' },
  { id: 'settings',   label: 'Settings',   icon: '⚙️' },
]

export function NavBar(): React.ReactElement {
  const { currentScreen, setCurrentScreen } = useAppStore()

  return (
    <nav style={styles.nav} className="app-titlebar">
      {/* Logo */}
      <div style={styles.logo} className="app-titlebar-logo">
        <span style={styles.logoIcon}>🔨</span>
        <span style={styles.logoText}>MyBuildy</span>
      </div>

      {/* Tab buttons */}
      <div style={styles.tabs}>
        {NAV_TABS.map((tab) => {
          const isActive = currentScreen === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setCurrentScreen(tab.id)}
              style={{
                ...styles.tab,
                ...(isActive ? styles.tabActive : styles.tabInactive),
              }}
              title={tab.label}
            >
              <span style={styles.tabIcon}>{tab.icon}</span>
              <span style={styles.tabLabel}>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

const styles = {
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 'var(--nav-height)',
    padding: '0 12px',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
    // On macOS with hiddenInset, the traffic lights live in this area
    WebkitAppRegion: 'drag',
  } as React.CSSProperties,

  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    WebkitAppRegion: 'drag',
  } as React.CSSProperties,

  logoIcon: {
    fontSize: 16,
  } as React.CSSProperties,

  logoText: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--color-text)',
    letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,

  tabs: {
    display: 'flex',
    gap: 2,
    // Tabs need to be clickable — not draggable
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,

  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
    whiteSpace: 'nowrap',
    background: 'transparent',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 500,
    transition: 'background 0.1s ease',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,

  tabActive: {
    background: 'var(--color-accent-muted)',
    color: 'var(--color-accent-text)',
  } as React.CSSProperties,

  tabInactive: {
    color: 'var(--color-text-muted)',
  } as React.CSSProperties,

  tabIcon: {
    fontSize: 13,
  } as React.CSSProperties,

  tabLabel: {
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
}
