import { describe, it, expect } from 'vitest'
import { BUILDY_VOICES, DEFAULT_BUILDY_VOICE, defaultNonSecretSettings } from './types'

describe("Buildy's own voices as users see them", () => {
  it('are only ever "Female voice" and "Male voice", never the voice or model names', () => {
    expect(BUILDY_VOICES.map((v) => v.label)).toEqual(['Female voice', 'Male voice'])
    for (const v of BUILDY_VOICES) {
      expect(`${v.name} ${v.label}`).not.toMatch(/bella|puck|kokoro/i)
    }
  })

  it('the female voice stays the default', () => {
    expect(DEFAULT_BUILDY_VOICE).toBe('bella')
    expect(defaultNonSecretSettings().buildyVoice).toBe('bella')
    expect(BUILDY_VOICES.find((v) => v.id === DEFAULT_BUILDY_VOICE)?.label).toBe('Female voice')
  })
})
