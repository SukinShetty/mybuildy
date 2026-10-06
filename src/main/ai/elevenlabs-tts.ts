// elevenlabs-tts.ts — main process
// Calls the ElevenLabs text-to-speech API and returns raw MP3 audio.
// The audio is sent to the companion renderer via IPC for playback.
//
// API: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
// Returns: audio/mpeg binary
//
// Voice settings tuned for a warm, supportive builder buddy:
//   - stability: 0.5 (natural variation, not monotone)
//   - similarity_boost: 0.75 (close to the voice but not rigid)
//   - style: 0.4 (some expressiveness)
//   - use_speaker_boost: true

import { fetchWithTimeout, CancelledError } from './fetch-with-timeout'
import { redactKnownSecrets } from '../secure-store'
import { debugLog, debugError } from '../debug-log'
import { classifyElevenLabsFailure, VOICE_FAILURE_REASONS, type VoiceFailureCode } from '../voice-health'
import { fakeElevenLabsFailure } from '../e2e-fakes'

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1'
// Hard cap so a long answer/explanation is read fully but extreme TTS calls are
// avoided. Short live-guidance lines are well under this; only long spoken
// answers approach it.
const TTS_MAX_CHARS = 500

/**
 * Clean text before sending to TTS: strip markdown / control markers that would
 * otherwise be read aloud or cause choppy synthesis, and cap the length so
 * playback stays short and smooth.
 */
function sanitizeForTTS(raw: string): string {
  let t = raw
    .replace(/```[\s\S]*?```/g, ' ')                 // fenced code blocks (drop entirely)
    .replace(/\[PROMPT_START\]|\[PROMPT_END\]/g, '') // control markers
    .replace(/\*\*/g, '')                            // bold markers
    .replace(/#{1,6}/g, '')                          // markdown headings (##, ###, ...)
    .replace(/`+/g, '')                              // inline code ticks
    .replace(/\s+/g, ' ')
    .trim()

  if (t.length > TTS_MAX_CHARS) {
    const cut = t.lastIndexOf(' ', TTS_MAX_CHARS)
    t = t.slice(0, cut > 0 ? cut : TTS_MAX_CHARS).trim()
  }
  return t
}

export interface ElevenLabsTTSResult {
  success: boolean
  audioBase64: string | null  // MP3 audio as base64 string
  error: string | null
  // Why ElevenLabs failed (voice-health.ts); null on success, with no key, or when stopped.
  failure: VoiceFailureCode | null
}

// The response body is read only to classify the failure; never logged.
const MAX_ERROR_BODY_CHARS = 2000

/**
 * Convert text to speech using ElevenLabs.
 * Returns base64-encoded MP3 audio on success, or an error message on failure.
 */
export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  voiceId: string
): Promise<ElevenLabsTTSResult> {
  if (!apiKey) {
    console.log('[ElevenLabs] No API key configured — skipping')
    return { success: false, audioBase64: null, error: 'No ElevenLabs API key configured', failure: null }
  }

  // e2e only (e2e-fakes.ts): ElevenLabs is never called.
  const fake = fakeElevenLabsFailure()
  if (fake) {
    const failure = fake === 'none' ? null : (fake as VoiceFailureCode)
    return { success: false, audioBase64: null, error: failure ? VOICE_FAILURE_REASONS[failure] : 'e2e', failure }
  }

  const cleanText = sanitizeForTTS(text)
  if (!cleanText) {
    return { success: false, audioBase64: null, error: 'Empty text', failure: null }
  }

  // Spoken text is screen-derived content — gate it.
  debugLog(`[ElevenLabs] TTS request: "${cleanText.slice(0, 60)}..." (${cleanText.length} chars) voice=${voiceId}`)

  try {
    const response = await fetchWithTimeout(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text: cleanText,
          // Streaming-friendly turbo model for faster, smoother playback
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.65,
            similarity_boost: 0.80,
            style: 0.15,
            use_speaker_boost: true,
          },
        }),
      }
    )

    if (!response.ok) {
      let body = ''
      try { body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS) } catch { /* classify from the status */ }
      const failure = classifyElevenLabsFailure(response.status, body)
      console.error(`[ElevenLabs] TTS failed: HTTP ${response.status} (${failure})`)
      return { success: false, audioBase64: null, error: VOICE_FAILURE_REASONS[failure], failure }
    }

    const audioBuffer = await response.arrayBuffer()
    const audioBase64 = Buffer.from(audioBuffer).toString('base64')
    console.log(`[ElevenLabs] TTS success: ${audioBase64.length} chars of base64 audio`)

    return { success: true, audioBase64, error: null, failure: null }
  } catch (error) {
    if (error instanceof CancelledError) return { success: false, audioBase64: null, error: 'Stopped.', failure: null }
    debugError(`[ElevenLabs] TTS exception: ${redactKnownSecrets(String(error))}`)
    return {
      success: false,
      audioBase64: null,
      error: `ElevenLabs TTS failed: ${redactKnownSecrets(String(error)).slice(0, 200)}`,
      failure: 'network',
    }
  }
}
