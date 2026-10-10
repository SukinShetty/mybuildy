import { describe, expect, it } from 'vitest'
import type { ModelListDiagnostic } from '../types'
import { modelListFailureMessage, modelListDiagnosticText } from './model-list-recovery'

describe('model-list failure guidance', () => {
  it('does not recommend a nonexistent next model or display untrusted text', () => {
    for (const message of ["This model didn't accept MyBuildy's request. Try the next recommended model.", 'private-token-should-not-appear']) {
      expect(modelListFailureMessage(message)).toContain('Retry')
      expect(modelListFailureMessage(message)).not.toContain('next recommended')
      expect(modelListFailureMessage(message)).not.toContain('private-token')
    }
  })
  it.each([
    'Your API key was rejected. Check it in Settings, or paste a new one.',
    'Your provider asked MyBuildy to slow down. Wait a minute and try again.',
    "Can't reach your AI provider. Check your internet connection and try again.",
    'Your AI provider took too long to answer, so MyBuildy stopped waiting. Try again in a moment.',
  ])('keeps the safe actionable explanation: %s', (message) => {
    expect(modelListFailureMessage(message)).toBe('Could not load your model list. ' + message)
  })
  it('shows fixed stage and validated status only', () => {
    expect(modelListDiagnosticText({ stage: 'model-list', status: 400, kind: 'bad-request' })).toBe('Model list · HTTP 400 · bad-request')
    expect(modelListDiagnosticText({ stage: 'model-list', status: 12345, kind: 'private-value' } as unknown as ModelListDiagnostic)).toBe('Model list · HTTP status unavailable · unknown')
    expect(modelListDiagnosticText(undefined)).toBeNull()
  })
})
