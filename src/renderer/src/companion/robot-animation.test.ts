import { describe, it, expect } from 'vitest'
import {
  ROBOT_ANIMATIONS, frameIndex, ongoingAnimation, currentAnimation, reactionSeconds, REACTION_PLANS, robotGlow,
  type RobotSituation, type RobotAnimation,
} from './robot-animation'

const calm: RobotSituation = {
  dragging: false, dragDirection: null, analysing: false, handoffOpen: false,
  agentWorking: false, promptReady: false, needsUser: false, paused: false,
}
const at = (over: Partial<RobotSituation>): RobotSituation => ({ ...calm, ...over })

describe('artwork specs (from the reference player)', () => {
  it('has the nine strips with the right frame counts', () => {
    expect(Object.fromEntries(Object.entries(ROBOT_ANIMATIONS).map(([k, v]) => [k, v.frames]))).toEqual({
      idle: 6, 'running-right': 8, 'running-left': 8, waving: 4, jumping: 5, failed: 8, waiting: 6, working: 6, review: 6,
    })
  })

  it('ping-pongs exactly waving, review, working and waiting', () => {
    const pp = (Object.keys(ROBOT_ANIMATIONS) as RobotAnimation[]).filter((k) => ROBOT_ANIMATIONS[k].pingPong).sort()
    expect(pp).toEqual(['review', 'waiting', 'waving', 'working'])
  })
})

describe('frameIndex', () => {
  it('idle holds the first frame, then blinks through frames 1-5, every 4.5 s', () => {
    expect(frameIndex('idle', 1, false)).toBe(0)
    expect(frameIndex('idle', 3.7, false)).toBe(0)
    expect(frameIndex('idle', 3.8 + 0.12, false)).toBe(1)
    expect(frameIndex('idle', 4.45, false)).toBe(5)
    expect(frameIndex('idle', 4.5 + 1, false)).toBe(0) // next cycle holds again
  })

  it('ping-pong strips go forward then back without repeating the ends', () => {
    // waving: 4 frames at 8 fps → 0 1 2 3 2 1 0 1 …
    const seq = Array.from({ length: 8 }, (_, i) => frameIndex('waving', (i + 0.5) / 8, false))
    expect(seq).toEqual([0, 1, 2, 3, 2, 1, 0, 1])
  })

  it('looping strips wrap around', () => {
    // running: 8 frames at 10 fps
    expect(frameIndex('running-right', 0.75, false)).toBe(7)
    expect(frameIndex('running-right', 0.85, false)).toBe(0)
  })

  it('reduced motion always shows the first frame', () => {
    for (const name of Object.keys(ROBOT_ANIMATIONS) as RobotAnimation[]) {
      for (const t of [0.3, 1.7, 4.2]) expect(frameIndex(name, t, true)).toBe(0)
    }
  })
})

describe('ongoingAnimation: MyBuildy events → robot state', () => {
  it('nothing happening → idle', () => expect(ongoingAnimation(calm)).toBe('idle'))
  it('the coding agent is working → review', () => expect(ongoingAnimation(at({ agentWorking: true }))).toBe('review'))
  it('MyBuildy is analysing → working', () => expect(ongoingAnimation(at({ analysing: true, agentWorking: true }))).toBe('working'))
  it('a prompt is ready to paste → waving', () => expect(ongoingAnimation(at({ promptReady: true }))).toBe('waving'))
  it('MyBuildy needs the user → waving', () => expect(ongoingAnimation(at({ needsUser: true }))).toBe('waving'))
  it('a hand-off decision card is open → waiting', () =>
    expect(ongoingAnimation(at({ handoffOpen: true, promptReady: true, agentWorking: true }))).toBe('waiting'))
  it('dragging runs in the direction of the drag, over everything else', () => {
    expect(ongoingAnimation(at({ dragging: true, dragDirection: 'left', analysing: true }))).toBe('running-left')
    expect(ongoingAnimation(at({ dragging: true, dragDirection: 'right', handoffOpen: true }))).toBe('running-right')
    expect(ongoingAnimation(at({ dragging: true, dragDirection: null }))).toBe('running-right')
  })
  it('paused → idle', () => expect(ongoingAnimation(at({ paused: true, promptReady: true }))).toBe('idle'))
})

describe('reactions', () => {
  it('Verifier pass → one jump with sparkles; goal complete → three jumps with confetti; failure → failed', () => {
    expect(REACTION_PLANS['verify-passed']).toEqual({ animation: 'jumping', repeats: 1, effect: 'sparkles' })
    expect(REACTION_PLANS['goal-complete']).toEqual({ animation: 'jumping', repeats: 3, effect: 'confetti' })
    expect(REACTION_PLANS.failed).toEqual({ animation: 'failed', repeats: 1, effect: null })
    expect(reactionSeconds('goal-complete')).toBeCloseTo(3 * reactionSeconds('verify-passed'))
  })

  it('plays the reaction, then returns to the right ongoing state', () => {
    const working = at({ agentWorking: true })
    const r = { type: 'failed' as const, startedAt: 1000 }
    expect(currentAnimation(working, r, 1500).animation).toBe('failed')
    const after = 1000 + reactionSeconds('failed') * 1000 + 1
    expect(currentAnimation(working, r, after)).toEqual({ animation: 'review', startedAt: null, effect: null })
  })

  it('a drag interrupts a reaction', () => {
    const r = { type: 'goal-complete' as const, startedAt: 0 }
    expect(currentAnimation(at({ dragging: true, dragDirection: 'left' }), r, 100).animation).toBe('running-left')
  })
})

describe('robotGlow keeps the existing colours', () => {
  const base = { listening: false, speaking: false, thinking: false, watching: true, alignment: null }
  it('maps each situation to its colour', () => {
    expect(robotGlow({ ...base, watching: false })).toBe('#F59E0B')
    expect(robotGlow(base)).toBe('#10B981')
    expect(robotGlow({ ...base, alignment: 'drift' })).toBe('#F59E0B')
    expect(robotGlow({ ...base, alignment: 'blocked' })).toBe('#EF4444')
    expect(robotGlow({ ...base, thinking: true, alignment: 'blocked' })).toBe('#8B5CF6')
    expect(robotGlow({ ...base, speaking: true })).toBe('#FFFFFF')
    expect(robotGlow({ ...base, listening: true, speaking: true })).toBe('#FB7185')
  })
})
