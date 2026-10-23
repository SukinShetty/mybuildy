import { describe, it, expect } from 'vitest'
import { findWakePhrase, routeCommand } from './wake-phrase'

describe('findWakePhrase', () => {
  it.each([
    ['MyBuildy give me the prompt', 'give me the prompt'],
    ['Hey MyBuildy, what should I type?', 'what should I type?'],
    ['My buildy, give me the prompt.', 'give me the prompt.'],
    ['My building, give me the prompt.', 'give me the prompt.'],
    ['Mybuild, show me the prompt', 'show me the prompt'],
  ])('hears %s', (text, command) => {
    const m = findWakePhrase(text)
    expect(m.heard).toBe(true)
    expect(m.command).toBe(command)
  })
  it.each(['my buddy is here', 'my body hurts', 'my baby is asleep', 'I will build it', 'my bill is due', 'maybe later', ''])(
    'ignores %s', (text) => expect(findWakePhrase(text).heard).toBe(false))
  it('"my building" counts only with a pause or a request after it', () => {
    expect(findWakePhrase('My building has a new lift').heard).toBe(false)
    expect(findWakePhrase('my building is on fire').heard).toBe(false)
    expect(findWakePhrase('My building, why did the tests fail?').heard).toBe(true)
    expect(findWakePhrase('My building what should I type').heard).toBe(true)
    expect(findWakePhrase('My building.').heard).toBe(true)
  })
  it('only at the start (after an optional "hey")', () => {
    expect(findWakePhrase('I told MyBuildy to stop').heard).toBe(false)
  })
})

describe('routeCommand', () => {
  it('maps prompt requests to the next-prompt action', () => {
    for (const t of ['give me the prompt', 'what should I type', 'next prompt', 'show me the prompt please']) {
      expect(routeCommand(t).kind).toBe('suggest-prompt')
    }
  })
  it('anything else is a question', () => {
    expect(routeCommand('why did the build fail')).toEqual({ kind: 'ask', question: 'why did the build fail' })
    expect(routeCommand('  ').kind).toBe('none')
  })
})
