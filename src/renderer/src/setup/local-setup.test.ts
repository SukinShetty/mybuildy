// "Use a local model instead" in first-run setup: what the user is told in each
// state of their local server. Plain words, provider names only — never a model
// or voice name.
import { describe, it, expect } from 'vitest'
import { LOCAL_SETUP_PROVIDERS, localServerGuidance, localModelGuidance, LOCAL_CHECKING_NOTE } from './setup-model'
import type { LocalServerStatus } from '../types'

const status = (over: Partial<LocalServerStatus>): LocalServerStatus => ({ provider: 'ollama', running: true, baseUrl: '', models: [], ...over })

describe('local servers offered', () => {
  it('Ollama and LM Studio, each with where to get it', () => {
    expect(LOCAL_SETUP_PROVIDERS.map((p) => [p.id, p.label, p.site])).toEqual([
      ['ollama', 'Ollama', 'https://ollama.com'],
      ['lmstudio', 'LM Studio', 'https://lmstudio.ai'],
    ])
  })
})

describe('localServerGuidance', () => {
  it('Ollama not running: install or open it, then Check again', () => {
    expect(localServerGuidance(status({ running: false }))).toBe(
      "Ollama isn't running on this computer. Install it from ollama.com, or open it if it's installed, then click Check again."
    )
  })
  it('LM Studio not running: start its local server, then Check again', () => {
    expect(localServerGuidance(status({ provider: 'lmstudio', running: false }))).toBe(
      "LM Studio's local server isn't running. Install LM Studio from lmstudio.ai, or open it, start its local server, then click Check again."
    )
  })
  it('running: nothing to fix', () => {
    expect(localServerGuidance(status({}))).toBeNull()
  })
})

describe('localModelGuidance', () => {
  it('no models at all: download one that can read images', () => {
    expect(localModelGuidance(status({}))).toEqual({
      tone: 'problem',
      message: 'Ollama is running, but has no models yet. In Ollama, download a model that can read images (a vision model), then click Check again.',
    })
  })
  it('models, but none can read images: say so, and how to fix it', () => {
    expect(localModelGuidance(status({ provider: 'lmstudio', models: [{ id: 'a', label: 'a', vision: 'no' }] }))).toEqual({
      tone: 'problem',
      message: "None of your LM Studio models can read images, and MyBuildy needs one to see your screen. In LM Studio, download a model that can read images (a vision model), then click Check again. You can still try one below.",
    })
  })
  it("can't tell which can read images: pick one, MyBuildy checks it", () => {
    expect(localModelGuidance(status({ models: [{ id: 'a', label: 'a', vision: 'unknown' }, { id: 'b', label: 'b', vision: 'no' }] }))).toEqual({
      tone: 'info',
      message: "MyBuildy can't tell which of these models can read images. Pick one, and MyBuildy checks that it can see your screen.",
    })
  })
  it('at least one can read images: no warning', () => {
    expect(localModelGuidance(status({ models: [{ id: 'a', label: 'a', vision: 'yes' }, { id: 'b', label: 'b', vision: 'no' }] }))).toBeNull()
  })
  it('not running: the server guidance applies, not this', () => {
    expect(localModelGuidance(status({ running: false }))).toBeNull()
  })
})

it('a local model can take a while the first time: the checking note says so', () => {
  expect(LOCAL_CHECKING_NOTE).toBe('Checking that this model can see your screen… A model on your computer can take a minute to start the first time.')
})

it('no message names a model', () => {
  const all = [
    localServerGuidance(status({ running: false })), localServerGuidance(status({ provider: 'lmstudio', running: false })),
    localModelGuidance(status({}))?.message, localModelGuidance(status({ models: [{ id: 'x', label: 'x', vision: 'no' }] }))?.message,
    LOCAL_CHECKING_NOTE,
  ].join(' ')
  expect(all).not.toMatch(/llava|llama|qwen|gemma|mistral|moondream|minicpm|pixtral|phi/i)
})
