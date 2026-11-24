// voice-queue.ts — main process (ELECTRON-FREE, unit-tested)
// The pure brain of voice playback: sentence-safe chunking, a single serial lock,
// pending-merge (keep only the latest next item), critical override, and dedup.
//
// It knows nothing about Electron or audio APIs — it drives an injected `sink`
// (which actually plays a clip) and an injected `synth` (which turns a text chunk
// into base64 MP3, or null to use system TTS). This separation lets the queue be
// tested deterministically (see voice-queue.test.ts) and makes the Electron glue
// in voice-player.ts thin.
//
// INVARIANTS enforced here:
//   2. Audio is interrupted only by explicit stop()/setMuted(true). New items
//      NEVER interrupt the chunk currently playing — they append/merge.
//   3. Long text is split into sentence-safe chunks played in unbroken sequence.
//   4. While an item plays, only the LATEST queued next item is kept (older
//      pending items are dropped). The currently-playing item always finishes.
//   5. A critical item truncates the queue AFTER the current chunk, then plays.

import { debugLog } from './debug-log'

export interface SpeakRequest {
  id: string
  text: string
  isCritical?: boolean
}

/** The thing that actually plays one clip and reports back via onEnded/onError. */
export interface VoiceSink {
  playAudio(id: string, audioBase64: string): void
  playTts(id: string, text: string): void
  stop(): void
}

/** Turn a chunk of text into base64 MP3, or null to fall back to system TTS. */
export type Synthesizer = (chunkText: string) => Promise<string | null>

export interface ProgressInfo {
  id: string
  chunkIndex: number
  chunkCount: number
  chunkText: string
  fullText: string
}

export interface VoiceQueueOptions {
  sink: VoiceSink
  synth: Synthesizer
  onProgress?: (info: ProgressInfo) => void
  chunk?: (text: string) => string[]
  now?: () => number
  dedupCooldownMs?: number
}

interface ActiveItem {
  req: SpeakRequest
  chunks: string[]
  index: number
}

const DEFAULT_COOLDOWN_MS = 90_000

export class VoiceQueue {
  private readonly sink: VoiceSink
  private readonly synth: Synthesizer
  private readonly onProgress?: (info: ProgressInfo) => void
  private readonly chunk: (text: string) => string[]
  private readonly now: () => number
  private readonly cooldownMs: number

  private active: ActiveItem | null = null
  private pending: SpeakRequest | null = null
  private playingChunkId: string | null = null   // non-null while a chunk is synthesizing or playing
  private muted = false
  private lastSpokenText = ''
  private lastSpokenAt = 0

  constructor(opts: VoiceQueueOptions) {
    this.sink = opts.sink
    this.synth = opts.synth
    this.onProgress = opts.onProgress
    this.chunk = opts.chunk ?? ((t) => splitIntoChunks(t))
    this.now = opts.now ?? (() => Date.now())
    this.cooldownMs = opts.dedupCooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  /** Queue an item to be spoken. Never interrupts the chunk currently playing. */
  enqueue(req: SpeakRequest): void {
    const text = (req.text || '').trim()
    if (!text) return
    const item: SpeakRequest = { ...req, text }

    if (this.muted) {
      debugLog(`[VoicePlayer-Main] Muted — dropping "${text.slice(0, 50)}"`)
      return
    }
    if (!item.isCritical && this.isDuplicate(text)) {
      debugLog(`[VoicePlayer-Main] Skipped (dedup): ${text.slice(0, 50)}`)
      return
    }

    // Idle → make it the active item and start.
    if (!this.active) {
      this.active = { req: item, chunks: this.chunk(text), index: 0 }
      console.log(`[VoicePlayer-Main] New item "${item.id}" (${this.active.chunks.length} chunks)`)
      void this.pump()
      return
    }

    // Something is playing.
    if (item.isCritical) {
      // Keep only the chunk currently playing; drop the rest of the active item.
      this.active.chunks = this.active.chunks.slice(0, this.active.index + 1)
      this.pending = item
      console.log('[VoicePlayer-Main] Queue truncated by critical override')
    } else {
      if (this.pending) {
        console.log('[VoicePlayer-Main] Pending item replaced (older dropped)')
      }
      this.pending = item
    }
  }

  /** The sink reports a clip finished. Advance the queue. */
  onEnded(id: string): void {
    if (id !== this.playingChunkId) {
      console.log(`[VoicePlayer-Main] Stale ended ignored (${id})`)
      return
    }
    if (this.active) {
      console.log(`[VoicePlayer-Main] Chunk ${this.active.index + 1} of ${this.active.chunks.length} ended`)
      this.active.index++
    }
    this.playingChunkId = null
    void this.pump()
  }

  /** The sink reports a clip errored. Treat as ended so the queue keeps moving. */
  onError(id: string): void {
    console.warn(`[VoicePlayer-Main] Chunk error (${id}) — advancing`)
    this.onEnded(id)
  }

  /** Explicit interrupt (Stop / Mute / Pause / Quit). The ONLY way to cut audio. */
  stop(): void {
    console.log('[VoicePlayer-Main] stop (explicit) — clearing queue + current')
    this.active = null
    this.pending = null
    this.playingChunkId = null
    this.sink.stop()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    console.log(`[VoicePlayer-Main] setMuted(${muted})`)
    if (muted) this.stop()
  }

  resetDedup(): void {
    this.lastSpokenText = ''
    this.lastSpokenAt = 0
  }

  /** Test/inspection helpers. */
  isBusy(): boolean { return this.playingChunkId !== null }
  currentChunkId(): string | null { return this.playingChunkId }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (this.playingChunkId) return // a chunk is in flight

    // Current item exhausted (or none) → promote pending, else go idle.
    if (!this.active || this.active.index >= this.active.chunks.length) {
      if (this.pending) {
        const next = this.pending
        this.pending = null
        this.active = { req: next, chunks: this.chunk(next.text), index: 0 }
        console.log(`[VoicePlayer-Main] Promoting pending "${next.id}" (${this.active.chunks.length} chunks)`)
      } else {
        this.active = null
        return
      }
    }

    const a = this.active
    if (a.chunks.length === 0) { this.active = null; return void this.pump() }

    const chunkText = a.chunks[a.index]
    const id = `${a.req.id}#${a.index}`
    this.playingChunkId = id // claim the lock synchronously, before any await

    const n = a.index + 1
    const m = a.chunks.length
    console.log(`[VoicePlayer-Main] Chunk ${n} of ${m} starting`)
    debugLog(`[VoicePlayer-Main] chunk text: "${chunkText.slice(0, 50)}"`)
    this.onProgress?.({ id: a.req.id, chunkIndex: a.index, chunkCount: m, chunkText, fullText: a.req.text })

    // Record dedup on the first chunk of an item (once it actually starts).
    if (a.index === 0) this.recordSpoken(a.req.text)

    try {
      const base64 = await this.synth(chunkText)
      if (this.playingChunkId !== id) return // stopped while synthesizing
      if (base64) this.sink.playAudio(id, base64)
      else this.sink.playTts(id, chunkText)
    } catch (error) {
      console.warn('[VoicePlayer-Main] synth failed — skipping chunk:', error)
      this.onEnded(id)
    }
  }

  private isDuplicate(text: string): boolean {
    return text === this.lastSpokenText && this.now() - this.lastSpokenAt < this.cooldownMs
  }
  private recordSpoken(text: string): void {
    this.lastSpokenText = text
    this.lastSpokenAt = this.now()
  }
}

/**
 * Split text into sentence-safe chunks. Greedily packs consecutive sentences into
 * a chunk up to `maxChars` (so short sentences combine), and hard-splits any single
 * sentence longer than `maxChars` at a word boundary. Short abbreviations (e.g.,
 * i.e.) naturally re-merge because the packer keeps filling up to maxChars.
 */
export function splitIntoChunks(text: string, maxChars = 250): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []

  const sentences = clean.match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]+(?=\s|$)|(?:[^.!?]|[.!?](?!\s|$))+$/g) || [clean]
  const chunks: string[] = []
  let buf = ''

  const flushLong = (): void => {
    while (buf.length > maxChars) {
      const cut = buf.lastIndexOf(' ', maxChars)
      const at = cut > 0 ? cut : maxChars
      chunks.push(buf.slice(0, at).trim())
      buf = buf.slice(at).trim()
    }
  }

  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (!buf) {
      buf = s
    } else if (buf.length + 1 + s.length <= maxChars) {
      buf += ' ' + s
    } else {
      chunks.push(buf)
      buf = s
    }
    flushLong()
  }
  if (buf) chunks.push(buf)
  return chunks
}
