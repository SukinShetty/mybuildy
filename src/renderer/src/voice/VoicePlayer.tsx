// VoicePlayer.tsx — renderer for the hidden voice window (?voice=true)
// A DUMB player. It plays exactly one clip when the main process tells it to, and
// reports `ended`/`error` back. ALL queueing/chunking/locking lives in the main
// process (voice-queue.ts). Its BrowserWindow has backgroundThrottling:false.
//
// Heavily instrumented (see VOICE_CUTOFF_EVIDENCE.md): every audio lifecycle event
// is logged with a performance.now() timestamp, and every pause / stopCurrent /
// cancel logs a stack trace so we can see WHO interrupted playback.

import { useEffect } from 'react'
import { pickBackupVoice } from './backup-voice'

const T0 = performance.now()
const ts = (): string => (performance.now() - T0).toFixed(0).padStart(6)
const vlog = (msg: string): void => console.log(`[Voice-R ${ts()}] ${msg}`)
const stack = (): string => (new Error().stack || '').split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' ')

// Module-level so the element can't be GC'd mid-playback.
let currentAudio: HTMLAudioElement | null = null
// Keep a reference to the live utterance — Chrome GC's unreferenced utterances
// mid-speech, which silently cuts off system TTS after a few seconds.
let currentUtterance: SpeechSynthesisUtterance | null = null

function stopCurrent(reason: string): void {
  vlog(`stopCurrent(${reason}) STACK: ${stack()}`)
  if (currentAudio) {
    try { currentAudio.pause() } catch { /* ignore */ }
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio.ontimeupdate = null
    currentAudio = null
  }
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel() } catch { /* ignore */ }
  }
  currentUtterance = null
}

export function VoicePlayer(): null {
  useEffect(() => {
    vlog('mounted (dumb player)')

    const unsubs = [
      window.mybuildy.voice.onPlayAudio((_, d) => {
        stopCurrent('new-audio')
        vlog(`play-audio ${d.id} (${d.audioBase64.length} b64 chars)`)
        const audio = new Audio(`data:audio/mpeg;base64,${d.audioBase64}`)
        audio.volume = 1.0
        currentAudio = audio
        let lastLogged = -1
        audio.ontimeupdate = () => {
          const t = audio.currentTime
          if (t - lastLogged >= 0.5) { lastLogged = t; vlog(`timeupdate ${d.id} t=${t.toFixed(2)}/${audio.duration.toFixed(2)}`) }
        }
        audio.oncanplaythrough = () => vlog(`canplaythrough ${d.id} dur=${audio.duration.toFixed(2)}`)
        audio.onpause = () => vlog(`PAUSE ${d.id} t=${audio.currentTime.toFixed(2)} STACK: ${stack()}`)
        audio.onended = () => { vlog(`ENDED ${d.id} t=${audio.currentTime.toFixed(2)}`); window.mybuildy.voice.ended(d.id) }
        audio.onerror = () => { vlog(`ERROR ${d.id} code=${audio.error?.code}`); window.mybuildy.voice.error(d.id) }
        vlog(`play() called ${d.id}`)
        audio.play().then(() => vlog(`play() RESOLVED ${d.id}`)).catch((err) => {
          vlog(`play() REJECTED ${d.id}: ${err?.name} ${err?.message}`)
          window.mybuildy.voice.error(d.id)
        })
      }),

      window.mybuildy.voice.onPlayTts((_, d) => {
        stopCurrent('new-tts')
        vlog(`play-tts ${d.id} len=${d.text.length}`)
        // @ts-expect-error TS narrows `window` to `never` inside this negated `in` guard, but window.mybuildy exists at runtime
        if (!('speechSynthesis' in window)) { window.mybuildy.voice.error(d.id); return }
        const utter = new SpeechSynthesisUtterance(d.text)
        const backupVoice = pickBackupVoice(window.speechSynthesis.getVoices()) // a natural female voice, never David
        if (backupVoice) utter.voice = backupVoice
        utter.rate = 0.95
        utter.pitch = 1.05
        utter.volume = 1.0
        currentUtterance = utter // retain (Chrome GC bug)
        utter.onstart = () => vlog(`tts start ${d.id}`)
        utter.onboundary = (e) => vlog(`tts boundary ${d.id} char=${e.charIndex}`)
        utter.onpause = () => vlog(`tts PAUSE ${d.id} STACK: ${stack()}`)
        utter.onend = () => { vlog(`tts ENDED ${d.id}`); currentUtterance = null; window.mybuildy.voice.ended(d.id) }
        utter.onerror = (e) => { vlog(`tts ERROR ${d.id}: ${e.error}`); currentUtterance = null; window.mybuildy.voice.error(d.id) }
        vlog(`speak() ${d.id}`)
        window.speechSynthesis.speak(utter)
      }),

      window.mybuildy.voice.onStop(() => {
        vlog('onStop IPC received')
        stopCurrent('ipc-stop')
      }),
    ]

    return () => { vlog('unmount cleanup'); unsubs.forEach((u) => u()); stopCurrent('unmount') }
  }, [])

  return null
}
