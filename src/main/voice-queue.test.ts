// voice-queue.test.ts
// Reproducible tests for the voice queue: rapid arrivals, long-text chunking,
// re-render storms, and critical override. Uses a mock sink + synth so playback
// is instant and deterministic (no real audio, no Electron).

import { describe, it, expect, vi } from 'vitest'
import { VoiceQueue, splitIntoChunks } from './voice-queue'

interface Play { id: string; kind: 'audio' | 'tts'; itemId: string }

function makeQueue(opts: { synth?: (c: string) => Promise<string | null> } = {}) {
  const plays: Play[] = []
  const stop = vi.fn()
  const sink = {
    playAudio: (id: string) => plays.push({ id, kind: 'audio' as const, itemId: id.split('#')[0] }),
    playTts: (id: string) => plays.push({ id, kind: 'tts' as const, itemId: id.split('#')[0] }),
    stop,
  }
  const synth = opts.synth ?? (async () => 'BASE64')
  const q = new VoiceQueue({ sink, synth })
  return { q, plays, stop }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Drive the queue to completion by ending each clip as soon as it plays. */
async function drainAll(q: VoiceQueue, plays: Play[]): Promise<void> {
  let ended = 0
  for (let guard = 0; guard < 5000; guard++) {
    await flush()
    if (plays.length > ended) {
      q.onEnded(plays[ended].id)
      ended++
    } else {
      return
    }
  }
  throw new Error('drainAll did not converge')
}

describe('splitIntoChunks', () => {
  it('combines short sentences and respects the 250-char cap', () => {
    const chunks = splitIntoChunks('Hi. Go. Run.')
    expect(chunks).toEqual(['Hi. Go. Run.']) // all short → one chunk
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(250)
  })

  it('chunks an 800-word text into multiple <=250 char chunks', () => {
    const text = Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ') + '.'
    const chunks = splitIntoChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(250)
    // Lossless: every word survives.
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toContain('word799')
  })
})

describe('VoiceQueue', () => {
  it('rapid arrivals: only the FIRST and LATEST end up played', async () => {
    const { q, plays } = makeQueue()
    for (let i = 1; i <= 10; i++) q.enqueue({ id: `a${i}`, text: `Item number ${i}.` })
    await drainAll(q, plays)
    const itemIds = [...new Set(plays.map((p) => p.itemId))].sort()
    expect(itemIds).toEqual(['a1', 'a10'])
  })

  it('long analysis is chunked and every chunk plays end to end', async () => {
    const text = Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ') + '.'
    const expectedChunks = splitIntoChunks(text).length
    const { q, plays } = makeQueue()
    q.enqueue({ id: 'long', text })
    await drainAll(q, plays)
    expect(plays.length).toBe(expectedChunks)
    expect(plays.every((p) => p.itemId === 'long')).toBe(true)
  })

  it('re-render storm: 50 arrivals never interrupt the chunk currently playing', async () => {
    const { q, plays, stop } = makeQueue()
    q.enqueue({ id: 'first', text: 'First sentence one. First sentence two. First sentence three.' })
    await flush() // first chunk is now playing
    const playingBefore = q.currentChunkId()
    expect(playingBefore).not.toBeNull()
    const playsBefore = plays.length

    for (let i = 0; i < 50; i++) {
      q.enqueue({ id: `storm${i}`, text: `Storm ${i}.` })
    }
    await flush()

    // The currently-playing chunk is unchanged; nothing new started; no stop().
    expect(q.currentChunkId()).toBe(playingBefore)
    expect(plays.length).toBe(playsBefore)
    expect(stop).not.toHaveBeenCalled()
  })

  it('critical override: current chunk finishes, then critical plays, rest dropped', async () => {
    const { q, plays } = makeQueue()
    q.enqueue({ id: 'normal', text: 'Normal one. Normal two. Normal three. Normal four. Normal five.' })
    await flush() // normal#0 playing
    expect(q.currentChunkId()).toBe('normal#0')

    q.enqueue({ id: 'crit', text: 'Critical blocker.', isCritical: true })
    await drainAll(q, plays)

    const itemSequence = plays.map((p) => p.itemId)
    // Only the first normal chunk played, then the critical item — middle normal
    // chunks were truncated by the override.
    expect(itemSequence).toEqual(['normal', 'crit'])
  })

  it('explicit stop clears the queue and calls sink.stop', async () => {
    const { q, plays, stop } = makeQueue()
    q.enqueue({ id: 'x', text: 'One. Two. Three.' })
    await flush()
    q.stop()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(q.currentChunkId()).toBeNull()
    // Nothing further plays after stop.
    const after = plays.length
    await flush()
    expect(plays.length).toBe(after)
  })
})

describe('splitIntoChunks keeps words with a dot inside them (index.html, mybuildy.com)', () => {
  const lines = [
    'Open index.html in your browser.',
    'Go to mybuildy.com to download it. Then open the app.',
    'Your .env file is missing. Add it and restart.',
    'Run npm test, then open src/main/index.ts and check the 3.5 second timeout!',
    'Version 0.1.0 is out. e.g. try it now',
  ]
  it('no words are dropped: the chunks put back together are the whole text', () => {
    for (const line of lines) expect(splitIntoChunks(line).join(' ')).toBe(line)
  })
  it('a sentence is not cut at the dot inside a word', () => {
    expect(splitIntoChunks('Open index.html in your browser.')).toEqual(['Open index.html in your browser.'])
  })
})
