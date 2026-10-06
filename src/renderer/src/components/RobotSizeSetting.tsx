// RobotSizeSetting.tsx — Settings → "Robot size": a slider from 60% to 200%
// and a Reset button (back to 100%). Scales the robot, its bar, icons and
// "Next:" text together; remembered across launches (main: robot-prefs.ts).
// Ctrl/Cmd + scroll over the robot also zooms it — the slider follows that.

import React, { useEffect, useState } from 'react'
import {
  ROBOT_DEFAULT_SCALE, ROBOT_MAX_SCALE, ROBOT_MIN_SCALE, ROBOT_SLIDER_STEP,
  robotPercentToScale, robotScaleToPercent,
} from '../robot-size'

export function RobotSizeSetting(): React.ReactElement {
  const [percent, setPercent] = useState<number | null>(null)

  useEffect(() => {
    void window.mybuildy.robot.getScale().then((s) => setPercent(robotScaleToPercent(s)))
    return window.mybuildy.robot.onScaleChanged((s) => setPercent(robotScaleToPercent(s)))
  }, [])

  function apply(nextPercent: number): void {
    setPercent(nextPercent)
    void window.mybuildy.robot.setScale(robotPercentToScale(nextPercent))
  }

  const value = percent ?? robotScaleToPercent(ROBOT_DEFAULT_SCALE)
  const isDefault = value === robotScaleToPercent(ROBOT_DEFAULT_SCALE)

  return (
    <div style={S.row}>
      <input
        type="range"
        aria-label="Robot size"
        min={robotScaleToPercent(ROBOT_MIN_SCALE)}
        max={robotScaleToPercent(ROBOT_MAX_SCALE)}
        step={Math.round(ROBOT_SLIDER_STEP * 100)}
        value={value}
        disabled={percent === null}
        onChange={(e) => apply(Number(e.target.value))}
        style={S.slider}
      />
      <span style={S.value} aria-live="polite">{value}%</span>
      <button
        type="button"
        className="btn-secondary"
        disabled={percent === null || isDefault}
        onClick={() => apply(robotScaleToPercent(ROBOT_DEFAULT_SCALE))}
      >
        Reset
      </button>
    </div>
  )
}

const S = {
  row: { display: 'flex', gap: 10, alignItems: 'center' },
  slider: { flex: 1, minWidth: 140, accentColor: 'var(--color-accent)' },
  value: { minWidth: 44, textAlign: 'right' as const, fontSize: 13, fontVariantNumeric: 'tabular-nums' as const, color: 'var(--color-text)' },
}
