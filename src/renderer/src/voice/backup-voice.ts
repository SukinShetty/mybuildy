// backup-voice.ts — pure: which of the computer's own voices MyBuildy speaks
// with when ElevenLabs isn't used. The most natural female voice available,
// and never Microsoft David (or another male voice) unless nothing else exists.

export interface VoiceInfo {
  name: string
  lang: string
  localService?: boolean
}

// Known female system voices, most natural first (Windows, macOS, Chrome/Linux).
const FEMALE_VOICES: RegExp[] = [
  /\b(aria|jenny|ava|emma|michelle|sonia|libby|natasha|clara)\b.*\b(natural|neural|online)\b/i,
  /\b(ava|zoe|allison|samantha|susan|serena|kate|karen|moira|tessa|fiona|veena|nicky)\b.*\b(premium|enhanced)\b/i,
  /\b(ava|zoe|allison|samantha|susan|serena|kate|karen|moira|tessa|fiona|veena|nicky|victoria)\b/i,
  /\b(aria|jenny|emma|michelle|sonia|libby|natasha|clara|hazel|susan|zira|catherine|linda|heera)\b/i,
  /\bfemale\b/i,
]
const MALE_VOICES = /\b(david|mark|george|guy|ryan|james|richard|ravi|sean|daniel|alex|fred|tom|aaron|arthur|oliver|male)\b/i

function score(v: VoiceInfo): number {
  if (MALE_VOICES.test(v.name) && !/\bfemale\b/i.test(v.name)) return -1
  const english = /^en[-_]/i.test(v.lang) ? (/^en[-_]us/i.test(v.lang) ? 2 : 1) : 0
  const tier = FEMALE_VOICES.findIndex((re) => re.test(v.name))
  return (tier === -1 ? 0 : (FEMALE_VOICES.length - tier) * 10) + english
}

/** The voice to speak with, or null to leave the system default (no voices loaded yet). */
export function pickBackupVoice<T extends VoiceInfo>(voices: T[]): T | null {
  if (voices.length === 0) return null
  const ranked = voices.map((v) => ({ v, s: score(v) })).sort((a, b) => b.s - a.s)
  // Never a male voice while any other exists; only if it is the sole voice at all.
  const best = ranked.find((r) => r.s >= 0)
  return best ? best.v : ranked[0].v
}
