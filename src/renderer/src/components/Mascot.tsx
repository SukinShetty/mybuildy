// Mascot.tsx
// MyBuildy's robot. Plays one of nine frame-by-frame animations (WebP strips
// of 256x288 frames in assets/robot/) over a soft, state-coloured glow, with
// the speaking ripples, listening pings, success sparkles, goal confetti and
// the "!" alert badge on top.
//
// Visual only — it takes props and renders accordingly. Which animation plays,
// and the frame timing, are pure functions in companion/robot-animation.ts.
//
// Rendering: each strip is the background of one box, sized so one frame fills
// it; the frame is chosen with background-position. The browser rescales the
// artwork from the source pixels at any robot size or zoom, so it stays sharp.
// Reduced motion: the first frame of each state only, no effects.

import React, { useEffect, useState } from 'react'

import idleStrip from '../assets/robot/idle.webp'
import runningRightStrip from '../assets/robot/running-right.webp'
import runningLeftStrip from '../assets/robot/running-left.webp'
import wavingStrip from '../assets/robot/waving.webp'
import jumpingStrip from '../assets/robot/jumping.webp'
import failedStrip from '../assets/robot/failed.webp'
import waitingStrip from '../assets/robot/waiting.webp'
import workingStrip from '../assets/robot/working.webp'
import reviewStrip from '../assets/robot/review.webp'

import {
  FRAME_HEIGHT, FRAME_WIDTH, ROBOT_ANIMATIONS, frameIndex,
  type ReactionPlan, type RobotAnimation,
} from '../companion/robot-animation'

const STRIPS: Record<RobotAnimation, string> = {
  idle: idleStrip,
  'running-right': runningRightStrip,
  'running-left': runningLeftStrip,
  waving: wavingStrip,
  jumping: jumpingStrip,
  failed: failedStrip,
  waiting: waitingStrip,
  working: workingStrip,
  review: reviewStrip,
}

/** Voice cues drawn around the robot (they don't change its animation). */
export type MascotVoice = 'speaking' | 'listening' | null

interface Props {
  animation: RobotAnimation
  /** When a one-off reaction started (ms, Date.now()); null for ongoing states. */
  startedAt?: number | null
  effect?: ReactionPlan['effect']
  /** Height of the robot box in px (width follows the 256:288 artwork). */
  size?: number
  glow: string
  voice?: MascotVoice
  /** Persistent "!" badge (blocked / hand-off) until guidance is opened. */
  showAlertBadge?: boolean
}

/** The OS "reduce motion" setting, kept current if the user changes it while MyBuildy runs. */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setReduced(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** The current frame of `animation`, advanced on every animation frame. */
function useFrame(animation: RobotAnimation, startedAt: number | null, reducedMotion: boolean): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (reducedMotion) { setFrame(0); return }
    const origin = startedAt ?? performance.timeOrigin + performance.now()
    let raf = 0
    const tick = (): void => {
      const seconds = (performance.timeOrigin + performance.now() - origin) / 1000
      setFrame(frameIndex(animation, seconds, false))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [animation, startedAt, reducedMotion])
  return frame
}

/** Load every strip once, so switching animations never flashes an empty box. */
function usePreloadedStrips(): void {
  useEffect(() => {
    for (const src of Object.values(STRIPS)) {
      const img = new Image()
      img.src = src
    }
  }, [])
}

const CONFETTI_COLOURS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899', '#FCD34D', '#8B5CF6']

export function Mascot({
  animation,
  startedAt = null,
  effect = null,
  size = 120,
  glow,
  voice = null,
  showAlertBadge = false,
}: Props): React.ReactElement {
  const reducedMotion = useReducedMotion()
  usePreloadedStrips()
  const frame = useFrame(animation, startedAt, reducedMotion)
  const frames = ROBOT_ANIMATIONS[animation].frames
  const width = Math.round((size * FRAME_WIDTH) / FRAME_HEIGHT)
  const dot = Math.max(5, Math.round(size * 0.05))
  const effectKey = startedAt ?? 0

  return (
    <div style={{ ...styles.wrap, width, height: size }} data-testid="mascot" data-animation={animation}>
      {/* Glow — a still radial gradient; its colour fades between states. */}
      <div
        style={{
          ...styles.glow,
          background: `radial-gradient(circle, ${glow}66 0%, ${glow}2E 45%, transparent 70%)`,
        }}
      />

      {/* Speaking ripples / listening pings, behind the robot */}
      {!reducedMotion && voice &&
        [0, 1, 2].map((i) => (
          <span
            key={`${voice}-${i}`}
            className={voice === 'speaking' ? 'mascot-ripple' : 'mascot-ping'}
            style={{ borderColor: glow, animationDelay: `${i * (voice === 'speaking' ? 0.5 : 0.4)}s` }}
          />
        ))}

      {/* The robot: one frame of the current strip */}
      <div
        role="img"
        aria-label={`MyBuildy: ${animation.replace('-', ' ')}`}
        style={{
          ...styles.sprite,
          backgroundImage: `url(${STRIPS[animation]})`,
          backgroundSize: `${frames * 100}% 100%`,
          backgroundPositionX: frames > 1 ? `${(frame / (frames - 1)) * 100}%` : '0%',
        }}
      />

      {/* Verifier passed — a short sparkle burst */}
      {!reducedMotion && effect === 'sparkles' && (
        <div key={`sparkles-${effectKey}`} style={styles.overlayCenter}>
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const angle = (i / 6) * Math.PI * 2
            const r = size * 0.45
            return (
              <span
                key={i}
                className="mascot-sparkle"
                style={{
                  ...styles.sparkle,
                  width: dot,
                  height: dot,
                  ['--dx' as string]: `${Math.round(Math.cos(angle) * r)}px`,
                  ['--dy' as string]: `${Math.round(Math.sin(angle) * r)}px`,
                }}
              />
            )
          })}
        </div>
      )}

      {/* Goal complete — confetti falling around the robot */}
      {!reducedMotion && effect === 'confetti' && (
        <div key={`confetti-${effectKey}`} style={styles.confettiBox}>
          {Array.from({ length: 18 }, (_, i) => (
            <span
              key={i}
              className="mascot-confetti"
              style={{
                left: `${(i * 37) % 100}%`,
                width: Math.max(4, Math.round(size * 0.045)),
                height: Math.max(6, Math.round(size * 0.07)),
                background: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length],
                animationDelay: `${(i % 6) * 0.25}s`,
                ['--spin' as string]: `${(i % 2 ? 1 : -1) * (180 + i * 20)}deg`,
              }}
            />
          ))}
        </div>
      )}

      {/* "!" badge — persists until the guidance panel is opened */}
      {showAlertBadge && (
        <div
          data-testid="mascot-alert-badge"
          style={{
            ...styles.badge,
            width: Math.round(size * 0.17),
            height: Math.round(size * 0.17),
            fontSize: Math.round(size * 0.11),
          }}
        >
          !
        </div>
      )}

      <style>{`
        .mascot-ripple,
        .mascot-ping {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 86%;
          height: 76%;
          border-radius: 50%;
          border: 2px solid;
          box-sizing: border-box;
          pointer-events: none;
        }
        .mascot-ripple { animation: mascotRipple 1.6s ease-out infinite; }
        .mascot-ping { animation: mascotPing 1.4s cubic-bezier(0, 0, 0.2, 1) infinite; }
        .mascot-sparkle { animation: mascotSparkle 0.8s ease-out forwards; }
        .mascot-confetti {
          position: absolute;
          top: -10%;
          border-radius: 2px;
          opacity: 0;
          animation: mascotConfetti 1.6s ease-in 2 forwards;
        }
        @keyframes mascotRipple {
          0% { transform: translate(-50%, -50%) scale(0.55); opacity: 0.55; }
          100% { transform: translate(-50%, -50%) scale(1.5); opacity: 0; }
        }
        @keyframes mascotPing {
          0% { transform: translate(-50%, -50%) scale(0.5); opacity: 0.7; }
          80%, 100% { transform: translate(-50%, -50%) scale(1.7); opacity: 0; }
        }
        @keyframes mascotSparkle {
          0% { transform: translate(0, 0) scale(0.4); opacity: 1; }
          100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0; }
        }
        @keyframes mascotConfetti {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(130%) rotate(var(--spin)); opacity: 0; }
        }
      `}</style>
    </div>
  )
}

const styles = {
  wrap: {
    position: 'relative' as const,
    background: 'transparent',
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  glow: {
    position: 'absolute' as const,
    inset: '-8%',
    borderRadius: '50%',
    pointerEvents: 'none' as const,
    opacity: 0.75,
    transition: 'background 0.4s ease-in-out',
  },
  sprite: {
    position: 'absolute' as const,
    inset: 0,
    backgroundRepeat: 'no-repeat',
    backgroundPositionY: '0%',
    pointerEvents: 'none' as const,
    // Static depth shadow only (never animated) — colour glow is the gradient layer.
    filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.4))',
  },
  overlayCenter: {
    position: 'absolute' as const,
    top: '50%',
    left: '50%',
    width: 0,
    height: 0,
    pointerEvents: 'none' as const,
  },
  sparkle: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    borderRadius: '50%',
    background: '#FCD34D',
    boxShadow: '0 0 6px #FCD34D',
    display: 'block',
  },
  confettiBox: {
    position: 'absolute' as const,
    inset: '-6% -10%',
    overflow: 'hidden' as const,
    pointerEvents: 'none' as const,
  },
  badge: {
    position: 'absolute' as const,
    top: '2%',
    right: '4%',
    borderRadius: '50%',
    background: '#EF4444',
    color: '#fff',
    fontWeight: 800,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    pointerEvents: 'none' as const,
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
  },
}
