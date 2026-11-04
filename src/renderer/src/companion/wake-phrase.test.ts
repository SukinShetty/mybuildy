import { describe, it, expect } from 'vitest'
import { findWakePhrase, routeCommand } from './wake-phrase'

describe('findWakePhrase ("Hey Buildy")', () => {
  it.each([
    ['Hey Buildy, give me the prompt.', 'give me the prompt.'],
    ['Hey Buildy what should I type?', 'what should I type?'],
    ['Hey, Bildy. Why did the tests fail?', 'Why did the tests fail?'],
    ['A building, explain this error.', 'explain this error.'],
    ['Hey Billy, what happened?', 'what happened?'],
    ['Hey Buildy.', ''],
  ])('hears %s', (text, command) => {
    const m = findWakePhrase(text)
    expect(m.heard).toBe(true)
    expect(m.command).toBe(command)
  })
  it.each(['hey buddy good to see you', 'a building fell down in the storm', 'they build houses near the river', 'my buddy is here',
    'I told Buildy to stop', 'hey bill can you send the file', ''])('ignores %s', (text) => expect(findWakePhrase(text).heard).toBe(false))
  it('strict rule (internal fallback) does not accept billy/buddy', () => {
    expect(findWakePhrase('Hey Billy, what happened?', 'strict').heard).toBe(false)
    expect(findWakePhrase('Hey Buildy, what happened?', 'strict').heard).toBe(true)
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
