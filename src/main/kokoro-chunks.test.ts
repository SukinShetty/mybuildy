import { describe, it, expect } from 'vitest'
import { splitIntoSentences } from './kokoro-chunks'
import { splitIntoChunks } from './voice-queue'

describe("Buildy's own voice speaks one sentence per chunk", () => {
  it('splits sentences; a very short one joins the next so it does not sound clipped', () => {
    expect(splitIntoSentences('Claude Code just finished building your invoice page. Two tests passed. Your next prompt is ready to paste.'))
      .toEqual(['Claude Code just finished building your invoice page.', 'Two tests passed. Your next prompt is ready to paste.'])
    expect(splitIntoSentences('Nice work! The login page is done and the tests pass.')).toEqual(['Nice work! The login page is done and the tests pass.'])
    expect(splitIntoSentences('The login page is done and the tests pass. Nice.')).toEqual(['The login page is done and the tests pass. Nice.'])
  })
  it('a sentence longer than 250 characters is still split at a word boundary, as the queue does', () => {
    const long = `${'word '.repeat(70).trim()}.`
    expect(splitIntoSentences(long)).toEqual(splitIntoChunks(long))
    for (const c of splitIntoSentences(long)) expect(c.length).toBeLessThanOrEqual(250)
  })
  it('the same words as the queue’s own chunking, nothing lost or added', () => {
    const text = 'First, open the terminal. Then run npm test! Did it pass? If so, paste the next prompt'
    expect(splitIntoSentences(text).join(' ')).toBe(splitIntoChunks(text).join(' '))
    expect(splitIntoSentences('')).toEqual([])
  })
})
