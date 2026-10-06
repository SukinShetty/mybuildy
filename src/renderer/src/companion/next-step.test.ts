import { describe, it, expect } from 'vitest'
import type { AnalysisResult } from '../types'
import { nextStepLabel, type NextStepInput } from './next-step'

const base: NextStepInput = {
  needsSetup: false, pastedJustNow: false, watchedSourceMessage: null, watchedWindowName: 'Terminal',
  isPaused: false, thinking: false, promptAlreadyPasted: false, analysis: null,
}
const analysis = (over: Partial<AnalysisResult>): AnalysisResult => ({
  screenContentVisible: true, whatIsHappening: '', whatItMeans: '', whatIsBuilt: [], whatIsMissing: [], whatIsBroken: [],
  whereUserIsStuck: null, bestNextMove: '', nextPrompt: '', builderNote: '', agentName: 'claude_code',
  analyzedAt: '2026-01-01T00:00:00Z', analysisDurationMs: 1, ...over,
})

describe('the line under the robot always says what to do next', () => {
  it('before a window is shown', () => {
    expect(nextStepLabel({ ...base, watchedWindowName: null })).toBe("Next: show me your coding agent's window")
  })
  it('setup unfinished', () => {
    expect(nextStepLabel({ ...base, needsSetup: true })).toMatch(/^Next: finish setting me up/)
  })
  it('the agent is working', () => {
    expect(nextStepLabel({ ...base, analysis: analysis({ terminalState: 'working' }) })).toBe('Waiting for Claude Code to finish')
  })
  it('a prompt is ready', () => {
    expect(nextStepLabel({ ...base, analysis: analysis({ nextPrompt: 'Add a login page', terminalState: 'awaiting_prompt' }) }))
      .toBe('Your prompt is ready — click Paste into terminal')
  })
  it('just pasted: press Enter yourself', () => {
    expect(nextStepLabel({ ...base, pastedJustNow: true })).toBe('Pasted — now press Enter in your terminal')
  })
  it('a hand-off, a permission question, a pause, a message from MyBuildy', () => {
    expect(nextStepLabel({ ...base, analysis: analysis({ needsHumanJudgment: true }) })).toBe('Next: answer the question in the panel')
    expect(nextStepLabel({ ...base, analysis: analysis({ terminalState: 'permission_prompt', agentName: 'other' }) }))
      .toBe('Your coding agent is asking you something — answer it in the terminal')
    expect(nextStepLabel({ ...base, isPaused: true })).toBe('Paused — click Resume to keep watching')
    expect(nextStepLabel({ ...base, watchedSourceMessage: 'Project switched — show MyBuildy your coding agent.' }))
      .toBe('Project switched — show MyBuildy your coding agent.')
  })
  it('while an analysis runs (started on the robot or in the Guidance tab), even with Auto off', () => {
    expect(nextStepLabel({ ...base, thinking: true })).toBe('Thinking about what just happened…')
    expect(nextStepLabel({ ...base, thinking: true, isPaused: true })).toBe('Thinking about what just happened…')
    expect(nextStepLabel({ ...base, thinking: true, watchedSourceMessage: 'The watched window is hidden.' }))
      .toBe('Thinking about what just happened…')
  })
  it('never a step already done: a pasted prompt is not offered again', () => {
    const ready = analysis({ nextPrompt: 'Add a login page', terminalState: 'awaiting_prompt' })
    expect(nextStepLabel({ ...base, analysis: ready, promptAlreadyPasted: true })).toBe('Waiting for Claude Code to finish')
    expect(nextStepLabel({ ...base, analysis: ready, promptAlreadyPasted: true, isPaused: true }))
      .toBe('Paused — click Resume to keep watching')
  })
  it('Auto off after Analyze Now: the result still says what to do', () => {
    const ready = analysis({ nextPrompt: 'Add a login page', terminalState: 'awaiting_prompt' })
    expect(nextStepLabel({ ...base, isPaused: true, analysis: ready })).toBe('Your prompt is ready — click Paste into terminal')
    expect(nextStepLabel({ ...base, isPaused: true, analysis: analysis({ needsHumanJudgment: true }) }))
      .toBe('Next: answer the question in the panel')
  })
})
