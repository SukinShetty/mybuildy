// voice-health.ts — main process (ELECTRON-FREE, unit-tested)
// MyBuildy never changes voice silently. The order is: ElevenLabs when the user
// set a key, otherwise Buildy's own voice (Kokoro, Bella), and the computer's
// voice only when Buildy's can't run. Whenever a voice later in that order
// speaks because an earlier one failed, this works out why — in plain words —
// and holds the notice until the right voice works again or the key changes.
// voice-player.ts reports each attempt here, sends changes to the robot and
// Settings, and writes them to the diagnostic log.

/** Why ElevenLabs speech failed. Logged as-is (no key, no spoken text). */
export type VoiceFailureCode =
  | 'invalid-key'
  | 'missing-permission'
  | 'quota'
  | 'unusual-activity'
  | 'voice-not-found'
  | 'paid-plan'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'other'
  | 'kokoro-missing'
  | 'kokoro-failed'

export const VOICE_FAILURE_REASONS: Record<VoiceFailureCode, string> = {
  'invalid-key': "ElevenLabs didn't accept the key. Check it was copied in full, or create a new one.",
  'missing-permission': "The ElevenLabs key isn't allowed to make speech. Create a key with Text to Speech turned on.",
  'quota': 'Your ElevenLabs credits for this month are used up.',
  'unusual-activity': 'ElevenLabs paused free-plan use from this connection (it does this with VPNs and shared networks).',
  'voice-not-found': "The voice chosen in Settings isn't available on your ElevenLabs account.",
  'paid-plan': 'That voice needs a paid ElevenLabs plan.',
  'rate-limit': 'ElevenLabs is busy right now. MyBuildy will try again with the next sentence.',
  'server': 'ElevenLabs is having problems right now. MyBuildy will try again with the next sentence.',
  'network': "MyBuildy couldn't reach ElevenLabs. Check your internet connection.",
  'other': 'ElevenLabs refused the request.',
  'kokoro-missing': "Buildy's voice files are missing from this install. Reinstalling MyBuildy puts them back.",
  'kokoro-failed': "Buildy's voice couldn't start on this computer.",
}

/** Which voice speaks instead. */
export type FallbackVoice = 'kokoro' | 'system'

/** The notice's first line: which voice failed, and which one is speaking instead. */
export function fallbackHeadline(code: VoiceFailureCode, speaking: FallbackVoice): string {
  if (code === 'kokoro-missing' || code === 'kokoro-failed') {
    return "Buildy's voice couldn't start, so MyBuildy is using your computer's voice"
  }
  return speaking === 'kokoro'
    ? "Your voice key isn't working, so MyBuildy is using Buildy's own voice"
    : "Your voice key isn't working, so MyBuildy is using your computer's voice"
}

/**
 * Classify a failed ElevenLabs request from its HTTP status and response body
 * (ElevenLabs answers {"detail": {"status": "quota_exceeded", ...}}).
 * `status` null = no response at all (network error or timeout).
 */
export function classifyElevenLabsFailure(status: number | null, body: string): VoiceFailureCode {
  if (status === null) return 'network'
  const detail = /"status"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? ''
  if (detail === 'quota_exceeded') return 'quota'
  if (detail === 'detected_unusual_activity') return 'unusual-activity'
  if (detail === 'missing_permissions') return 'missing-permission'
  if (detail === 'voice_not_found') return 'voice-not-found'
  if (detail === 'invalid_api_key') return 'invalid-key'
  if (status === 401 || status === 403) return 'invalid-key'
  if (status === 402) return 'paid-plan'
  if (status === 404) return 'voice-not-found'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'server'
  return 'other'
}

/** The notice the robot and Settings show while a fallback voice is speaking. */
export interface VoiceFallbackState {
  code: VoiceFailureCode
  headline: string
  reason: string
}

/** Tracks whether MyBuildy is on the computer's voice because ElevenLabs failed. */
export class VoiceHealth {
  private state: VoiceFallbackState | null = null

  current(): VoiceFallbackState | null {
    return this.state
  }

  /** A voice failed and `speaking` took over. Returns the new state if it changed. */
  failed(code: VoiceFailureCode, speaking: FallbackVoice = 'system'): VoiceFallbackState | null | undefined {
    const headline = fallbackHeadline(code, speaking)
    if (this.state?.code === code && this.state.headline === headline) return undefined
    this.state = { code, headline, reason: VOICE_FAILURE_REASONS[code] }
    return this.state
  }

  /** The intended voice spoke, or the key was changed or removed. Returns null if that cleared a notice. */
  ok(): null | undefined {
    if (!this.state) return undefined
    this.state = null
    return null
  }
}
