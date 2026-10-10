import { describe, it, expect } from 'vitest'
import { PASTE_BUTTON_LABEL, PASTE_SUCCESS_MESSAGE, pasteFailureMessage } from './types'

describe('paste wording', () => {
  it('the button says it pastes, and success tells the user to press Enter themselves', () => {
    expect(PASTE_BUTTON_LABEL).toBe('Paste into terminal')
    expect(PASTE_SUCCESS_MESSAGE).toBe('Pasted into your terminal. Read it, then press Enter to run it.')
  })

  it('an aborted paste says what changed and that nothing was pasted', () => {
    expect(pasteFailureMessage({ sent: false, reason: 'stale', detail: 'The project changed before the prompt could be pasted.' }, false))
      .toBe('The project changed before the prompt could be pasted. Nothing was pasted.')
    expect(pasteFailureMessage({ sent: false, reason: 'stale' }, false))
      .toBe('The prompt changed before it could be pasted. Nothing was pasted.')
  })

  it('a terminal that lost the foreground at the last moment is explained, with the right paste key', () => {
    expect(pasteFailureMessage({ sent: false, reason: 'window_not_in_front' }, false)).toBe(
      "Your terminal wasn't in front at the last moment, so nothing was pasted. The prompt is on your clipboard: press Ctrl+V in your terminal, read it, then press Enter."
    )
    expect(pasteFailureMessage({ sent: false, reason: 'window_not_in_front' }, true)).toContain('press Cmd+V')
  })

  it('the picked window closed, or is no longer the same window: says so, nothing was pasted, prompt on the clipboard', () => {
    expect(pasteFailureMessage({ sent: false, reason: 'window_gone' }, false)).toBe(
      'The window you picked has closed, so nothing was pasted. Pick your terminal again. The prompt is on your clipboard: press Ctrl+V in your terminal, read it, then press Enter.'
    )
    expect(pasteFailureMessage({ sent: false, reason: 'window_changed' }, false)).toBe(
      "MyBuildy couldn't confirm this is the window you picked, so nothing was pasted. Pick your terminal again. The prompt is on your clipboard: press Ctrl+V in your terminal, read it, then press Enter."
    )
    expect(pasteFailureMessage({ sent: false, reason: 'window_gone' }, true)).toContain('press Cmd+V')
  })

  it('never tells the user the app will press Enter for them', () => {
    for (const reason of ['stale', 'not_eligible', 'window_not_in_front', 'window_gone', 'window_changed', 'timeout', 'unknown'] as const) {
      const text = pasteFailureMessage({ sent: false, reason }, false)
      expect(text).not.toMatch(/Ctrl\+V then Enter|and press Enter for you|sends? it for you/i)
    }
  })
})
