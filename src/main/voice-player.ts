// voice-player.ts — main process
// Owns audio playback so it survives renderer re-renders, focus changes, and the
// companion window being backgrounded.
//
// THE FIX (see VOICE_CUTOFF_DIAGNOSIS.md): playback previously lived in the
// companion renderer, whose BrowserWindow throttles when backgrounded (the user
// clicks their terminal → companion loses focus → Chromium throttles its media →
// audio cut off mid-sentence). Here we own a dedicated HIDDEN BrowserWindow created
// with `backgroundThrottling: false`, never focused and never re-rendered by app
// state, so playback is immune to UI lifecycle. The main process holds the queue,
// the lock, chunking, and ElevenLabs synthesis (via the electron-free VoiceQueue).
//
// The hidden window is a DUMB player: it plays exactly one clip on command and
// reports `ended`. All scheduling lives in VoiceQueue.

import { BrowserWindow } from 'electron'
import { join } from 'path'
import { IPC } from '../renderer/src/types'
import type { AppSettings } from '../renderer/src/types'
import { VoiceQueue, splitIntoChunks } from './voice-queue'
import type { SpeakRequest } from './voice-queue'
import { synthesizeSpeech } from './ai/elevenlabs-tts'
import { withoutCancellation } from './ai/fetch-with-timeout'
import { sendSpeechProgress } from './guidance-window'
import { loadSettings } from './memory'
import { debugLog } from './debug-log'
import { logWatchEvent } from './watch-log'
import { VoiceHealth, type VoiceFailureCode, type VoiceFallbackState, type FallbackVoice } from './voice-health'
import { kokoroStatus, kokoroIsLoading, prefetchKokoro, speakWithKokoro, clearKokoroPrefetch } from './kokoro-engine'
import { DEFAULT_BUILDY_VOICE, type BuildyVoice } from '../renderer/src/types'
import { splitIntoSentences } from './kokoro-chunks'

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const SETTINGS_TTL_MS = 10_000

let voiceWin: BrowserWindow | null = null
let queue: VoiceQueue | null = null
let cachedSettings: AppSettings | null = null
let cachedAt = 0
let progressText: string | null = null // the sentence being made or played

// The voice order: ElevenLabs when the user set a key, otherwise Buildy's own
// voice (Kokoro, Bella), and the computer's voice only if Buildy's can't run.
// Never a silent fallback: the robot and Settings say which voice is speaking
// instead, and why (voice-health.ts). ipc-handlers.ts decides where it goes.
type Engine = 'elevenlabs' | 'kokoro' | 'system'
const voiceHealth = new VoiceHealth()
let voiceNotice: (state: VoiceFallbackState | null) => void = () => {}

export function setVoiceFallbackNotice(notify: (state: VoiceFallbackState | null) => void): void {
  voiceNotice = notify
}

// A line is waiting while Buildy's voice is still loading: the robot shows he
// is getting ready to speak (ipc-handlers.ts sends it to the robot).
let preparingNotice: (preparing: boolean) => void = () => {}
let preparing = false
export function setVoicePreparingNotice(notify: (preparing: boolean) => void): void {
  preparingNotice = notify
}
function setPreparing(next: boolean): void {
  if (next === preparing) return
  preparing = next
  preparingNotice(next)
}

/** Buildy's voice from Settings (Bella or Puck), for the next sentence. */
function buildyVoice(): BuildyVoice {
  return cachedSettings?.buildyVoice ?? DEFAULT_BUILDY_VOICE
}

/** Bella or Puck was chosen in Settings: re-read it, so the next sentence uses it. */
export function buildyVoiceChanged(): void {
  cachedSettings = null
  void getSettings()
}

export function getVoiceFallback(): VoiceFallbackState | null {
  return voiceHealth.current()
}

/** The ElevenLabs key was saved, replaced or removed: start afresh (and re-read it). */
export function resetVoiceHealth(): void {
  cachedSettings = null
  void getSettings() // know the new key (or none) before the next line is chunked
  if (voiceHealth.ok() === null) voiceNotice(null)
}

function voiceFailed(code: VoiceFailureCode, speaking: FallbackVoice): void {
  const changed = voiceHealth.failed(code, speaking)
  if (changed === undefined) return
  console.warn(`[VoicePlayer-Main] voice fallback (${code}) — ${speaking} voice speaking, and saying so`)
  logWatchEvent('voice-fallback', { reason: code, speaking })
  voiceNotice(changed)
}

/** Buildy's own voice speaks (no ElevenLabs key) and is running: one sentence per chunk. */
function kokoroIsTheVoice(): boolean {
  const state = kokoroStatus().state
  // Settings not known yet (just after a key change): the queue's own chunking.
  if (!cachedSettings) return false
  return !cachedSettings.elevenLabsApiKey && (state === 'loading' || state === 'ready')
}

// For the diagnostic log: which voice spoke each line, and how long until its first word.
let lastEngine: Engine = 'system'
let lastBuildyVoice: BuildyVoice = DEFAULT_BUILDY_VOICE
const lineTimes = new Map<string, { queuedAt: number; startedAt: number }>()

function noteFirstWord(chunkId: string): void {
  if (!chunkId.endsWith('#0')) return
  const itemId = chunkId.slice(0, -2)
  const times = lineTimes.get(itemId)
  lineTimes.delete(itemId)
  if (!times) return
  const now = Date.now()
  logWatchEvent('voice-line', {
    engine: lastEngine,
    ...(lastEngine === 'kokoro' ? { voice: lastBuildyVoice } : {}),
    firstWordMs: now - times.startedAt,
    sinceQueuedMs: now - times.queuedAt,
  })
}

function voiceWorked(): void {
  if (voiceHealth.ok() === undefined) return
  logWatchEvent('voice-restored')
  voiceNotice(null)
}

async function getSettings(): Promise<AppSettings | null> {
  if (!cachedSettings || Date.now() - cachedAt > SETTINGS_TTL_MS) {
    try {
      cachedSettings = await loadSettings()
      cachedAt = Date.now()
    } catch (error) {
      console.warn('[VoicePlayer-Main] settings load failed:', error)
    }
  }
  return cachedSettings
}

export function createVoicePlayerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    // Offscreen rather than show:false — a never-shown window can have its audio
    // suspended by the OS/Chromium media session on a real device. Offscreen-shown
    // is a real, painted, audible window that's still invisible to the user.
    x: -10000,
    y: -10000,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Never throttle this renderer when it's in the background…
      backgroundThrottling: false,
      // …and never let autoplay policy block audio (the window gets no user gesture).
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  win.setIgnoreMouseEvents(true)

  // The voice window is invisible and has no devtools. Forward its console to the
  // main process stdout so `npm run dev` (with MYBUILDY_DEBUG) prints [Voice-Window]
  // lines for debugging. These can include spoken-text fragments, so they are
  // gated — silent in production.
  win.webContents.on('console-message', (_e, _level, message) => {
    debugLog(`[Voice-Window] ${message}`)
  })

  // Show OFFSCREEN once ready (not show:false) so its audio is never suspended.
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?voice=true`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { voice: 'true' } })
  }

  void getSettings() // know early whether an ElevenLabs key is set (chunking choice)
  queue = new VoiceQueue({
    sink: {
      playAudio: (id, audioBase64) => {
        if (win.isDestroyed()) return
        console.log(`[VoicePlayer-Main] → play-audio ${id} (${lastEngine}${lastEngine === 'kokoro' ? ` ${lastBuildyVoice}` : ''})`)
        noteFirstWord(id)
        sendSpeechProgress(progressText) // highlighted only now that its audio plays
        win.webContents.send(IPC.VOICE_PLAY_AUDIO, { id, audioBase64 })
      },
      playTts: (id, text) => {
        if (win.isDestroyed()) return
        console.log(`[VoicePlayer-Main] → play-tts ${id}`)
        lastEngine = 'system'
        noteFirstWord(id)
        sendSpeechProgress(progressText)
        win.webContents.send(IPC.VOICE_PLAY_TTS, { id, text })
      },
      stop: () => {
        if (win.isDestroyed()) return
        win.webContents.send(IPC.VOICE_STOP)
      },
    },
    // One chunk's audio, in the voice order: ElevenLabs (key set) → Buildy's own
    // voice → null (the player uses the computer's voice). Every fallback is
    // announced (voiceFailed). ElevenLabs runs outside the watch's cancel scope:
    // speech has its own Stop, and must not switch voice because the watch that
    // asked for it ended.
    synth: async (chunkText) => {
      const s = await getSettings()
      let elevenLabsFailure: VoiceFailureCode | null = null
      if (s?.elevenLabsApiKey) {
        const key = s.elevenLabsApiKey
        try {
          const r = await withoutCancellation(() => synthesizeSpeech(chunkText, key, s.elevenLabsVoiceId || DEFAULT_VOICE_ID))
          if (r.success && r.audioBase64) { lastEngine = 'elevenlabs'; voiceWorked(); return r.audioBase64 }
          elevenLabsFailure = r.failure
        } catch (error) {
          console.warn('[VoicePlayer-Main] ElevenLabs error:', error)
          elevenLabsFailure = 'other'
        }
      }
      // Buildy's voice still loading: the robot shows he's getting ready to speak.
      const voice = buildyVoice()
      if (kokoroIsLoading()) setPreparing(true)
      const wav = await speakWithKokoro(chunkText, voice)
      setPreparing(false)
      if (wav) {
        lastEngine = 'kokoro'
        lastBuildyVoice = voice
        if (elevenLabsFailure) voiceFailed(elevenLabsFailure, 'kokoro')
        else voiceWorked()
        return wav
      }
      const k = kokoroStatus()
      if (elevenLabsFailure) voiceFailed(elevenLabsFailure, 'system')
      else if (k.state === 'failed') voiceFailed(k.code, 'system')
      else if (k.state === 'ready') voiceFailed('kokoro-failed', 'system')
      return null
    },
    // Buildy's own voice speaks one sentence at a time (kokoro-chunks.ts), so the
    // first words start quickly; ElevenLabs keeps the queue's own chunking.
    chunk: (text) => (kokoroIsTheVoice() ? splitIntoSentences(text) : splitIntoChunks(text)),
    onProgress: (info) => {
      if (info.chunkIndex === 0) {
        const times = lineTimes.get(info.id)
        if (times) times.startedAt = Date.now()
      }
      // The sentence about to be made: the guidance window highlights it only
      // once its audio starts (playAudio / playTts), never while it's being made.
      progressText = info.chunkText
    },
  })

  voiceWin = win
  console.log('[VoicePlayer-Main] Hidden voice window created (backgroundThrottling: false)')
  return win
}

// ─── Public API (called by analysis-loop + IPC handlers) ──────────────────────

export function enqueueSpeech(req: SpeakRequest): void {
  if (!queue) { console.warn('[VoicePlayer-Main] enqueue before init'); return }
  const now = Date.now()
  lineTimes.set(req.id, { queuedAt: now, startedAt: now })
  if (lineTimes.size > 50) lineTimes.delete(lineTimes.keys().next().value as string)
  // Buildy's own voice: start making every sentence now, in order, so each one
  // is ready by the time the one before it has been spoken.
  if (kokoroIsTheVoice()) prefetchKokoro(splitIntoSentences(req.text), buildyVoice())
  queue.enqueue(req)
}

export function stopVoice(): void {
  clearKokoroPrefetch()
  queue?.stop()
  setPreparing(false)
  sendSpeechProgress(null)
}

const SAMPLE_LINE = "Hi! This is how I'll sound when I tell you what your coding agent just did."
let sampleCount = 0

/**
 * Settings → Voice → Play sample: a short line in Bella or Puck, now. Stops
 * whatever was being said; never goes through the queue (so it is not
 * remembered as said). Returns false if Buildy's voice can't speak right now.
 */
export async function playVoiceSample(voice: BuildyVoice): Promise<boolean> {
  stopVoice()
  if (kokoroIsLoading()) setPreparing(true)
  const wav = await speakWithKokoro(SAMPLE_LINE, voice)
  setPreparing(false)
  if (!wav || !voiceWin || voiceWin.isDestroyed()) return false
  logWatchEvent('voice-sample', { voice })
  voiceWin.webContents.send(IPC.VOICE_PLAY_AUDIO, { id: `sample-${++sampleCount}`, audioBase64: wav })
  return true
}

export function setVoiceMuted(muted: boolean): void {
  queue?.setMuted(muted)
  if (muted) sendSpeechProgress(null)
}

export function resetVoiceDedup(): void {
  queue?.resetDedup()
}

/** Called when the voice window reports a clip finished: nothing is playing until the next starts. */
export function handleVoiceEnded(id: string): void {
  if (id.startsWith('sample-')) return
  sendSpeechProgress(null)
  queue?.onEnded(id)
}

/** Called when the voice window reports a clip failed. */
export function handleVoiceError(id: string): void {
  if (id.startsWith('sample-')) return
  sendSpeechProgress(null)
  queue?.onError(id)
}

export function destroyVoicePlayer(): void {
  if (voiceWin && !voiceWin.isDestroyed()) voiceWin.destroy()
  voiceWin = null
  queue = null
}
