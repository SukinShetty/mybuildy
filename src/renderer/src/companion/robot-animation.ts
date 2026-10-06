// robot-animation.ts — pure: which frame-by-frame animation the robot plays,
// and which frame of it to show. No React, no assets, no timers — callers pass
// the time — so the mapping and timing are fully unit-tested
// (robot-animation.test.ts).
//
// Artwork: nine horizontal strips of 256x288 frames (assets/robot/*.webp).
// Timing follows the artist's reference player: frames per second per strip,
// a blink every 4.5 s for idle, and ping-pong playback for the gentle loops
// (waving, review, working, waiting).

export type RobotAnimation =
  | 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping'
  | 'failed' | 'waiting' | 'working' | 'review'

export const FRAME_WIDTH = 256
export const FRAME_HEIGHT = 288

export interface AnimationSpec {
  frames: number
  fps: number
  /** Play forward then back (0 1 2 3 2 1 0 …) instead of wrapping. */
  pingPong: boolean
}

export const ROBOT_ANIMATIONS: Record<RobotAnimation, AnimationSpec> = {
  idle: { frames: 6, fps: 8, pingPong: false },
  'running-right': { frames: 8, fps: 10, pingPong: false },
  'running-left': { frames: 8, fps: 10, pingPong: false },
  waving: { frames: 4, fps: 8, pingPong: true },
  jumping: { frames: 5, fps: 6, pingPong: false },
  failed: { frames: 8, fps: 7, pingPong: false },
  waiting: { frames: 6, fps: 5, pingPong: true },
  working: { frames: 6, fps: 5, pingPong: true },
  review: { frames: 6, fps: 5, pingPong: true },
}

// Idle holds its first frame, then blinks: frames 1–5 over ~0.7 s every 4.5 s.
const IDLE_CYCLE_SECONDS = 4.5
const IDLE_HOLD_SECONDS = 3.8
const IDLE_BLINK_FRAME_SECONDS = 0.1167

/**
 * The frame to show `seconds` after the animation started. Reduced motion:
 * always the first frame (a still robot).
 */
export function frameIndex(animation: RobotAnimation, seconds: number, reducedMotion: boolean): number {
  const spec = ROBOT_ANIMATIONS[animation]
  if (reducedMotion || seconds <= 0) return 0
  if (animation === 'idle') {
    const t = seconds % IDLE_CYCLE_SECONDS
    if (t < IDLE_HOLD_SECONDS) return 0
    return Math.min(spec.frames - 1, Math.floor((t - IDLE_HOLD_SECONDS) / IDLE_BLINK_FRAME_SECONDS))
  }
  const step = Math.floor(seconds * spec.fps)
  if (spec.pingPong) {
    const period = 2 * spec.frames - 2
    const p = step % period
    return p < spec.frames ? p : period - p
  }
  return step % spec.frames
}

// ─── Ongoing state ───────────────────────────────────────────────────────────

export interface RobotSituation {
  /** The robot window is being dragged, and which way it last moved. */
  dragging: boolean
  dragDirection: 'left' | 'right' | null
  /** MyBuildy itself is analysing (a screen analysis, or answering a spoken question). */
  analysing: boolean
  /** A hand-off decision card is open (an unresolved human-judgment moment). */
  handoffOpen: boolean
  /** The coding agent is mid-turn. */
  agentWorking: boolean
  /** A suggested prompt is ready to paste. */
  promptReady: boolean
  /** MyBuildy needs the user: setup unfinished, the watched window was lost,
   *  or the agent is asking a permission question. */
  needsUser: boolean
  /** Watching is paused (the robot rests). */
  paused: boolean
}

/**
 * The animation for what is going on right now. Order matters: being dragged
 * wins, then MyBuildy's own work, then a decision waiting on the user, then the
 * agent working, then a prompt or question for the user, then idle.
 */
export function ongoingAnimation(s: RobotSituation): RobotAnimation {
  if (s.dragging) return s.dragDirection === 'left' ? 'running-left' : 'running-right'
  if (s.paused) return 'idle'
  if (s.analysing) return 'working'
  if (s.handoffOpen) return 'waiting'
  if (s.agentWorking) return 'review'
  if (s.promptReady || s.needsUser) return 'waving'
  return 'idle'
}

// ─── One-off reactions ───────────────────────────────────────────────────────

export type RobotReaction = 'verify-passed' | 'goal-complete' | 'failed'

export interface ReactionPlan {
  animation: RobotAnimation
  /** How many times the strip plays before returning to the ongoing state. */
  repeats: number
  effect: 'sparkles' | 'confetti' | null
}

export const REACTION_PLANS: Record<RobotReaction, ReactionPlan> = {
  'verify-passed': { animation: 'jumping', repeats: 1, effect: 'sparkles' },
  'goal-complete': { animation: 'jumping', repeats: 3, effect: 'confetti' },
  failed: { animation: 'failed', repeats: 1, effect: null },
}

/** How long a reaction plays (whole strips) before the ongoing state returns. */
export function reactionSeconds(reaction: RobotReaction): number {
  const plan = REACTION_PLANS[reaction]
  const spec = ROBOT_ANIMATIONS[plan.animation]
  return (plan.repeats * spec.frames) / spec.fps
}

/**
 * What to show: a reaction while it is still playing (dragging always
 * interrupts it), otherwise the ongoing animation.
 */
export function currentAnimation(
  situation: RobotSituation,
  reaction: { type: RobotReaction; startedAt: number } | null,
  now: number
): { animation: RobotAnimation; startedAt: number | null; effect: ReactionPlan['effect'] } {
  if (reaction && !situation.dragging && now - reaction.startedAt < reactionSeconds(reaction.type) * 1000) {
    const plan = REACTION_PLANS[reaction.type]
    return { animation: plan.animation, startedAt: reaction.startedAt, effect: plan.effect }
  }
  return { animation: ongoingAnimation(situation), startedAt: null, effect: null }
}

// ─── Glow (unchanged colours) ────────────────────────────────────────────────

export const GLOW_COLOURS = {
  idle: '#F59E0B',      // warm orange
  watching: '#10B981',  // green (on track)
  thinking: '#8B5CF6',  // purple
  speaking: '#FFFFFF',  // white
  listening: '#FB7185', // pink
  drift: '#F59E0B',     // amber
  blocked: '#EF4444',   // red
} as const

/** The glow behind the robot: voice first, then MyBuildy thinking, then goal alignment while watching. */
export function robotGlow(g: {
  listening: boolean
  speaking: boolean
  thinking: boolean
  watching: boolean
  alignment: 'on-track' | 'drift' | 'blocked' | null
}): string {
  if (g.listening) return GLOW_COLOURS.listening
  if (g.speaking) return GLOW_COLOURS.speaking
  if (g.thinking) return GLOW_COLOURS.thinking
  if (!g.watching) return GLOW_COLOURS.idle
  if (g.alignment === 'drift') return GLOW_COLOURS.drift
  if (g.alignment === 'blocked') return GLOW_COLOURS.blocked
  return GLOW_COLOURS.watching
}
