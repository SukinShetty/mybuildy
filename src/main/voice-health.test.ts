import { describe, it, expect } from 'vitest'
import { classifyElevenLabsFailure, VoiceHealth, VOICE_FAILURE_REASONS } from './voice-health'
import { pickBackupVoice } from '../renderer/src/voice/backup-voice'

describe('why ElevenLabs did not speak, in plain English', () => {
  it('reads the reason ElevenLabs gives', () => {
    expect(classifyElevenLabsFailure(401, '{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}')).toBe('quota')
    expect(classifyElevenLabsFailure(401, '{"detail":{"status":"detected_unusual_activity"}}')).toBe('unusual-activity')
    expect(classifyElevenLabsFailure(401, '{"detail":{"status":"missing_permissions","message":"missing text_to_speech"}}')).toBe('missing-permission')
    expect(classifyElevenLabsFailure(401, '{"detail":{"status":"invalid_api_key"}}')).toBe('invalid-key')
    expect(classifyElevenLabsFailure(404, '{"detail":{"status":"voice_not_found"}}')).toBe('voice-not-found')
  })
  it('falls back to the HTTP status, and no answer at all is the network', () => {
    expect(classifyElevenLabsFailure(401, '')).toBe('invalid-key')
    expect(classifyElevenLabsFailure(402, '')).toBe('paid-plan')
    expect(classifyElevenLabsFailure(429, '')).toBe('rate-limit')
    expect(classifyElevenLabsFailure(503, 'Service Unavailable')).toBe('server')
    expect(classifyElevenLabsFailure(null, '')).toBe('network')
    expect(classifyElevenLabsFailure(400, 'odd')).toBe('other')
  })
  it('every reason is a plain sentence', () => {
    for (const reason of Object.values(VOICE_FAILURE_REASONS)) expect(reason).toMatch(/^[A-Z].*\.$/)
    expect(VOICE_FAILURE_REASONS.quota).toBe('Your ElevenLabs credits for this month are used up.')
  })
})

describe('the computer-voice notice: shown on a failure, once, and cleared when ElevenLabs works', () => {
  it('raises, does not repeat, changes with the reason, and clears', () => {
    const health = new VoiceHealth()
    expect(health.ok()).toBeUndefined() // nothing to clear
    expect(health.failed('quota')).toEqual({ code: 'quota', reason: VOICE_FAILURE_REASONS.quota })
    expect(health.failed('quota')).toBeUndefined() // same reason: not raised again per sentence
    expect(health.failed('network')?.code).toBe('network')
    expect(health.current()?.code).toBe('network')
    expect(health.ok()).toBeNull() // cleared
    expect(health.current()).toBeNull()
  })
})

describe("the computer's own voice: the most natural female voice, never Microsoft David", () => {
  const windows = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Mark - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  ]
  it('Windows: Zira, not David (the default) or Mark', () => {
    expect(pickBackupVoice(windows)?.name).toBe('Microsoft Zira - English (United States)')
  })
  it('a natural (neural) voice beats a standard one', () => {
    expect(pickBackupVoice([...windows, { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' }])?.name)
      .toMatch(/^Microsoft Aria Online \(Natural\)/)
  })
  it('macOS: Samantha, or an enhanced voice when installed', () => {
    const mac = [{ name: 'Alex', lang: 'en-US' }, { name: 'Daniel', lang: 'en-GB' }, { name: 'Samantha', lang: 'en-US' }]
    expect(pickBackupVoice(mac)?.name).toBe('Samantha')
    expect(pickBackupVoice([...mac, { name: 'Ava (Premium)', lang: 'en-US' }])?.name).toBe('Ava (Premium)')
  })
  it('an unknown non-male voice beats David; David only when he is the only voice', () => {
    expect(pickBackupVoice([{ name: 'Microsoft David - English (United States)', lang: 'en-US' }, { name: 'Microsoft Hortense - French (France)', lang: 'fr-FR' }])?.name)
      .toMatch(/Hortense/)
    expect(pickBackupVoice([{ name: 'Microsoft David - English (United States)', lang: 'en-US' }])?.name).toMatch(/David/)
    expect(pickBackupVoice([])).toBeNull()
  })
})
