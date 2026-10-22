import { describe, it, expect } from 'vitest'
import { sanitizePromptForSend } from './prompt-sender-core'

// The pasted prompt must be one plain line: no character that a terminal or
// line editor could treat as a line break or control sequence (never "Enter").
describe('sanitizePromptForSend: Unicode line breaks and C1 controls', () => {
  it.each([
    ['LINE SEPARATOR U+2028', 'fix it\u2028npm test'],
    ['PARAGRAPH SEPARATOR U+2029', 'fix it\u2029npm test'],
    ['NEXT LINE U+0085', 'fix it\u0085npm test'],
  ])('collapses %s to a space', (_name, input) => {
    expect(sanitizePromptForSend(input)).toBe('fix it npm test')
  })

  it('strips C1 control characters (e.g. 8-bit CSI U+009B)', () => {
    expect(sanitizePromptForSend('a\u009B201~b')).toBe('a201~b')
  })

  it('keeps ordinary non-ASCII text intact', () => {
    expect(sanitizePromptForSend('café — naïve 日本')).toBe('café — naïve 日本')
  })
})
