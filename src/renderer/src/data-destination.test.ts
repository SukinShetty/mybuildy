import { describe, it, expect } from 'vitest'
import { dataDestinationNote, UPDATE_CHECK_NOTE } from './types'

const ELEVEN = 'Spoken guidance and voice questions are sent to ElevenLabs.'

describe('Settings privacy wording is always true', () => {
  it('a remote custom endpoint is never described as local', () => {
    const note = dataDestinationNote({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', hasElevenLabsKey: false })
    expect(note).toBe('Screenshots and prompts are sent to llm.example.com.')
    expect(note).not.toMatch(/never leaves|stays? (on|here)|local/i)
  })

  it('a custom endpoint on this computer is local', () => {
    for (const baseUrl of ['http://localhost:8080/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
      expect(dataDestinationNote({ provider: 'custom', baseUrl, hasElevenLabsKey: false })).toMatch(/stay on this computer/)
    }
  })

  it('local providers say local, and add ElevenLabs when a voice key is saved', () => {
    expect(dataDestinationNote({ provider: 'ollama', baseUrl: '', hasElevenLabsKey: false })).not.toContain('ElevenLabs')
    const withVoice = dataDestinationNote({ provider: 'lmstudio', baseUrl: '', hasElevenLabsKey: true })
    expect(withVoice).toMatch(/stay on this computer/)
    expect(withVoice).toContain(ELEVEN)
    expect(dataDestinationNote({ provider: 'custom', baseUrl: 'http://localhost:8080/v1', hasElevenLabsKey: true })).toContain(ELEVEN)
  })

  it('cloud providers name where data goes and describe keys accurately', () => {
    const note = dataDestinationNote({ provider: 'anthropic', baseUrl: '', hasElevenLabsKey: false })
    expect(note).toContain('Screenshots and prompts are sent to Anthropic.')
    expect(note).toContain('never sent back to this screen')
    expect(note).not.toMatch(/never exposed|never enter/i)
  })
})

describe('the update check is disclosed truthfully', () => {
  it('names GitHub, says once on open, and that nothing downloads without a click', () => {
    expect(UPDATE_CHECK_NOTE).toMatch(/GitHub/)
    expect(UPDATE_CHECK_NOTE).toMatch(/once/)
    expect(UPDATE_CHECK_NOTE).toMatch(/click Update/)
  })
})
