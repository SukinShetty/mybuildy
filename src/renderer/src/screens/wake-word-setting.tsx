// wake-word-setting.tsx — Settings → Voice: the "Hey Buildy" checkbox.
// When WAKE_WORD_AVAILABLE is false, it stays greyed out and unchecked
// (Coming soon), even if an earlier test build saved wakeWordEnabled true.

import React from 'react'
import {
  WAKE_WORD_AVAILABLE,
  WAKE_WORD_COMING_SOON_HINT,
  WAKE_WORD_COMING_SOON_LABEL,
  WAKE_WORD_EXPLANATION,
  WAKE_WORD_UNAVAILABLE,
} from '../types'

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--color-text)',
  cursor: 'pointer',
}

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-dim)',
  lineHeight: 1.4,
}

export function WakeWordSetting({
  available = WAKE_WORD_AVAILABLE,
  savedEnabled,
  listenModel,
  onChange,
}: {
  available?: boolean
  savedEnabled: boolean
  listenModel: 'missing' | 'off' | 'loading' | 'ready' | 'failed'
  onChange: (enabled: boolean) => void
}): React.ReactElement {
  if (!available) {
    return (
      <>
        <label style={{ ...labelStyle, color: 'var(--color-text-muted)', cursor: 'default' }}>
          <input type="checkbox" data-testid="wake-word-toggle" checked={false} disabled readOnly />
          {WAKE_WORD_COMING_SOON_LABEL}
        </label>
        <div style={hintStyle} data-testid="wake-word-explanation">{WAKE_WORD_COMING_SOON_HINT}</div>
      </>
    )
  }
  return (
    <>
      <label style={labelStyle}>
        <input
          type="checkbox"
          data-testid="wake-word-toggle"
          checked={savedEnabled === true}
          disabled={listenModel === 'missing' && savedEnabled !== true}
          onChange={(e) => { onChange(e.target.checked) }}
        />
        Wake word (experimental): say &quot;Hey Buildy&quot;
      </label>
      <div style={hintStyle} data-testid="wake-word-explanation">{WAKE_WORD_EXPLANATION}</div>
      {listenModel === 'missing' && <div style={hintStyle} role="status">{WAKE_WORD_UNAVAILABLE}</div>}
    </>
  )
}
