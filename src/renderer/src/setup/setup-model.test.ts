import { describe, it, expect } from 'vitest'
import {
  setupSteps, progressLabel, resumeStep, nextStep, previousStep, READY_GOALS, KEY_PROVIDERS, ADVANCED_KEY_PROVIDERS,
  doneWhenText, agentInstructions, OWN_GOAL_EXAMPLE,
} from './setup-model'

describe('setup steps', () => {
  it('Windows: 7 steps, no macOS permission steps', () => {
    const steps = setupSteps('win32')
    expect(steps).toEqual(['welcome', 'key', 'model', 'goal', 'agent', 'window', 'done'])
    expect(progressLabel(steps, 'key')).toBe('Step 2 of 7')
  })
  it('Mac: the screen and paste steps come after the model', () => {
    const steps = setupSteps('darwin')
    expect(steps).toEqual(['welcome', 'key', 'model', 'screen', 'paste', 'goal', 'agent', 'window', 'done'])
    expect(progressLabel(steps, 'screen')).toBe('Step 4 of 9')
  })
  it('resumes at the saved step; a step that does not exist here starts from the beginning', () => {
    expect(resumeStep(setupSteps('darwin'), 'screen')).toBe('screen')
    expect(resumeStep(setupSteps('win32'), 'screen')).toBe('welcome')
    expect(resumeStep(setupSteps('win32'), null)).toBe('welcome')
  })
  it('Next and Back stay within the steps', () => {
    const steps = setupSteps('win32')
    expect(nextStep(steps, 'model')).toBe('goal')
    expect(nextStep(steps, 'done')).toBe('done')
    expect(previousStep(steps, 'welcome')).toBe('welcome')
    expect(previousStep(steps, 'goal')).toBe('model')
  })
})

describe('ready-made goals', () => {
  it('four goals, each with what to build and a checkable "Done when" line', () => {
    expect(READY_GOALS.map((g) => g.title)).toEqual([
      'A personal habit tracker web page',
      'A simple portfolio page about me',
      'A to-do list that remembers my tasks',
      'A small expense tracker',
    ])
    for (const g of READY_GOALS) {
      expect(g.purpose.length).toBeGreaterThan(20)
      expect(doneWhenText(g.doneWhen)).toMatch(/^Done when [A-Za-z]/)
    }
    expect(OWN_GOAL_EXAMPLE.purpose).toBeTruthy()
  })
})

describe('keys and commands', () => {
  it('every provider has a "Where do I get a key?" link', () => {
    expect(KEY_PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'openrouter'])
    expect(ADVANCED_KEY_PROVIDERS.map((p) => [p.id, p.notYetTested])).toEqual([['gemini', true]])
    for (const p of [...KEY_PROVIDERS, ...ADVANCED_KEY_PROVIDERS]) expect(p.keyUrl).toMatch(/^https:\/\//)
  })
  it('Mac uses Terminal; Windows uses PowerShell (no &&, which Windows PowerShell 5.1 rejects)', () => {
    const mac = agentInstructions('darwin')
    const win = agentInstructions('win32')
    expect(mac.terminal).toBe('Terminal')
    expect(win.terminal).toBe('PowerShell')
    expect(win.commands.map((c) => c.command).join(' ')).not.toContain('&&')
    for (const i of [mac, win]) expect(i.commands.at(-1)!.command).toBe('claude')
  })
})
