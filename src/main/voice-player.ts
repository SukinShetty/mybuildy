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
import { VoiceQueue } from './voice-queue'
import type { SpeakRequest } from './voice-queue'
import { synthesizeSpeech } from './ai/elevenlabs-tts'
import { withoutCancellation } from './ai/fetch-with-timeout'
import { sendSpeechProgress } from './guidance-window'
import { loadSettings } from './memory'
import { debugLog } from './debug-log'
import { logWatchEvent } from './watch-log'
import { VoiceHealth, type VoiceFailureCode, type VoiceFallbackState } from './voice-health'

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const SETTINGS_TTL_MS = 10_000

let voiceWin: BrowserWindow | null = null
let queue: VoiceQueue | null = null
let cachedSettings: AppSettings | null = null
let cachedAt = 0

// Never a silent fallback: while a set ElevenLabs key fails, the robot and
// Settings say so, with the reason (voice-health.ts). ipc-handlers.ts decides
// where the notice goes.
const voiceHealth = new VoiceHealth()
let voiceNotice: (state: VoiceFallbackState | null) => void = () => {}

export function setVoiceFallbackNotice(notify: (state: VoiceFallbackState | null) => void): void {
  voiceNotice = notify
}

export function getVoiceFallback(): VoiceFallbackState | null {
  return voiceHealth.current()
}

/** The ElevenLabs key was saved, replaced or removed: start afresh (and re-read it). */
export function resetVoiceHealth(): void {
  cachedSettings = null
  if (voiceHealth.ok() === null) voiceNotice(null)
}

function voiceFailed(code: VoiceFailureCode): void {
  const changed = voiceHealth.failed(code)
  if (changed === undefined) return
  console.warn(`[VoicePlayer-Main] ElevenLabs failed (${code}) — using the computer's voice, and saying so`)
  logWatchEvent('voice-fallback', { reason: code })
  voiceNotice(changed)
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

  queue = new VoiceQueue({
    sink: {
      playAudio: (id, audioBase64) => {
        if (win.isDestroyed()) return
        console.log(`[VoicePlayer-Main] → play-audio ${id}`)
        win.webContents.send(IPC.VOICE_PLAY_AUDIO, { id, audioBase64 })
      },
      playTts: (id, text) => {
        if (win.isDestroyed()) return
        console.log(`[VoicePlayer-Main] → play-tts ${id}`)
        win.webContents.send(IPC.VOICE_PLAY_TTS, { id, text })
      },
      stop: () => {
        if (win.isDestroyed()) return
        win.webContents.send(IPC.VOICE_STOP)
      },
    },
    // ElevenLabs synthesis per chunk; null → the player uses system TTS. With a
    // key set, a failure is never silent (voiceFailed). Run outside the watch's
    // cancel scope: speech has its own Stop, and must not switch voice because
    // the watch that asked for it ended.
    synth: async (chunkText) => {
      const s = await getSettings()
      if (!s || !s.elevenLabsApiKey) return null
      const key = s.elevenLabsApiKey
      try {
        const r = await withoutCancellation(() => synthesizeSpeech(chunkText, key, s.elevenLabsVoiceId || DEFAULT_VOICE_ID))
        if (r.success && r.audioBase64) { voiceWorked(); return r.audioBase64 }
        if (r.failure) voiceFailed(r.failure)
        return null
      } catch (error) {
        console.warn('[VoicePlayer-Main] synth error → falling back to system TTS:', error)
        voiceFailed('other')
        return null
      }
    },
    onProgress: (info) => {
      // Tell the guidance window which sentence is currently being spoken.
      sendSpeechProgress(info.chunkText)
    },
  })

  voiceWin = win
  console.log('[VoicePlayer-Main] Hidden voice window created (backgroundThrottling: false)')
  return win
}

// ─── Public API (called by analysis-loop + IPC handlers) ──────────────────────

export function enqueueSpeech(req: SpeakRequest): void {
  if (!queue) { console.warn('[VoicePlayer-Main] enqueue before init'); return }
  queue.enqueue(req)
}

export function stopVoice(): void {
  queue?.stop()
  sendSpeechProgress(null)
}

export function setVoiceMuted(muted: boolean): void {
  queue?.setMuted(muted)
  if (muted) sendSpeechProgress(null)
}

export function resetVoiceDedup(): void {
  queue?.resetDedup()
}

/** Called when the voice window reports a clip finished. */
export function handleVoiceEnded(id: string): void {
  queue?.onEnded(id)
  if (queue && !queue.isBusy()) sendSpeechProgress(null)
}

/** Called when the voice window reports a clip failed. */
export function handleVoiceError(id: string): void {
  queue?.onError(id)
  if (queue && !queue.isBusy()) sendSpeechProgress(null)
}

export function destroyVoicePlayer(): void {
  if (voiceWin && !voiceWin.isDestroyed()) voiceWin.destroy()
  voiceWin = null
  queue = null
}
