// kokoro-chunks.ts — ELECTRON-FREE, unit-tested. How Buildy's own voice
// (Kokoro) splits text: one sentence per chunk, so the first words start as
// soon as the first sentence is made instead of after a whole paragraph.
// Passed to the voice queue through its existing `chunk` option
// (voice-player.ts); voice-queue.ts and its splitIntoChunks are unchanged, and
// ElevenLabs keeps the queue's own chunking.

import { splitIntoChunks } from './voice-queue'

// A sentence this short ("Nice.", "e.g.") is spoken with the next one, so it
// doesn't sound clipped on its own.
const MIN_SENTENCE_CHARS = 25

export function splitIntoSentences(text: string): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  // Same sentence boundaries as splitIntoChunks.
  const sentences = (clean.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [clean]).map((s) => s.trim()).filter(Boolean)
  const merged: string[] = []
  let carry = ''
  for (const s of sentences) {
    const joined = carry ? `${carry} ${s}` : s
    if (joined.length < MIN_SENTENCE_CHARS) { carry = joined; continue }
    merged.push(joined)
    carry = ''
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] += ` ${carry}`
    else merged.push(carry)
  }
  // A very long sentence is still split at a word boundary (the queue's own rule).
  return merged.flatMap((s) => splitIntoChunks(s))
}
